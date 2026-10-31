// @effect-diagnostics globalTimers:off -- Native process-group teardown stays bounded independently of the Effect clock, matching the platform spawner.
// @effect-diagnostics nodeBuiltinImport:off -- This owned spawn bridge exposes the native stdin callback hidden by ChildProcessHandle.stdin.
import * as NodeChildProcess from "node:child_process";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import type { StandardCommand } from "effect/process/ChildProcess";
import * as Client from "./client.ts";
import * as CodexError from "./errors.ts";
import { makeAcknowledgedWriter, makeStderrTail } from "./_internal/stdio.ts";

const signalProcessTree = (
  child: NodeChildProcess.ChildProcess,
  command: StandardCommand,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
  done: () => void = () => {},
) => {
  // A dead leader's PID can be reused; only a detached POSIX group remains ours to signal.
  if (
    child.pid === undefined ||
    ((platform === "win32" || command.options.detached === false) &&
      (child.exitCode !== null || child.signalCode !== null))
  ) {
    done();
    return;
  }
  if (platform === "win32") {
    NodeChildProcess.execFile(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 5_000 },
      (error) => {
        if (error && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* The process can exit before fallback. */
          }
        }
        done();
      },
    );
    return;
  }
  try {
    process.kill(command.options.detached === false ? child.pid : -child.pid, signal);
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    try {
      child.kill(signal);
    } catch {
      /* The process group can disappear before cleanup. */
    }
  }
  done();
};

const terminateProcessTree = Effect.fn("CodexNativeProcess.terminateTree")(
  (child: NodeChildProcess.ChildProcess, command: StandardCommand, platform: NodeJS.Platform) =>
    Effect.callback<void>((resume) => {
      if (child.pid === undefined) {
        resume(Effect.void);
        return;
      }
      let settled = false;
      let pollTimer: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;
      const alive = () => {
        if (child.exitCode === null && child.signalCode === null) return true;
        if (platform === "win32" || command.options.detached === false) return false;
        try {
          process.kill(-child.pid!, 0);
          return true;
        } catch {
          return false;
        }
      };
      const stop = () => {
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        child.removeListener("exit", poll);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        stop();
        resume(Effect.void);
      };
      const poll = () => {
        clearTimeout(pollTimer);
        if (settled) return;
        if (!alive()) {
          finish();
          return;
        }
        // Native process-group cleanup has the same bounded native-time wait as the platform spawner.
        pollTimer = setTimeout(poll, 10);
      };
      signalProcessTree(child, command, platform, command.options.killSignal ?? "SIGTERM", () => {
        if (settled) return;
        const forceAfter = command.options.forceKillAfter;
        deadline = setTimeout(
          () => {
            if (forceAfter === undefined || !alive()) {
              finish();
              return;
            }
            signalProcessTree(child, command, platform, "SIGKILL", () => {
              deadline = setTimeout(finish, 1_000);
              poll();
            });
          },
          forceAfter === undefined ? 1_000 : Duration.toMillis(forceAfter),
        );
        child.on("exit", poll);
        poll();
      });
      return Effect.sync(() => {
        settled = true;
        stop();
      });
    }),
);

export const makeNodeClient = Effect.fn("CodexNativeProcess.open")(function* (
  command: StandardCommand,
  options: Client.CodexAppServerClientOptions & {
    readonly platform: NodeJS.Platform;
    readonly onSpawn?: (pid: number) => Effect.Effect<void>;
  },
) {
  const platform = options.platform;
  const exited = yield* Deferred.make<{ code: number | null }>();
  const child = yield* Effect.acquireRelease(
    Effect.callback<
      NodeChildProcess.ChildProcessWithoutNullStreams,
      CodexError.CodexAppServerSpawnError
    >((resume) => {
      const env =
        command.options.env === undefined
          ? process.env
          : command.options.extendEnv === true
            ? { ...process.env, ...command.options.env }
            : command.options.env;
      const child = NodeChildProcess.spawn(command.command, [...command.args], {
        ...(command.options.cwd === undefined ? {} : { cwd: command.options.cwd }),
        env,
        windowsHide: command.options.windowsHide ?? true,
        detached: command.options.detached ?? platform !== "win32",
        shell: command.options.shell ?? false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", (cause) =>
        resume(
          Effect.fail(new CodexError.CodexAppServerSpawnError({ command: command.command, cause })),
        ),
      );
      child.once("exit", (code) => {
        if (code !== null && code !== 0)
          signalProcessTree(child, command, platform, command.options.killSignal ?? "SIGTERM");
        Deferred.doneUnsafe(exited, Effect.succeed({ code }));
      });
      child.once("spawn", () => resume(Effect.succeed(child)));
      return terminateProcessTree(child, command, platform);
    }),
    (child) =>
      Effect.sync(() => child.stdin.destroy()).pipe(
        Effect.andThen(terminateProcessTree(child, command, platform)),
      ),
  );
  if (child.pid !== undefined && options.onSpawn !== undefined) yield* options.onSpawn(child.pid);
  const streamError = (cause: unknown) =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "CodexNativeProcess",
      method: "read",
      cause,
    });
  const tail = yield* makeStderrTail(
    Stream.fromAsyncIterable<Uint8Array, PlatformError.PlatformError>(child.stderr, streamError),
  );
  const writer = yield* makeAcknowledgedWriter(child.stdin);
  return yield* Client.make(
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromAsyncIterable<Uint8Array, PlatformError.PlatformError>(
        child.stdout,
        streamError,
      ),
      stdout: () => Sink.drain,
      stderr: () => Sink.drain,
    }),
    { ...options, acknowledgedWriter: writer },
    Deferred.await(exited).pipe(
      Effect.flatMap(({ code }) =>
        tail.read.pipe(
          Effect.map(
            (stderr) =>
              new CodexError.CodexAppServerProcessExitedError({
                ...(code === null ? {} : { code }),
                ...(child.pid === undefined ? {} : { pid: child.pid }),
                ...(stderr.length === 0 ? {} : { stderr }),
              }),
          ),
        ),
      ),
    ),
  );
});
