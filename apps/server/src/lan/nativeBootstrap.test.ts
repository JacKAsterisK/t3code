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
import { migrationManifest } from "../persistence/Migrations.ts";
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
            const searchShadows = new Set(
              db
                .prepare("PRAGMA table_list")
                .all()
                .filter(
                  (row) =>
                    row.type === "shadow" &&
                    String(row.name).startsWith("orchestration_v2_message_search_"),
                )
                .map((row) => String(row.name)),
            );
            for (const row of db
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all()) {
              const name = String(row.name);
              if (name === "agent_gateway_compatibility_state") {
                assert.deepEqual(
                  db
                    .prepare("SELECT * FROM agent_gateway_compatibility_state")
                    .all()
                    .map((entry) => ({ ...entry })),
                  [
                    {
                      id: 1,
                      mode: "legacy",
                      generation: 0,
                      shadow_reads: 0,
                      shadow_digest: null,
                      backup_id: null,
                    },
                  ],
                );
              } else if (
                !searchShadows.has(name) &&
                !["effect_sql_migrations", "orchestration_v2_projection_metadata"].includes(name)
              )
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

  it.effect.each([
    {
      name: "unknown owner data",
      mutate:
        "CREATE TABLE unrecognized_owner_data(value TEXT); INSERT INTO unrecognized_owner_data VALUES ('preserve me')",
    },
    { name: "shadow mode", mutate: "UPDATE agent_gateway_compatibility_state SET mode='shadow'" },
    { name: "adapter mode", mutate: "UPDATE agent_gateway_compatibility_state SET mode='adapter'" },
    {
      name: "changed generation",
      mutate: "UPDATE agent_gateway_compatibility_state SET generation=1",
    },
    {
      name: "shadow progress",
      mutate: "UPDATE agent_gateway_compatibility_state SET shadow_reads=1",
    },
    {
      name: "shadow evidence",
      mutate: "UPDATE agent_gateway_compatibility_state SET shadow_digest='existing-evidence'",
    },
    {
      name: "backup identity",
      mutate: "UPDATE agent_gateway_compatibility_state SET backup_id='existing-backup'",
    },
    { name: "missing pristine row", mutate: "DELETE FROM agent_gateway_compatibility_state" },
    {
      name: "additional metadata column",
      mutate:
        "ALTER TABLE agent_gateway_compatibility_state ADD COLUMN owner_bytes TEXT DEFAULT 'preserve me'",
    },
    {
      name: "event log identity",
      mutate:
        "INSERT INTO agent_event_log_state (id,epoch,head_seq,floor_seq) VALUES (1,'existing-epoch',0,1)",
    },
    {
      name: "event fact",
      mutate:
        "INSERT INTO agent_event_facts (log_seq,event_id,fact_key,kind,origin_environment_id,origin_generation,source_kind,source_sequence,transition_ordinal,occurred_at,recorded_at,data_json) VALUES (1,'existing-fact','fact-key','run_finished','origin','generation','native',1,0,1,1,'{}')",
    },
    {
      name: "approval authorization",
      mutate:
        "INSERT INTO agent_approval_authorizations (session_id,application_id,consent_family_id,initiating_client_id,enabled,updated_at,credential_kind) VALUES ('existing-session','app','family','client',1,1,'local')",
    },
    {
      name: "authentication and OAuth grant",
      mutate:
        "INSERT INTO auth_sessions (session_id,subject,scopes,method,issued_at,expires_at) VALUES ('existing-session','owner','[\"orchestration:read\"]','pairing','2026-10-31','2026-11-01'); INSERT INTO auth_mcp_grants (grant_id,client_id,resource,session_id,access,expires_at,renewable) VALUES ('existing-grant','client','resource','existing-session','full-access',1,1)",
    },
  ])("never resets accepted $name, authentication or an environment identity", ({ mutate }) =>
    Effect.gen(function* () {
      const { request, home, dbPath } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* NativeMaintenance.NativeMaintenance;
      yield* service.bootstrap(request);
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(dbPath);
        try {
          db.exec(mutate);
        } finally {
          db.close();
        }
      });
      const before = yield* fs.readFile(dbPath);
      assert.throws(
        () => NativeMaintenance.assertEmptyBootstrapDatabase(dbPath),
        /Native maintenance refused \(busy\)\./u,
      );
      assert.deepEqual(yield* fs.readFile(dbPath), before);
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
          migrationManifest.at(-1)![0],
        );
      } finally {
        db.close();
      }
    }).pipe(Effect.provide([NodeServices.layer, layer]), Effect.scoped),
);
