// @effect-diagnostics nodeBuiltinImport:off -- Synthetic stopped homes exercise native publication and recovery without an installed app.
import * as NodeTest from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import { runNativeHomeRepair } from "./home-repair-native.ts";
import { supportedMigrationIds } from "./home-repair.ts";

NodeTest.test("history import rejects a mismatched actual owning Hub parent", async () => {
  await NodeAssert.rejects(
    runNativeHomeRepair(
      "import-retained-lan-history",
      {
        schemaVersion: 1,
        repairId: "a".repeat(32),
        expectedPlanId: "b".repeat(64),
        expectedReviewGeneration: "c".repeat(64),
        expectedSourceEnvironmentId: "source",
        expectedTargetEnvironmentId: "target",
        expectedSourceDataGeneration: "d".repeat(64),
        expectedSourceWorkGeneration: "e".repeat(64),
        expectedTargetDataGeneration: "f".repeat(64),
        expectedTargetWorkGeneration: "0".repeat(64),
        opaqueBackupApproved: true,
        admissionOwnerPid: process.ppid + 1,
      },
      {
        userHomeDirectory: "C:\\fixture",
        localAppData: "C:\\fixture\\Local",
        appDataDirectory: "C:\\fixture\\Roaming",
        supportedMigrationIds,
      },
    ),
    /owning Hub|native child parent/u,
  );
});

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NativeMaintenance from "../../apps/server/src/lan/NativeMaintenance.ts";
import { createHistoryImportFixture } from "./home-repair-history.fixture-builder.ts";
import { previewHistoryImport, importHistory } from "./home-repair-history.ts";
import {
  previewRetainedLanHistory,
  pendingHistoryImportPreview,
  type HistoryImportExecutionPorts,
  type HistoryImportRequest,
} from "./home-repair-import.ts";
import { previewHomeRepair, type PreviewOptions } from "./home-repair.ts";
import { treeDigest } from "./home-repair-executor.ts";
import { nativeHomePaths } from "../../packages/shared/src/nativeHomeSelection.ts";
const database = (home: string) => NodePath.join(home, "userdata", "statev2.sqlite");
const digest = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
    : null;
const rawSet = (home: string) =>
  Object.fromEntries(
    ["statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm"].map((name) => [
      name,
      digest(NodePath.join(home, "userdata", name)),
    ]),
  );
async function nativeObservation(home: string) {
  const work = NativeMaintenance.inspectNativeUpdateWork(database(home));
  const hash = NodeCrypto.createHash("sha256");
  for (const name of ["statev2.sqlite", "statev2.sqlite-wal"]) {
    const file = NodePath.join(home, "userdata", name);
    hash.update(name);
    if (name.endsWith("-wal") && (!NodeFS.existsSync(file) || NodeFS.statSync(file).size === 0))
      hash.update("absent");
    else hash.update(NodeFS.readFileSync(file));
  }
  return { ...work, dataGeneration: hash.digest("hex") };
}
function mutate(home: string, sql: string) {
  const db = new NodeSqlite.DatabaseSync(database(home));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
async function fixture(
  run: (context: {
    options: PreviewOptions;
    source: string;
    target: string;
    root: string;
    request: HistoryImportRequest;
    ports: HistoryImportExecutionPorts;
    invoke: (
      operation: string,
      request: unknown,
    ) => Promise<Awaited<ReturnType<typeof runNativeHomeRepair>>>;
  }) => Promise<void>,
  withWal = false,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-history-import-"));
  try {
    const created = await createHistoryImportFixture(root);
    const options = {
      userHomeDirectory: created.userHomeDirectory,
      localAppData: created.localAppData,
      appDataDirectory: created.appDataDirectory,
      supportedMigrationIds,
    };
    const source = created.source,
      target = created.target;
    if (withWal) {
      const db = new NodeSqlite.DatabaseSync(database(target));
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,error,command_type) VALUES ('wal-fixture','thread','parent','2026-10-27T00:00:00Z',0,'accepted',NULL,'fixture')",
      );
      const snapshot = NodePath.join(root, "wal-fixture");
      NodeFS.mkdirSync(snapshot);
      for (const suffix of ["", "-wal", "-shm"])
        NodeFS.copyFileSync(
          database(target) + suffix,
          NodePath.join(snapshot, "statev2.sqlite" + suffix),
        );
      db.close();
      for (const suffix of ["", "-wal", "-shm"])
        NodeFS.copyFileSync(
          NodePath.join(snapshot, "statev2.sqlite" + suffix),
          database(target) + suffix,
        );
    }
    const history = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: target,
    });
    NodeAssert.deepEqual(history.blockers, []);
    const sourceNative = await nativeObservation(source),
      targetNative = await nativeObservation(target);
    const request: HistoryImportRequest = {
      schemaVersion: 1,
      repairId: "b".repeat(32),
      expectedPlanId: previewHomeRepair(options).planId,
      expectedReviewGeneration: history.reviewGeneration,
      expectedSourceEnvironmentId: history.sourceEnvironmentId,
      expectedTargetEnvironmentId: history.targetEnvironmentId,
      expectedSourceDataGeneration: sourceNative.dataGeneration,
      expectedSourceWorkGeneration: sourceNative.workGeneration,
      expectedTargetDataGeneration: targetNative.dataGeneration,
      expectedTargetWorkGeneration: targetNative.workGeneration,
      opaqueBackupApproved: true,
      admissionOwnerPid: process.ppid,
    };
    let held = false;
    const ports: HistoryImportExecutionPorts = {
      withExclusiveAdmission: async (resources, operation) => {
        NodeAssert.equal(held, false);
        NodeAssert.deepEqual(resources.homes, [target, source]);
        held = true;
        try {
          return await operation();
        } finally {
          held = false;
        }
      },
      verifyStopped: async () => {
        NodeAssert.equal(held, true);
      },
      availableStorageBytes: () => 10 ** 12,
    };
    const invoke = (operation: string, input: unknown) =>
      runNativeHomeRepair(operation, input, options, undefined, undefined, ports);
    await run({ options, source, target, root, request, ports, invoke });
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(root).startsWith("t3-native-history-import-")
    )
      // eslint-disable-next-line no-unsafe-finally -- Only the verified synthetic temporary fixture root may be removed.
      throw new Error("Unsafe native import fixture cleanup");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
const recoveryRequest = (
  request: HistoryImportRequest,
  recoveryOperation: "recover" | "rollback",
) => ({
  schemaVersion: 1,
  repairId: request.repairId,
  expectedReviewGeneration: request.expectedReviewGeneration,
  expectedSourceEnvironmentId: request.expectedSourceEnvironmentId,
  expectedTargetEnvironmentId: request.expectedTargetEnvironmentId,
  admissionOwnerPid: process.ppid,
  recoveryOperation,
});
NodeTest.test(
  "native history import publishes rich settled history, keeps existing work and supports exact rollback",
  () =>
    fixture(async ({ source, target, options, request, invoke }) => {
      const sourceBefore = treeDigest(source).sha256;
      const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
      const selectionBefore = NodeFS.readFileSync(paths.selectionPath);
      const before = await nativeObservation(target);
      const imported = await invoke("import-retained-lan-history", request);
      NodeAssert.equal(imported.status, "imported-pending-verification");
      if (!("proof" in imported)) throw new Error("No import proof");
      NodeAssert.equal(
        imported.proof.eventPrefixGenerationBefore,
        imported.proof.eventPrefixGenerationAfter,
      );
      NodeAssert.equal(
        imported.proof.existingWorkGenerationBefore,
        imported.proof.existingWorkGenerationAfter,
      );
      NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
      NodeAssert.deepEqual(NodeFS.readFileSync(paths.selectionPath), selectionBefore);
      NodeAssert.equal(NodeFS.existsSync(paths.journalPath), false);
      const repeated = await invoke(
        "recover-import-retained-lan-history",
        recoveryRequest(request, "recover"),
      );
      NodeAssert.deepEqual(repeated, imported);
      const restored = await invoke(
        "recover-import-retained-lan-history",
        recoveryRequest(request, "rollback"),
      );
      NodeAssert.equal(restored.status, "rolled-back");
      const after = await nativeObservation(target);
      NodeAssert.equal(after.dataGeneration, before.dataGeneration);
      NodeAssert.equal(after.workGeneration, before.workGeneration);
      NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
      NodeAssert.deepEqual(NodeFS.readFileSync(paths.selectionPath), selectionBefore);
    }),
);
const forwardRenames = [
  "quarantine:statev2.sqlite-wal",
  "quarantine:statev2.sqlite-shm",
  "quarantine:statev2.sqlite",
  "publish:statev2.sqlite",
  "journal-archive",
];
NodeTest.test.each(forwardRenames.flatMap((name) => ["before:" + name, "after:" + name]))(
  "recovers native import interruption at %s without opening a partial target",
  (phase) =>
    fixture(async ({ options, source, target, request, ports, invoke }) => {
      const beforeSource = treeDigest(source).sha256;
      let fired = false;
      Object.assign(ports, {
        onPhase: (current: string) => {
          if (current === phase && !fired) {
            fired = true;
            throw new Error("simulated import interruption");
          }
        },
      });
      await NodeAssert.rejects(
        invoke("import-retained-lan-history", request),
        /simulated import interruption/u,
      );
      NodeAssert.equal(fired, true);
      const beforeRaw = rawSet(target);
      const pending = pendingHistoryImportPreview(options);
      if (
        NodeFS.existsSync(
          nativeHomePaths(options.userHomeDirectory, options.localAppData).journalPath,
        )
      )
        NodeAssert.equal(pending?.historyImportRecovery.repairId, request.repairId);
      else NodeAssert.equal(pending, null);
      NodeAssert.deepEqual(rawSet(target), beforeRaw);
      if (phase === "after:quarantine:statev2.sqlite") {
        NodeAssert.equal(NodeFS.existsSync(database(target)), false);
        await NodeAssert.rejects(
          invoke("recover", { schemaVersion: 1, repairId: request.repairId }),
          /matching held recovery/u,
        );
        NodeAssert.equal(NodeFS.existsSync(database(target)), false);
        await NodeAssert.rejects(
          invoke("adopt-original-with-work", {
            schemaVersion: 1,
            repairId: "d".repeat(32),
            expectedPlanId: request.expectedPlanId,
            choice: "adopt-original-retain-lan",
            opaqueBackupApproved: true,
            expectedOriginalEnvironmentId: request.expectedTargetEnvironmentId,
            expectedLanEnvironmentId: request.expectedSourceEnvironmentId,
            admissionOwnerPid: process.ppid,
          }),
          /matching held recovery/u,
        );
        NodeAssert.deepEqual(rawSet(target), beforeRaw);
      }
      Object.assign(ports, { onPhase: undefined });
      const recovered = await invoke(
        "recover-import-retained-lan-history",
        recoveryRequest(request, "recover"),
      );
      NodeAssert.equal(recovered.status, "imported-pending-verification");
      NodeAssert.equal(treeDigest(source).sha256, beforeSource);
      NodeAssert.equal(NodeFS.existsSync(database(target)), true);
    }, true),
);

const rollbackRenames = [
  "rollback-quarantine:statev2.sqlite-wal",
  "rollback-quarantine:statev2.sqlite-shm",
  "rollback-quarantine:statev2.sqlite",
  "rollback-restore:statev2.sqlite-wal",
  "rollback-restore:statev2.sqlite-shm",
  "rollback-restore:statev2.sqlite",
  "rollback-attachment",
  "journal-archive",
];
NodeTest.test.each(rollbackRenames.flatMap((name) => ["before:" + name, "after:" + name]))(
  "recovers rollback interruption at %s without opening a partial target",
  (phase) =>
    fixture(async ({ options, source, target, request, ports, invoke }) => {
      const before = await nativeObservation(target);
      const sourceBefore = treeDigest(source).sha256;
      await invoke("import-retained-lan-history", request);
      NodeFS.writeFileSync(database(target) + "-wal", "");
      NodeFS.writeFileSync(database(target) + "-shm", Buffer.alloc(32768));
      let fired = false;
      Object.assign(ports, {
        onPhase: (current: string) => {
          if (current === phase && !fired) {
            fired = true;
            throw new Error("simulated rollback interruption");
          }
        },
      });
      await NodeAssert.rejects(
        invoke("recover-import-retained-lan-history", recoveryRequest(request, "rollback")),
        /simulated rollback interruption/u,
      );
      NodeAssert.equal(fired, true);
      const beforeRaw = rawSet(target);
      pendingHistoryImportPreview(options);
      NodeAssert.deepEqual(rawSet(target), beforeRaw);
      Object.assign(ports, { onPhase: undefined });
      const recovered = await invoke(
        "recover-import-retained-lan-history",
        recoveryRequest(request, "recover"),
      );
      NodeAssert.equal(recovered.status, "rolled-back");
      const after = await nativeObservation(target);
      NodeAssert.equal(after.dataGeneration, before.dataGeneration);
      NodeAssert.equal(after.workGeneration, before.workGeneration);
      NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
    }, true),
);

NodeTest.test("retains a truncated private attachment copy and resumes immutable publication", () =>
  fixture(async ({ source, target, root, request, ports, invoke }) => {
    let fired = false;
    Object.assign(ports, {
      onPhase: (phase: string) => {
        if (phase !== "before:attachment-copy" || fired) return;
        fired = true;
        const recovery = NodePath.join(
          root,
          "AppData",
          "Local",
          "T3CodeLAN",
          "recovery",
          request.repairId,
        );
        const manifest = JSON.parse(
          NodeFS.readFileSync(NodePath.join(recovery, "history-import-manifest.json"), "utf8"),
        );
        const attachment = manifest.attachmentManifest.find(
          (item: { alreadyPresent: boolean }) => !item.alreadyPresent,
        );
        const bytes = NodeFS.readFileSync(
          NodePath.join(recovery, "staged-original", attachment.targetRelativePath),
        );
        NodeFS.writeFileSync(
          NodePath.join(
            target,
            attachment.targetRelativePath + `.history-import-${request.repairId}.partial`,
          ),
          bytes.subarray(0, 2),
        );
        throw new Error("simulated attachment copy interruption");
      },
    });
    const sourceBefore = treeDigest(source).sha256;
    await NodeAssert.rejects(
      invoke("import-retained-lan-history", request),
      /simulated attachment copy interruption/u,
    );
    NodeAssert.equal(fired, true);
    Object.assign(ports, { onPhase: undefined });
    NodeAssert.equal(
      (await invoke("recover-import-retained-lan-history", recoveryRequest(request, "recover")))
        .status,
      "imported-pending-verification",
    );
    const retained = NodeFS.readdirSync(
      NodePath.join(
        root,
        "AppData",
        "Local",
        "T3CodeLAN",
        "recovery",
        request.repairId,
        "attachment-partials",
      ),
    );
    NodeAssert.equal(retained.length, 1);
    NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
  }),
);
NodeTest.test("refuses later target work and leaves both import and fresh backups retained", () =>
  fixture(async ({ source, target, request, invoke }) => {
    const imported = await invoke("import-retained-lan-history", request);
    mutate(
      target,
      "UPDATE orchestration_v2_projection_runtime_requests SET payload_json=json_set(payload_json,'$.laterUserWork','retained') WHERE status='pending'",
    );
    const before = rawSet(target),
      sourceBefore = treeDigest(source).sha256;
    await NodeAssert.rejects(
      invoke("recover-import-retained-lan-history", recoveryRequest(request, "rollback")),
      /changed after import|newer/u,
    );
    NodeAssert.deepEqual(rawSet(target), before);
    NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
    if (!("receiptPath" in imported)) throw new Error("Missing import receipt");
    NodeAssert.equal(NodeFS.existsSync(imported.receiptPath), true);
  }),
);
NodeTest.test("refuses insufficient disk before any recovery directory or snapshot", () =>
  fixture(async ({ options, request, ports, invoke }) => {
    Object.assign(ports, { availableStorageBytes: () => 0 });
    await NodeAssert.rejects(
      invoke("import-retained-lan-history", request),
      /Insufficient disk space.*required.*available/u,
    );
    const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
    NodeAssert.equal(NodeFS.existsSync(paths.journalPath), false);
    NodeAssert.equal(
      NodeFS.existsSync(
        NodePath.join(NodePath.dirname(paths.selectionPath), "recovery", request.repairId),
      ),
      false,
    );
  }),
);
NodeTest.test("prepared Hub import marker recovers as a no-op with no home mutation", () =>
  fixture(async ({ source, target, request, invoke }) => {
    const before = [treeDigest(source).sha256, treeDigest(target).sha256];
    const cancelled = await invoke(
      "recover-import-retained-lan-history",
      recoveryRequest(request, "recover"),
    );
    NodeAssert.equal(cancelled.status, "rolled-back");
    NodeAssert.deepEqual([treeDigest(source).sha256, treeDigest(target).sha256], before);
  }),
);

NodeTest.test.each(["journaled", "staged"])(
  "restarts reviewed staging safely after %s interruption",
  (phase) =>
    fixture(async ({ root, source, request, ports, invoke }) => {
      let fired = false;
      Object.assign(ports, {
        onPhase: (current: string) => {
          if (current === phase && !fired) {
            fired = true;
            throw new Error("simulated staging interruption");
          }
        },
      });
      const sourceBefore = treeDigest(source).sha256;
      await NodeAssert.rejects(
        invoke("import-retained-lan-history", request),
        /simulated staging interruption/u,
      );
      NodeAssert.equal(fired, true);
      Object.assign(ports, { onPhase: undefined });
      NodeAssert.equal(
        (await invoke("recover-import-retained-lan-history", recoveryRequest(request, "recover")))
          .status,
        "imported-pending-verification",
      );
      NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
      NodeAssert.equal(
        NodeFS.existsSync(
          NodePath.join(
            root,
            "AppData",
            "Local",
            "T3CodeLAN",
            "recovery",
            request.repairId,
            "snapshot-0",
          ),
        ),
        true,
      );
    }),
);
NodeTest.test("retains a failed imported stage and reclones the original backup before retry", () =>
  fixture(async ({ root, request, ports, invoke }) => {
    Object.assign(ports, {
      importHistory: async (input: Parameters<typeof importHistory>[0]) => {
        await importHistory(input);
        throw new Error("simulated after staged events");
      },
    });
    await NodeAssert.rejects(
      invoke("import-retained-lan-history", request),
      /simulated after staged events/u,
    );
    Object.assign(ports, { importHistory: undefined });
    NodeAssert.equal(
      (await invoke("recover-import-retained-lan-history", recoveryRequest(request, "recover")))
        .status,
      "imported-pending-verification",
    );
    const names = NodeFS.readdirSync(
      NodePath.join(root, "AppData", "Local", "T3CodeLAN", "recovery", request.repairId),
    );
    NodeAssert.equal(names.filter((name) => name.startsWith("retained-stage-")).length, 1);
  }),
);
NodeTest.test.each(["source", "profile", "selection"])(
  "refuses rollback after %s changes without discarding the newer bytes",
  (kind) =>
    fixture(async ({ options, source, target, request, invoke }) => {
      await invoke("import-retained-lan-history", request);
      if (kind === "source")
        mutate(
          source,
          "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','New retained source history') WHERE message_id='message:1'",
        );
      else if (kind === "profile")
        NodeFS.appendFileSync(
          NodePath.join(options.appDataDirectory, "t3code-v2", "Local State"),
          "new opaque profile bytes",
        );
      else
        NodeFS.appendFileSync(
          nativeHomePaths(options.userHomeDirectory, options.localAppData).selectionPath,
          " ",
        );
      const before = rawSet(target),
        sourceBefore = treeDigest(source).sha256;
      await NodeAssert.rejects(
        invoke("recover-import-retained-lan-history", recoveryRequest(request, "rollback")),
        /changed after import|changed during import/u,
      );
      NodeAssert.deepEqual(rawSet(target), before);
      NodeAssert.equal(treeDigest(source).sha256, sourceBefore);
    }),
);
NodeTest.test("refuses an unknown SQLite quarantine while preserving a missing live main", () =>
  fixture(async ({ options, target, root, request, ports, invoke }) => {
    Object.assign(ports, {
      onPhase: (phase: string) => {
        if (phase === "after:quarantine:statev2.sqlite")
          throw new Error("simulated raw interruption");
      },
    });
    await NodeAssert.rejects(
      invoke("import-retained-lan-history", request),
      /simulated raw interruption/u,
    );
    Object.assign(ports, { onPhase: undefined });
    const quarantined = NodePath.join(
      root,
      "AppData",
      "Local",
      "T3CodeLAN",
      "recovery",
      request.repairId,
      "original-sqlite",
      "statev2.sqlite",
    );
    NodeFS.appendFileSync(quarantined, "unknown bytes");
    const before = rawSet(target);
    await NodeAssert.rejects(
      invoke("recover-import-retained-lan-history", recoveryRequest(request, "recover")),
      /unrecognized raw file state|recognized pre\/publish/u,
    );
    NodeAssert.deepEqual(rawSet(target), before);
    NodeAssert.equal(NodeFS.existsSync(database(target)), false);
    NodeAssert.notEqual(pendingHistoryImportPreview(options), null);
  }, true),
);
NodeTest.test(
  "blocks older home schemas explicitly and surfaces unexpected preview errors without private causes",
  () =>
    fixture(async ({ options, source, request, invoke }) => {
      const failed = await previewRetainedLanHistory(options, {
        previewHistory: async () => {
          throw new Error("private C:/credentials should not be shown");
        },
      });
      NodeAssert.equal(failed.canImportRetainedLanHistory, false);
      NodeAssert.ok(failed.historyImportBlockers.includes("retained-history-preview-failed"));
      NodeAssert.equal(JSON.stringify(failed).includes("credentials"), false);
      mutate(
        source,
        `DELETE FROM effect_sql_migrations WHERE migration_id=${Math.max(...supportedMigrationIds)}`,
      );
      const preview = await previewRetainedLanHistory(options);
      NodeAssert.ok(
        preview.historyImportBlockers.includes("history-import-requires-current-schema"),
      );
      await NodeAssert.rejects(
        invoke("import-retained-lan-history", request),
        /current supported schema/u,
      );
    }),
);
