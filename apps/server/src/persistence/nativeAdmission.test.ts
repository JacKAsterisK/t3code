// @effect-diagnostics nodeBuiltinImport:off -- These boundary tests preserve isolated on-disk data across refused startup and maintenance.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { NativeAdmissionError } from "@t3tools/shared/nativeAdmission";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";

it.layer(NodeServices.layer)("native admission boundaries", (it) => {
  it.effect(
    "blocks database import, identity, secrets and ownership before their first write",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-admission-boundary-" });
        const context = yield* Layer.build(ServerConfig.layerTest(root, root));
        const config = Context.get(context, ServerConfig.ServerConfig);
        const legacy = path.join(config.stateDir, "state.sqlite");
        yield* fs.writeFileString(
          legacy,
          "preserve the legacy bytes without opening or migrating them",
        );
        yield* fs.writeFileString(path.join(root, "native-activation.json"), "unresolved");
        const exits = yield* Effect.all([
          SqlClient.SqlClient.pipe(Effect.provide(Sqlite.layerConfig), Effect.exit),
          ServerSecretStore.ServerSecretStore.pipe(
            Effect.provide(ServerSecretStore.layer),
            Effect.exit,
          ),
          ServerEnvironment.ServerEnvironmentIdentity.pipe(
            Effect.provide(ServerEnvironment.layerIdentity),
            Effect.exit,
          ),
          acquireServerOwnership(config.serverRuntimeStatePath).pipe(Effect.exit),
        ]).pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provide(ProcessRunner.layer),
        );
        for (const exit of exits) {
          const observation: Exit.Exit<unknown, unknown> = exit;
          assert.isTrue(Exit.isFailure(observation));
          if (Exit.isFailure(observation))
            assert.instanceOf(Cause.squash(observation.cause), NativeAdmissionError);
        }
        assert.isFalse(yield* fs.exists(config.dbPath));
        assert.isFalse(yield* fs.exists(config.environmentIdPath));
        assert.isFalse(yield* fs.exists(config.secretsDir));
        assert.isFalse(yield* fs.exists(path.join(config.stateDir, "server-owner.sqlite")));
        assert.equal(
          yield* fs.readFileString(legacy),
          "preserve the legacy bytes without opening or migrating them",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("refuses directory preparation before sweeping pending attachments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-admission-sweep-" });
      const paths = yield* ServerConfig.deriveServerPaths(root, undefined);
      yield* fs.makeDirectory(paths.attachmentsDir, { recursive: true });
      const partial = path.join(paths.attachmentsDir, "retained.part");
      yield* fs.writeFileString(partial, "interrupted upload");
      NodeFS.utimesSync(partial, 946684800, 946684800);
      yield* fs.writeFileString(path.join(root, "native-activation.json"), "unresolved");
      const exit = yield* Effect.exit(ServerConfig.ensureServerDirectories(paths));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.instanceOf(Cause.squash(exit.cause), NativeAdmissionError);
      assert.equal(yield* fs.readFileString(partial), "interrupted upload");
      assert.isFalse(yield* fs.exists(paths.worktreesDir));
    }).pipe(Effect.scoped),
  );

  it.effect("blocks direct maintenance writers and leaves both database generations intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-admission-maintenance-" });
      const userdata = path.join(root, "userdata");
      yield* fs.makeDirectory(userdata);
      const current = path.join(userdata, "statev2.sqlite");
      const legacy = path.join(userdata, "state.sqlite");
      yield* fs.writeFileString(current, "preserve current");
      yield* fs.writeFileString(legacy, "preserve legacy");
      yield* fs.writeFileString(path.join(root, "native-activation.json"), "unresolved");
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      assert.equal((yield* Effect.flip(maintenance.compact(current)))._tag, "DatabaseCompactError");
      assert.equal(
        (yield* Effect.flip(maintenance.removeLegacyDatabase(current)))._tag,
        "LegacyDatabaseRemoveError",
      );
      assert.equal(yield* fs.readFileString(current), "preserve current");
      assert.equal(yield* fs.readFileString(legacy), "preserve legacy");
    }).pipe(Effect.scoped, Effect.provide(DatabaseMaintenance.layer)),
  );
});
