import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Gate from "./auth/ApprovalAdmissionGate.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Config from "./config.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";

it.effect(
  "settings file I/O progresses outside admission, but Labs publication waits for the shared gate without a snapshot lock inversion",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const read = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let observeReads = false;
      const observedFs: FileSystem.FileSystem = {
        ...fs,
        readFileString: (path, encoding) =>
          fs
            .readFileString(path, encoding)
            .pipe(
              Effect.tap(() =>
                observeReads && path === config.settingsPath
                  ? Deferred.succeed(read, undefined)
                  : Effect.void,
              ),
            ),
      };
      const context = yield* Settings.layer.pipe(
        Layer.provide(Secrets.layer),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFs)),
        Layer.build,
      );
      const settings = Context.get(context, Settings.ServerSettingsService);
      const gate = Context.get(context, Gate.ApprovalAdmissionGate);
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true, agentEventsEnabled: true });
      const previous = yield* settings.getAdmissionSettings!;
      observeReads = true;
      const holding = yield* gate
        .withGate(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const mutation = yield* settings
        .updateSettings({ agentEventsEnabled: false })
        .pipe(Effect.forkChild);
      yield* Deferred.await(read);
      assert.deepEqual(yield* settings.getAdmissionSettings!, previous);
      assert.isUndefined(mutation.pollUnsafe());
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holding);
      yield* Fiber.join(mutation);
      const current = yield* settings.getAdmissionSettings!;
      assert.isFalse(current.agentEventsEnabled);
      assert.isAbove(current.generation, previous.generation);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(Gate.layer, Sqlite.layerMemory).pipe(
          Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-settings-admission-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
