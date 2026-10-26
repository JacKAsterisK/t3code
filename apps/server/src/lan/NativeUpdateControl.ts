// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- This native callback adapter owns the bounded Windows update-control pipe.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  decodeNativeUpdateRequest,
  NATIVE_UPDATE_MAX_LINE_BYTES,
  NATIVE_UPDATE_PREPARE_MS,
  NATIVE_UPDATE_RESERVATION_MS,
  nativeUpdatePipePath,
  type NativeUpdateIdentity,
  type NativeUpdateRequest,
} from "@t3tools/shared/nativeUpdateControl";
import * as NativeUpdateGate from "./NativeUpdateGate.ts";

export class NativeUpdateControlError extends Schema.TaggedError<NativeUpdateControlError>()(
  "NativeUpdateControlError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Native update control is unavailable.";
  }
}

interface ControlInput extends Omit<
  NativeUpdateGate.NativeUpdateReservationInput,
  "id" | "timeout"
> {
  readonly identity: NativeUpdateIdentity;
  readonly desktopPid: number;
}

interface ActiveReservation {
  readonly reservation: NativeUpdateGate.NativeUpdateReservation;
  readonly owner: NodeNet.Socket;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly expiresUtc: string;
  readonly timer: ReturnType<typeof setTimeout>;
  closeToken?: string;
  desktop?: NodeNet.Socket;
  closing: boolean;
}

export const startNativeUpdateControl = Effect.fn("NativeUpdateControl.start")(function* (
  input: ControlInput,
) {
  const gate = yield* NativeUpdateGate.NativeUpdateGate;
  const platform = yield* HostProcess.Platform;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const pipeName = nativeUpdatePipePath(input.identity.ownerId);
  if (platform !== "win32" || input.identity.pid !== process.pid || input.desktopPid <= 0) {
    return yield* new NativeUpdateControlError({ cause: "unsupported-owner" });
  }
  let active: ActiveReservation | undefined;
  const sockets = new Set<NodeNet.Socket>();
  const release = async (record: ActiveReservation) => {
    clearTimeout(record.timer);
    await run(record.reservation.release).catch(() => undefined);
    if ((await run(gate.status)).phase === "closing") {
      record.closing = true;
      return;
    }
    if (active === record) active = undefined;
  };
  const matches = (request: NativeUpdateRequest) =>
    request.environmentId === input.identity.environmentId &&
    request.ownerId === input.identity.ownerId &&
    request.pid === input.identity.pid;
  const server = NodeNet.createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    let buffer = Buffer.alloc(0);
    let pending = false;
    const initialTimeout = setTimeout(() => socket.destroy(), NATIVE_UPDATE_PREPARE_MS);
    initialTimeout.unref();
    const send = (request: NativeUpdateRequest, body: Record<string, unknown>) => {
      if (!socket.destroyed)
        socket.write(
          JSON.stringify({
            schemaVersion: 1,
            operation: request.operation,
            ...input.identity,
            nonce: request.nonce,
            ...body,
          }) + "\n",
        );
    };
    const handle = async (request: NativeUpdateRequest) => {
      if (!matches(request)) {
        send(request, { status: "deferred", reason: "unknown" });
        return;
      }
      if (request.operation === "reserve") {
        if (active !== undefined) {
          send(request, { status: "deferred", reason: "reserved" });
          return;
        }
        const expiresAt = Date.now() + NATIVE_UPDATE_RESERVATION_MS;
        const reservation = await run(
          gate.reserve({
            ...input,
            id: NodeCrypto.randomUUID(),
            timeout: NATIVE_UPDATE_PREPARE_MS,
          }),
          { signal: controller.signal },
        );
        if (socket.destroyed) {
          await run(reservation.release);
          return;
        }
        const record: ActiveReservation = {
          reservation,
          owner: socket,
          nonce: request.nonce,
          expiresAt,
          expiresUtc: new Date(expiresAt).toISOString(),
          closing: false,
          timer: setTimeout(
            () => {
              void release(record);
            },
            Math.max(0, expiresAt - Date.now()),
          ),
        };
        record.timer.unref();
        active = record;
        send(request, {
          status: "ready",
          reservationId: reservation.id,
          expiresUtc: record.expiresUtc,
        });
        return;
      }
      const record = active;
      if (record === undefined || (!record.closing && Date.now() >= record.expiresAt)) {
        if (record !== undefined) await release(record);
        send(request, { status: "deferred", reason: "timeout" });
        return;
      }
      if (request.operation === "consume-close" || request.operation === "abort-close") {
        if (
          request.desktopPid !== input.desktopPid ||
          request.closeToken !== record.closeToken ||
          record.closeToken === undefined ||
          socket === record.owner
        ) {
          send(request, { status: "deferred", reason: "unknown" });
          return;
        }
        if (request.operation === "abort-close") {
          if (record.desktop !== socket || !record.closing) {
            send(request, { status: "deferred", reason: "unknown" });
            return;
          }
          await run(record.reservation.abortClose);
          clearTimeout(record.timer);
          if (active === record) active = undefined;
          send(request, { status: "cancelled" });
          return;
        }
        if (record.closing) {
          send(request, { status: "deferred", reason: "reserved" });
          return;
        }
        record.desktop = socket;
        await run(record.reservation.consume, { signal: controller.signal });
        record.closing = true;
        record.desktop = socket;
        clearTimeout(record.timer);
        send(request, {
          status: "closing",
          reservationId: record.reservation.id,
          expiresUtc: record.expiresUtc,
        });
        return;
      }
      if (
        record.owner !== socket ||
        request.nonce !== record.nonce ||
        request.reservationId !== record.reservation.id ||
        record.closing
      ) {
        send(request, { status: "deferred", reason: "unknown" });
        return;
      }
      if (request.operation === "cancel") {
        await release(record);
        send(request, { status: "cancelled" });
        return;
      }
      await run(record.reservation.confirm, { signal: controller.signal });
      if (active !== record || socket.destroyed || Date.now() >= record.expiresAt) {
        await release(record);
        send(request, { status: "deferred", reason: "timeout" });
        return;
      }
      record.closeToken = NodeCrypto.randomBytes(16).toString("hex");
      send(request, {
        status: "committed",
        reservationId: record.reservation.id,
        expiresUtc: record.expiresUtc,
        closeToken: record.closeToken,
      });
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > NATIVE_UPDATE_MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (pending || newline !== buffer.length - 1) {
        socket.destroy();
        return;
      }
      let request: NativeUpdateRequest | undefined;
      try {
        request = decodeNativeUpdateRequest(
          JSON.parse(buffer.subarray(0, newline).toString("utf8")),
        );
      } catch {
        socket.destroy();
        return;
      }
      buffer = Buffer.alloc(0);
      if (request === undefined) {
        socket.destroy();
        return;
      }
      clearTimeout(initialTimeout);
      pending = true;
      void handle(request)
        .catch(async () => {
          const record = active;
          if (record !== undefined && (record.owner === socket || record.desktop === socket))
            await release(record);
          send(request, { status: "deferred", reason: "unknown" });
        })
        .finally(() => {
          pending = false;
        });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(initialTimeout);
      controller.abort();
      sockets.delete(socket);
      if (active !== undefined && (active.owner === socket || active.desktop === socket))
        void release(active);
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(pipeName, () => {
            server.off("error", reject);
            resolve();
          });
        }),
      catch: (cause) => new NativeUpdateControlError({ cause }),
    }),
    () =>
      Effect.promise(async () => {
        for (const socket of sockets) socket.destroy();
        if (active !== undefined) await release(active);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
  return { schemaVersion: 1 as const, pipeName };
});
