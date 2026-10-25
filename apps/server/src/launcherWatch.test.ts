// @effect-diagnostics nodeBuiltinImport:off - Real Node pipe events exercise the private desktop lifetime channel.
import { assert, it } from "@effect/vitest";
import * as NodeStream from "node:stream";
import { DESKTOP_BACKEND_SHUTDOWN_COMMAND } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitDesktopShutdown, awaitLauncherLoss } from "./launcherWatch.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("notices a launcher that was already gone when the watch began", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, "linux"));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
  }),
);

const subscribedShutdown = Effect.gen(function* () {
  const input = new NodeStream.PassThrough();
  const ready = yield* Deferred.make<void>();
  input.once("resume", () => {
    Deferred.doneUnsafe(ready, Effect.void);
  });
  const watched = yield* awaitDesktopShutdown(input).pipe(Effect.result, Effect.forkChild);
  yield* Deferred.await(ready);
  return { input, watched };
});

it.effect("accepts a complete private desktop shutdown request across input chunks", () =>
  Effect.gen(function* () {
    const { input, watched } = yield* subscribedShutdown;
    input.write(DESKTOP_BACKEND_SHUTDOWN_COMMAND.slice(0, 7));
    input.end(DESKTOP_BACKEND_SHUTDOWN_COMMAND.slice(7));
    const result = yield* Fiber.join(watched);
    assert.equal(result._tag, "Success");
  }),
);

it.effect.each(["closed", "invalid_command", "read"] as const)(
  "does not report a desktop shutdown request for channel failure: %s",
  (reason) =>
    Effect.gen(function* () {
      const { input, watched } = yield* subscribedShutdown;
      if (reason === "closed") input.end("t3-desktop");
      else if (reason === "invalid_command") input.end("unexpected request\n");
      else input.destroy(new Error("synthetic input failure"));
      const result = yield* Fiber.join(watched);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, reason);
      input.destroy();
    }),
);
