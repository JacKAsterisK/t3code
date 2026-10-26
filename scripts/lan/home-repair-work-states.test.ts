// @effect-diagnostics nodeBuiltinImport:off -- Genuine migrated temporary homes; status metadata only, no live state or provider.
import * as NodeTest from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { createHomeRepairFixture } from "./home-repair.fixture-builder.ts";
import { previewHomeRepair, supportedMigrationIds } from "./home-repair.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";
import { nativeWorkStatusDefinitions } from "../../apps/server/src/lan/nativeWorkStates.ts";

const previewTables = new Set([
  "orchestration_v2_projection_runs",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_projection_runtime_requests",
]);
const expectedPreview: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  orchestration_v2_projection_runs: {
    preparing: 1,
    queued: 1,
    starting: 1,
    running: 1,
    waiting: 1,
    completed: 0,
    interrupted: 0,
    failed: 0,
    cancelled: 0,
    rolled_back: 0,
  },
  orchestration_v2_effect_outbox: { pending: 1, running: 1, succeeded: 0, failed: 0, cancelled: 0 },
  orchestration_v2_projection_runtime_requests: {
    pending: 1,
    resolved: 0,
    expired: 0,
    cancelled: 0,
  },
};
const hash = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const workTotal = (work: ReturnType<typeof inspectStoppedRepairWork>) =>
  work.activeRuns +
  work.queuedRuns +
  work.pendingRequests +
  work.backgroundAgents +
  work.scheduledWork +
  work.restartContinuations;

async function fixture(
  run: (input: {
    database: string;
    preview: () => ReturnType<typeof previewHomeRepair>;
    insert: (table: string, status: string, ordinal?: number) => void;
    clear: (table: string) => void;
  }) => void,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-work-state-fixture-"));
  try {
    await createHomeRepairFixture(root);
    const database = NodePath.join(root, ".t3", "userdata", "statev2.sqlite");
    const allowedTables = new Set<string>(nativeWorkStatusDefinitions.map(([table]) => table));
    const mutate = (table: string, status?: string, ordinal = 0) => {
      if (!allowedTables.has(table)) throw new Error("Unrecognized synthetic status table");
      const db = new NodeSqlite.DatabaseSync(database);
      try {
        if (status === undefined) {
          db.exec(`DELETE FROM ${table}`);
          return;
        }
        const thread = String(
          db.prepare("SELECT thread_id FROM orchestration_v2_projection_threads LIMIT 1").get()!
            .thread_id,
        );
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .filter(
            (row) => row.pk || (row.notnull && row.dflt_value === null) || row.name === "thread_id",
          );
        const names = columns.map((row) => String(row.name));
        db.prepare(
          `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
        ).run(
          ...columns.map((row) =>
            row.name === "status"
              ? status
              : row.name === "thread_id"
                ? thread
                : row.name === "provider"
                  ? "claude"
                  : String(row.type).includes("INT")
                    ? ordinal
                    : String(row.name).endsWith("json")
                      ? "{}"
                      : `synthetic-${String(row.name)}-${ordinal}`,
          ),
        );
      } finally {
        db.close();
      }
    };
    run({
      database,
      insert: (table, status, ordinal) => mutate(table, status, ordinal),
      clear: (table) => mutate(table),
      preview: () =>
        previewHomeRepair({
          userHomeDirectory: root,
          localAppData: NodePath.join(root, "AppData", "Local"),
          appDataDirectory: NodePath.join(root, "AppData", "Roaming"),
          supportedMigrationIds,
        }),
    });
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(root).startsWith("t3-work-state-fixture-")
    )
      throw new Error("Unsafe synthetic fixture cleanup");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

NodeTest.test("genuine schema67 seventeen rolled-back runs remain terminal history", async () => {
  await fixture(({ database, insert, preview }) => {
    for (let n = 0; n < 17; n++) insert("orchestration_v2_projection_runs", "rolled_back", n);
    const before = hash(database);
    NodeAssert.equal(preview().original.activeWork, 0);
    NodeAssert.equal(workTotal(inspectStoppedRepairWork(database)), 0);
    NodeAssert.equal(hash(database), before);
  });
});

NodeTest.test(
  "genuine schema67 catalogue covers native active, queued, terminal and unknown states",
  async () => {
    await fixture(({ database, insert, clear, preview }) => {
      for (const [table, allowed, busy] of nativeWorkStatusDefinitions) {
        for (const status of allowed) {
          insert(table, status);
          const before = hash(database);
          const blocks =
            ((busy as readonly string[]).includes(status) &&
              !(table === "orchestration_v2_projection_provider_sessions" && status === "ready") &&
              !(table === "orchestration_v2_projection_provider_threads" && status === "active")) ||
            (table === "orchestration_v2_projection_runs" && status === "queued");
          NodeAssert.equal(
            workTotal(inspectStoppedRepairWork(database)) > 0,
            blocks,
            `${table}/${status}`,
          );
          if (previewTables.has(table)) {
            NodeAssert.notEqual(
              expectedPreview[table]?.[status],
              undefined,
              `Unreviewed preview state ${table}/${status}`,
            );
            NodeAssert.equal(
              preview().original.activeWork,
              expectedPreview[table]![status],
              `${table}/${status}`,
            );
          }
          NodeAssert.equal(hash(database), before);
          clear(table);
        }
        try {
          insert(table, "unknown-state");
        } catch (error) {
          // A genuine SQL CHECK may reject the invalid state before it can be persisted.
          NodeAssert.match(String(error), /CHECK constraint failed/);
          NodeAssert.equal(workTotal(inspectStoppedRepairWork(database)), 0);
          continue;
        }
        NodeAssert.throws(
          () => inspectStoppedRepairWork(database),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "reason" in error &&
            error.reason === "schema",
        );
        if (previewTables.has(table)) {
          const report = preview();
          NodeAssert.equal(report.original.activeWork, null);
          NodeAssert.ok(report.original.blockers.includes("active-work-inspection-unknown"));
        }
        clear(table);
      }
    });
  },
);

NodeTest.test(
  "preview uses native warm-session correlation for terminal and unfinished work",
  async () => {
    await fixture(({ database, insert, preview }) => {
      insert("orchestration_v2_projection_provider_sessions", "ready");
      insert("orchestration_v2_projection_provider_threads", "active");
      insert("orchestration_v2_projection_runs", "completed");
      const before = hash(database);
      NodeAssert.equal(preview().original.activeWork, 0);
      NodeAssert.equal(workTotal(inspectStoppedRepairWork(database)), 0);
      NodeAssert.equal(hash(database), before);
      insert("orchestration_v2_projection_runs", "waiting", 1);
      const busy = inspectStoppedRepairWork(database);
      NodeAssert.ok(busy.backgroundAgents > 0);
      NodeAssert.equal(preview().original.activeWork, workTotal(busy));
    });
  },
);

NodeTest.test("preview keeps native projection and deferred-work checks fail-closed", async () => {
  await fixture(({ database, insert, clear, preview }) => {
    insert("orchestration_v2_projection_provider_threads", "active");
    const db = new NodeSqlite.DatabaseSync(database);
    try {
      db.exec(
        "UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_object('goal',json_object('objective','Retain synthetic deferred work','status','active'))",
      );
    } finally {
      db.close();
    }
    NodeAssert.ok(preview().original.activeWork! > 0);
    clear("orchestration_v2_projection_provider_threads");
    const lag = new NodeSqlite.DatabaseSync(database);
    try {
      lag.exec(
        "UPDATE orchestration_v2_projection_metadata SET last_sequence=last_sequence+1 WHERE projection_name='thread-projections'",
      );
    } finally {
      lag.close();
    }
    const report = preview();
    NodeAssert.equal(report.original.activeWork, null);
    NodeAssert.ok(report.original.blockers.includes("active-work-inspection-unknown"));
    NodeAssert.equal(report.state, "blocked");
  });
});
