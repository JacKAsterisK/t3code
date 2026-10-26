// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This native callback adapter owns the bounded Windows close-message and pipe boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Electron from "electron";

import { isLanDistribution } from "@t3tools/shared/distribution";
import {
  isNativeUpdateOwnerId,
  NATIVE_UPDATE_CLOSE_MESSAGE,
  NATIVE_UPDATE_MAX_LINE_BYTES,
  NATIVE_UPDATE_PREPARE_MS,
  nativeUpdatePipePath,
  nativeUpdateTokenFromMessage,
  type NativeUpdateIdentity,
} from "@t3tools/shared/nativeUpdateControl";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";

class NativeUpdateCloseRefused extends Error {}

async function readBoundedFile(path: string): Promise<string> {
  const stat = await NodeFSP.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NATIVE_UPDATE_MAX_LINE_BYTES)
    throw new Error("Invalid update owner record.");
  const file = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.alloc(NATIVE_UPDATE_MAX_LINE_BYTES + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > NATIVE_UPDATE_MAX_LINE_BYTES) throw new Error("Invalid update owner record.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function readIdentity(stateDir: string, expectedPid: number): Promise<NativeUpdateIdentity> {
  const [runtimeText, environmentText] = await Promise.all([
    readBoundedFile(NodePath.join(stateDir, "server-runtime.json")),
    readBoundedFile(NodePath.join(stateDir, "environment-id")),
  ]);
  const runtime: unknown = JSON.parse(runtimeText);
  if (typeof runtime !== "object" || runtime === null) throw new Error("Invalid update owner.");
  const record = runtime as Record<string, unknown>;
  const environmentId = environmentText.trim();
  if (
    record.version !== 1 ||
    record.pid !== expectedPid ||
    !isNativeUpdateOwnerId(record.ownerId) ||
    environmentId.length === 0 ||
    environmentId.length > 200
  )
    throw new Error("Invalid update owner.");
  return { environmentId, ownerId: record.ownerId, pid: expectedPid };
}

async function consumeClose(identity: NativeUpdateIdentity, closeToken: string) {
  const socket = NodeNet.createConnection(nativeUpdatePipePath(identity.ownerId));
  const nonce = NodeCrypto.randomBytes(32).toString("hex");
  const request = (operation: "consume-close" | "abort-close", expectedStatus: string) =>
    new Promise<string>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const finish = (error?: Error, reservationId = "") => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (error !== undefined) reject(error);
        else resolve(reservationId);
      };
      const onError = () => finish(new Error("Update close unavailable."));
      const onClose = () => finish(new Error("Update close disconnected."));
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > NATIVE_UPDATE_MAX_LINE_BYTES) {
          onError();
          return;
        }
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        try {
          const reply = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<
            string,
            unknown
          >;
          if (
            newline !== buffer.length - 1 ||
            reply.schemaVersion !== 1 ||
            reply.operation !== operation ||
            reply.nonce !== nonce ||
            reply.environmentId !== identity.environmentId ||
            reply.ownerId !== identity.ownerId ||
            reply.pid !== identity.pid
          ) {
            onError();
            return;
          }
          if (reply.status === "deferred") {
            finish(new NativeUpdateCloseRefused("Update close deferred."));
            return;
          }
          if (
            reply.status !== expectedStatus ||
            (operation === "consume-close" && !isNativeUpdateOwnerId(reply.reservationId))
          ) {
            onError();
            return;
          }
          finish(undefined, typeof reply.reservationId === "string" ? reply.reservationId : "");
        } catch {
          onError();
        }
      };
      const timer = setTimeout(onError, NATIVE_UPDATE_PREPARE_MS);
      timer.unref();
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.write(
        JSON.stringify({
          schemaVersion: 1,
          operation,
          ...identity,
          nonce,
          desktopPid: process.pid,
          closeToken,
        }) + "\n",
      );
    });
  socket.on("error", () => socket.destroy());
  let reservationId: string;
  try {
    reservationId = await request("consume-close", "closing");
  } catch (cause) {
    socket.destroy();
    throw cause;
  }
  return {
    reservationId,
    abort: async () => {
      try {
        await request("abort-close", "cancelled");
      } finally {
        socket.destroy();
      }
    },
    dispose: () => socket.destroy(),
  };
}

async function localRendererReady(
  contents: Electron.WebContents,
  identity: NativeUpdateIdentity,
  reservationId: string,
): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  const script = `typeof window.__t3NativeUpdateReady === "function" && window.__t3NativeUpdateReady(${JSON.stringify(identity.environmentId)}, ${JSON.stringify(reservationId)}) === true`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), NATIVE_UPDATE_PREPARE_MS);
    timer.unref();
    void Promise.resolve()
      .then(() => contents.executeJavaScript(script, false))
      .then(
        (ready: unknown) => finish(ready === true),
        () => finish(false),
      );
  });
}

export const listen = Effect.fn("DesktopNativeUpdateClose.listen")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const processEnvironment = yield* HostProcess.Environment;
  delete processEnvironment.T3CODE_NATIVE_UPDATE_CLOSE_PARENT_PID;
  if (!isLanDistribution || environment.platform !== "win32" || environment.processArch !== "x64")
    return;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const initialSettings = yield* settings.get;
  if (initialSettings.wslBackendEnabled || initialSettings.wslOnly) return;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const message = yield* Effect.tryPromise(async () => {
    const { DataType, load, open: openLibrary } = await import("ffi-rs");
    const library = "t3-native-update-user32";
    openLibrary({ library, path: "user32.dll" });
    const result = load({
      library,
      funcName: "RegisterWindowMessageW",
      retType: DataType.U32,
      paramsType: [DataType.U8Array],
      paramsValue: [Buffer.from(NATIVE_UPDATE_CLOSE_MESSAGE + "\0", "utf16le")],
    });
    if (typeof result !== "number" || result < 0xc000 || result > 0xffff)
      throw new Error("Update close message unavailable.");
    return result;
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (message === undefined) return;
  let closing = false;
  const hooks = new Set<Electron.BrowserWindow>();
  const connections = new Set<Awaited<ReturnType<typeof consumeClose>>>();
  const readyDesktop = Effect.fn("DesktopNativeUpdateClose.readyDesktop")(function* (
    window: Electron.BrowserWindow,
  ) {
    const main = yield* electronWindow.main;
    const currentSettings = yield* settings.get;
    if (
      window.isDestroyed() ||
      Option.isNone(main) ||
      main.value !== window ||
      Electron.BrowserWindow.getAllWindows().length !== 1 ||
      currentSettings.wslBackendEnabled ||
      currentSettings.wslOnly
    )
      return undefined;
    const instances = yield* pool.list;
    const primary = yield* pool.primary;
    for (const instance of instances) {
      const state = yield* instance.snapshot;
      if (instance.id !== primary.id && (state.desiredRunning || Option.isSome(state.activePid)))
        return undefined;
    }
    const config = yield* primary.currentConfig;
    const state = yield* primary.snapshot;
    return Option.isNone(config) ||
      config.value.runningDistro !== undefined ||
      !state.ready ||
      Option.isNone(state.activePid)
      ? undefined
      : state.activePid.value;
  });
  const hook = (window: Electron.BrowserWindow) => {
    hooks.add(window);
    window.hookWindowMessage(message, (wParam, lParam) => {
      const token = nativeUpdateTokenFromMessage(wParam, lParam);
      if (token === undefined || closing) return;
      closing = true;
      let releaseCapture: Effect.Effect<void> | undefined;
      let consumeAttempted = false;
      void (async () => {
        const pid = await run(readyDesktop(window));
        if (pid === undefined) {
          closing = false;
          return;
        }
        const identity = await readIdentity(environment.stateDir, pid);
        const captureReservation = await run(snapShot.reserveNativeUpdateClose);
        if (Option.isNone(captureReservation)) {
          closing = false;
          return;
        }
        releaseCapture = captureReservation.value.release;
        consumeAttempted = true;
        const connection = await consumeClose(identity, token);
        connections.add(connection);
        let aborted = false;
        const abort = () => {
          if (aborted) return;
          aborted = true;
          window.removeListener("close", onClose);
          if (!window.webContents.isDestroyed())
            window.webContents.removeListener("will-prevent-unload", onPreventUnload);
          void connection
            .abort()
            .then(async () => {
              if (releaseCapture !== undefined) await run(releaseCapture);
              releaseCapture = undefined;
              closing = false;
            })
            .catch(() => undefined)
            .finally(() => {
              connections.delete(connection);
            });
        };
        const onClose = (event: Electron.Event) => {
          queueMicrotask(() => {
            if (event.defaultPrevented && !window.isDestroyed()) abort();
          });
        };
        const onPreventUnload = (event: Electron.Event) => {
          queueMicrotask(() => {
            if (!event.defaultPrevented && !window.isDestroyed()) abort();
          });
        };
        if (window.isDestroyed()) return;
        if (!(await localRendererReady(window.webContents, identity, connection.reservationId))) {
          abort();
          return;
        }
        let currentPid: number | undefined;
        try {
          currentPid = runSync(readyDesktop(window));
        } catch {
          abort();
          return;
        }
        if (currentPid !== pid) {
          abort();
          return;
        }
        window.on("close", onClose);
        window.webContents.once("will-prevent-unload", onPreventUnload);
        window.close();
      })().catch(async (cause) => {
        if (!consumeAttempted || cause instanceof NativeUpdateCloseRefused) {
          if (releaseCapture !== undefined) await run(releaseCapture);
          releaseCapture = undefined;
          closing = false;
        }
      });
    });
    window.once("closed", () => hooks.delete(window));
  };
  const onCreated = (_event: Electron.Event, window: Electron.BrowserWindow) => hook(window);
  Electron.app.on("browser-window-created", onCreated);
  processEnvironment.T3CODE_NATIVE_UPDATE_CLOSE_PARENT_PID = String(process.pid);
  for (const window of Electron.BrowserWindow.getAllWindows()) hook(window);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      delete processEnvironment.T3CODE_NATIVE_UPDATE_CLOSE_PARENT_PID;
      Electron.app.removeListener("browser-window-created", onCreated);
      for (const window of hooks) if (!window.isDestroyed()) window.unhookWindowMessage(message);
      for (const connection of connections) connection.dispose();
    }),
  );
});
