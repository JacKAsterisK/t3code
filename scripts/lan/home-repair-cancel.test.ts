// @effect-diagnostics nodeBuiltinImport:off -- Genuine synthetic schema67 state, never installed homes or providers.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import { test, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import {
  seedCancellationFixture as seed,
  migrateCancellationFixtureDatabase,
} from "./home-repair-cancel.fixture-builder.ts";
import { cancelRepairStagedWork } from "./home-repair-cancel-staged.ts";
import {
  cancelOriginalWork,
  rollbackOriginalWorkCancellation,
  type WorkCancellationPorts,
} from "./home-repair-cancel.ts";
import { previewHomeRepair, supportedMigrationIds } from "./home-repair.ts";
import { treeDigest } from "./home-repair-executor.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";

async function fixture(run: (home: string, file: string) => Promise<void>, secondThread = false) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cancel-domain-"));
  try {
    const home = NodePath.join(root, "T3CodeLAN", "recovery", "a".repeat(32), "staged-original");
    NodeFS.mkdirSync(NodePath.join(home, "userdata", "attachments"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, "userdata", "attachments", "retained.txt"),
      "Retained attachment bytes",
    );
    const file = NodePath.join(home, "userdata", "statev2.sqlite");
    await migrateCancellationFixtureDatabase(file, 67);
    await seed(file, secondThread);
    const schedules = new NodeSqlite.DatabaseSync(file);
    try {
      schedules.exec(`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_at,last_run_status,last_run_error,run_count)
      VALUES ('retained-disabled','Retained disabled schedule','Synthetic only',0,'{}','project:fixture',NULL,'{}','{}','full-access','default','user','web','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z',NULL,NULL,'completed',NULL,1)`);
    } finally {
      schedules.close();
    }
    await run(home, file);
  } finally {
    if (
      NodePath.dirname(root) !== NodeOS.tmpdir() ||
      !NodePath.basename(root).startsWith("t3-cancel-domain-")
    )
      throw new Error("Unsafe fixture cleanup");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
test("schema67 14 queued, one running and two pending requests cancel while retaining history and creating no effects", async () =>
  fixture(async (home, file) => {
    const before = inspectStoppedRepairWork(file);
    NodeAssert.equal(before.activeRuns, 1);
    NodeAssert.equal(before.queuedRuns, 14);
    NodeAssert.equal(before.pendingRequests, 2);
    NodeAssert.deepEqual(
      [
        before.activeRuns,
        before.queuedRuns,
        before.pendingRequests,
        before.backgroundAgents,
        before.scheduledWork,
        before.restartContinuations,
      ],
      [1, 14, 2, 472, 0, 0],
    );
    const childProcessModule: typeof NodeChildProcess = NodeModule.createRequire(import.meta.url)(
      "node:child_process",
    );
    using _restoreNamedExports = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
    using spawn = vi.spyOn(childProcessModule, "spawn").mockImplementation(() => {
      throw new Error("Unexpected subprocess");
    });
    using fork = vi.spyOn(childProcessModule, "fork").mockImplementation(() => {
      throw new Error("Unexpected subprocess");
    });
    using execFile = vi.spyOn(childProcessModule, "execFile").mockImplementation(() => {
      throw new Error("Unexpected subprocess");
    });
    NodeModule.syncBuiltinESMExports();
    const result = await cancelRepairStagedWork(home, "a".repeat(32));
    NodeAssert.equal(
      spawn.mock.calls.length + fork.mock.calls.length + execFile.mock.calls.length,
      0,
    );
    NodeAssert.equal(result.providerLaunches, 0);
    const stopped = inspectStoppedRepairWork(file);
    NodeAssert.deepEqual(
      [
        stopped.activeRuns,
        stopped.queuedRuns,
        stopped.pendingRequests,
        stopped.backgroundAgents,
        stopped.scheduledWork,
        stopped.restartContinuations,
      ],
      [0, 0, 0, 0, 0, 0],
    );
    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      NodeAssert.deepEqual(
        JSON.parse(
          String(
            db
              .prepare(
                "SELECT json_extract(payload_json,'$.attachments') attachments FROM orchestration_v2_projection_messages WHERE message_id='message:0'",
              )
              .get()!.attachments,
          ),
        ),
        [
          {
            type: "file",
            id: "retained",
            name: "retained.txt",
            mimeType: "text/plain",
            sizeBytes: 25,
          },
        ],
      );
      NodeAssert.equal(
        db.prepare("SELECT enabled FROM scheduled_tasks WHERE task_id='retained-disabled'").get()!
          .enabled,
        0,
      );
      NodeAssert.equal(
        db.prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_messages").get()!.n,
        16,
      );
      NodeAssert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_v2_projection_runs WHERE status='cancelled'",
          )
          .get()!.n,
        15,
      );
      NodeAssert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_v2_projection_runtime_requests WHERE status='cancelled'",
          )
          .get()!.n,
        2,
      );
      NodeAssert.equal(
        db.prepare("SELECT COUNT(*) n FROM orchestration_v2_effect_outbox").get()!.n,
        0,
      );
      NodeAssert.equal(
        db.prepare("SELECT MAX(migration_id) n FROM effect_sql_migrations").get()!.n,
        Math.max(...supportedMigrationIds),
      );
      NodeAssert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_command_receipts WHERE command_type='home-repair.cancel-unfinished'",
          )
          .get()!.n,
        1,
      );
      NodeAssert.equal(
        db
          .prepare(
            "SELECT json_extract(payload_json,'$.text') text FROM orchestration_v2_projection_messages WHERE message_id='message:streaming'",
          )
          .get()!.text,
        "Retained partial response",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(home, "userdata", "attachments", "retained.txt"), "utf8"),
        "Retained attachment bytes",
      );
    } finally {
      db.close();
    }
    NodeAssert.equal((await cancelRepairStagedWork(home, "a".repeat(32))).events, 0);
  }));

const retainedGoal = {
  objective: "Retain the synthetic offline goal objective",
  status: "active",
  tokensUsed: 17,
  tokenBudget: 500,
  timeUsedSeconds: 8,
  checks: 3,
  lastCheck: "Synthetic retained goal progress",
};

function setFixtureGoal(file: string, status: string, goal: object) {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    const prior = JSON.parse(
      String(
        db
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='provider-thread:fixture'",
          )
          .get()!.payload_json,
      ),
    );
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_threads SET status=?,payload_json=? WHERE provider_thread_id='provider-thread:fixture'",
    ).run(status, JSON.stringify({ ...prior, status, goal }));
  } finally {
    db.close();
  }
}

test.each(["active", "idle", "not_loaded"])(
  "offline cancellation pauses an active goal owned by a %s provider thread through the domain event sink",
  async (status) =>
    fixture(async (home, file) => {
      await cancelRepairStagedWork(home, "a".repeat(32));
      setFixtureGoal(file, status, retainedGoal);
      const before = inspectStoppedRepairWork(file);
      NodeAssert.equal(before.backgroundAgents, status === "active" ? 2 : 1);
      const prior = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      let head: number;
      try {
        head = Number(prior.prepare("SELECT MAX(sequence) n FROM orchestration_events").get()!.n);
      } finally {
        prior.close();
      }
      const result = await cancelRepairStagedWork(home, "c".repeat(32));
      NodeAssert.equal(result.events, 1);
      NodeAssert.equal(result.providerLaunches, 0);
      const after = inspectStoppedRepairWork(file);
      NodeAssert.deepEqual(
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
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        const thread = db
          .prepare(
            "SELECT status,payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='provider-thread:fixture'",
          )
          .get()!;
        const payload = JSON.parse(String(thread.payload_json));
        NodeAssert.equal(thread.status, status === "active" ? "idle" : status);
        NodeAssert.deepEqual(payload.goal, { ...retainedGoal, status: "paused" });
        const events = db
          .prepare(
            "SELECT payload_json FROM orchestration_events WHERE event_type='provider-thread.updated' AND sequence>?",
          )
          .all(head);
        NodeAssert.equal(events.length, 1);
        NodeAssert.deepEqual(JSON.parse(String(events[0]!.payload_json)).goal, payload.goal);
        NodeAssert.equal(
          db
            .prepare(
              "SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'",
            )
            .get()!.last_sequence,
          db.prepare("SELECT MAX(sequence) n FROM orchestration_events").get()!.n,
        );
        NodeAssert.equal(
          db.prepare("SELECT COUNT(*) n FROM orchestration_v2_effect_outbox").get()!.n,
          0,
        );
        NodeAssert.equal(
          db.prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_messages").get()!.n,
          16,
        );
      } finally {
        db.close();
      }
      NodeAssert.equal((await cancelRepairStagedWork(home, "c".repeat(32))).events, 0);
    }),
);

test("goal pause survives snapshot installation and cancellation rollback restores the active goal and history", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const file = NodePath.join(original, "userdata", "statev2.sqlite");
    setFixtureGoal(file, "not_loaded", retainedGoal);
    const before = treeDigest(original);
    const result = await cancelOriginalWork(
      options,
      { ...request, expectedPlanId: previewHomeRepair(options).planId },
      ports,
    );
    const after = inspectStoppedRepairWork(file);
    NodeAssert.deepEqual(
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
    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT status,payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='provider-thread:fixture'",
        )
        .get()!;
      NodeAssert.equal(row.status, "not_loaded");
      NodeAssert.deepEqual(JSON.parse(String(row.payload_json)).goal, {
        ...retainedGoal,
        status: "paused",
      });
    } finally {
      db.close();
    }
    NodeAssert.equal(result.expectedPlanId, previewHomeRepair(options).planId);
    await rollbackOriginalWorkCancellation(options, request.repairId, ports);
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
    const restored = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      NodeAssert.deepEqual(
        JSON.parse(
          String(
            restored
              .prepare(
                "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='provider-thread:fixture'",
              )
              .get()!.payload_json,
          ),
        ).goal,
        retainedGoal,
      );
    } finally {
      restored.close();
    }
  }));

async function transactionFixture(
  run: (context: {
    options: {
      userHomeDirectory: string;
      localAppData: string;
      appDataDirectory: string;
      supportedMigrationIds: readonly number[];
    };
    original: string;
    ports: WorkCancellationPorts;
    request: {
      schemaVersion: 1;
      expectedPlanId: string;
      repairId: string;
      cancelUnfinishedWorkApproved: true;
      opaqueBackupApproved: true;
    };
  }) => Promise<void>,
) {
  await fixture(async (home) => {
    const root = NodePath.resolve(home, "../../../..");
    const user = NodePath.join(root, "user");
    const original = NodePath.join(user, ".t3");
    NodeFS.mkdirSync(user);
    NodeFS.renameSync(home, original);
    NodeFS.writeFileSync(
      NodePath.join(original, "userdata", "environment-id"),
      "11111111-1111-4111-8111-111111111111\n",
    );
    const options = {
      userHomeDirectory: user,
      localAppData: NodePath.join(user, "AppData", "Local"),
      appDataDirectory: NodePath.join(user, "AppData", "Roaming"),
      supportedMigrationIds,
    };
    const profile = NodePath.join(options.appDataDirectory, "t3code-v2");
    NodeFS.mkdirSync(profile, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(profile, "Local State"),
      "opaque synthetic profile, no credential",
    );
    let admitted = false;
    const ports: WorkCancellationPorts = {
      withExclusiveAdmission: async (_resources, operation) => {
        NodeAssert.equal(admitted, false);
        admitted = true;
        try {
          return await operation();
        } finally {
          admitted = false;
        }
      },
      verifyStoppedForCancellation: async (_resources, expected) => {
        NodeAssert.equal(admitted, true);
        NodeAssert.equal(expected, original);
      },
    };
    await run({
      options,
      original,
      ports,
      request: {
        schemaVersion: 1,
        expectedPlanId: previewHomeRepair(options).planId,
        repairId: "b".repeat(32),
        cancelUnfinishedWorkApproved: true,
        opaqueBackupApproved: true,
      },
    });
  });
}

test("coherent cancellation snapshot preserves schema67 originals and rollback restores complete history bytes", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const before = treeDigest(original);
    const beforeActiveWork = previewHomeRepair(options).original.activeWork;
    NodeAssert.ok(beforeActiveWork! > 0);
    const result = await cancelOriginalWork(options, request, ports);
    const receipt = JSON.parse(NodeFS.readFileSync(result.receiptPath, "utf8"));
    NodeAssert.equal(treeDigest(receipt.snapshot.backup).sha256, before.sha256);
    NodeAssert.equal(
      inspectStoppedRepairWork(NodePath.join(original, "userdata", "statev2.sqlite")).queuedRuns,
      0,
    );
    NodeAssert.equal(previewHomeRepair(options).original.counts.messages, 16);
    await rollbackOriginalWorkCancellation(options, request.repairId, ports);
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
    NodeAssert.equal(previewHomeRepair(options).original.activeWork, beforeActiveWork);
    await rollbackOriginalWorkCancellation(options, request.repairId, ports);
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
  }));

test("staging failure and stale preview leave every original home byte unchanged", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const before = treeDigest(original);
    await NodeAssert.rejects(
      cancelOriginalWork(options, { ...request, expectedPlanId: "0".repeat(64) }, ports),
      /stale/,
    );
    await NodeAssert.rejects(
      cancelOriginalWork(options, request, {
        ...ports,
        cancelStagedWork: async () => {
          throw new Error("synthetic staging failure");
        },
      }),
      /synthetic/,
    );
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(options.localAppData, "T3CodeLAN", "home-repair.json")),
      false,
    );
  }));

test("new work prevents cancellation rollback without losing the snapshot", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const result = await cancelOriginalWork(options, request, ports);
    NodeFS.writeFileSync(
      NodePath.join(original, "userdata", "attachments", "new-work.txt"),
      "new work retained",
    );
    await NodeAssert.rejects(
      rollbackOriginalWorkCancellation(options, request.repairId, ports),
      /New work/,
    );
    NodeAssert.equal(
      NodeFS.readFileSync(
        NodePath.join(original, "userdata", "attachments", "new-work.txt"),
        "utf8",
      ),
      "new work retained",
    );
    NodeAssert.equal(NodeFS.existsSync(result.receiptPath), true);
  }));

test("interrupted installation recovery restores retired schema67 database without a readable installed database", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const before = treeDigest(original);
    const result = await cancelOriginalWork(options, request, ports);
    const receipt = JSON.parse(NodeFS.readFileSync(result.receiptPath, "utf8"));
    NodeFS.renameSync(
      NodePath.join(original, "userdata", "statev2.sqlite"),
      NodePath.join(NodePath.dirname(result.receiptPath), "interrupted-candidate.sqlite"),
    );
    NodeFS.writeFileSync(
      result.receiptPath,
      JSON.stringify({ ...receipt, status: "prepared", afterSha256: null }),
    );
    NodeFS.writeFileSync(
      NodePath.join(options.localAppData, "T3CodeLAN", "home-repair.json"),
      JSON.stringify({
        schemaVersion: 1,
        operation: "cancel-original-work",
        repairId: request.repairId,
        receiptPath: result.receiptPath,
      }),
    );
    await rollbackOriginalWorkCancellation(options, request.repairId, ports, true);
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
  }));

test("failure in the second conversation rolls back earlier cancellation events and receipts", async () =>
  fixture(async (home, file) => {
    const setup = new NodeSqlite.DatabaseSync(file);
    const before = setup.prepare("SELECT COUNT(*) n FROM orchestration_events").get()!.n;
    setup.exec(
      "CREATE TRIGGER fixture_reject_second BEFORE INSERT ON orchestration_command_receipts WHEN NEW.aggregate_id='thread:second' BEGIN SELECT RAISE(ABORT,'synthetic second conversation failure'); END",
    );
    setup.close();
    await NodeAssert.rejects(cancelRepairStagedWork(home, "a".repeat(32)));
    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      NodeAssert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_v2_projection_runs WHERE status='cancelled'",
          )
          .get()!.n,
        0,
      );
      NodeAssert.equal(
        db
          .prepare("SELECT COUNT(*) n FROM orchestration_v2_projection_runs WHERE status='queued'")
          .get()!.n,
        15,
      );
      NodeAssert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_command_receipts WHERE command_type='home-repair.cancel-unfinished'",
          )
          .get()!.n,
        0,
      );
      NodeAssert.equal(db.prepare("SELECT COUNT(*) n FROM orchestration_events").get()!.n, before);
    } finally {
      db.close();
    }
  }, true));

test("closed nonempty WAL is coherently staged and original DB plus WAL restore byte for byte", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const file = NodePath.join(original, "userdata", "statev2.sqlite");
    const writer = new NodeSqlite.DatabaseSync(file);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture_wal_history(text TEXT); INSERT INTO fixture_wal_history VALUES('Retained WAL-only history')",
    );
    const main = NodeFS.readFileSync(file),
      wal = NodeFS.readFileSync(file + "-wal");
    NodeAssert.ok(wal.length > 32);
    writer.close();
    NodeFS.writeFileSync(file, main);
    NodeFS.writeFileSync(file + "-wal", wal);
    const before = treeDigest(original);
    const result = await cancelOriginalWork(
      options,
      { ...request, expectedPlanId: previewHomeRepair(options).planId },
      ports,
    );
    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      NodeAssert.equal(
        db.prepare("SELECT text FROM fixture_wal_history").get()!.text,
        "Retained WAL-only history",
      );
    } finally {
      db.close();
    }
    await rollbackOriginalWorkCancellation(options, request.repairId, ports);
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
    NodeAssert.deepEqual(NodeFS.readFileSync(file), main);
    NodeAssert.deepEqual(NodeFS.readFileSync(file + "-wal"), wal);
    NodeAssert.ok(NodeFS.existsSync(result.receiptPath));
  }));

test("enabled schedule is refused before any cancellation or snapshot installation", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(original, "userdata", "statev2.sqlite"));
    db.exec("UPDATE scheduled_tasks SET enabled=1");
    db.close();
    const before = treeDigest(original);
    await NodeAssert.rejects(
      cancelOriginalWork(
        options,
        { ...request, expectedPlanId: previewHomeRepair(options).planId },
        ports,
      ),
      /Schedules/,
    );
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
  }));

test("payload and indexed lifecycle disagreement fails without appending cancellation events", async () =>
  fixture(async (home, file) => {
    const db = new NodeSqlite.DatabaseSync(file);
    const before = db.prepare("SELECT COUNT(*) n FROM orchestration_events").get()!.n;
    db.exec(
      "UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.status','completed') WHERE run_id='run:0'",
    );
    db.close();
    await NodeAssert.rejects(cancelRepairStagedWork(home, "a".repeat(32)));
    const after = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      NodeAssert.equal(
        after.prepare("SELECT COUNT(*) n FROM orchestration_events").get()!.n,
        before,
      );
      NodeAssert.equal(
        after
          .prepare(
            "SELECT COUNT(*) n FROM orchestration_v2_projection_runs WHERE status='cancelled'",
          )
          .get()!.n,
        0,
      );
    } finally {
      after.close();
    }
  }));

test("returned cancellation plan matches a fresh preview before releasing the same admission", async () =>
  transactionFixture(async ({ options, ports, request }) => {
    let checked = false;
    const held: WorkCancellationPorts = {
      ...ports,
      withExclusiveAdmission: async (resources, operation) =>
        ports.withExclusiveAdmission(resources, async () => {
          const result = await operation();
          if (result !== null && typeof result === "object" && "expectedPlanId" in result) {
            NodeAssert.equal(result.expectedPlanId, previewHomeRepair(options).planId);
            checked = true;
          }
          return result;
        }),
    };
    await cancelOriginalWork(options, request, held);
    NodeAssert.equal(checked, true);
  }));

test("failure after journal cleanup restores the barrier before rollback and retains exact original history", async () =>
  transactionFixture(async ({ options, original, ports, request }) => {
    const before = treeDigest(original);
    const beforeActiveWork = previewHomeRepair(options).original.activeWork;
    NodeAssert.ok(beforeActiveWork! > 0);
    const journal = NodePath.join(options.localAppData, "T3CodeLAN", "home-repair.json");
    const fsModule: typeof NodeFS = NodeModule.createRequire(import.meta.url)("node:fs");
    const realUnlink = fsModule.unlinkSync;
    let failed = false,
      barrierRechecked = false;
    using _restoreNamedExports = { [Symbol.dispose]: () => NodeModule.syncBuiltinESMExports() };
    using _unlink = vi.spyOn(fsModule, "unlinkSync").mockImplementation((file) => {
      realUnlink(file);
      if (String(file) === journal && !failed) {
        failed = true;
        throw new Error("synthetic failure after journal cleanup");
      }
    });
    NodeModule.syncBuiltinESMExports();
    await NodeAssert.rejects(
      cancelOriginalWork(options, request, {
        ...ports,
        verifyStoppedForCancellation: async (resources, home) => {
          await ports.verifyStoppedForCancellation(resources, home);
          if (failed) {
            NodeAssert.equal(NodeFS.existsSync(journal), true);
            barrierRechecked = true;
          }
        },
      }),
      /synthetic failure after journal cleanup/,
    );
    NodeAssert.equal(barrierRechecked, true);
    NodeAssert.equal(NodeFS.existsSync(journal), false);
    NodeAssert.equal(treeDigest(original).sha256, before.sha256);
    NodeAssert.equal(previewHomeRepair(options).original.activeWork, beforeActiveWork);
  }));
