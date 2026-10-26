// @effect-diagnostics nodeBuiltinImport:off -- These fixtures own isolated Windows named-pipe clients.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { NATIVE_UPDATE_MAX_LINE_BYTES } from "@t3tools/shared/nativeUpdateControl";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as NativeUpdateControl from "./NativeUpdateControl.ts";
import * as NativeUpdateGate from "./NativeUpdateGate.ts";

const nativePlatform = Context.get(Context.empty(), HostProcess.Platform);

interface Peer {
  readonly socket: NodeNet.Socket;
  readonly lines: AsyncIterableIterator<string>;
  readonly closed: Promise<void>;
}

const connect = Effect.fn("NativeUpdateControlTest.connect")(function* (pipeName: string) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const socket = new NodeNet.Socket();
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        });
        const reader = NodeReadline.createInterface({ input: socket });
        reader.on("error", () => {});
        const lines = reader[Symbol.asyncIterator]();
        socket.on("error", () => {});
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.connect(pipeName, resolve);
        });
        return { socket, lines, closed } satisfies Peer;
      },
      catch: (cause) => new NativeUpdateControl.NativeUpdateControlError({ cause }),
    }),
    (peer) =>
      Effect.promise(() => {
        peer.socket.destroy();
        return peer.closed;
      }),
  );
});

const request = Effect.fn("NativeUpdateControlTest.request")(function (peer: Peer, body: object) {
  return Effect.tryPromise({
    try: async () => {
      peer.socket.write(JSON.stringify(body) + "\n");
      const line = await peer.lines.next();
      if (line.done) throw new Error("Synthetic pipe closed before replying.");
      return JSON.parse(line.value) as Record<string, unknown>;
    },
    catch: (cause) => new NativeUpdateControl.NativeUpdateControlError({ cause }),
  });
});

const disconnect = Effect.fn("NativeUpdateControlTest.disconnect")(function (peer: Peer) {
  return Effect.promise(() => {
    peer.socket.destroy();
    return peer.closed;
  });
});

const fixture = Effect.fn("NativeUpdateControlTest.fixture")(function* (
  overrides: Partial<Omit<NativeUpdateGate.NativeUpdateReservationInput, "id" | "timeout">> = {},
) {
  const identity = {
    environmentId: "synthetic-update-environment",
    ownerId: NodeCrypto.randomUUID(),
    pid: process.pid,
  };
  const desktopPid = process.pid + 1;
  const control = yield* NativeUpdateControl.startNativeUpdateControl({
    identity,
    desktopPid,
    inspectReady: Effect.succeed(true),
    freezeDrafts: () => Effect.succeed(true),
    verifyFrozenDrafts: () => Effect.succeed(true),
    thawDrafts: () => Effect.void,
    ...overrides,
  }).pipe(Effect.provideService(HostProcess.Platform, nativePlatform));
  const gate = yield* NativeUpdateGate.NativeUpdateGate;
  const owner = yield* connect(control.pipeName);
  const base = { schemaVersion: 1, ...identity, nonce: "ab".repeat(32) };
  return { ...control, gate, owner, base, desktopPid };
});

if (nativePlatform === "win32") {
  describe("native update named pipe", () => {
    it.live("retains terminal admission after consume and both client disconnections", () =>
      Effect.gen(function* () {
        let thaws = 0;
        const gate = yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture({
              thawDrafts: () =>
                Effect.sync(() => {
                  thaws++;
                }),
            });
            const reserved = yield* request(f.owner, { ...f.base, operation: "reserve" });
            assert.strictEqual(reserved.status, "ready");
            const committed = yield* request(f.owner, {
              ...f.base,
              operation: "commit",
              reservationId: reserved.reservationId,
            });
            assert.strictEqual(committed.status, "committed");
            const desktop = yield* connect(f.pipeName);
            const consumed = yield* request(desktop, {
              ...f.base,
              operation: "consume-close",
              closeToken: committed.closeToken,
              desktopPid: f.desktopPid,
            });
            assert.strictEqual(consumed.status, "closing");
            yield* disconnect(f.owner);
            yield* disconnect(desktop);
            return f.gate;
          }),
        );
        assert.deepStrictEqual(yield* gate.status, { phase: "closing", activeCount: 0 });
        assert.strictEqual(thaws, 0);
      }).pipe(Effect.provide(NativeUpdateGate.layer)),
    );

    it.live("binds commit to identity, owner connection, nonce and reservation ID", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let inspections = 0;
          const f = yield* fixture({
            inspectReady: Effect.sync(() => {
              inspections++;
              return true;
            }),
          });
          const wrongIdentity = yield* request(f.owner, {
            ...f.base,
            operation: "reserve",
            environmentId: "another-environment",
          });
          assert.strictEqual(wrongIdentity.status, "deferred");
          assert.strictEqual(inspections, 0);
          const reserved = yield* request(f.owner, { ...f.base, operation: "reserve" });
          assert.strictEqual(reserved.status, "ready");
          const commit = { ...f.base, operation: "commit", reservationId: reserved.reservationId };
          const other = yield* connect(f.pipeName);
          assert.strictEqual((yield* request(other, commit)).status, "deferred");
          for (const override of [
            { nonce: "cd".repeat(32) },
            { reservationId: NodeCrypto.randomUUID() },
            { pid: process.pid + 2 },
            { ownerId: NodeCrypto.randomUUID() },
          ]) {
            assert.strictEqual(
              (yield* request(f.owner, { ...commit, ...override })).status,
              "deferred",
            );
          }
          assert.strictEqual((yield* f.gate.status).phase, "reserved");
          const committed = yield* request(f.owner, commit);
          assert.strictEqual(committed.status, "committed");
          const consume = {
            ...f.base,
            operation: "consume-close",
            closeToken: committed.closeToken,
            desktopPid: f.desktopPid,
          };
          assert.strictEqual((yield* request(f.owner, consume)).status, "deferred");
          assert.strictEqual(
            (yield* request(other, { ...consume, desktopPid: f.desktopPid + 1 })).status,
            "deferred",
          );
          assert.strictEqual(
            (yield* request(other, { ...consume, closeToken: "00".repeat(16) })).status,
            "deferred",
          );
          assert.strictEqual((yield* request(other, consume)).status, "closing");
          assert.strictEqual(
            (yield* request(other, { ...consume, operation: "abort-close" })).status,
            "cancelled",
          );
          assert.strictEqual((yield* f.gate.status).phase, "open");
        }),
      ).pipe(Effect.provide(NativeUpdateGate.layer)),
    );

    it.live("invalidates a committed token on cancel and admits a fresh reservation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const reserved = yield* request(f.owner, { ...f.base, operation: "reserve" });
          const committed = yield* request(f.owner, {
            ...f.base,
            operation: "commit",
            reservationId: reserved.reservationId,
          });
          assert.strictEqual(committed.status, "committed");
          assert.strictEqual(
            (yield* request(f.owner, {
              ...f.base,
              operation: "cancel",
              reservationId: reserved.reservationId,
            })).status,
            "cancelled",
          );
          const desktop = yield* connect(f.pipeName);
          assert.strictEqual(
            (yield* request(desktop, {
              ...f.base,
              operation: "consume-close",
              closeToken: committed.closeToken,
              desktopPid: f.desktopPid,
            })).status,
            "deferred",
          );
          const next = yield* request(f.owner, { ...f.base, operation: "reserve" });
          assert.strictEqual(next.status, "ready");
          assert.notStrictEqual(next.reservationId, reserved.reservationId);
          assert.strictEqual(
            (yield* request(desktop, {
              ...f.base,
              operation: "consume-close",
              closeToken: committed.closeToken,
              desktopPid: f.desktopPid,
            })).status,
            "deferred",
          );
          yield* request(f.owner, {
            ...f.base,
            operation: "cancel",
            reservationId: next.reservationId,
          });
        }),
      ).pipe(Effect.provide(NativeUpdateGate.layer)),
    );

    it.live("clears adapter ownership when final desktop readiness fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let ready = true;
          const f = yield* fixture({ inspectReady: Effect.sync(() => ready) });
          const reserved = yield* request(f.owner, { ...f.base, operation: "reserve" });
          const committed = yield* request(f.owner, {
            ...f.base,
            operation: "commit",
            reservationId: reserved.reservationId,
          });
          const desktop = yield* connect(f.pipeName);
          ready = false;
          assert.strictEqual(
            (yield* request(desktop, {
              ...f.base,
              operation: "consume-close",
              closeToken: committed.closeToken,
              desktopPid: f.desktopPid,
            })).status,
            "deferred",
          );
          assert.strictEqual((yield* f.gate.status).phase, "open");
          ready = true;
          const retry = yield* request(f.owner, { ...f.base, operation: "reserve" });
          assert.strictEqual(retry.status, "ready");
          yield* request(f.owner, {
            ...f.base,
            operation: "cancel",
            reservationId: retry.reservationId,
          });
        }),
      ).pipe(Effect.provide(NativeUpdateGate.layer)),
    );

    it.live("cancels disconnected preparation and thaws before another client reserves", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const freezing = yield* Deferred.make<void>();
          const thawed = yield* Deferred.make<void>();
          let first = true;
          const f = yield* fixture({
            freezeDrafts: () =>
              Effect.suspend(() => {
                if (!first) return Effect.succeed(true);
                first = false;
                return Deferred.succeed(freezing, undefined).pipe(Effect.andThen(Effect.never));
              }),
            thawDrafts: () => Deferred.succeed(thawed, undefined).pipe(Effect.asVoid),
          });
          f.owner.socket.write(JSON.stringify({ ...f.base, operation: "reserve" }) + "\n");
          yield* Deferred.await(freezing);
          yield* disconnect(f.owner);
          yield* Deferred.await(thawed);
          const other = yield* connect(f.pipeName);
          const next = yield* request(other, { ...f.base, operation: "reserve" });
          assert.strictEqual(next.status, "ready");
          yield* request(other, {
            ...f.base,
            operation: "cancel",
            reservationId: next.reservationId,
          });
        }),
      ).pipe(Effect.provide(NativeUpdateGate.layer)),
    );

    it.live("closes oversized and malformed input before accepting execution", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let inspections = 0;
          const f = yield* fixture({
            inspectReady: Effect.sync(() => {
              inspections++;
              return true;
            }),
          });
          for (const bytes of [
            Buffer.from("é".repeat(NATIVE_UPDATE_MAX_LINE_BYTES / 2 + 1)),
            Buffer.from("{not-json}\n"),
            Buffer.from("{}\n"),
          ]) {
            const peer = yield* connect(f.pipeName);
            peer.socket.write(bytes);
            yield* Effect.promise(() => peer.closed);
          }
          assert.strictEqual(inspections, 0);
          assert.strictEqual((yield* f.gate.status).phase, "open");
          const reserved = yield* request(f.owner, { ...f.base, operation: "reserve" });
          assert.strictEqual(reserved.status, "ready");
          yield* request(f.owner, {
            ...f.base,
            operation: "cancel",
            reservationId: reserved.reservationId,
          });
        }),
      ).pipe(Effect.provide(NativeUpdateGate.layer)),
    );
  });
} else {
  it.effect("refuses native update control on unsupported platforms", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = yield* fixture().pipe(Effect.flip);
        assert.instanceOf(failure, NativeUpdateControl.NativeUpdateControlError);
      }),
    ).pipe(Effect.provide(NativeUpdateGate.layer)),
  );
}
