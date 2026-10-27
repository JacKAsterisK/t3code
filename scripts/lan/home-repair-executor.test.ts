// @effect-diagnostics nodeBuiltinImport:off -- Synthetic homes exercise transactions, retention, and rollback without installed state.
import * as NodeTest from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { previewHomeRepair, supportedMigrationIds, type PreviewOptions } from "./home-repair.ts";
import { runNativeHomeRepair } from "./home-repair-native.ts";
import {
  executeHomeRepair,
  rollbackHomeRepair,
  recoverHomeRepair,
  type HomeRepairExecutionPorts,
} from "./home-repair-executor.ts";
import {
  resolveNativeHomeSelection,
  assertNativeHomeMatchesSelection,
  nativeHomePaths,
} from "../../packages/shared/src/nativeHomeSelection.ts";

async function fixture(
  run: (input: {
    options: PreviewOptions;
    original: string;
    lan: string;
    ports: HomeRepairExecutionPorts;
  }) => Promise<void>,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-repair-executor-"));
  const options = {
    userHomeDirectory: root,
    localAppData: NodePath.join(root, "AppData", "Local"),
    appDataDirectory: NodePath.join(root, "AppData", "Roaming"),
    supportedMigrationIds,
  };
  const original = NodePath.join(root, ".t3");
  const lan = NodePath.join(options.localAppData, "T3CodeLAN", "data");
  let held = false;
  const ports: HomeRepairExecutionPorts = {
    withExclusiveAdmission: async (_resources, operation) => {
      NodeAssert.equal(held, false);
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
      NodeAssert.notEqual(home, original);
      const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      try {
        for (let id = 68; id <= 71; id++)
          db.prepare("INSERT INTO effect_sql_migrations VALUES(?)").run(id);
      } finally {
        db.close();
      }
    },
    validateStagedHome: async (home) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
        readOnly: true,
      });
      try {
        NodeAssert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
        NodeAssert.equal(
          db.prepare("SELECT text FROM orchestration_v2_projection_messages").get()!.text,
          "original message",
        );
      } finally {
        db.close();
      }
    },
  };
  try {
    for (const [home, id, migrations, text] of [
      [original, "11111111-1111-4111-8111-111111111111", 67, "original message"],
      [lan, "22222222-2222-4222-8222-222222222222", 71, "new LAN message"],
    ] as const) {
      NodeFS.mkdirSync(NodePath.join(home, "userdata", "attachments"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, "userdata", "environment-id"), id + "\n");
      NodeFS.writeFileSync(NodePath.join(home, "userdata", "attachments", "file.txt"), text);
      const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      db.exec(
        "CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY); CREATE TABLE orchestration_v2_projection_threads(id TEXT); CREATE TABLE orchestration_v2_projection_messages(text TEXT);",
      );
      for (let n = 1; n <= migrations; n++)
        db.prepare("INSERT INTO effect_sql_migrations VALUES(?)").run(n);
      db.exec("INSERT INTO orchestration_v2_projection_threads VALUES('fixture')");
      db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES(?)").run(text);
      db.close();
    }
    for (const profile of [
      NodePath.join(options.appDataDirectory, "t3code-v2"),
      NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile"),
    ]) {
      NodeFS.mkdirSync(profile, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(profile, "Local State"),
        "opaque fixture protection context",
      );
    }
    await run({ options, original, lan, ports });
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(root)) === NodePath.resolve(NodeOS.tmpdir()) &&
      NodePath.basename(root).startsWith("t3-repair-executor-")
    )
      NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

NodeTest.test(
  "manual retention binds only the existing LAN identity and preserves unfinished work",
  () =>
    fixture(async ({ options, original, lan, ports }) => {
      const database = NodePath.join(lan, "userdata", "statev2.sqlite");
      const db = new NodeSqlite.DatabaseSync(database);
      try {
        db.exec(
          "CREATE TABLE orchestration_v2_projection_runs(status TEXT); INSERT INTO orchestration_v2_projection_runs VALUES('running')",
        );
      } finally {
        db.close();
      }
      const originalDatabase = NodePath.join(original, "userdata", "statev2.sqlite");
      const originalDb = new NodeSqlite.DatabaseSync(originalDatabase);
      try {
        originalDb.exec(
          "CREATE TABLE orchestration_v2_projection_runs(status TEXT); INSERT INTO orchestration_v2_projection_runs VALUES('running')",
        );
      } finally {
        originalDb.close();
      }
      const before = NodeFS.readFileSync(database);
      const beforeOriginal = NodeFS.readFileSync(originalDatabase);
      const preview = previewHomeRepair(options);
      NodeAssert.equal(preview.lan.activeWork, 1);
      NodeAssert.equal(preview.original.activeWork, 1);
      const request = {
        schemaVersion: 1,
        expectedPlanId: preview.planId,
        choice: "side-by-side-retain-original",
        opaqueBackupApproved: true,
        repairId: "d".repeat(32),
        expectedLanEnvironmentId: preview.lan.environmentId,
        admissionOwnerPid: process.ppid,
      };
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "retain-selected-lan",
          { ...request, expectedLanEnvironmentId: "wrong" },
          options,
          ports,
        ),
      );
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "retain-selected-lan",
          { ...request, admissionOwnerPid: process.ppid + 1 },
          options,
          ports,
        ),
      );
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "retain-selected-lan",
          { ...request, expectedPlanId: "f".repeat(64) },
          options,
          ports,
        ),
      );
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "retain-selected-lan",
          { ...request, choice: "adopt-original-retain-lan" },
          options,
          ports,
        ),
      );
      const result = await runNativeHomeRepair("retain-selected-lan", request, options, ports);
      if (result.status !== "selected-pending-verification")
        throw new Error("Unexpected retention result");
      NodeAssert.equal(result.homeDirectory, lan);
      NodeAssert.equal(result.environmentId, preview.lan.environmentId);
      NodeAssert.deepEqual(NodeFS.readFileSync(database), before);
      NodeAssert.deepEqual(NodeFS.readFileSync(originalDatabase), beforeOriginal);
      const selected = resolveNativeHomeSelection(options);
      NodeAssert.equal(selected.homeDirectory, lan);
      NodeAssert.equal(
        selected.electronProfileDirectory,
        NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile"),
      );
      const receipt = JSON.parse(NodeFS.readFileSync(result.receiptPath, "utf8"));
      const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
      NodeFS.writeFileSync(
        paths.journalPath,
        JSON.stringify({
          schemaVersion: 1,
          repairId: request.repairId,
          receiptPath: result.receiptPath,
          previousSelection: receipt.previousSelection,
          operation: "retain-selected-lan",
          expectedLanEnvironmentId: request.expectedLanEnvironmentId,
          snapshots: receipt.snapshots,
        }),
      );
      const recover = {
        schemaVersion: 1,
        repairId: request.repairId,
        expectedLanEnvironmentId: request.expectedLanEnvironmentId,
        admissionOwnerPid: process.ppid,
        recoveryOperation: "recover",
      };
      await NodeAssert.rejects(
        runNativeHomeRepair(
          "recover-retain-selected-lan",
          { ...recover, expectedLanEnvironmentId: "wrong" },
          options,
          ports,
        ),
      );
      const rolledBack = await runNativeHomeRepair(
        "recover-retain-selected-lan",
        recover,
        options,
        ports,
      );
      NodeAssert.equal(rolledBack.status, "rolled-back");
      NodeAssert.deepEqual(NodeFS.readFileSync(database), before);
      NodeAssert.deepEqual(NodeFS.readFileSync(originalDatabase), beforeOriginal);
      NodeAssert.throws(() => resolveNativeHomeSelection(options), /Both original and LAN/);
    }),
);

NodeTest.test("manual retention refuses recovery of an adopt-original transaction", () =>
  fixture(async ({ options, original, ports }) => {
    const preview = previewHomeRepair(options);
    const repairId = "f".repeat(32);
    const result = await executeHomeRepair(
      options,
      {
        schemaVersion: 1,
        expectedPlanId: preview.planId,
        choice: "adopt-original-retain-lan",
        opaqueBackupApproved: true,
        repairId,
      },
      ports,
    );
    const receipt = JSON.parse(NodeFS.readFileSync(result.receiptPath, "utf8"));
    const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
    const selectionBefore = NodeFS.readFileSync(paths.selectionPath);
    NodeFS.writeFileSync(
      paths.journalPath,
      JSON.stringify({
        schemaVersion: 1,
        repairId,
        receiptPath: result.receiptPath,
        previousSelection: receipt.previousSelection,
        snapshots: receipt.snapshots,
      }),
    );
    await NodeAssert.rejects(
      runNativeHomeRepair(
        "recover-retain-selected-lan",
        {
          schemaVersion: 1,
          repairId,
          expectedLanEnvironmentId: preview.lan.environmentId,
          admissionOwnerPid: process.ppid,
          recoveryOperation: "recover",
        },
        options,
        ports,
      ),
      /retained LAN transaction/,
    );
    NodeAssert.deepEqual(NodeFS.readFileSync(paths.selectionPath), selectionBefore);
    NodeAssert.equal(result.homeDirectory, original);
  }),
);

NodeTest.test("manual retention refuses unknown unfinished work", () =>
  fixture(async ({ options, lan, ports }) => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(lan, "userdata", "statev2.sqlite"));
    try {
      db.exec(
        "CREATE TABLE orchestration_v2_projection_runs(status TEXT); INSERT INTO orchestration_v2_projection_runs VALUES('unknown')",
      );
    } finally {
      db.close();
    }
    const preview = previewHomeRepair(options);
    NodeAssert.equal(preview.lan.activeWork, null);
    await NodeAssert.rejects(
      runNativeHomeRepair(
        "retain-selected-lan",
        {
          schemaVersion: 1,
          expectedPlanId: preview.planId,
          choice: "side-by-side-retain-original",
          opaqueBackupApproved: true,
          repairId: "e".repeat(32),
          expectedLanEnvironmentId: preview.lan.environmentId,
          admissionOwnerPid: process.ppid,
        },
        options,
        ports,
      ),
    );
  }),
);

NodeTest.test(
  "split startup refuses automatic selection; apply selects complete original state and retains LAN",
  () =>
    fixture(async ({ options, original, lan, ports }) => {
      NodeAssert.throws(() => resolveNativeHomeSelection(options), /Both original and LAN/);
      const preview = previewHomeRepair(options);
      const result = await executeHomeRepair(
        options,
        {
          schemaVersion: 1,
          expectedPlanId: preview.planId,
          choice: "adopt-original-retain-lan",
          opaqueBackupApproved: true,
          repairId: "a".repeat(32),
        },
        ports,
      );
      NodeAssert.equal(result.status, "selected-pending-verification");
      NodeAssert.equal(result.restoredHistoryVerified, false);
      NodeAssert.equal(result.homeDirectory, original);
      NodeAssert.equal(result.retainedHomeDirectory, lan);
      const selection = resolveNativeHomeSelection(options);
      NodeAssert.equal(selection.homeDirectory, original);
      NodeAssert.equal(
        selection.electronProfileDirectory,
        NodePath.join(options.appDataDirectory, "t3code-v2"),
      );
      for (const [home, text] of [
        [original, "original message"],
        [lan, "new LAN message"],
      ]) {
        const db = new NodeSqlite.DatabaseSync(NodePath.join(home!, "userdata", "statev2.sqlite"), {
          readOnly: true,
        });
        NodeAssert.equal(
          db.prepare("SELECT text FROM orchestration_v2_projection_messages").get()!.text,
          text,
        );
        db.close();
      }
      const oldDb = new NodeSqlite.DatabaseSync(
        NodePath.join(original, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      NodeAssert.equal(
        oldDb.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get()!.n,
        67,
      );
      oldDb.close();
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(lan, "userdata", "attachments", "file.txt"), "utf8"),
        "new LAN message",
      );
      NodeAssert.equal(
        (await rollbackHomeRepair(options, "a".repeat(32), ports)).status,
        "rolled-back",
      );
      NodeAssert.throws(() => resolveNativeHomeSelection(options), /Both original and LAN/);
    }),
);

NodeTest.test(
  "staged migration failure leaves source identity/history/profile and selection unchanged",
  () =>
    fixture(async ({ options, original, ports }) => {
      const preview = previewHomeRepair(options);
      await NodeAssert.rejects(
        executeHomeRepair(
          options,
          {
            schemaVersion: 1,
            expectedPlanId: preview.planId,
            choice: "adopt-original-retain-lan",
            opaqueBackupApproved: true,
            repairId: "b".repeat(32),
          },
          {
            ...ports,
            migrateStagedHome: async () => {
              throw new Error("fixture migration failure");
            },
          },
        ),
        /fixture migration failure/,
      );
      NodeAssert.equal(
        NodeFS.existsSync(
          nativeHomePaths(options.userHomeDirectory, options.localAppData).selectionPath,
        ),
        false,
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(original, "userdata", "environment-id"), "utf8").trim(),
        "11111111-1111-4111-8111-111111111111",
      );
      NodeAssert.equal(previewHomeRepair(options).original.counts.messages, 1);
    }),
);

NodeTest.test("busy admission and stale previews fail before backup or selection", () =>
  fixture(async ({ options, ports }) => {
    const request = {
      schemaVersion: 1 as const,
      expectedPlanId: previewHomeRepair(options).planId,
      choice: "adopt-original-retain-lan" as const,
      opaqueBackupApproved: true as const,
      repairId: "c".repeat(32),
    };
    await NodeAssert.rejects(
      executeHomeRepair(options, request, {
        ...ports,
        verifyStoppedAndIdle: async () => {
          throw new Error("fixture busy");
        },
      }),
      /fixture busy/,
    );
    await NodeAssert.rejects(
      executeHomeRepair(options, { ...request, expectedPlanId: "f".repeat(64) }, ports),
      /stale/,
    );
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(options.localAppData, "T3CodeLAN", "recovery")),
      false,
    );
  }),
);

NodeTest.test("new work after selection blocks automatic rollback", () =>
  fixture(async ({ options, original, ports }) => {
    await executeHomeRepair(
      options,
      {
        schemaVersion: 1,
        expectedPlanId: previewHomeRepair(options).planId,
        choice: "adopt-original-retain-lan",
        opaqueBackupApproved: true,
        repairId: "d".repeat(32),
      },
      ports,
    );
    const db = new NodeSqlite.DatabaseSync(NodePath.join(original, "userdata", "statev2.sqlite"));
    db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES(?)").run(
      "new accepted work",
    );
    db.close();
    await NodeAssert.rejects(rollbackHomeRepair(options, "d".repeat(32), ports), /manual recovery/);
    NodeAssert.equal(previewHomeRepair(options).original.counts.messages, 2);
  }),
);

NodeTest.test(
  "interrupted post-selection transaction recovers only unchanged preserved homes",
  () =>
    fixture(async ({ options, ports }) => {
      const result = await executeHomeRepair(
        options,
        {
          schemaVersion: 1,
          expectedPlanId: previewHomeRepair(options).planId,
          choice: "adopt-original-retain-lan",
          opaqueBackupApproved: true,
          repairId: "e".repeat(32),
        },
        ports,
      );
      const receipt = JSON.parse(NodeFS.readFileSync(result.receiptPath, "utf8"));
      const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
      NodeFS.writeFileSync(
        paths.journalPath,
        JSON.stringify({
          schemaVersion: 1,
          repairId: receipt.repairId,
          receiptPath: result.receiptPath,
          previousSelection: receipt.previousSelection,
          snapshots: receipt.snapshots,
        }),
      );
      NodeFS.unlinkSync(result.receiptPath);
      NodeAssert.throws(() => resolveNativeHomeSelection(options), /incomplete/);
      NodeAssert.equal(
        (await recoverHomeRepair(options, "e".repeat(32), ports)).status,
        "rolled-back",
      );
      NodeAssert.equal(NodeFS.existsSync(paths.selectionPath), false);
      NodeAssert.equal(NodeFS.existsSync(paths.journalPath), false);
      NodeAssert.ok(NodeFS.existsSync(receipt.snapshots[0].backup));
    }),
);

NodeTest.test("startup refuses settings-only state rather than creating a new identity", () =>
  fixture(async ({ options, original }) => {
    NodeFS.unlinkSync(NodePath.join(original, "userdata", "environment-id"));
    NodeFS.unlinkSync(NodePath.join(original, "userdata", "statev2.sqlite"));
    NodeAssert.throws(
      () => resolveNativeHomeSelection(options),
      /existing state without an initialized identity/,
    );
  }),
);

NodeTest.test(
  "startup rechecks selection after admission and refuses a previously resolved old home",
  () =>
    fixture(async ({ options, original, lan, ports }) => {
      const preview = previewHomeRepair(options);
      await executeHomeRepair(
        options,
        {
          schemaVersion: 1,
          expectedPlanId: preview.planId,
          choice: "side-by-side-retain-original",
          opaqueBackupApproved: true,
          repairId: "c".repeat(32),
        },
        ports,
      );
      NodeAssert.throws(
        () => assertNativeHomeMatchesSelection(original, options),
        /changed before startup admission/,
      );
      NodeAssert.doesNotThrow(() => assertNativeHomeMatchesSelection(lan, options));
    }),
);

NodeTest.test("recovery finishes interrupted rollback after restoring the previous selection", () =>
  fixture(async ({ options, ports }) => {
    const preview = previewHomeRepair(options);
    const repairId = "d".repeat(32);
    const applied = await executeHomeRepair(
      options,
      {
        schemaVersion: 1,
        expectedPlanId: preview.planId,
        choice: "adopt-original-retain-lan",
        opaqueBackupApproved: true,
        repairId,
      },
      ports,
    );
    const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
    const receipt = JSON.parse(NodeFS.readFileSync(applied.receiptPath, "utf8"));
    NodeFS.writeFileSync(
      paths.journalPath,
      JSON.stringify({
        schemaVersion: 1,
        repairId,
        receiptPath: applied.receiptPath,
        previousSelection: receipt.previousSelection,
        snapshots: receipt.snapshots,
      }),
    );
    NodeFS.unlinkSync(paths.selectionPath);
    NodeAssert.deepEqual(await recoverHomeRepair(options, repairId, ports), {
      schemaVersion: 1,
      status: "rolled-back",
    });
    NodeAssert.equal(NodeFS.existsSync(paths.journalPath), false);
    NodeAssert.equal(
      JSON.parse(NodeFS.readFileSync(applied.receiptPath, "utf8")).status,
      "rolled-back",
    );
  }),
);

NodeTest.test(
  "LAN-only upgrades keep the existing identity/profile and support explicit retention plus rollback",
  () =>
    fixture(async ({ options, original, lan, ports }) => {
      const hidden = NodePath.join(options.userHomeDirectory, "fixture-unselected-original");
      NodeAssert.equal(NodePath.dirname(original), options.userHomeDirectory);
      NodeAssert.equal(NodePath.dirname(hidden), options.userHomeDirectory);
      NodeFS.renameSync(original, hidden);
      const selected = resolveNativeHomeSelection(options);
      NodeAssert.equal(selected.homeDirectory, lan);
      NodeAssert.equal(
        selected.electronProfileDirectory,
        NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile"),
      );
      NodeAssert.doesNotThrow(() => assertNativeHomeMatchesSelection(lan, options));
      const preview = previewHomeRepair(options);
      NodeAssert.equal(preview.state, "lan-only");
      const result = await executeHomeRepair(
        options,
        {
          schemaVersion: 1,
          expectedPlanId: preview.planId,
          choice: "side-by-side-retain-original",
          opaqueBackupApproved: true,
          repairId: "e".repeat(32),
        },
        {
          ...ports,
          migrateStagedHome: async () => {},
          validateStagedHome: async (home) => {
            const db = new NodeSqlite.DatabaseSync(
              NodePath.join(home, "userdata", "statev2.sqlite"),
              { readOnly: true },
            );
            try {
              NodeAssert.equal(
                db.prepare("SELECT text FROM orchestration_v2_projection_messages").get()!.text,
                "new LAN message",
              );
            } finally {
              db.close();
            }
          },
        },
      );
      NodeAssert.equal(result.homeDirectory, lan);
      NodeAssert.equal(result.environmentId, "22222222-2222-4222-8222-222222222222");
      NodeAssert.equal(NodeFS.existsSync(original), false);
      NodeAssert.equal(resolveNativeHomeSelection(options).homeDirectory, lan);
      await rollbackHomeRepair(options, "e".repeat(32), ports);
      NodeAssert.equal(resolveNativeHomeSelection(options).homeDirectory, lan);
      NodeAssert.equal(NodeFS.existsSync(original), false);
    }),
);

NodeTest.test(
  "LAN-only retention refuses an original home that appears during staging without discarding its work",
  () =>
    fixture(async ({ options, original, ports }) => {
      const hidden = NodePath.join(options.userHomeDirectory, "fixture-unselected-original");
      NodeAssert.equal(NodePath.dirname(original), options.userHomeDirectory);
      NodeAssert.equal(NodePath.dirname(hidden), options.userHomeDirectory);
      NodeFS.renameSync(original, hidden);
      const preview = previewHomeRepair(options);
      await NodeAssert.rejects(
        executeHomeRepair(
          options,
          {
            schemaVersion: 1,
            expectedPlanId: preview.planId,
            choice: "side-by-side-retain-original",
            opaqueBackupApproved: true,
            repairId: "f".repeat(32),
          },
          {
            ...ports,
            migrateStagedHome: async () => {
              NodeFS.mkdirSync(original);
              NodeFS.writeFileSync(NodePath.join(original, "preserve-work"), "new unrelated work");
            },
            validateStagedHome: async () => {},
          },
        ),
        /inventory changed/,
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(original, "preserve-work"), "utf8"),
        "new unrelated work",
      );
      NodeAssert.equal(
        NodeFS.existsSync(
          nativeHomePaths(options.userHomeDirectory, options.localAppData).selectionPath,
        ),
        false,
      );
    }),
);
