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
  const insert = (
    table: string,
    status: string,
    values: Readonly<Record<string, string | number | null>> = {},
  ) =>
    Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      try {
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .filter(
            (row) =>
              row.pk ||
              (row.notnull && row.dflt_value === null) ||
              Object.hasOwn(values, String(row.name)),
          );
        const names = columns.map((row) => String(row.name));
        db.prepare(
          `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
        ).run(
          ...columns.map((row) =>
            Object.hasOwn(values, String(row.name))
              ? values[String(row.name)]!
              : row.name === "status"
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
  const warm = () =>
    Effect.gen(function* () {
      yield* insert("orchestration_v2_projection_provider_sessions", "ready", {
        provider_session_id: "session:warm",
        thread_id: "thread:warm",
      });
      yield* insert("orchestration_v2_projection_provider_threads", "active", {
        provider_thread_id: "provider-thread:warm",
        provider_session_id: "session:warm",
        thread_id: "thread:warm",
      });
    });
  return { request, mutate, insert, warm, dbPath };
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

  it.effect.each(["completed", "interrupted", "failed", "cancelled", "rolled_back"])(
    "admits crash-stale warm providers after a $status run without rewriting stopped state",
    (status) =>
      Effect.gen(function* () {
        const { request, insert, warm } = yield* fixture;
        yield* warm();
        yield* insert("orchestration_v2_projection_runs", status, {
          thread_id: "thread:warm",
          provider_thread_id: "provider-thread:warm",
        });
        yield* insert("orchestration_v2_projection_provider_turns", "completed", {
          thread_id: "thread:warm",
          provider_thread_id: "provider-thread:warm",
        });
        const service = yield* NativeMaintenance.NativeMaintenance;
        const observed = yield* service.inspect(request);
        assert.deepEqual(
          [
            observed.activeRuns,
            observed.queuedRuns,
            observed.pendingRequests,
            observed.backgroundAgents,
            observed.scheduledWork,
            observed.restartContinuations,
          ],
          [0, 0, 0, 0, 0, 0],
        );
        const verified = yield* service.verify({ ...request, operation: "verify" });
        assert.equal(verified.dataGeneration, observed.dataGeneration);
        assert.equal(verified.workGeneration, observed.workGeneration);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(
    [
      ["orchestration_v2_projection_runs", "preparing"],
      ["orchestration_v2_projection_runs", "starting"],
      ["orchestration_v2_projection_runs", "running"],
      ["orchestration_v2_projection_runs", "waiting"],
      ["orchestration_v2_projection_provider_turns", "pending"],
      ["orchestration_v2_projection_provider_turns", "running"],
      ["orchestration_v2_projection_runtime_requests", "pending"],
      ["orchestration_v2_projection_subagents", "waiting"],
    ].map(([table, status]) => ({ table: table!, status: status! })),
  )("retains warm-provider busy counts for unfinished $table ($status)", ({ table, status }) =>
    Effect.gen(function* () {
      const { request, insert, warm } = yield* fixture;
      yield* warm();
      yield* insert(table, status, {
        thread_id: "thread:warm",
        provider_thread_id: "provider-thread:warm",
      });
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.isAtLeast((yield* service.inspect(request)).backgroundAgents, 2);
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "relates warm state through shared-session bindings and provider-thread IDs, not unrelated work",
    () =>
      Effect.gen(function* () {
        const { request, insert, mutate, warm } = yield* fixture;
        yield* warm();
        yield* insert("orchestration_v2_projection_runs", "running", {
          thread_id: "thread:other",
          provider_thread_id: "provider-thread:other",
        });
        const service = yield* NativeMaintenance.NativeMaintenance;
        const unrelated = yield* service.inspect(request);
        assert.equal(unrelated.activeRuns, 1);
        assert.equal(unrelated.backgroundAgents, 0);
        yield* mutate(
          "UPDATE orchestration_v2_projection_provider_sessions SET thread_id=NULL; INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id,thread_id) VALUES ('session:warm','thread:other')",
        );
        assert.equal((yield* service.inspect(request)).backgroundAgents, 1);
        yield* mutate(
          "UPDATE orchestration_v2_projection_provider_threads SET thread_id=NULL; UPDATE orchestration_v2_projection_runs SET provider_thread_id='provider-thread:warm'",
        );
        assert.equal((yield* service.inspect(request)).backgroundAgents, 2);
        assert.equal(
          (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
          "busy",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([
    {
      table: "orchestration_v2_projection_runs",
      status: "completed",
      payload: {
        delegatedCompletion: {
          disposition: "open",
          nextGeneration: 2,
          delivery: { generation: 1, messageId: "message:pending", taskIds: ["task:child"] },
        },
      },
    },
    {
      table: "orchestration_v2_projection_subagents",
      status: "idle",
      payload: { completionDelivery: { state: "claimed", observedByRunId: null } },
    },
    {
      table: "orchestration_v2_projection_subagents",
      status: "idle",
      payload: { origin: "app_owned", childThreadId: "thread:child", result: null },
    },
    {
      table: "orchestration_v2_projection_provider_threads",
      status: "active",
      payload: { pendingBackgroundTasks: [{ taskId: "task:pending" }] },
    },
    { table: "orchestration_v2_effect_outbox", status: "pending", payload: {} },
  ])("retains deferred-delivery blockers behind warm $table state", ({ table, status, payload }) =>
    Effect.gen(function* () {
      const { request, insert, mutate, warm } = yield* fixture;
      yield* warm();
      if (table === "orchestration_v2_projection_provider_threads")
        yield* mutate(
          `UPDATE orchestration_v2_projection_provider_threads SET payload_json='${JSON.stringify(payload)}'`,
        );
      else
        yield* insert(table, status, {
          thread_id: "thread:warm",
          payload_json: JSON.stringify(payload),
        });
      const service = yield* NativeMaintenance.NativeMaintenance;
      const observed = yield* service.inspect(request);
      assert.isAtLeast(observed.backgroundAgents, 2);
      assert.isAbove(observed.restartContinuations, 0);
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"])(
    "counts an explicit $status native goal only when it owns unfinished work",
    (status) =>
      Effect.gen(function* () {
        const { request, mutate, warm } = yield* fixture;
        yield* warm();
        yield* mutate(
          `UPDATE orchestration_v2_projection_provider_threads SET payload_json='${JSON.stringify({ goal: { objective: "Finish the requested task", status } })}'`,
        );
        const service = yield* NativeMaintenance.NativeMaintenance;
        assert.equal(
          (yield* service.inspect(request)).backgroundAgents,
          status === "active" ? 2 : 0,
        );
        if (status === "active")
          assert.equal(
            (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
            "busy",
          );
        else
          assert.equal(
            (yield* service.verify({ ...request, operation: "verify" })).backgroundAgents,
            0,
          );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refuses unknown native goals and warm status values rather than assuming they are idle",
    () =>
      Effect.gen(function* () {
        const { request, mutate, warm } = yield* fixture;
        yield* warm();
        const service = yield* NativeMaintenance.NativeMaintenance;
        yield* mutate(
          `UPDATE orchestration_v2_projection_provider_threads SET payload_json='{"goal":{"objective":"Unknown work","status":"future"}}'`,
        );
        assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
        yield* mutate(
          "UPDATE orchestration_v2_projection_provider_threads SET payload_json='{}'; UPDATE orchestration_v2_projection_provider_sessions SET status='future'",
        );
        assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(
    [
      ["orchestration_v2_projection_runs", "running"],
      ["orchestration_v2_projection_runs", "queued"],
      ["orchestration_v2_projection_nodes", "waiting"],
      ["orchestration_v2_projection_runtime_requests", "pending"],
      ["orchestration_v2_projection_provider_sessions", "starting"],
      ["orchestration_v2_projection_provider_sessions", "running"],
      ["orchestration_v2_projection_provider_sessions", "waiting"],
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
