// @effect-diagnostics nodeBuiltinImport:off -- Explicit offline recovery installs a validated staged database while Hub holds both homes and Electron profiles stopped.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { previewHomeRepair, type PreviewOptions } from "./home-repair.ts";
import {
  atomicWrite,
  copySnapshot,
  treeDigest,
  type RepairAdmissionResources,
} from "./home-repair-executor.ts";
import { cancelRepairStagedWork } from "./home-repair-cancel-staged.ts";
import {
  assertOrdinaryNativePath,
  nativeHomePaths,
} from "../../packages/shared/src/nativeHomeSelection.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";
import { strictJson } from "../../packages/shared/src/strictJson.ts";

export interface WorkCancellationRequest {
  readonly schemaVersion: 1;
  readonly repairId: string;
  readonly expectedPlanId: string;
  readonly cancelUnfinishedWorkApproved: true;
  readonly opaqueBackupApproved: true;
}
export interface WorkCancellationPorts {
  readonly withExclusiveAdmission: <A>(
    resources: RepairAdmissionResources,
    operation: () => Promise<A>,
  ) => Promise<A>;
  readonly verifyStoppedForCancellation: (
    resources: RepairAdmissionResources,
    original: string,
  ) => Promise<void>;
  readonly cancelStagedWork?: typeof cancelRepairStagedWork;
}
const databaseNames = ["statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm"] as const;
interface Image {
  readonly name: string;
  readonly sha256: string;
}
interface CancellationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "original-work-cancellation";
  readonly repairId: string;
  readonly status: "prepared" | "unfinished-work-cancelled" | "rolled-back";
  readonly original: string;
  readonly expectedPlanId: string;
  readonly previousSelection: string | null;
  readonly snapshot: ReturnType<typeof copySnapshot>;
  readonly originalImages: readonly Image[];
  readonly installedImage: Image;
  readonly afterSha256: string | null;
  readonly summary: Awaited<ReturnType<typeof cancelRepairStagedWork>>;
}
const hash = (file: string) => {
  const metadata = NodeFS.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
    throw new Error("Database recovery images must be ordinary files.");
  const digest = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(65536);
    for (;;) {
      const n = NodeFS.readSync(fd, bytes);
      if (!n) break;
      digest.update(bytes.subarray(0, n));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return digest.digest("hex");
};
function cancellationPaths(options: PreviewOptions, repairId: string) {
  if (!/^[a-f0-9]{32}$/.test(repairId)) throw new Error("Invalid cancellation identity.");
  const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const directory = NodePath.join(NodePath.dirname(paths.selectionPath), "recovery", repairId);
  assertOrdinaryNativePath(directory, true);
  return {
    ...paths,
    directory,
    receiptPath: NodePath.join(directory, "cancellation-receipt.json"),
  };
}
function resourcesFor(options: PreviewOptions) {
  const preview = previewHomeRepair(options);
  if (
    preview.state === "blocked" ||
    preview.original.state !== "initialized" ||
    (preview.lan.activeWork !== 0 && preview.lan.state === "initialized")
  )
    throw new Error(
      "Cancellation requires a supported original home and an idle retained LAN home.",
    );
  return {
    preview,
    resources: {
      homes: [preview.original, preview.lan]
        .filter((home) => home.state === "initialized")
        .map((home) => home.homeDirectory),
      electronProfiles: preview.electronProfiles
        .filter((profile) => profile.localState.present)
        .map((profile) => profile.profileDirectory),
    },
  };
}
function images(directory: string): Image[] {
  return databaseNames
    .filter((name) => NodeFS.existsSync(NodePath.join(directory, name)))
    .map((name) => ({ name, sha256: hash(NodePath.join(directory, name)) }));
}
function writeReceipt(path: string, receipt: CancellationReceipt) {
  const text = JSON.stringify(receipt) + "\n";
  if (Buffer.byteLength(text) > 16384)
    throw new Error("Cancellation receipt exceeds its reviewed bound.");
  atomicWrite(path, text, receipt.repairId);
}
function restoreImages(receipt: CancellationReceipt, directory: string) {
  const target = NodePath.join(receipt.original, "userdata");
  const retired = NodePath.join(directory, "retired-database");
  // Read-only SQLite inspection can recreate an empty WAL and disposable SHM cache.
  // Main database and nonempty WAL must still match exact original or staged bytes.
  for (const name of databaseNames) {
    const at = NodePath.join(target, name);
    const old = receipt.originalImages.find((image) => image.name === name);
    const moved = NodePath.join(retired, name);
    const actual = NodeFS.existsSync(at) ? hash(at) : null;
    if (
      actual !== null &&
      actual !== old?.sha256 &&
      !(name === "statev2.sqlite" && actual === receipt.installedImage.sha256) &&
      !(name === "statev2.sqlite-wal" && actual !== null && NodeFS.statSync(at).size === 0) &&
      !(name === "statev2.sqlite-shm")
    )
      throw new Error("New database activity prevents automatic cancellation rollback.");
    if (NodeFS.existsSync(moved) && hash(moved) !== old?.sha256)
      throw new Error("Retired database image is not intact.");
    if (old && actual !== old.sha256 && !NodeFS.existsSync(moved))
      throw new Error("An original database image is missing.");
  }
  for (const name of databaseNames) {
    const at = NodePath.join(target, name);
    const moved = NodePath.join(retired, name);
    const old = receipt.originalImages.find((image) => image.name === name);
    if (NodeFS.existsSync(at) && (!old || hash(at) !== old.sha256))
      NodeFS.renameSync(at, NodePath.join(directory, `cancelled-${name}`));
    if (NodeFS.existsSync(moved) && !NodeFS.existsSync(at)) NodeFS.renameSync(moved, at);
  }
}
export async function cancelOriginalWork(
  options: PreviewOptions,
  request: WorkCancellationRequest,
  ports: WorkCancellationPorts,
) {
  if (
    request.schemaVersion !== 1 ||
    request.cancelUnfinishedWorkApproved !== true ||
    request.opaqueBackupApproved !== true ||
    !/^[a-f0-9]{64}$/.test(request.expectedPlanId)
  )
    throw new Error(
      "An exact preview, explicit cancellation and opaque-backup consent are required.",
    );
  const paths = cancellationPaths(options, request.repairId);
  const { preview, resources } = resourcesFor(options);
  if (preview.planId !== request.expectedPlanId) throw new Error("Cancellation preview is stale.");
  const original = preview.original.homeDirectory;
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStoppedForCancellation(resources, original);
    if (previewHomeRepair(options).planId !== request.expectedPlanId)
      throw new Error("Cancellation state changed before admission.");
    if (NodeFS.existsSync(paths.journalPath) || NodeFS.existsSync(paths.directory))
      throw new Error("Existing recovery state must be resolved first.");
    const before = inspectStoppedRepairWork(NodePath.join(original, "userdata", "statev2.sqlite"));
    if (before.scheduledWork !== 0 || before.restartContinuations !== 0)
      throw new Error(
        "Schedules or deferred/restart work require separate resolution; no cancellation was made.",
      );
    NodeFS.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const snapshot = copySnapshot(original, NodePath.join(paths.directory, "snapshot-0"));
    const staged = NodePath.join(paths.directory, "staged-original");
    NodeFS.cpSync(snapshot.backup, staged, { recursive: true, force: false, errorOnExist: true });
    const summary = await (ports.cancelStagedWork ?? cancelRepairStagedWork)(
      staged,
      request.repairId,
    );
    await ports.verifyStoppedForCancellation(resources, original);
    if (
      treeDigest(original).sha256 !== snapshot.sha256 ||
      previewHomeRepair(options).planId !== request.expectedPlanId
    )
      throw new Error("Original state changed while cancellation was staged.");
    const state = NodePath.join(original, "userdata");
    if (NodeFS.statSync(state).dev !== NodeFS.statSync(paths.directory).dev)
      throw new Error("Cancellation staging must be on the original database volume.");
    const candidate = NodePath.join(paths.directory, "prepared-statev2.sqlite");
    const stagedDatabase = NodePath.join(staged, "userdata", "statev2.sqlite");
    NodeFS.copyFileSync(stagedDatabase, candidate, NodeFS.constants.COPYFILE_EXCL);
    const fd = NodeFS.openSync(candidate, "r+");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    const installedImage = { name: "statev2.sqlite", sha256: hash(stagedDatabase) };
    if (hash(candidate) !== installedImage.sha256)
      throw new Error("Prepared cancellation database verification failed.");
    const previousSelection = NodeFS.existsSync(paths.selectionPath)
      ? NodeFS.readFileSync(paths.selectionPath, "utf8")
      : null;
    if (previousSelection !== null && Buffer.byteLength(previousSelection) > 4096)
      throw new Error("Oversized original selection.");
    const receipt: CancellationReceipt = {
      expectedPlanId: request.expectedPlanId,
      previousSelection,
      schemaVersion: 1,
      kind: "original-work-cancellation",
      repairId: request.repairId,
      status: "prepared",
      original,
      snapshot,
      originalImages: images(state),
      installedImage,
      afterSha256: null,
      summary,
    };
    writeReceipt(paths.receiptPath, receipt);
    const journalText =
      JSON.stringify({
        schemaVersion: 1,
        operation: "cancel-original-work",
        repairId: request.repairId,
        receiptPath: paths.receiptPath,
      }) + "\n";
    atomicWrite(paths.journalPath, journalText, request.repairId);
    const retired = NodePath.join(paths.directory, "retired-database");
    NodeFS.mkdirSync(retired);
    try {
      for (const image of receipt.originalImages)
        NodeFS.renameSync(NodePath.join(state, image.name), NodePath.join(retired, image.name));
      NodeFS.renameSync(candidate, NodePath.join(state, "statev2.sqlite"));
      const after = inspectStoppedRepairWork(NodePath.join(state, "statev2.sqlite"));
      if (
        [
          after.activeRuns,
          after.queuedRuns,
          after.pendingRequests,
          after.backgroundAgents,
          after.scheduledWork,
          after.restartContinuations,
        ].some((n) => n !== 0)
      )
        throw new Error("Installed cancellation did not produce idle state.");
      const completed = {
        ...receipt,
        status: "unfinished-work-cancelled" as const,
        afterSha256: treeDigest(original).sha256,
      };
      writeReceipt(paths.receiptPath, completed);
      NodeFS.unlinkSync(paths.journalPath);
      const fresh = previewHomeRepair(options);
      if (fresh.state === "blocked" || fresh.original.activeWork !== 0)
        throw new Error("Post-cancellation preview is not usable.");
      const expectedPlanId = fresh.planId;
      return {
        schemaVersion: 1 as const,
        status: "unfinished-work-cancelled" as const,
        repairId: request.repairId,
        receiptPath: paths.receiptPath,
        summary,
        expectedPlanId,
      };
    } catch (error) {
      // A post-cleanup preview can fail after unlink. Re-establish the startup barrier before restoring any database image.
      if (!NodeFS.existsSync(paths.journalPath))
        atomicWrite(paths.journalPath, journalText, request.repairId);
      else {
        assertOrdinaryNativePath(paths.journalPath, false);
        if (
          NodeFS.statSync(paths.journalPath).size > 8192 ||
          NodeFS.readFileSync(paths.journalPath, "utf8") !== journalText
        )
          throw new Error("A different recovery journal prevents cancellation rollback.", {
            cause: error,
          });
      }
      await ports.verifyStoppedForCancellation(resources, original);
      const databaseFiles = databaseNames.map((name) => `userdata/${name}`);
      if (
        treeDigest(original, databaseFiles).sha256 !==
        treeDigest(snapshot.backup, databaseFiles).sha256
      )
        throw new Error("New non-database work prevents cancellation rollback.", { cause: error });
      restoreImages(receipt, paths.directory);
      writeReceipt(paths.receiptPath, { ...receipt, status: "rolled-back" });
      NodeFS.unlinkSync(paths.journalPath);
      throw error;
    }
  });
}
export async function rollbackOriginalWorkCancellation(
  options: PreviewOptions,
  repairId: string,
  ports: WorkCancellationPorts,
  recovery = false,
) {
  const paths = cancellationPaths(options, repairId);
  assertOrdinaryNativePath(paths.receiptPath, false);
  if (NodeFS.statSync(paths.receiptPath).size > 16384)
    throw new Error("Oversized cancellation receipt.");
  const receipt = strictJson(NodeFS.readFileSync(paths.receiptPath)) as CancellationReceipt;
  const original = NodePath.join(options.userHomeDirectory, ".t3");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "original-work-cancellation" ||
    receipt.repairId !== repairId ||
    receipt.original !== original ||
    receipt.snapshot.source !== original ||
    receipt.snapshot.backup !== NodePath.join(paths.directory, "snapshot-0") ||
    !["prepared", "unfinished-work-cancelled", "rolled-back"].includes(receipt.status) ||
    !/^[a-f0-9]{64}$/.test(receipt.snapshot.sha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.installedImage.sha256) ||
    !Array.isArray(receipt.originalImages) ||
    receipt.originalImages.length < 1 ||
    receipt.originalImages.length > 3 ||
    new Set(receipt.originalImages.map((image) => image.name)).size !==
      receipt.originalImages.length ||
    !receipt.originalImages.some((image) => image.name === "statev2.sqlite") ||
    !/^[a-f0-9]{64}$/.test(receipt.expectedPlanId) ||
    (receipt.previousSelection !== null &&
      (typeof receipt.previousSelection !== "string" ||
        Buffer.byteLength(receipt.previousSelection) > 4096)) ||
    (receipt.afterSha256 !== null && !/^[a-f0-9]{64}$/.test(receipt.afterSha256)) ||
    receipt.installedImage.name !== "statev2.sqlite" ||
    receipt.originalImages.some(
      (image) =>
        !databaseNames.includes(image.name as (typeof databaseNames)[number]) ||
        !/^[a-f0-9]{64}$/.test(image.sha256),
    )
  )
    throw new Error("Invalid cancellation receipt.");
  // A partially installed original may have no readable database. Admission is established from the fixed homes/profile paths, not this database's preview.
  const resources = {
    homes: [original, paths.lanHomeDirectory].filter((directory) =>
      NodeFS.existsSync(NodePath.join(directory, "userdata", "environment-id")),
    ),
    electronProfiles: ["t3code-v2", "T3 Code (Alpha)", "t3code"]
      .map((name) => NodePath.join(options.appDataDirectory, name))
      .concat(NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile"))
      .filter((directory) => NodeFS.existsSync(NodePath.join(directory, "Local State"))),
  };
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStoppedForCancellation(resources, original);
    const selection = NodeFS.existsSync(paths.selectionPath)
      ? NodeFS.readFileSync(paths.selectionPath, "utf8")
      : null;
    if (selection !== receipt.previousSelection)
      throw new Error("Home selection must be rolled back before cancellation rollback.");
    if (treeDigest(receipt.snapshot.backup).sha256 !== receipt.snapshot.sha256)
      throw new Error("Original snapshot is not intact.");
    if (
      !recovery &&
      receipt.status !== "rolled-back" &&
      treeDigest(original).sha256 !== receipt.afterSha256
    )
      throw new Error("New work prevents cancellation rollback.");
    if (NodeFS.existsSync(paths.journalPath)) {
      const journal = strictJson(NodeFS.readFileSync(paths.journalPath)) as Record<string, unknown>;
      if (
        journal.operation !== "cancel-original-work" ||
        journal.repairId !== repairId ||
        journal.receiptPath !== paths.receiptPath
      )
        throw new Error("A different recovery operation is pending.");
    } else if (recovery) throw new Error("No interrupted cancellation is pending.");
    else
      atomicWrite(
        paths.journalPath,
        JSON.stringify({
          schemaVersion: 1,
          operation: "cancel-original-work",
          repairId,
          receiptPath: paths.receiptPath,
        }) + "\n",
        repairId,
      );
    const databaseFiles = databaseNames.map((name) => `userdata/${name}`);
    if (
      treeDigest(original, databaseFiles).sha256 !==
      treeDigest(receipt.snapshot.backup, databaseFiles).sha256
    )
      throw new Error("New non-database work prevents cancellation recovery.");
    restoreImages(receipt, paths.directory);
    if (treeDigest(original).sha256 !== receipt.snapshot.sha256)
      throw new Error("Restored original state did not match the complete snapshot.");
    writeReceipt(paths.receiptPath, { ...receipt, status: "rolled-back" });
    NodeFS.unlinkSync(paths.journalPath);
    return { schemaVersion: 1 as const, status: "rolled-back" as const };
  });
}
