// @effect-diagnostics nodeBuiltinImport:off - The native desktop lifetime reader owns inherited Node stdin.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DESKTOP_BACKEND_SHUTDOWN_COMMAND } from "@t3tools/contracts";
import type * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// Capture before config and bootstrap reads to detect launcher loss during startup.
const startupParentPid = process.ppid;

/**
 * Any parent change signals launcher loss, including adoption by a Linux subreaper;
 * otherwise an orphan backend keeps its ownership lock and blocks replacement launches.
 * Skip init-launched backends and Windows, which retains the exited parent's id.
 */
export const awaitLauncherLoss = Effect.fn("launcherWatch.awaitLauncherLoss")(function* (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly interval?: Duration.Input;
}): Effect.fn.Return<void> {
  const platform = yield* HostProcess.Platform;
  const launcherPid = options?.launcherPid ?? startupParentPid;
  const getParentPid = options?.getParentPid ?? (() => process.ppid);
  const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
  if (platform === "win32" || launcherPid <= 1) return yield* Effect.never;
  const poll: Effect.Effect<void> = Effect.suspend(() => {
    const parentPid = getParentPid();
    return parentPid === launcherPid
      ? Effect.flatMap(Effect.sleep(interval), () => poll)
      : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
          launcherPid,
          parentPid,
        });
  });
  return yield* poll;
});

export class DesktopShutdownChannelError extends Schema.TaggedError<DesktopShutdownChannelError>()(
  "DesktopShutdownChannelError",
  {
    reason: Schema.Literals(["closed", "invalid_command", "read"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** An opted-in native desktop owns stdin; only its private command is a graceful request. */
export const awaitDesktopShutdown = Effect.fn("launcherWatch.awaitDesktopShutdown")(
  (input: NodeStream.Readable = process.stdin) =>
    Effect.callback<void, DesktopShutdownChannelError>((resume) => {
      let pending = "",
        settled = false;
      const detach = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("close", onEnd);
        input.off("error", onError);
        input.pause();
      };
      const finish = (effect: Effect.Effect<void, DesktopShutdownChannelError>) => {
        if (settled) return;
        settled = true;
        detach();
        resume(effect);
      };
      const onData = (chunk: Buffer | string) => {
        pending += String(chunk);
        if (
          pending.length > DESKTOP_BACKEND_SHUTDOWN_COMMAND.length ||
          !DESKTOP_BACKEND_SHUTDOWN_COMMAND.startsWith(pending)
        ) {
          finish(Effect.fail(new DesktopShutdownChannelError({ reason: "invalid_command" })));
        } else if (pending === DESKTOP_BACKEND_SHUTDOWN_COMMAND) finish(Effect.void);
      };
      const onEnd = () =>
        finish(Effect.fail(new DesktopShutdownChannelError({ reason: "closed" })));
      const onError = (cause: Error) =>
        finish(Effect.fail(new DesktopShutdownChannelError({ reason: "read", cause })));
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("close", onEnd);
      input.once("error", onError);
      if (input.readableEnded || input.destroyed) onEnd();
      else input.resume();
      return Effect.sync(detach);
    }),
);
