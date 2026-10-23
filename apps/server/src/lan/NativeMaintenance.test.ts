// @effect-diagnostics nodeBuiltinImport:off -- Offline SQLite fixtures exercise the native stopped-state inspector without touching installed homes.
import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NativeMaintenance from "./NativeMaintenance.ts";

const identity: NativeMaintenance.NativeBuildIdentity = {
  appId: "com.spiderpunch.t3code.lan",
  productName: "T3 Code LAN",
  protocolScheme: "t3code-lan",
  homeDirectoryName: "T3CodeLAN",
  nativeUpdater: "disabled",
  telemetry: "disabled",
  cloudConfiguration: "disabled",
  protocolVersion: 2,
  applicationVersion: "0.1.2",
  sourceCommit: "a".repeat(40),
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-maintenance-" });
  const home = path.join(root, "T3CodeLAN", "data");
  yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
  yield* fs.writeFileString(path.join(home, "userdata", "environment-id"), "environment:fixture");
  const dbPath = path.join(home, "userdata", "statev2.sqlite");
  yield* runMigrations().pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.scoped,
  );
  const mutate = (sql: string) =>
    Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    });
  yield* mutate(
    "UPDATE orchestration_v2_projection_metadata SET schema_version=2,last_sequence=0 WHERE projection_name='thread-projections'",
  );
  const request: NativeMaintenance.NativeMaintenanceRequest = {
    schemaVersion: 1,
    operation: "inspect",
    nonce: "b".repeat(64),
    homeDirectory: home,
    environmentId: "environment:fixture",
    journalPath: path.join(root, "T3CodeLAN", "activation.json"),
  };
  const insert = (table: string, status: string) =>
    Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      try {
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .filter((row) => row.pk || (row.notnull && row.dflt_value === null));
        const names = columns.map((row) => String(row.name));
        db.prepare(
          `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
        ).run(
          ...columns.map((row) =>
            row.name === "status"
              ? status
              : String(row.type).includes("INT")
                ? 0
                : String(row.name).endsWith("json")
                  ? "{}"
                  : "fixture",
          ),
        );
      } finally {
        db.close();
      }
    });
  return { request, mutate, insert, dbPath };
});
const testLayer = NativeMaintenance.layer(identity).pipe(
  Layer.provide(
    Layer.succeed(NativeMaintenance.NativeMaintenanceLease, { verify: () => Effect.void }),
  ),
);

it.layer(NodeServices.layer)("NativeMaintenance", (it) => {
  it.effect(
    "reads stopped state without starting providers, rewriting identity or changing database bytes",
    () =>
      Effect.gen(function* () {
        const { request } = yield* fixture;
        const service = yield* NativeMaintenance.NativeMaintenance;
        const first = yield* service.inspect(request);
        const second = yield* service.verify({ ...request, operation: "verify" });
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
        assert.equal(second.workGeneration, first.workGeneration);
        assert.equal(second.environmentId, request.environmentId);
        assert.deepEqual(second.compiledIdentity, identity);
        assert.match(first.dataGeneration, /^[a-f0-9]{64}$/u);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(
    [
      ["orchestration_v2_projection_runs", "running"],
      ["orchestration_v2_projection_runs", "queued"],
      ["orchestration_v2_projection_nodes", "waiting"],
      ["orchestration_v2_projection_runtime_requests", "pending"],
      ["orchestration_v2_projection_provider_sessions", "ready"],
      ["orchestration_v2_projection_provider_threads", "active"],
      ["orchestration_v2_projection_provider_turns", "running"],
      ["orchestration_v2_projection_subagents", "pending"],
      ["orchestration_v2_projection_turn_items", "running"],
      ["orchestration_v2_effect_outbox", "pending"],
      ["orchestration_v2_thread_launch_workflows", "pending"],
    ].map(([table, status]) => ({ table: table!, status: status! })),
  )("refuses migration for native busy work in $table ($status)", ({ table, status }) =>
    Effect.gen(function* () {
      const { request, insert } = yield* fixture;
      yield* insert(table, status);
      const service = yield* NativeMaintenance.NativeMaintenance;
      const result = yield* service.inspect(request);
      assert.isAbove(
        result.activeRuns +
          result.queuedRuns +
          result.pendingRequests +
          result.backgroundAgents +
          result.restartContinuations,
        0,
      );
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses enabled schedules and unknown or lagging state", () =>
    Effect.gen(function* () {
      const { request, insert, mutate } = yield* fixture;
      const service = yield* NativeMaintenance.NativeMaintenance;
      yield* insert("scheduled_tasks", "fixture");
      yield* mutate("UPDATE scheduled_tasks SET enabled=1");
      assert.equal((yield* service.inspect(request)).scheduledWork, 1);
      yield* mutate("UPDATE orchestration_v2_projection_metadata SET last_sequence=1");
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "projection");
      yield* mutate(
        "UPDATE orchestration_v2_projection_metadata SET last_sequence=0; UPDATE effect_sql_migrations SET name='unknown' WHERE migration_id=70",
      );
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("binds accepted command identities even when no run is active", () =>
    Effect.gen(function* () {
      const { request, mutate } = yield* fixture;
      const service = yield* NativeMaintenance.NativeMaintenance;
      const before = yield* service.inspect(request);
      yield* mutate(
        "INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error,command_type) VALUES ('new','thread','thread:fixture','2026-10-23T00:00:00Z',0,'accepted',NULL,'thread.send')",
      );
      const after = yield* service.inspect(request);
      assert.notEqual(after.workGeneration, before.workGeneration);
      assert.notEqual(after.dataGeneration, before.dataGeneration);
      assert.equal(after.activeRuns, 0);
      assert.equal(
        (yield* service.inspect({ ...request, environmentId: "wrong" }).pipe(Effect.flip)).reason,
        "identity",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refuses delegated completion and background recovery behind terminal or idle statuses",
    () =>
      Effect.gen(function* () {
        const { request, mutate, insert } = yield* fixture;
        const service = yield* NativeMaintenance.NativeMaintenance;
        yield* insert("orchestration_v2_projection_runs", "completed");
        yield* mutate(
          `UPDATE orchestration_v2_projection_runs SET payload_json='{"delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"message:pending","taskIds":["task:child"]}}}'`,
        );
        assert.isAbove((yield* service.inspect(request)).restartContinuations, 0);
        assert.equal(
          (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
          "busy",
        );
        yield* mutate("DELETE FROM orchestration_v2_projection_runs");
        yield* insert("orchestration_v2_projection_subagents", "idle");
        yield* mutate(
          `UPDATE orchestration_v2_projection_subagents SET payload_json='{"completionDelivery":{"state":"claimed","observedByRunId":null}}'`,
        );
        assert.isAbove((yield* service.inspect(request)).restartContinuations, 0);
        yield* mutate(
          `UPDATE orchestration_v2_projection_subagents SET payload_json='{"completionDelivery":{"state":"future","observedByRunId":null}}'`,
        );
        assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
        yield* mutate(
          "UPDATE orchestration_v2_projection_subagents SET status='rolled_back',payload_json='{}'",
        );
        assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires native exclusive lease proof before reading the home", () =>
    Effect.gen(function* () {
      const { request } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(request.homeDirectory, "native-admission.lock"), "");
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "lease");
    }).pipe(
      Effect.provide(
        NativeMaintenance.layer(identity).pipe(Layer.provide(NativeMaintenance.layerNativeLease)),
      ),
    ),
  );

  it.effect("allows consumed context history and defers undelivered or unknown transfers", () =>
    Effect.gen(function* () {
      const { request, insert, mutate } = yield* fixture;
      const service = yield* NativeMaintenance.NativeMaintenance;
      yield* insert("orchestration_v2_projection_context_transfers", "consumed");
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" })).restartContinuations,
        0,
      );
      yield* mutate("UPDATE orchestration_v2_projection_context_transfers SET status='pending'");
      assert.isAbove((yield* service.inspect(request)).restartContinuations, 0);
      yield* mutate("UPDATE orchestration_v2_projection_context_transfers SET status='future'");
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
    }).pipe(Effect.provide(testLayer)),
  );
});
