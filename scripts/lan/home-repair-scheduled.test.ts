// @effect-diagnostics nodeBuiltinImport:off -- Real migration schemas in generated temporary homes; no live state or provider is used.
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

const hash = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

for (const enabled of [0, 1, 2]) {
  NodeTest.test(
    `genuine schema 67 scheduled task enabled=${enabled} preserves native admission`,
    async () => {
      const root = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-scheduled-repair-fixture-"),
      );
      try {
        await createHomeRepairFixture(root);
        const database = NodePath.join(root, ".t3", "userdata", "statev2.sqlite");
        const db = new NodeSqlite.DatabaseSync(database);
        try {
          const columns = db
            .prepare("PRAGMA table_info(scheduled_tasks)")
            .all()
            .map((row) => row.name);
          NodeAssert.ok(columns.includes("enabled"));
          NodeAssert.ok(columns.includes("last_run_status"));
          NodeAssert.ok(!columns.includes("status"));
          NodeAssert.equal(
            db.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get()!.n,
            67,
          );
          db.prepare(`INSERT INTO scheduled_tasks
          (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,
           model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,
           created_at,updated_at,next_run_at,last_run_at,last_run_status,last_run_error,run_count)
          VALUES ('synthetic-schedule','Synthetic schedule','Synthetic fixture only',?,
            '{}','synthetic-project',NULL,'{}','{}','full-access','default','fixture','fixture',
            '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL,NULL,'completed',NULL,12)`).run(
            enabled,
          );
        } finally {
          db.close();
        }
        const before = hash(database);
        const report = previewHomeRepair({
          userHomeDirectory: root,
          localAppData: NodePath.join(root, "AppData", "Local"),
          appDataDirectory: NodePath.join(root, "AppData", "Roaming"),
          supportedMigrationIds,
        });
        NodeAssert.equal(report.original.activeWork, enabled === 2 ? null : enabled);
        NodeAssert.equal(report.lan.activeWork, 0);
        NodeAssert.equal(report.original.counts.messages, 1);
        NodeAssert.equal(report.lan.counts.messages, 2);
        if (enabled === 2) {
          NodeAssert.ok(report.original.blockers.includes("active-work-inspection-unknown"));
          NodeAssert.equal(report.state, "blocked");
          NodeAssert.throws(
            () => inspectStoppedRepairWork(database),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "reason" in error &&
              error.reason === "schema",
          );
        } else {
          NodeAssert.equal(report.original.state, "initialized");
          NodeAssert.equal(inspectStoppedRepairWork(database).scheduledWork, enabled);
        }
        NodeAssert.equal(hash(database), before);
      } finally {
        if (
          NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
          !NodePath.basename(root).startsWith("t3-scheduled-repair-fixture-")
        ) {
          throw new Error("Refusing unsafe synthetic fixture cleanup");
        }
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
