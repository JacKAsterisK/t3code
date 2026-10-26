// @effect-diagnostics nodeBuiltinImport:off -- Offline SQLite fixtures exercise the native stopped-state inspector without touching installed homes.
import { assert, it as effectIt } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NativeMaintenance from "./NativeMaintenance.ts";
import { nativeMaintenanceRefusalMessage } from "./nativeMaintenanceEntry.ts";

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
const fixtureAtMigration = (toMigrationInclusive?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-maintenance-" });
    const home = path.join(root, "T3CodeLAN", "data");
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
    yield* fs.writeFileString(path.join(home, "userdata", "environment-id"), "environment:fixture");
    const dbPath = path.join(home, "userdata", "statev2.sqlite");
    yield* runMigrations({ toMigrationInclusive }).pipe(
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
const fixture = fixtureAtMigration();
const testLayer = NativeMaintenance.layer(identity).pipe(
  Layer.provide(
    Layer.succeed(NativeMaintenance.NativeMaintenanceLease, { verify: () => Effect.void }),
  ),
);

effectIt.layer(NodeServices.layer)("NativeMaintenance", (it) => {
  it.effect.each(["identity", "lease", "schema", "projection", "busy", "changed", "io"] as const)(
    "limits the $1 refusal to its reason token even with a private nested cause",
    (reason) =>
      Effect.sync(() => {
        assert.equal(
          nativeMaintenanceRefusalMessage(
            new NativeMaintenance.NativeMaintenanceError({
              reason,
              cause: new Error("C:\\private-fixture\\statev2.sqlite: internal cause"),
            }),
          ),
          `native_maintenance_refused:${reason}\n`,
        );
      }),
  );

  it.effect("redacts unexpected and forged refusal errors", () =>
    Effect.sync(() => {
      assert.equal(
        nativeMaintenanceRefusalMessage(new Error("C:\\private-fixture\\statev2.sqlite")),
        "native_maintenance_refused:io\n",
      );
      assert.equal(
        nativeMaintenanceRefusalMessage({
          _tag: "NativeMaintenanceError",
          reason: "changed:C:\\private-fixture",
        }),
        "native_maintenance_refused:io\n",
      );
    }),
  );

  it.effect("binds real nonempty WAL bytes even when the main database is unchanged", () =>
    Effect.gen(function* () {
      const { request, mutate, dbPath } = yield* fixture;
      yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      const writer = new NodeSqlite.DatabaseSync(dbPath);
      try {
        writer.exec(
          "PRAGMA wal_autocheckpoint=0; CREATE TABLE maintenance_wal_payload(value TEXT); INSERT INTO maintenance_wal_payload VALUES('before')",
        );
        const main = NodeFS.readFileSync(dbPath);
        const service = yield* NativeMaintenance.NativeMaintenance;
        const first = yield* service.inspect(request);
        writer.exec("INSERT INTO maintenance_wal_payload VALUES('after')");
        assert.isAbove(NodeFS.statSync(dbPath + "-wal").size, 0);
        assert.deepEqual(NodeFS.readFileSync(dbPath), main);
        const second = yield* service.inspect(request);
        assert.notEqual(first.dataGeneration, second.dataGeneration);
        assert.equal(first.workGeneration, second.workGeneration);
      } finally {
        writer.close();
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses an empty WAL alias before applying absent-WAL equivalence", () =>
    Effect.gen(function* () {
      const { request, mutate, dbPath } = yield* fixture;
      yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      const alias = dbPath + ".empty-fixture";
      NodeFS.writeFileSync(alias, "");
      NodeFS.linkSync(alias, dbPath + "-wal");
      assert.equal(NodeFS.lstatSync(dbPath + "-wal").nlink, 2);
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "identity");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "verifies stopped schema71 history when real SQLite read-only connections create an empty WAL",
    () =>
      Effect.gen(function* () {
        const { request, mutate, insert, dbPath } = yield* fixtureAtMigration(71);
        yield* insert("orchestration_v2_projection_runs", "completed", {
          run_id: "run:retained-schema71",
          payload_json: '{"status":"completed","note":"Retained schema71 terminal history"}',
        });
        yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
        assert.isFalse(NodeFS.existsSync(dbPath + "-wal"));
        const service = yield* NativeMaintenance.NativeMaintenance;
        const result = yield* service.verify({ ...request, operation: "verify" });
        assert.deepEqual(
          [
            result.activeRuns,
            result.queuedRuns,
            result.pendingRequests,
            result.backgroundAgents,
            result.scheduledWork,
            result.restartContinuations,
          ],
          [0, 0, 0, 0, 0, 0],
        );
        const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.equal(
            db.prepare("SELECT MAX(migration_id) n FROM effect_sql_migrations").get()!.n,
            73,
          );
          assert.equal(
            db
              .prepare(
                "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='run:retained-schema71'",
              )
              .get()!.payload_json,
            '{"status":"completed","note":"Retained schema71 terminal history"}',
          );
        } finally {
          db.close();
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps two absent-WAL inspections stable across actual empty-WAL read connection closure",
    () =>
      Effect.gen(function* () {
        const { request, mutate, dbPath } = yield* fixture;
        yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
        assert.isFalse(NodeFS.existsSync(dbPath + "-wal"));
        const service = yield* NativeMaintenance.NativeMaintenance;
        const first = yield* service.inspect(request);
        assert.equal(NodeFS.statSync(dbPath + "-wal").size, 0);
        NodeFS.unlinkSync(dbPath + "-wal");
        if (NodeFS.existsSync(dbPath + "-shm")) NodeFS.unlinkSync(dbPath + "-shm");
        assert.isFalse(NodeFS.existsSync(dbPath + "-wal"));
        const second = yield* service.inspect(request);
        const third = yield* service.inspect(request);
        assert.equal(first.dataGeneration, second.dataGeneration);
        assert.equal(second.dataGeneration, third.dataGeneration);
        assert.equal(first.workGeneration, second.workGeneration);
        assert.equal(NodeFS.statSync(dbPath + "-wal").size, 0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses a real SQLite write committed after the stopped read connection closes", () =>
    Effect.gen(function* () {
      const { request, mutate, dbPath } = yield* fixture;
      yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      const close = NodeSqlite.DatabaseSync.prototype.close;
      let written = false;
      using _close = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "close")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync) {
          close.call(this);
          if (written) return;
          written = true;
          const writer = new NodeSqlite.DatabaseSync(dbPath);
          try {
            writer.exec(
              "INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error,command_type) VALUES ('concurrent-write','thread','thread:fixture','2026-10-25T00:00:00Z',0,'accepted',NULL,'thread.send')",
            );
          } finally {
            writer.close();
          }
        });
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "changed");
      assert.isTrue(written);
    }).pipe(Effect.provide(testLayer)),
  );

  effectIt.live("writes only the native refusal reason to stderr without paths or causes", () =>
    Effect.gen(function* () {
      const { request } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(request.homeDirectory, "native-admission.lock"), "");
      const entry = NodeURL.fileURLToPath(new URL("./nativeMaintenanceEntry.ts", import.meta.url));
      const preload =
        "data:text/javascript," +
        encodeURIComponent(
          "globalThis.__T3_LAN_BUILD_IDENTITY__=" + JSON.stringify(identity) + ";",
        );
      const child = NodeChildProcess.spawnSync(process.execPath, ["--import", preload, entry], {
        input: JSON.stringify(request),
        encoding: "utf8",
        windowsHide: true,
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          NODE_NO_WARNINGS: "1",
          USERPROFILE: request.homeDirectory,
          TEMP: request.homeDirectory,
          TMP: request.homeDirectory,
        },
      });
      assert.equal(child.status, 1);
      assert.equal(child.stdout, "");
      assert.equal(child.stderr, "native_maintenance_refused:lease\n");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

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
          status === "active" ? 3 : 0,
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

  it.effect.each(
    ["idle", "not_loaded"].flatMap((providerStatus) =>
      ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].map(
        (goalStatus) => ({ providerStatus, goalStatus }),
      ),
    ),
  )(
    "counts a $goalStatus goal independently of $providerStatus provider state",
    ({ providerStatus, goalStatus }) =>
      Effect.gen(function* () {
        const { request, insert } = yield* fixture;
        yield* insert("orchestration_v2_projection_provider_sessions", "stopped", {
          provider_session_id: "session:stopped",
          thread_id: "thread:goal",
        });
        yield* insert("orchestration_v2_projection_provider_threads", providerStatus, {
          provider_thread_id: "provider-thread:goal",
          provider_session_id: "session:stopped",
          thread_id: "thread:goal",
          payload_json: JSON.stringify({
            goal: { objective: "Finish the requested task", status: goalStatus },
          }),
        });
        yield* insert("orchestration_v2_projection_runs", "completed", {
          thread_id: "thread:goal",
          provider_thread_id: "provider-thread:goal",
        });
        yield* insert("orchestration_v2_projection_provider_turns", "completed", {
          thread_id: "thread:goal",
          provider_thread_id: "provider-thread:goal",
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
          [0, 0, 0, goalStatus === "active" ? 1 : 0, 0, 0],
        );
        if (goalStatus === "active")
          assert.equal(
            (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
            "busy",
          );
        else {
          const verified = yield* service.verify({ ...request, operation: "verify" });
          assert.equal(verified.dataGeneration, observed.dataGeneration);
          assert.equal(verified.workGeneration, observed.workGeneration);
        }
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
