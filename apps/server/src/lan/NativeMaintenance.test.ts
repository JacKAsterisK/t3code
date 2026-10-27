// @effect-diagnostics nodeBuiltinImport:off -- Offline SQLite fixtures exercise the native stopped-state inspector without touching installed homes.
import { assert, it as effectIt } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NativeMaintenance from "./NativeMaintenance.ts";
import { nativeMaintenanceRefusalMessage } from "./nativeMaintenanceEntry.ts";
import { nativeRestartSafeEffects } from "./nativeWorkStates.ts";
import {
  REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS,
  PROCESS_BOUND_EFFECT_TYPES,
} from "../orchestration-v2/EffectOutbox.ts";

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
const migrationSeeds = new Map<number | undefined, Buffer>();
const fixtureAtMigration = (toMigrationInclusive?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-maintenance-" });
    const home = path.join(root, "T3CodeLAN", "data");
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
    yield* fs.writeFileString(path.join(home, "userdata", "environment-id"), "environment:fixture");
    const dbPath = path.join(home, "userdata", "statev2.sqlite");
    const seed = migrationSeeds.get(toMigrationInclusive);
    if (seed === undefined) {
      yield* runMigrations({ toMigrationInclusive }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
        Effect.scoped,
      );
      if (NodeFS.existsSync(dbPath + "-wal") && NodeFS.statSync(dbPath + "-wal").size !== 0)
        throw new Error("Synthetic migration seed still has uncheckpointed WAL frames.");
      migrationSeeds.set(toMigrationInclusive, NodeFS.readFileSync(dbPath));
    } else yield* fs.writeFile(dbPath, seed);
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
    const appendEvent = (aggregateKind: "project" | "thread", sequence: number) =>
      insert("orchestration_events", "fixture", {
        sequence,
        event_id: `event:${sequence}`,
        aggregate_kind: aggregateKind,
        stream_id: `${aggregateKind}:fixture`,
        stream_version: sequence,
        event_type: `${aggregateKind}.created`,
        occurred_at: "2026-10-25T00:00:00.000Z",
        actor_kind: "user",
        application_event_version: 2,
        metadata_json: "{}",
        payload_json: JSON.stringify({
          id: `${aggregateKind}:fixture`,
          title: "Retained project history",
          workspaceRoot: "C:/fixture/project",
          scripts: [],
          createdAt: "2026-10-25T00:00:00.000Z",
          updatedAt: "2026-10-25T00:00:00.000Z",
          deletedAt: null,
        }),
      });
    return { request, mutate, insert, warm, dbPath, appendEvent };
  });
const fixture = fixtureAtMigration();
const stalePlanDisplayFixture = (status: string) =>
  Effect.gen(function* () {
    const base = yield* fixture;
    const threadId = "thread:stale-plan";
    const runId = "run:stale-plan";
    const providerThreadId = "provider-thread:stale-plan";
    const providerTurnId = "provider-turn:stale-plan";
    const startedAt = "2026-10-25T00:00:00.000Z";
    yield* base.insert("orchestration_v2_projection_runs", status, {
      run_id: runId,
      thread_id: threadId,
      provider_thread_id: providerThreadId,
      payload_json: JSON.stringify({
        id: runId,
        threadId,
        status,
        providerThreadId,
        rootNodeId: "node:root",
        ordinal: 1,
        requestedAt: startedAt,
        completedAt: "2026-10-25T00:01:00.000Z",
      }),
    });
    for (const kind of ["todo_list", "plan"] as const) {
      const nodeId = `node:${kind}`;
      const itemId = `item:${kind}`;
      const type = kind === "todo_list" ? "todo_list" : "proposed_plan";
      const nativeItemRef = {
        driver: "codex",
        nativeId: kind === "todo_list" ? "turn-plan:native-turn" : "native-proposal",
        strength: "strong",
      };
      yield* base.insert("orchestration_v2_projection_nodes", "running", {
        node_id: nodeId,
        thread_id: threadId,
        run_id: runId,
        kind,
        runtime_request_id: null,
        provider_thread_id: providerThreadId,
        provider_turn_id: providerTurnId,
        payload_json: JSON.stringify({
          id: nodeId,
          threadId,
          runId,
          parentNodeId: "node:root",
          rootNodeId: "node:root",
          kind,
          status: "running",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt: null,
        }),
      });
      yield* base.insert("orchestration_v2_projection_turn_items", "running", {
        turn_item_id: itemId,
        thread_id: threadId,
        run_id: runId,
        node_id: nodeId,
        provider_thread_id: providerThreadId,
        provider_turn_id: providerTurnId,
        type,
        payload_json: JSON.stringify({
          id: itemId,
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef,
          parentItemId: null,
          ordinal: kind === "todo_list" ? 1 : 2,
          status: "running",
          title: null,
          startedAt,
          completedAt: null,
          updatedAt: startedAt,
          type,
          planId: `plan:${kind}`,
          ...(kind === "todo_list"
            ? {
                steps: [{ id: "step:one", text: "Keep unfinished work", status: "running" }],
                explanation: "Retained plan",
              }
            : { markdown: "## Partial retained proposal", streaming: true }),
        }),
      });
    }
    const readDisplays = () => {
      const db = new NodeSqlite.DatabaseSync(base.dbPath, { readOnly: true });
      try {
        return ["orchestration_v2_projection_nodes", "orchestration_v2_projection_turn_items"].map(
          (table) =>
            db.prepare(`SELECT status,payload_json FROM ${table} ORDER BY payload_json`).all(),
        );
      } finally {
        db.close();
      }
    };
    return { ...base, threadId, runId, providerThreadId, providerTurnId, readDisplays };
  });
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

  it.effect.each([
    { name: "project-only history", threadHead: 0, projectHead: 1 },
    { name: "project events after thread history", threadHead: 4, projectHead: 5 },
  ])("accepts the current thread projection with $name", ({ threadHead, projectHead }) =>
    Effect.gen(function* () {
      const { request, mutate, appendEvent } = yield* fixture;
      if (threadHead > 0) yield* appendEvent("thread", threadHead);
      yield* appendEvent("project", projectHead);
      yield* mutate(
        `UPDATE orchestration_v2_projection_metadata SET last_sequence=${threadHead} WHERE projection_name='thread-projections'`,
      );
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
      assert.equal((yield* service.inspect(request)).dataGeneration, observed.dataGeneration);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([
    { name: "lagging thread projection", lastSequence: 3, schemaVersion: 2 },
    { name: "thread projection ahead of thread events", lastSequence: 5, schemaVersion: 2 },
    { name: "unknown thread projection schema", lastSequence: 4, schemaVersion: 3 },
  ])("refuses a $name even with a later project event", ({ lastSequence, schemaVersion }) =>
    Effect.gen(function* () {
      const { request, mutate, appendEvent } = yield* fixture;
      yield* appendEvent("thread", 4);
      yield* appendEvent("project", 5);
      yield* mutate(
        `UPDATE orchestration_v2_projection_metadata SET last_sequence=${lastSequence},schema_version=${schemaVersion} WHERE projection_name='thread-projections'`,
      );
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "projection");
    }).pipe(Effect.provide(testLayer)),
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
        const { request, mutate, insert, dbPath, appendEvent } = yield* fixtureAtMigration(71);
        yield* appendEvent("project", 1);
        yield* insert("orchestration_v2_projection_runs", "completed", {
          run_id: "run:retained-schema71",
          payload_json: '{"status":"completed","note":"Retained schema71 terminal history"}',
        });
        yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
        assert.isFalse(NodeFS.existsSync(dbPath + "-wal"));
        const service = yield* NativeMaintenance.NativeMaintenance;
        const inspected = yield* service.inspect(request);
        const result = yield* service.verify({ ...request, operation: "verify" });
        assert.equal(result.workGeneration, inspected.workGeneration);
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

  it.effect("manual activation preserves unfinished work while applying migrations", () =>
    Effect.gen(function* () {
      const { request, insert, dbPath } = yield* fixtureAtMigration(71);
      yield* insert("orchestration_v2_projection_runs", "running", {
        run_id: "run:manual-preserved",
        thread_id: "thread:manual-preserved",
        payload_json: '{"status":"running","note":"retained"}',
      });
      const service = yield* NativeMaintenance.NativeMaintenance;
      const inspected = yield* service.inspect({ ...request, manualActivation: true });
      assert.isAbove(inspected.activeRuns, 0);
      assert.isFalse(Object.hasOwn(inspected, "manualActivation"));
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
      assert.equal(
        (yield* service
          .verify({ ...request, operation: "verify", manualActivation: false })
          .pipe(Effect.flip)).reason,
        "busy",
      );
      const verified = yield* service.verify({
        ...request,
        operation: "verify",
        manualActivation: true,
      });
      assert.isTrue(verified.manualActivation);
      assert.equal(verified.workGeneration, inspected.workGeneration);
      assert.equal(verified.activeRuns, inspected.activeRuns);
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          db.prepare("SELECT MAX(migration_id) n FROM effect_sql_migrations").get()!.n,
          73,
        );
        const row = db
          .prepare(
            "SELECT status,payload_json FROM orchestration_v2_projection_runs WHERE run_id='run:manual-preserved'",
          )
          .get()!;
        assert.equal(row.status, "running");
        assert.equal(row.payload_json, '{"status":"running","note":"retained"}');
      } finally {
        db.close();
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("manual activation still requires the stopped lease and a current projection", () =>
    Effect.gen(function* () {
      const { request, mutate } = yield* fixture;
      const denied = NativeMaintenance.layer(identity).pipe(
        Layer.provide(
          Layer.succeed(NativeMaintenance.NativeMaintenanceLease, {
            verify: () =>
              Effect.fail(new NativeMaintenance.NativeMaintenanceError({ reason: "lease" })),
          }),
        ),
      );
      const refusal = yield* Effect.gen(function* () {
        const service = yield* NativeMaintenance.NativeMaintenance;
        return yield* service
          .verify({ ...request, operation: "verify", manualActivation: true })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(denied));
      assert.equal(refusal.reason, "lease");
      yield* mutate(
        "UPDATE orchestration_v2_projection_metadata SET last_sequence=1 WHERE projection_name='thread-projections'",
      );
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal(
        (yield* service
          .verify({ ...request, operation: "verify", manualActivation: true })
          .pipe(Effect.flip)).reason,
        "projection",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("manual activation still refuses a concurrent SQLite write", () =>
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
              "INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error,command_type) VALUES ('manual-concurrent-write','thread','thread:fixture','2026-10-25T00:00:00Z',0,'accepted',NULL,'thread.send')",
            );
          } finally {
            writer.close();
          }
        });
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal(
        (yield* service
          .verify({ ...request, operation: "verify", manualActivation: true })
          .pipe(Effect.flip)).reason,
        "changed",
      );
      assert.isTrue(written);
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

  it.effect.each(["completed", "interrupted", "failed", "cancelled", "rolled_back"])(
    "ignores stale plan displays under a $status run without rewriting retained rows",
    (status) =>
      Effect.gen(function* () {
        const { request, dbPath, readDisplays } = yield* stalePlanDisplayFixture(status);
        const retained = readDisplays();
        assert.isTrue(retained.flat().every((row) => row.status === "running"));
        const stopped = NativeMaintenance.inspectStoppedRepairWork(dbPath);
        assert.equal(stopped.backgroundAgents, 0);
        const service = yield* NativeMaintenance.NativeMaintenance;
        const inspected = yield* service.inspect(request);
        const probed = yield* service.probe({ ...request, operation: "probe" });
        const verified = yield* service.verify({ ...request, operation: "verify" });
        for (const observed of [stopped, inspected, probed, verified])
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
        assert.equal(probed.workGeneration, inspected.workGeneration);
        assert.equal(verified.workGeneration, inspected.workGeneration);
        assert.equal(verified.dataGeneration, inspected.dataGeneration);
        assert.deepEqual(readDisplays(), retained);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("binds ignored plan display content into the update work generation", () =>
    Effect.gen(function* () {
      const { request, mutate } = yield* stalePlanDisplayFixture("completed");
      const service = yield* NativeMaintenance.NativeMaintenance;
      const before = yield* service.inspect(request);
      yield* mutate(
        "UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.explanation','Changed retained plan') WHERE type='todo_list'",
      );
      const after = yield* service.inspect(request);
      assert.equal(after.backgroundAgents, 0);
      assert.notEqual(after.workGeneration, before.workGeneration);
      assert.notEqual(after.dataGeneration, before.dataGeneration);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([
    {
      name: "running parent",
      sql: "UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_set(payload_json,'$.status','running')",
    },
    {
      name: "waiting parent",
      sql: "UPDATE orchestration_v2_projection_runs SET status='waiting',payload_json=json_set(payload_json,'$.status','waiting')",
    },
    {
      name: "counting node",
      sql: "UPDATE orchestration_v2_projection_nodes SET payload_json=json_set(payload_json,'$.countsForRun',json('true')) WHERE kind='todo_list'",
    },
    {
      name: "tool node",
      sql: "UPDATE orchestration_v2_projection_nodes SET kind='tool_call',payload_json=json_set(payload_json,'$.kind','tool_call') WHERE kind='todo_list'",
    },
    { name: "missing parent", sql: "DELETE FROM orchestration_v2_projection_runs" },
    {
      name: "wrong-thread parent",
      sql: "UPDATE orchestration_v2_projection_runs SET thread_id='thread:other',payload_json=json_set(payload_json,'$.threadId','thread:other')",
    },
    {
      name: "missing item node",
      sql: "UPDATE orchestration_v2_projection_turn_items SET node_id='node:missing',payload_json=json_set(payload_json,'$.nodeId','node:missing') WHERE type='todo_list'",
    },
    {
      name: "mismatched item node payload",
      sql: "UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.nodeId','node:other') WHERE type='todo_list'",
    },
    {
      name: "runtime-bound node",
      sql: "UPDATE orchestration_v2_projection_nodes SET runtime_request_id='request:pending',payload_json=json_set(payload_json,'$.runtimeRequestId','request:pending') WHERE kind='todo_list'",
    },
  ])("keeps stale plan displays with a $name busy", ({ sql }) =>
    Effect.gen(function* () {
      const { request, mutate, dbPath } = yield* stalePlanDisplayFixture("completed");
      yield* mutate(sql);
      assert.isAbove(NativeMaintenance.inspectStoppedRepairWork(dbPath).backgroundAgents, 0);
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.isAbove((yield* service.inspect(request)).backgroundAgents, 0);
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([
    {
      table: "orchestration_v2_projection_provider_turns",
      status: "running",
      category: "backgroundAgents",
    },
    {
      table: "orchestration_v2_projection_runtime_requests",
      status: "pending",
      category: "pendingRequests",
    },
  ] as const)(
    "keeps real $status $table busy beside stale plan displays",
    ({ table, status, category }) =>
      Effect.gen(function* () {
        const { request, insert, threadId, runId, providerThreadId, providerTurnId } =
          yield* stalePlanDisplayFixture("completed");
        yield* insert(table, status, {
          provider_turn_id: providerTurnId,
          runtime_request_id: "request:real",
          thread_id: threadId,
          run_id: runId,
          provider_thread_id: providerThreadId,
          payload_json: JSON.stringify({
            id: "real-work",
            threadId,
            runId,
            status,
            providerThreadId,
          }),
        });
        const service = yield* NativeMaintenance.NativeMaintenance;
        assert.isAbove((yield* service.inspect(request))[category], 0);
        assert.equal(
          (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
          "busy",
        );
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

  it.effect(
    "carries an enabled idle schedule across migrations while original repair stays strict",
    () =>
      Effect.gen(function* () {
        const { request, insert, dbPath } = yield* fixtureAtMigration(71);
        yield* insert("scheduled_tasks", "fixture", { enabled: 1, last_run_status: "never" });
        const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        const before = db.prepare("SELECT * FROM scheduled_tasks").all();
        db.close();
        assert.equal(NativeMaintenance.inspectStoppedRepairWork(dbPath).scheduledWork, 1);
        const service = yield* NativeMaintenance.NativeMaintenance;
        const observed = yield* service.inspect(request);
        assert.equal(observed.scheduledWork, 0);
        assert.equal(observed.carriedWork.scheduledWork, 1);
        const verified = yield* service.verify({ ...request, operation: "verify" });
        assert.equal(verified.workGeneration, observed.workGeneration);
        const after = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        assert.deepEqual(after.prepare("SELECT * FROM scheduled_tasks").all(), before);
        after.close();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("probes an active WAL snapshot without admission or durable file writes", () =>
    Effect.gen(function* () {
      const { request, mutate, dbPath } = yield* fixture;
      yield* mutate("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      const writer = new NodeSqlite.DatabaseSync(dbPath);
      try {
        writer.exec(
          "PRAGMA wal_autocheckpoint=0; CREATE TABLE probe_writer(value TEXT); INSERT INTO probe_writer VALUES('retained')",
        );
        const before = [NodeFS.readFileSync(dbPath), NodeFS.readFileSync(dbPath + "-wal")];
        const service = yield* NativeMaintenance.NativeMaintenance;
        const observed = yield* service.probe({ ...request, operation: "probe" });
        assert.equal(observed.operation, "probe");
        assert.equal(observed.draftStateKnown, false);
        assert.equal(observed.hasUnsentPrompt, null);
        assert.deepEqual(
          [NodeFS.readFileSync(dbPath), NodeFS.readFileSync(dbPath + "-wal")],
          before,
        );
      } finally {
        writer.close();
      }
    }).pipe(
      Effect.provide(
        NativeMaintenance.layer(identity).pipe(
          Layer.provide(
            Layer.succeed(NativeMaintenance.NativeMaintenanceLease, {
              verify: () => Effect.die("probe acquired admission"),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("carries idle schedules but refuses unknown or lagging state", () =>
    Effect.gen(function* () {
      const { request, insert, mutate } = yield* fixture;
      const service = yield* NativeMaintenance.NativeMaintenance;
      yield* insert("scheduled_tasks", "fixture", { last_run_status: "never" });
      yield* mutate("UPDATE scheduled_tasks SET enabled=1");
      assert.equal((yield* service.inspect(request)).carriedWork.scheduledWork, 1);
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

  it.effect("carries durable delegated completions but refuses unknown background delivery", () =>
    Effect.gen(function* () {
      const { request, mutate, insert } = yield* fixture;
      const service = yield* NativeMaintenance.NativeMaintenance;
      yield* insert("orchestration_v2_projection_runs", "completed");
      yield* mutate(
        `UPDATE orchestration_v2_projection_runs SET payload_json='{"delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"message:pending","taskIds":["task:child"]}}}'`,
      );
      assert.equal((yield* service.inspect(request)).restartContinuations, 0);
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" })).carriedWork
          .restartContinuations,
        1,
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
  it.effect.each([
    "queued input",
    "app question",
    "checkpoint",
    "delegation",
    "continuation",
    "resolved context",
  ] as const)("preserves %s across candidate migrations", (kind) =>
    Effect.gen(function* () {
      const { request, insert, dbPath } = yield* fixtureAtMigration(71);
      let category: keyof ReturnType<
        typeof NativeMaintenance.inspectNativeUpdateWork
      >["carriedWork"] = "restartContinuations";
      if (kind === "queued input") {
        category = "queuedRuns";
        yield* insert("orchestration_v2_projection_messages", "fixture", {
          message_id: "message:queued",
          thread_id: "thread:queued",
          role: "user",
          streaming: 0,
          payload_json: JSON.stringify({
            id: "message:queued",
            createdBy: "user",
            creationSource: "client",
            text: "Keep this input",
          }),
        });
        yield* insert("orchestration_v2_projection_runs", "queued", {
          run_id: "run:queued",
          thread_id: "thread:queued",
          payload_json: JSON.stringify({ userMessageId: "message:queued" }),
        });
      } else if (kind === "app question") {
        category = "pendingRequests";
        yield* insert("orchestration_v2_projection_runtime_requests", "pending", {
          node_id: "node:question",
          payload_json: JSON.stringify({
            responseCapability: { type: "message" },
            prompt: "Keep this question",
          }),
        });
        yield* insert("orchestration_v2_projection_nodes", "waiting", { node_id: "node:question" });
      } else if (kind === "checkpoint") {
        category = "activeRuns";
        yield* insert("orchestration_v2_projection_runs", "waiting", { run_id: "run:checkpoint" });
        yield* insert("orchestration_v2_effect_outbox", "pending", {
          effect_type: "checkpoint.capture",
          payload_json: JSON.stringify({
            type: "checkpoint.capture",
            runId: "run:checkpoint",
            scopeId: "scope:checkpoint",
          }),
        });
      } else if (kind === "delegation") {
        category = "backgroundAgents";
        yield* insert("orchestration_v2_projection_subagents", "waiting", {
          origin: "app_owned",
          child_thread_id: "thread:child",
          payload_json: JSON.stringify({
            origin: "app_owned",
            childThreadId: "thread:child",
            result: null,
          }),
        });
      } else if (kind === "continuation") {
        yield* insert("orchestration_v2_effect_outbox", "pending", {
          effect_type: "provider-runtime.continue",
          payload_json: JSON.stringify({
            type: "provider-runtime.continue",
            sourceRunId: "run:previous",
          }),
        });
      } else yield* insert("orchestration_v2_projection_context_transfers", "resolved_portable");
      const service = yield* NativeMaintenance.NativeMaintenance;
      const before = yield* service.inspect(request);
      assert.isAbove(before.carriedWork[category], 0);
      assert.equal(NativeMaintenance.inspectStoppedRepairWork(dbPath).workGeneration.length, 64);
      const after = yield* service.verify({ ...request, operation: "verify" });
      assert.equal(after.workGeneration, before.workGeneration);
      assert.deepEqual(
        [
          after.activeRuns,
          after.queuedRuns,
          after.pendingRequests,
          after.backgroundAgents,
          after.scheduledWork,
          after.restartContinuations,
        ],
        [0, 0, 0, 0, 0, 0],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["pending", "dispatching", "running"] as const)(
    "carries only undispatched webhook work in state %s",
    (state) =>
      Effect.gen(function* () {
        const { request, insert } = yield* fixture;
        yield* insert("scheduled_tasks", "fixture", {
          task_id: "task:webhook",
          enabled: 1,
          last_run_status: "never",
        });
        yield* insert("scheduled_task_webhook_pending", "fixture", {
          task_id: "task:webhook",
          state,
        });
        const service = yield* NativeMaintenance.NativeMaintenance;
        const observed = yield* service.inspect(request);
        assert.equal(observed.scheduledWork, state === "pending" ? 0 : 1);
        assert.equal(observed.carriedWork.scheduledWork, state === "pending" ? 2 : 1);
        if (state !== "pending")
          assert.equal(
            (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
            "busy",
          );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("blocks a running disabled schedule and unknown schedule states", () =>
    Effect.gen(function* () {
      const { request, insert, mutate } = yield* fixture;
      yield* insert("scheduled_tasks", "fixture", { enabled: 0, last_run_status: "running" });
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal((yield* service.inspect(request)).scheduledWork, 1);
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
      yield* mutate("UPDATE scheduled_tasks SET last_run_status='future'");
      assert.equal((yield* service.inspect(request).pipe(Effect.flip)).reason, "schema");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps provider-bound approvals blocking beside a durable app question", () =>
    Effect.gen(function* () {
      const { request, insert } = yield* fixture;
      for (const type of ["message", "provider"])
        yield* insert("orchestration_v2_projection_runtime_requests", "pending", {
          runtime_request_id: "request:" + type,
          node_id: "node:shared",
          payload_json: JSON.stringify({ responseCapability: { type } }),
        });
      const service = yield* NativeMaintenance.NativeMaintenance;
      const observed = yield* service.inspect(request);
      assert.equal(observed.carriedWork.pendingRequests, 1);
      assert.equal(observed.pendingRequests, 1);
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "busy",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([
    "clean",
    "draft",
    "unknown",
    "stale",
    "future",
    "foreign owner",
    "foreign environment",
    "missing",
  ] as const)("binds live draft readiness for %s state", (kind) =>
    Effect.gen(function* () {
      const { request } = yield* fixture;
      const now = yield* DateTime.now;
      const state = request.homeDirectory + "/userdata/";
      NodeFS.writeFileSync(
        state + "server-runtime.json",
        JSON.stringify({ version: 1, pid: process.pid, ownerId: "owner:fixture" }),
      );
      if (kind !== "missing")
        NodeFS.writeFileSync(
          state + "native-update-readiness.json",
          JSON.stringify({
            schemaVersion: 1,
            environmentId:
              kind === "foreign environment" ? "environment:other" : request.environmentId,
            ownerId: kind === "foreign owner" ? "owner:other" : "owner:fixture",
            draftStateKnown: kind !== "unknown",
            hasUnsentPrompt: kind === "unknown" ? null : kind === "draft",
            observedUtc: DateTime.formatIso(
              DateTime.add(now, { seconds: kind === "stale" ? -31 : kind === "future" ? 1 : 0 }),
            ),
          }),
        );
      const service = yield* NativeMaintenance.NativeMaintenance;
      const observed = yield* service.probe({ ...request, operation: "probe" });
      assert.isTrue(observed.processRunning);
      assert.equal(observed.draftStateKnown, kind === "clean" || kind === "draft");
      assert.equal(
        observed.hasUnsentPrompt,
        kind === "clean" ? false : kind === "draft" ? true : null,
      );
      assert.equal(
        observed.draftsObservedUtc,
        kind === "clean" || kind === "draft" ? DateTime.formatIso(now) : null,
      );
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("keeps the native replay subset aligned with authoritative process-loss recovery", () =>
    Effect.sync(() => {
      assert.deepEqual(
        Object.keys(nativeRestartSafeEffects).sort(),
        [...REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS].sort(),
      );
      assert.isFalse(
        PROCESS_BOUND_EFFECT_TYPES.some((type) => Object.hasOwn(nativeRestartSafeEffects, type)),
      );
    }),
  );

  it.effect("refuses a candidate migration if carried work changes without a domain event", () =>
    Effect.gen(function* () {
      const { request, insert, dbPath } = yield* fixtureAtMigration(71);
      yield* insert("orchestration_v2_projection_context_transfers", "resolved_portable", {
        payload_json: JSON.stringify({ text: "Retain the exact transfer" }),
      });
      const close = NodeSqlite.DatabaseSync.prototype.close;
      let closes = 0;
      let changed = false;
      using _close = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "close")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync) {
          close.call(this);
          closes++;
          if (closes !== 2) return;
          changed = true;
          const writer = new NodeSqlite.DatabaseSync(dbPath);
          try {
            writer.exec(
              "UPDATE orchestration_v2_projection_context_transfers SET payload_json='{}'",
            );
          } finally {
            writer.close();
          }
        });
      const service = yield* NativeMaintenance.NativeMaintenance;
      assert.equal(
        (yield* service.verify({ ...request, operation: "verify" }).pipe(Effect.flip)).reason,
        "changed",
      );
      assert.isTrue(changed);
    }).pipe(Effect.provide(testLayer)),
  );

  effectIt.live(
    "serves the probe through the real helper entry without a stopped admission lease",
    () =>
      Effect.gen(function* () {
        const { request } = yield* fixture;
        const entry = NodeURL.fileURLToPath(
          new URL("./nativeMaintenanceEntry.ts", import.meta.url),
        );
        const preload =
          "data:text/javascript," +
          encodeURIComponent(
            "globalThis.__T3_LAN_BUILD_IDENTITY__=" + JSON.stringify(identity) + ";",
          );
        const child = NodeChildProcess.spawnSync(process.execPath, ["--import", preload, entry], {
          input: JSON.stringify({ ...request, operation: "probe" }),
          encoding: "utf8",
          windowsHide: true,
          env: {
            SystemRoot: "C:/Windows",
            WINDIR: "C:/Windows",
            NODE_NO_WARNINGS: "1",
            USERPROFILE: request.homeDirectory,
            TEMP: request.homeDirectory,
            TMP: request.homeDirectory,
          },
        });
        assert.equal(child.status, 0);
        assert.equal(child.stderr, "");
        const reply = JSON.parse(child.stdout);
        assert.equal(reply.operation, "probe");
        assert.equal(reply.nonce, request.nonce);
        assert.deepEqual(reply.compiledIdentity, identity);
        assert.equal(reply.processRunning, false);
        assert.equal(reply.draftStateKnown, false);
        assert.equal(reply.hasUnsentPrompt, null);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect.each([
    "supported",
    "legacy",
    "foreign pipe",
    "unsupported version",
    "guard disabled",
  ] as const)("trusts guarded close only for %s capability", (kind) =>
    Effect.gen(function* () {
      const { request } = yield* fixture;
      const now = yield* DateTime.now;
      const state = request.homeDirectory + "/userdata/";
      const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const pipe = "\\\\.\\pipe\\t3code-lan-update-v1-" + ownerId;
      NodeFS.writeFileSync(
        state + "server-runtime.json",
        JSON.stringify({ version: 1, pid: process.pid, ownerId }),
      );
      NodeFS.writeFileSync(
        state + "native-update-readiness.json",
        JSON.stringify({
          schemaVersion: 1,
          environmentId: request.environmentId,
          ownerId,
          draftStateKnown: true,
          hasUnsentPrompt: false,
          observedUtc: DateTime.formatIso(now),
          ...(kind === "legacy"
            ? {}
            : {
                guardedCloseSupported: kind !== "guard disabled",
                updateControlVersion: kind === "unsupported version" ? 2 : 1,
                updateControlPipe: kind === "foreign pipe" ? "\\\\.\\pipe\\unrelated" : pipe,
              }),
        }),
      );
      const service = yield* NativeMaintenance.NativeMaintenance;
      const observed = yield* service.probe({ ...request, operation: "probe" });
      assert.equal(observed.serverProcessId, process.pid);
      assert.equal(observed.serverOwnerId, ownerId);
      assert.equal(observed.guardedCloseSupported, kind === "supported");
      assert.equal(observed.updateControlVersion, kind === "supported" ? 1 : null);
      assert.equal(observed.updateControlPipe, kind === "supported" ? pipe : null);
    }).pipe(Effect.provide(testLayer)),
  );
});
