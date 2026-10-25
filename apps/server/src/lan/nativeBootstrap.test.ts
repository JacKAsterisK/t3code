// @effect-diagnostics nodeBuiltinImport:off - New temporary independent homes only; no server, HTTP listener, provider, credentials or task is started.
import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { strictJson } from "@t3tools/shared/strictJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NativeMaintenance from "./NativeMaintenance.ts";

const identity: NativeMaintenance.NativeBuildIdentity = {
  appId: "com.example.lanfixture",
  productName: "LAN Fixture",
  protocolScheme: "lan-fixture",
  homeDirectoryName: "T3CodeLAN",
  telemetry: "disabled",
  cloudConfiguration: "disabled",
  nativeUpdater: "disabled",
  protocolVersion: 2,
  applicationVersion: "0.1.2",
  sourceCommit: "a".repeat(40),
};
const layer = NativeMaintenance.layer(identity).pipe(
  Layer.provide(
    Layer.succeed(NativeMaintenance.NativeMaintenanceLease, { verify: () => Effect.void }),
  ),
);
const decodeBootstrapLocation = Schema.decodeUnknownSync(
  Schema.Struct({ stagingDirectory: Schema.String }),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-bootstrap-" });
  const home = path.join(root, "T3CodeLAN", "data");
  yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
  yield* fs.writeFileString(path.join(home, "native-admission.lock"), "");
  yield* fs.writeFileString(path.join(home, "userdata", "server-owner.sqlite"), "");
  const request: NativeMaintenance.NativeMaintenanceRequest = {
    schemaVersion: 1,
    operation: "bootstrap",
    nonce: "b".repeat(64),
    bootstrapId: "c".repeat(64),
    environmentId: "12345678-1234-4234-8234-123456789abc",
    homeDirectory: home,
    journalPath: path.join(root, "T3CodeLAN", "activation.json"),
  };
  yield* fs.writeFileString(request.journalPath, JSON.stringify({ ...request, kind: "bootstrap" }));
  return { request, home, dbPath: path.join(home, "userdata", "statev2.sqlite") };
});

it.layer(NodeServices.layer)("native fresh-home bootstrap", (it) => {
  it.effect(
    "initializes only empty schema and identity, then resumes the same interrupted bootstrap without granting access",
    () =>
      Effect.gen(function* () {
        const { request, home, dbPath } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* NativeMaintenance.NativeMaintenance;
        const first = yield* service.bootstrap(request);
        const second = yield* service.bootstrap(request);
        assert.equal(first.environmentId, request.environmentId);
        assert.equal(second.workGeneration, first.workGeneration);
        assert.equal(second.compiledIdentity.appId, identity.appId);
        assert.deepEqual(
          [
            first.activeRuns,
            first.queuedRuns,
            first.pendingRequests,
            first.backgroundAgents,
            first.scheduledWork,
            first.restartContinuations,
          ],
          [0, 0, 0, 0, 0, 0],
        );
        assert.deepEqual((yield* fs.readDirectory(home)).sort(), [
          "native-admission.lock",
          "native-bootstrap-state.json",
          "userdata",
        ]);
        assert.equal(
          (yield* fs.readFileString(path.join(home, "userdata", "environment-id"))).trim(),
          request.environmentId,
        );
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
          try {
            for (const row of db
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all()) {
              const name = String(row.name);
              if (!["effect_sql_migrations", "orchestration_v2_projection_metadata"].includes(name))
                assert.isUndefined(
                  db.prepare('SELECT 1 FROM "' + name.replaceAll('"', '""') + '" LIMIT 1').get(),
                );
            }
          } finally {
            db.close();
          }
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refuses unknown home contents and mismatched bootstrap journals before creating native identity or database",
    () =>
      Effect.gen(function* () {
        const { request, home, dbPath } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* NativeMaintenance.NativeMaintenance;
        yield* fs.writeFileString(path.join(home, "settings.json"), "preserved existing settings");
        assert.equal((yield* service.bootstrap(request).pipe(Effect.flip)).reason, "identity");
        assert.isFalse(yield* fs.exists(dbPath));
        assert.isFalse(yield* fs.exists(path.join(home, "userdata", "environment-id")));
        yield* fs.remove(path.join(home, "settings.json"));
        assert.equal(
          (yield* service.bootstrap({ ...request, bootstrapId: "d".repeat(64) }).pipe(Effect.flip))
            .reason,
          "identity",
        );
        assert.isFalse(yield* fs.exists(dbPath));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "never uses bootstrap to reset existing accepted data, authentication or an environment identity",
    () =>
      Effect.gen(function* () {
        const { request, home, dbPath } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* NativeMaintenance.NativeMaintenance;
        yield* service.bootstrap(request);
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(dbPath);
          try {
            db.exec(
              "CREATE TABLE unrecognized_owner_data(value TEXT); INSERT INTO unrecognized_owner_data VALUES ('preserve me')",
            );
          } finally {
            db.close();
          }
        });
        const before = yield* fs.readFile(dbPath);
        assert.equal((yield* service.bootstrap(request).pipe(Effect.flip)).reason, "changed");
        assert.deepEqual(yield* fs.readFile(dbPath), before);
        yield* fs.writeFileString(
          path.join(home, "userdata", "environment-id"),
          "other-environment\n",
        );
        assert.equal((yield* service.bootstrap(request).pipe(Effect.flip)).reason, "identity");
        assert.equal(
          yield* fs.readFileString(path.join(home, "userdata", "environment-id")),
          "other-environment\n",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "resumes only its recorded interrupted publication links and refuses an unreceipted database",
    () =>
      Effect.gen(function* () {
        const { request, home, dbPath } = yield* fixture;
        const path = yield* Path.Path;
        const service = yield* NativeMaintenance.NativeMaintenance;
        yield* service.bootstrap(request);
        const receiptPath = path.join(home, "native-bootstrap-state.json");
        const state = decodeBootstrapLocation(strictJson(NodeFS.readFileSync(receiptPath)));
        const stagedReceipt = path.join(state.stagingDirectory, "native-bootstrap-state.json");
        const stagedDatabase = path.join(state.stagingDirectory, "statev2.sqlite");
        NodeFS.linkSync(receiptPath, stagedReceipt);
        NodeFS.linkSync(dbPath, stagedDatabase);
        const resumed = yield* service.bootstrap(request);
        assert.equal(resumed.environmentId, request.environmentId);
        assert.equal(NodeFS.lstatSync(dbPath).nlink, 1);
        assert.equal(NodeFS.lstatSync(receiptPath).nlink, 1);
        assert.isFalse(NodeFS.existsSync(stagedDatabase));
        assert.isFalse(NodeFS.existsSync(stagedReceipt));
        const before = NodeFS.readFileSync(dbPath);
        NodeFS.unlinkSync(receiptPath);
        assert.equal((yield* service.bootstrap(request).pipe(Effect.flip)).reason, "identity");
        assert.deepEqual(NodeFS.readFileSync(dbPath), before);
      }).pipe(Effect.provide(layer)),
  );
});

it.effect(
  "fresh drop-in bootstrap initializes the original .t3 home with its in-home journal and no conversation or grants",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-dropin-bootstrap-" });
      const home = path.join(root, ".t3");
      yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(home, "native-admission.lock"), "");
      yield* fs.writeFileString(path.join(home, "userdata", "server-owner.sqlite"), "");
      const request: NativeMaintenance.NativeMaintenanceRequest = {
        schemaVersion: 1,
        operation: "bootstrap",
        nonce: "f".repeat(64),
        bootstrapId: "e".repeat(64),
        environmentId: "12345678-1234-4234-8234-123456789abc",
        homeDirectory: home,
        journalPath: path.join(home, "native-activation.json"),
      };
      yield* fs.writeFileString(
        request.journalPath,
        JSON.stringify({ ...request, kind: "bootstrap" }),
      );
      const service = yield* NativeMaintenance.NativeMaintenance;
      const result = yield* service.bootstrap(request);
      assert.equal(result.homeDirectory, home);
      assert.equal(result.environmentId, request.environmentId);
      assert.equal(
        (yield* fs.readFileString(path.join(home, "userdata", "environment-id"))).trim(),
        request.environmentId,
      );
      const db = new NodeSqlite.DatabaseSync(path.join(home, "userdata", "statev2.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_messages").get()!.n,
          0,
        );
        assert.equal(
          db.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get()!.n,
          71,
        );
      } finally {
        db.close();
      }
    }).pipe(Effect.provide([NodeServices.layer, layer]), Effect.scoped),
);
