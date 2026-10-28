// @effect-diagnostics nodeBuiltinImport:off -- Genuine synthetic schemas and opaque profiles exercise offline adoption without installed state.
import * as NodeTest from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { createHomeRepairFixture } from "./home-repair.fixture-builder.ts";
import { previewHomeRepair, supportedMigrationIds } from "./home-repair.ts";
import { runNativeHomeRepair } from "./home-repair-native.ts";
import { treeDigest, type HomeRepairExecutionPorts } from "./home-repair-executor.ts";
import { migrateRepairStagedHome, validateRepairStagedHome } from "./home-repair-migrations.ts";
import { inspectNativeUpdateWork } from "../../apps/server/src/lan/NativeMaintenance.ts";
import {
  nativeHomePaths,
  resolveNativeHomeSelection,
} from "../../packages/shared/src/nativeHomeSelection.ts";

async function fixture(
  run: (input: {
    options: Parameters<typeof previewHomeRepair>[0];
    original: string;
    lan: string;
    ports: HomeRepairExecutionPorts;
    mutate: (sql: string, home?: string) => void;
  }) => Promise<void>,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-work-"));
  try {
    const created = await createHomeRepairFixture(root);
    const options = {
      userHomeDirectory: root,
      localAppData: created.localAppData,
      appDataDirectory: created.appDataDirectory,
      supportedMigrationIds,
    };
    const original = NodePath.join(root, ".t3");
    const lan = NodePath.join(options.localAppData, "T3CodeLAN", "data");
    const mutate = (sql: string, home = original) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    };
    // Preserve a queued agent input as exact durable work rather than settling or starting it.
    mutate(`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES ('run:queued','fixture-0',1,'codex','queued','2026-10-27T00:00:00Z','{"id":"run:queued","threadId":"fixture-0","status":"queued","userMessageId":"fixture-0"}')`);
    let held = false;
    const ports: HomeRepairExecutionPorts = {
      withExclusiveAdmission: async (resources, operation) => {
        NodeAssert.equal(held, false);
        NodeAssert.ok(resources.homes.includes(original));
        held = true;
        try {
          return await operation();
        } finally {
          held = false;
        }
      },
      verifyStoppedAndIdle: async () => {
        NodeAssert.equal(held, true);
      },
      migrateStagedHome: async (home) => {
        NodeAssert.equal(held, true);
        await migrateRepairStagedHome(home);
      },
      validateStagedHome: validateRepairStagedHome,
    };
    await run({ options, original, lan, ports, mutate });
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(root).startsWith("t3-adopt-work-")
    )
      // eslint-disable-next-line no-unsafe-finally -- Never remove a fixture directory without checking its exact temporary root.
      throw new Error("Unsafe adoption fixture cleanup");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

const requestFor = (options: Parameters<typeof previewHomeRepair>[0]) => {
  const preview = previewHomeRepair(options);
  return {
    schemaVersion: 1,
    expectedPlanId: preview.planId,
    choice: "adopt-original-retain-lan",
    opaqueBackupApproved: true,
    repairId: "b".repeat(32),
    expectedOriginalEnvironmentId: preview.original.environmentId,
    expectedLanEnvironmentId: preview.lan.environmentId,
    admissionOwnerPid: process.ppid,
  };
};

NodeTest.test(
  "adopts original unfinished work through staged 67-to-current migrations and held recovery",
  () =>
    fixture(async ({ options, original, lan, ports }) => {
      const request = requestFor(options);
      NodeAssert.equal(previewHomeRepair(options).original.activeWork, 1);
      const before = [treeDigest(original), treeDigest(lan)];
      const work = inspectNativeUpdateWork(
        NodePath.join(original, "userdata", "statev2.sqlite"),
      ).workGeneration;
      const result = await runNativeHomeRepair("adopt-original-with-work", request, options, ports);
      if (result.status !== "selected-pending-verification")
        throw new Error("Unexpected adoption result");
      const adopted = result as typeof result & {
        operation: string;
        originalWorkGeneration: string;
        stagedOriginalWorkGeneration: string;
        unfinishedWorkPreserved: boolean;
      };
      NodeAssert.equal(adopted.operation, "adopt-original-with-work");
      NodeAssert.equal(adopted.unfinishedWorkPreserved, true);
      NodeAssert.equal(adopted.originalWorkGeneration, work);
      NodeAssert.equal(adopted.stagedOriginalWorkGeneration, work);
      NodeAssert.equal(result.homeDirectory, original);
      NodeAssert.equal(result.retainedHomeDirectory, lan);
      NodeAssert.equal(result.environmentId, request.expectedOriginalEnvironmentId);
      NodeAssert.deepEqual([treeDigest(original), treeDigest(lan)], before);
      NodeAssert.equal(resolveNativeHomeSelection(options).homeDirectory, original);
      const receipt = JSON.parse(NodeFS.readFileSync(result.receiptPath, "utf8"));
      NodeAssert.equal(receipt.operation, "adopt-original-with-work");
      NodeAssert.equal(receipt.originalWorkGeneration, work);
      NodeAssert.equal(receipt.stagedOriginalWorkGeneration, work);
      NodeAssert.equal(receipt.snapshots.length, 4);
      for (const snapshot of receipt.snapshots)
        NodeAssert.equal(treeDigest(snapshot.backup).sha256, snapshot.sha256);
      const staged = NodePath.join(
        NodePath.dirname(result.receiptPath),
        "staged-original",
        "userdata",
        "statev2.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(staged, { readOnly: true });
      try {
        NodeAssert.equal(
          db.prepare("SELECT MAX(migration_id) AS n FROM effect_sql_migrations").get()!.n,
          supportedMigrationIds.at(-1),
        );
        NodeAssert.equal(
          db
            .prepare(
              "SELECT status FROM orchestration_v2_projection_runs WHERE run_id='run:queued'",
            )
            .get()!.status,
          "queued",
        );
      } finally {
        db.close();
      }
      const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
      NodeFS.writeFileSync(
        paths.journalPath,
        JSON.stringify({ ...receipt, receiptPath: result.receiptPath }),
      );
      const recover = {
        schemaVersion: 1,
        repairId: request.repairId,
        expectedOriginalEnvironmentId: request.expectedOriginalEnvironmentId,
        expectedLanEnvironmentId: request.expectedLanEnvironmentId,
        admissionOwnerPid: process.ppid,
        recoveryOperation: "recover",
      };
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "recover-adopt-original-with-work",
          { ...recover, expectedOriginalEnvironmentId: "wrong" },
          options,
          ports,
        ),
      );
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "recover",
          { schemaVersion: 1, repairId: request.repairId },
          options,
          ports,
        ),
        /matching held recovery/,
      );
      const recovered = await runNativeHomeRepair(
        "recover-adopt-original-with-work",
        recover,
        options,
        ports,
      );
      NodeAssert.equal(recovered.status, "rolled-back");
      NodeAssert.equal(NodeFS.existsSync(paths.selectionPath), false);
      NodeAssert.deepEqual([treeDigest(original), treeDigest(lan)], before);
    }),
);

NodeTest.test.each(["source", "staged"] as const)(
  "refuses adoption when %s unfinished work changes",
  (changed) =>
    fixture(async ({ options, original, ports, mutate }) => {
      const request = requestFor(options);
      const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
      await NodeAssert.rejects(
        runNativeHomeRepair("adopt-original-with-work", request, options, {
          ...ports,
          migrateStagedHome: async (home) => {
            await ports.migrateStagedHome(home);
            mutate(
              "UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.note','changed work')",
              changed === "source" ? original : home,
            );
          },
        }),
        /changed|preserv/i,
      );
      NodeAssert.equal(NodeFS.existsSync(paths.selectionPath), false);
    }),
);

NodeTest.test("adoption refuses wrong owner, identity, choice and unknown original schema", () =>
  fixture(async ({ options, ports, mutate }) => {
    const request = requestFor(options);
    for (const change of [
      { admissionOwnerPid: process.ppid + 1 },
      { expectedOriginalEnvironmentId: "wrong" },
      { expectedLanEnvironmentId: "wrong" },
      { choice: "side-by-side-retain-original" },
      { opaqueBackupApproved: false },
      { unexpected: true },
    ])
      await NodeAssert.rejects(
        runNativeHomeRepair("adopt-original-with-work", { ...request, ...change }, options, ports),
      );
    mutate(
      "UPDATE orchestration_v2_projection_metadata SET last_sequence=1 WHERE projection_name='thread-projections'",
    );
    await NodeAssert.rejects(
      runNativeHomeRepair("adopt-original-with-work", requestFor(options), options, ports),
    );
    mutate(
      "UPDATE orchestration_v2_projection_metadata SET last_sequence=0 WHERE projection_name='thread-projections'; UPDATE orchestration_v2_projection_runs SET status='future'",
    );
    await NodeAssert.rejects(
      runNativeHomeRepair("adopt-original-with-work", requestFor(options), options, ports),
    );
  }),
);

NodeTest.test("adopts known original work without creating an absent LAN home", () =>
  fixture(async ({ options, original, lan, ports }) => {
    NodeFS.renameSync(lan, NodePath.join(NodePath.dirname(lan), "fixture-retained-lan"));
    const request = requestFor(options);
    NodeAssert.equal(request.expectedLanEnvironmentId, null);
    const result = await runNativeHomeRepair("adopt-original-with-work", request, options, ports);
    if (result.status !== "selected-pending-verification")
      throw new Error("Unexpected adoption result");
    NodeAssert.equal(result.homeDirectory, original);
    NodeAssert.equal(NodeFS.existsSync(lan), false);
  }),
);

NodeTest.test(
  "adoption recovery refuses a later legitimate source migration with unchanged durable work",
  () =>
    fixture(async ({ options, original, ports }) => {
      const request = requestFor(options);
      const result = await runNativeHomeRepair("adopt-original-with-work", request, options, ports);
      if (result.status !== "selected-pending-verification")
        throw new Error("Unexpected adoption result");
      const database = NodePath.join(original, "userdata", "statev2.sqlite");
      const before = inspectNativeUpdateWork(database).workGeneration;
      NodeFS.copyFileSync(
        NodePath.join(
          NodePath.dirname(result.receiptPath),
          "staged-original",
          "userdata",
          "statev2.sqlite",
        ),
        database,
      );
      NodeAssert.equal(inspectNativeUpdateWork(database).workGeneration, before);
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "recover-adopt-original-with-work",
          {
            schemaVersion: 1,
            repairId: request.repairId,
            expectedOriginalEnvironmentId: request.expectedOriginalEnvironmentId,
            expectedLanEnvironmentId: request.expectedLanEnvironmentId,
            admissionOwnerPid: process.ppid,
            recoveryOperation: "rollback",
          },
          options,
          ports,
        ),
        /Source data changed/,
      );
      NodeAssert.equal(resolveNativeHomeSelection(options).homeDirectory, original);
    }),
);

NodeTest.test("adoption rollback restores an existing valid LAN selection byte for byte", () =>
  fixture(async ({ options, lan, ports }) => {
    const priorRequest = requestFor(options);
    const {
      expectedOriginalEnvironmentId: _originalId,
      expectedLanEnvironmentId: _lanId,
      admissionOwnerPid: _owner,
      ...ordinary
    } = priorRequest;
    const prior = await runNativeHomeRepair(
      "apply",
      { ...ordinary, choice: "side-by-side-retain-original", repairId: "a".repeat(32) },
      options,
      ports,
    );
    if (prior.status !== "selected-pending-verification")
      throw new Error("Unexpected prior selection");
    const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
    const previousBytes = NodeFS.readFileSync(paths.selectionPath);
    const request = requestFor(options);
    await runNativeHomeRepair("adopt-original-with-work", request, options, ports);
    await runNativeHomeRepair(
      "recover-adopt-original-with-work",
      {
        schemaVersion: 1,
        repairId: request.repairId,
        expectedOriginalEnvironmentId: request.expectedOriginalEnvironmentId,
        expectedLanEnvironmentId: request.expectedLanEnvironmentId,
        admissionOwnerPid: process.ppid,
        recoveryOperation: "rollback",
      },
      options,
      ports,
    );
    NodeAssert.deepEqual(NodeFS.readFileSync(paths.selectionPath), previousBytes);
    NodeAssert.equal(resolveNativeHomeSelection(options).homeDirectory, lan);
  }),
);
