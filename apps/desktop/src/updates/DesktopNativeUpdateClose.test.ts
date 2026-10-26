// @effect-diagnostics nodeBuiltinImport:off -- These fixtures own synthetic owner files and a bounded local pipe peer.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  nativeUpdatePipePath,
  NATIVE_UPDATE_PREPARE_MS,
} from "@t3tools/shared/nativeUpdateControl";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopNativeUpdateClose from "./DesktopNativeUpdateClose.ts";

const mocks = vi.hoisted(() => ({
  windows: vi.fn(),
  appOn: vi.fn(),
  appRemove: vi.fn(),
  open: vi.fn(),
  load: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { on: mocks.appOn, removeListener: mocks.appRemove },
  BrowserWindow: { getAllWindows: mocks.windows },
}));
vi.mock("electron-updater", () => ({}));
vi.mock("ffi-rs", () => ({ DataType: { U32: 1, U8Array: 2 }, open: mocks.open, load: mocks.load }));
vi.mock("@t3tools/shared/distribution", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/distribution")>()),
  isLanDistribution: true,
}));

interface Received {
  readonly socket: NodeNet.Socket;
  readonly body: Record<string, unknown>;
}

const fixture = Effect.fn("DesktopNativeUpdateCloseTest.fixture")(function* (
  prevented?: "close" | "unload" | "unload-allowed",
  options: {
    readonly captureBusy?: boolean;
    readonly dropAbort?: boolean;
    readonly environmentId?: string;
    readonly rendererDelay?: Promise<void>;
  } = {},
) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-close-test-"))),
    (directory) =>
      Effect.promise(async () => {
        assert.strictEqual(NodePath.dirname(directory), NodePath.resolve(NodeOS.tmpdir()));
        assert.isTrue(NodePath.basename(directory).startsWith("t3-native-close-test-"));
        for (const file of ["server-runtime.json", "environment-id"]) {
          await NodeFSP.rm(NodePath.join(directory, file), { force: true });
        }
        await NodeFSP.rmdir(directory);
      }),
  );
  const identity = {
    environmentId: options.environmentId ?? "synthetic-native-close",
    ownerId: NodeCrypto.randomUUID(),
    pid: 4242,
  };
  yield* Effect.promise(() =>
    Promise.all([
      NodeFSP.writeFile(
        NodePath.join(root, "server-runtime.json"),
        JSON.stringify({ version: 1, ...identity }),
      ),
      NodeFSP.writeFile(NodePath.join(root, "environment-id"), identity.environmentId),
    ]),
  );
  const received = yield* Deferred.make<Received>();
  const aborted = yield* Deferred.make<Received>();
  const disconnected = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const captureChecked = yield* Deferred.make<void>();
  const captureReleased = yield* Deferred.make<void>();
  const rendererStarted = yield* Deferred.make<void>();
  const rendererFinished = yield* Deferred.make<void>();
  const reservationId = "91f02484-6cba-42f8-86ea-4c1f77c7e85b";
  const capture = { held: false, checks: 0, releases: 0 };
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      Deferred.doneUnsafe(disconnected, Effect.void);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const body = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      const message = { socket, body };
      if (body.operation === "abort-close") {
        Deferred.doneUnsafe(aborted, Effect.succeed(message));
        if (options.dropAbort) socket.destroy();
        else socket.write(JSON.stringify({ ...body, status: "cancelled" }) + "\n");
      } else Deferred.doneUnsafe(received, Effect.succeed(message));
    });
  });
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(nativeUpdatePipePath(identity.ownerId), () => {
            server.off("error", reject);
            resolve();
          });
        }),
    ),
    () =>
      Effect.promise(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
  let nativeMessage: ((wParam: Buffer, lParam: Buffer) => void) | undefined;
  const localReady = vi.fn<(environmentId: string, reservationId: string) => unknown>(() => true);
  const renderer: { __t3NativeUpdateReady: typeof localReady | undefined } = {
    __t3NativeUpdateReady: localReady,
  };
  const executions: Promise<unknown>[] = [];
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScript: vi.fn((script: string): Promise<unknown> => {
      const execution = (async (): Promise<unknown> => {
        Deferred.doneUnsafe(rendererStarted, Effect.void);
        try {
          if (options.rendererDelay !== undefined) await options.rendererDelay;
          return NodeVM.runInNewContext(script, { window: renderer });
        } finally {
          Deferred.doneUnsafe(rendererFinished, Effect.void);
        }
      })();
      executions.push(execution);
      return execution;
    }),
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents,
    hookWindowMessage: vi.fn(
      (_message: number, callback: (wParam: Buffer, lParam: Buffer) => void) => {
        nativeMessage = callback;
      },
    ),
    unhookWindowMessage: vi.fn(),
    close: vi.fn(() => {
      window.emit("close", { defaultPrevented: prevented === "close" });
      if (prevented === "unload" || prevented === "unload-allowed")
        contents.emit("will-prevent-unload", { defaultPrevented: prevented === "unload-allowed" });
      queueMicrotask(() => Deferred.doneUnsafe(closed, Effect.void));
    }),
  });
  const browserWindow = window as unknown as Electron.BrowserWindow;
  mocks.windows.mockReset().mockReturnValue([browserWindow]);
  mocks.appOn.mockReset();
  mocks.appRemove.mockReset();
  mocks.open.mockReset();
  mocks.load.mockReset().mockReturnValue(0xc123);
  let backendPid = identity.pid;
  let wslEnabled = false;
  const primary: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Synthetic Windows backend"),
    start: Effect.die("Unexpected backend start"),
    stop: () => Effect.die("Unexpected backend stop"),
    currentConfig: Effect.succeedSome({} as DesktopBackendManager.DesktopBackendStartConfig),
    snapshot: Effect.sync(() => ({
      ready: true,
      desiredRunning: true,
      activePid: Option.some(backendPid),
      restartAttempt: 0,
      restartScheduled: false,
    })),
    waitForReady: () => Effect.succeed(true),
  };
  const environment: NodeJS.ProcessEnv = { T3CODE_NATIVE_UPDATE_CLOSE_PARENT_PID: "stale-parent" };
  yield* DesktopNativeUpdateClose.listen().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "win32",
          processArch: "x64",
          stateDir: root,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.mock(DesktopBackendPool.DesktopBackendPool)({
          list: Effect.succeed([primary]),
          primary: Effect.succeed(primary),
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Effect.succeedSome(browserWindow),
        }),
        Layer.mock(DesktopAppSettings.DesktopAppSettings)({
          get: Effect.sync(() => ({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            wslBackendEnabled: wslEnabled,
          })),
        }),
        Layer.mock(DesktopSnapShot.DesktopSnapShot)({
          reserveNativeUpdateClose: Effect.sync(() => {
            capture.checks++;
            Deferred.doneUnsafe(captureChecked, Effect.void);
            if (options.captureBusy || capture.held) return Option.none();
            capture.held = true;
            return Option.some({
              release: Effect.sync(() => {
                capture.held = false;
                capture.releases++;
                Deferred.doneUnsafe(captureReleased, Effect.void);
              }),
            });
          }),
        }),
        Layer.succeed(HostProcess.Environment, environment),
      ),
    ),
  );
  assert.isDefined(nativeMessage);
  assert.strictEqual(environment.T3CODE_NATIVE_UPDATE_CLOSE_PARENT_PID, String(process.pid));
  const token = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  return {
    window,
    received,
    aborted,
    disconnected,
    closed,
    environment,
    capture,
    captureChecked,
    captureReleased,
    identity,
    reservationId,
    renderer,
    localReady,
    rendererStarted,
    rendererFinished,
    executions,
    send: () => nativeMessage!(token.subarray(0, 8), token.subarray(8)),
    reply: (message: Received, override: Record<string, unknown> = {}) =>
      message.socket.write(
        JSON.stringify({ ...message.body, status: "closing", reservationId, ...override }) + "\n",
      ),
    changeBackend: () => {
      backendPid++;
    },
    enableWsl: () => {
      wslEnabled = true;
    },
  };
});

if (Context.get(Context.empty(), HostProcess.Platform) === "win32") {
  describe("DesktopNativeUpdateClose", () => {
    it.live("uses the normal window close after a matching consume acknowledgement", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          f.send();
          const message = yield* Deferred.await(f.received);
          assert.strictEqual(message.body.operation, "consume-close");
          assert.strictEqual(message.body.desktopPid, process.pid);
          assert.strictEqual(message.body.closeToken, "00112233445566778899aabbccddeeff");
          assert.strictEqual(f.window.close.mock.calls.length, 0);
          f.reply(message);
          yield* Deferred.await(f.closed);
          assert.strictEqual(f.window.close.mock.calls.length, 1);
          assert.isFalse(yield* Deferred.isDone(f.aborted));
          assert.isTrue(f.capture.held);
          assert.strictEqual(f.capture.releases, 0);
          assert.deepStrictEqual(f.localReady.mock.calls, [
            [f.identity.environmentId, f.reservationId],
          ]);
        }),
      ),
    );

    it.live.each([
      { status: "deferred" },
      { nonce: "00".repeat(32) },
      { operation: "commit" },
      { pid: 5252 },
      { reservationId: undefined },
      { reservationId: "invalid-reservation" },
      { reservationId: 123 },
    ])("does not close for a stale or invalid acknowledgement %j", (reply) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          f.send();
          const message = yield* Deferred.await(f.received);
          f.reply(message, reply);
          yield* Deferred.await(f.disconnected);
          assert.strictEqual(f.window.close.mock.calls.length, 0);
          assert.strictEqual(f.window.webContents.executeJavaScript.mock.calls.length, 0);
          if ("status" in reply && reply.status === "deferred") {
            yield* Deferred.await(f.captureReleased);
            assert.isFalse(f.capture.held);
            assert.strictEqual(f.capture.releases, 1);
          } else {
            assert.isTrue(f.capture.held);
            assert.strictEqual(f.capture.releases, 0);
            f.send();
            assert.strictEqual(f.capture.checks, 1);
          }
        }),
      ),
    );

    it.live(
      "evaluates renderer readiness with the exact escaped environment and reservation IDs",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const environmentId = 'synthetic "renderer"\nC:\\reservation\\';
            const f = yield* fixture(undefined, { environmentId });
            f.localReady.mockImplementation(
              (environment, reservation) =>
                environment === environmentId && reservation === f.reservationId,
            );
            f.send();
            const message = yield* Deferred.await(f.received);
            f.reply(message);
            yield* Deferred.await(f.closed);
            assert.deepStrictEqual(f.localReady.mock.calls, [[environmentId, f.reservationId]]);
            assert.strictEqual(f.window.webContents.executeJavaScript.mock.calls.length, 1);
            assert.strictEqual(f.window.close.mock.calls.length, 1);
          }),
        ),
    );

    it.live.each(["false", "missing", "throw", "truthy", "promise"] as const)(
      "aborts despite server readiness when local renderer readiness is %s",
      (outcome) =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            if (outcome === "missing") f.renderer.__t3NativeUpdateReady = undefined;
            else if (outcome === "throw")
              f.localReady.mockImplementation(() => {
                throw new Error("Synthetic renderer failure");
              });
            else
              f.localReady.mockReturnValue(
                outcome === "truthy"
                  ? "yes"
                  : outcome === "promise"
                    ? Promise.resolve(true)
                    : false,
              );
            f.send();
            const message = yield* Deferred.await(f.received);
            f.reply(message);
            const abort = yield* Deferred.await(f.aborted);
            yield* Deferred.await(f.captureReleased);
            assert.strictEqual(abort.socket, message.socket);
            assert.strictEqual(f.window.close.mock.calls.length, 0);
            assert.isFalse(f.capture.held);
            assert.strictEqual(f.capture.releases, 1);
          }),
        ),
    );

    it.live("does not close when renderer execution becomes true after its deadline", () => {
      const delay = Promise.withResolvers<void>();
      return Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(undefined, { rendererDelay: delay.promise });
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            }),
            () =>
              Effect.sync(() => {
                vi.useRealTimers();
              }),
          );
          f.send();
          const message = yield* Deferred.await(f.received);
          f.reply(message);
          yield* Deferred.await(f.rendererStarted);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(NATIVE_UPDATE_PREPARE_MS + 1));
          yield* Deferred.await(f.aborted);
          yield* Deferred.await(f.captureReleased);
          delay.resolve();
          assert.strictEqual(yield* Effect.promise(() => f.executions[0]!), true);
          assert.strictEqual(f.localReady.mock.calls.length, 1);
          assert.strictEqual(f.window.close.mock.calls.length, 0);
          assert.isFalse(f.capture.held);
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => delay.resolve())));
    });

    it.live(
      "retains the capture fence when local renderer refusal loses its abort acknowledgement",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(undefined, { dropAbort: true });
            f.localReady.mockReturnValue(false);
            f.send();
            const message = yield* Deferred.await(f.received);
            f.reply(message);
            yield* Deferred.await(f.aborted);
            yield* Deferred.await(f.disconnected);
            assert.strictEqual(f.window.close.mock.calls.length, 0);
            assert.isTrue(f.capture.held);
            assert.strictEqual(f.capture.releases, 0);
            f.send();
            assert.strictEqual(f.capture.checks, 1);
          }),
        ),
    );

    it.live("does not close when the consume acknowledgement is lost", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          f.send();
          const message = yield* Deferred.await(f.received);
          message.socket.destroy();
          yield* Deferred.await(f.disconnected);
          assert.strictEqual(f.window.close.mock.calls.length, 0);
          assert.isTrue(f.capture.held);
          assert.strictEqual(f.capture.releases, 0);
        }),
      ),
    );

    it.live("ignores an acknowledgement arriving after the bounded request deadline", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            }),
            () =>
              Effect.sync(() => {
                vi.useRealTimers();
              }),
          );
          f.send();
          const message = yield* Deferred.await(f.received);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(NATIVE_UPDATE_PREPARE_MS + 1));
          yield* Deferred.await(f.disconnected);
          f.reply(message);
          assert.strictEqual(f.window.close.mock.calls.length, 0);
          assert.isTrue(f.capture.held);
          assert.strictEqual(f.capture.releases, 0);
        }),
      ),
    );

    it.live.each(["close", "unload"] as const)(
      "aborts a prevented %s on the same authenticated connection",
      (prevented) =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(prevented);
            f.send();
            const message = yield* Deferred.await(f.received);
            f.reply(message);
            const abort = yield* Deferred.await(f.aborted);
            assert.strictEqual(f.window.close.mock.calls.length, 1);
            assert.strictEqual(abort.socket, message.socket);
            assert.strictEqual(abort.body.closeToken, message.body.closeToken);
            assert.strictEqual(abort.body.nonce, message.body.nonce);
            yield* Deferred.await(f.captureReleased);
            assert.isFalse(f.capture.held);
            assert.strictEqual(f.capture.releases, 1);
          }),
        ),
    );

    it.live.each(["backend", "settings"] as const)(
      "aborts if %s changes while consume is pending",
      (changed) =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            f.send();
            const message = yield* Deferred.await(f.received);
            if (changed === "backend") f.changeBackend();
            else f.enableWsl();
            f.reply(message);
            yield* Deferred.await(f.aborted);
            yield* Deferred.await(f.captureReleased);
            assert.strictEqual(f.window.close.mock.calls.length, 0);
            assert.isFalse(f.capture.held);
          }),
        ),
    );

    it.live("allows an unload that Electron's event handler explicitly unblocks", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture("unload-allowed");
          f.send();
          const message = yield* Deferred.await(f.received);
          f.reply(message);
          yield* Deferred.await(f.closed);
          assert.strictEqual(f.window.close.mock.calls.length, 1);
          assert.isFalse(yield* Deferred.isDone(f.aborted));
        }),
      ),
    );

    it.live("leaves an ordinary manual window close outside the update protocol", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          assert.strictEqual(f.window.listenerCount("close"), 0);
          f.window.close();
          assert.strictEqual(f.window.close.mock.calls.length, 1);
          assert.isFalse(yield* Deferred.isDone(f.received));
          assert.strictEqual(f.capture.checks, 0);
        }),
      ),
    );

    it.live("does not consume or close while the snapshot service has pending capture work", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(undefined, { captureBusy: true });
          f.send();
          yield* Deferred.await(f.captureChecked);
          assert.strictEqual(f.window.close.mock.calls.length, 0);
          assert.isFalse(yield* Deferred.isDone(f.received));
          assert.isFalse(f.capture.held);
          assert.strictEqual(f.capture.releases, 0);
        }),
      ),
    );

    it.live("keeps the snapshot lease when a prevented close loses its abort acknowledgement", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture("close", { dropAbort: true });
          f.send();
          const message = yield* Deferred.await(f.received);
          f.reply(message);
          yield* Deferred.await(f.aborted);
          yield* Deferred.await(f.disconnected);
          assert.strictEqual(f.window.close.mock.calls.length, 1);
          assert.isTrue(f.capture.held);
          assert.strictEqual(f.capture.releases, 0);
          f.send();
          assert.strictEqual(f.capture.checks, 1);
        }),
      ),
    );
  });
}
