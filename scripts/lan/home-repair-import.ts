// @effect-diagnostics nodeBuiltinImport:off -- Stopped, Hub-owned import transactions publish only checked SQLite state and immutable attachment copies.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { previewHomeRepair, type HomeRepairPreview, type PreviewOptions } from "./home-repair.ts";
import {
  atomicWrite,
  copySnapshot,
  treeDigest,
  type RepairAdmissionResources,
} from "./home-repair-executor.ts";
import { migrateRepairStagedHome, validateRepairStagedHome } from "./home-repair-migrations.ts";
import {
  previewHistoryImport,
  importHistory,
  type HistoryImportPreview,
  type HistoryImportResult,
} from "./home-repair-history.ts";
import {
  inspectNativeUpdateWork,
  inspectStoppedRepairWork,
} from "../../apps/server/src/lan/NativeMaintenance.ts";
import {
  assertOrdinaryNativePath,
  nativeHomePaths,
  resolveNativeHomeSelection,
} from "../../packages/shared/src/nativeHomeSelection.ts";
import { strictJson } from "../../packages/shared/src/strictJson.ts";

const operation = "import-retained-lan-history" as const;
const hex = /^[a-f0-9]{64}$/u;
const counters = [
  "activeRuns",
  "queuedRuns",
  "pendingRequests",
  "backgroundAgents",
  "scheduledWork",
  "restartContinuations",
] as const;
const databaseNames = ["statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm"] as const;
type DatabaseName = (typeof databaseNames)[number];
type FilePin = { readonly bytes: number; readonly sha256: string } | null;
type RawPins = Record<DatabaseName, FilePin>;
type Observation = { readonly dataGeneration: string; readonly workGeneration: string };
type Snapshot = ReturnType<typeof copySnapshot>;
export interface HistoryImportRequest {
  readonly schemaVersion: 1;
  readonly repairId: string;
  readonly expectedPlanId: string;
  readonly expectedReviewGeneration: string;
  readonly expectedSourceEnvironmentId: string;
  readonly expectedTargetEnvironmentId: string;
  readonly expectedSourceDataGeneration: string;
  readonly expectedSourceWorkGeneration: string;
  readonly expectedTargetDataGeneration: string;
  readonly expectedTargetWorkGeneration: string;
  readonly opaqueBackupApproved: true;
  readonly admissionOwnerPid: number;
}
export interface HistoryImportRecoveryRequest {
  readonly schemaVersion: 1;
  readonly repairId: string;
  readonly expectedReviewGeneration: string;
  readonly expectedSourceEnvironmentId: string;
  readonly expectedTargetEnvironmentId: string;
  readonly admissionOwnerPid: number;
  readonly recoveryOperation: "recover" | "rollback";
}
export interface HistoryImportExecutionPorts {
  readonly withExclusiveAdmission: <A>(
    resources: RepairAdmissionResources,
    run: () => Promise<A>,
  ) => Promise<A>;
  readonly verifyStopped: (resources: RepairAdmissionResources) => Promise<void>;
  readonly previewHistory?: typeof previewHistoryImport;
  readonly importHistory?: typeof importHistory;
  readonly onPhase?: (phase: string) => void;
  readonly availableStorageBytes?: (directory: string) => number;
}
export interface HistoryImportReply {
  readonly schemaVersion: 1;
  readonly operation: typeof operation;
  readonly status: "imported-pending-verification" | "rolled-back";
  readonly repairId: string;
  readonly receiptPath: string;
  readonly sourceEnvironmentId: string;
  readonly targetEnvironmentId: string;
  readonly reviewGeneration: string;
  readonly sourceDataGenerationBefore: string;
  readonly sourceDataGenerationAfter: string;
  readonly sourceWorkGenerationBefore: string;
  readonly sourceWorkGenerationAfter: string;
  readonly targetDataGenerationBefore: string;
  readonly targetDataGenerationAfter: string;
  readonly targetWorkGenerationBefore: string;
  readonly targetWorkGenerationAfter: string;
  readonly summary: HistoryImportPreview["summary"];
  readonly proof: HistoryImportResult["proof"];
  readonly existingWorkPreserved: true;
  readonly eventPrefixPreserved: true;
  readonly sourcePreserved: true;
}
interface Journal {
  schemaVersion: 1;
  operation: typeof operation;
  repairId: string;
  phase:
    | "backing-up"
    | "staging"
    | "publishing-attachments"
    | "publishing-database"
    | "published"
    | "rolling-back"
    | "completed"
    | "rolled-back";
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  reviewGeneration: string;
  cachedPreview: HomeRepairPreview;
  historyPreview: HistoryImportPreview;
  selectionSha256: string;
  snapshots: Snapshot[];
  sourceBefore: Observation;
  targetBefore: Observation;
  targetAuxiliaryGeneration: string;
  manifestSha256?: string;
  oldPins?: RawPins;
  newDatabasePin?: NonNullable<FilePin>;
  rollbackPins?: RawPins;
  rollbackStep?: "quarantine" | "restore" | "attachments";
  expectedTargetAfter?: Observation;
  result?: HistoryImportReply;
}
function fail(message: string): never {
  throw new Error(message);
}
const sha = (value: NodeCrypto.BinaryLike) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const locations = (options: PreviewOptions, repairId: string) => {
  if (!/^[a-f0-9]{32}$/u.test(repairId)) fail("Import requires a new exact repair ID.");
  const homes = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const root = NodePath.join(NodePath.dirname(homes.selectionPath), "recovery", repairId);
  return {
    ...homes,
    root,
    staged: NodePath.join(root, "staged-original"),
    receipt: NodePath.join(root, "receipt.json"),
    manifest: NodePath.join(root, "history-import-manifest.json"),
    old: NodePath.join(root, "original-sqlite"),
    rollback: NodePath.join(root, "post-import-sqlite"),
    restore: NodePath.join(root, "restore-original-sqlite"),
  };
};
function filePin(file: string): FilePin {
  assertOrdinaryNativePath(file, false);
  let metadata: NodeFS.Stats;
  try {
    metadata = NodeFS.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const digest = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const length = NodeFS.readSync(descriptor, buffer);
      if (!length) break;
      digest.update(buffer.subarray(0, length));
    }
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return { bytes: metadata.size, sha256: digest.digest("hex") };
}
function samePin(left: FilePin, right: FilePin): boolean {
  return left === null
    ? right === null
    : right !== null && left.bytes === right.bytes && left.sha256 === right.sha256;
}
const rawPins = (directory: string): RawPins =>
  Object.fromEntries(
    databaseNames.map((name) => [name, filePin(NodePath.join(directory, name))]),
  ) as RawPins;
function boundedJson(file: string, maximum = 131072): Record<string, unknown> {
  assertOrdinaryNativePath(file, false);
  if (NodeFS.statSync(file).size > maximum) fail("Import recovery metadata is oversized.");
  const value = strictJson(NodeFS.readFileSync(file));
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid import recovery metadata.");
  return value as Record<string, unknown>;
}
function metadata(file: string, value: unknown, repairId: string) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > 131072) fail("Import journal exceeds its bounded metadata limit.");
  atomicWrite(file, text, `${repairId}.${NodeCrypto.randomBytes(6).toString("hex")}`);
}
function identity(home: string) {
  const file = NodePath.join(home, "userdata", "environment-id");
  assertOrdinaryNativePath(file, false);
  if (NodeFS.statSync(file).size > 256) fail("Oversized home identity.");
  return NodeFS.readFileSync(file, "utf8").trim();
}
function selectionGeneration(options: PreviewOptions) {
  const file = nativeHomePaths(options.userHomeDirectory, options.localAppData).selectionPath;
  assertOrdinaryNativePath(file, false);
  if (NodeFS.statSync(file).size > 4096) fail("Oversized selected-home binding.");
  return sha(NodeFS.readFileSync(file));
}
function dataGeneration(home: string) {
  const hash = NodeCrypto.createHash("sha256");
  for (const name of ["statev2.sqlite", "statev2.sqlite-wal"]) {
    const file = NodePath.join(home, "userdata", name);
    assertOrdinaryNativePath(file, false);
    let pin: { bytes: number } | null;
    try {
      pin = { bytes: NodeFS.statSync(file).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      pin = null;
    }
    hash.update(name);
    if (name.endsWith("-wal") && (pin === null || pin.bytes === 0)) {
      hash.update("absent");
      continue;
    }
    if (pin === null) fail("Import database is missing.");
    const fd = NodeFS.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const length = NodeFS.readSync(fd, buffer);
        if (!length) break;
        hash.update(buffer.subarray(0, length));
      }
    } finally {
      NodeFS.closeSync(fd);
    }
  }
  return hash.digest("hex");
}
function observe(home: string): Observation {
  const work = inspectNativeUpdateWork(NodePath.join(home, "userdata", "statev2.sqlite"));
  if (counters.some((key) => !Number.isSafeInteger(work[key]) || work[key] < 0))
    fail("Import requires known native work.");
  return { dataGeneration: dataGeneration(home), workGeneration: work.workGeneration };
}
function requireIdleSource(home: string) {
  const work = inspectStoppedRepairWork(NodePath.join(home, "userdata", "statev2.sqlite"));
  if (counters.some((key) => work[key] !== 0))
    fail("Retained LAN import source must have no unfinished work.");
}
function auxiliaryGeneration(home: string, allowedNewFiles: readonly string[] = []) {
  const ignored = new Set([
    "native-admission.lock",
    "userdata/server-owner.sqlite",
    "userdata/server-owner.sqlite-journal",
    ...databaseNames.map((name) => "userdata/" + name),
    ...allowedNewFiles,
  ]);
  const hash = NodeCrypto.createHash("sha256");
  let count = 0;
  const walk = (relative: string) => {
    const at = NodePath.join(home, relative);
    const stat = NodeFS.lstatSync(at);
    if (stat.isSymbolicLink()) fail("Import refuses redirected auxiliary state.");
    if (stat.isDirectory()) {
      for (const name of NodeFS.readdirSync(at).sort())
        walk(relative ? relative + "/" + name : name);
      return;
    }
    if (ignored.has(relative)) return;
    if (!stat.isFile() || stat.nlink !== 1 || ++count > 100000)
      fail("Import auxiliary inventory is not ordinary or bounded.");
    const pin = filePin(at)!;
    hash.update(JSON.stringify([relative, pin.bytes, pin.sha256]));
  };
  walk("");
  return hash.digest("hex");
}
const profiles = (options: PreviewOptions) => [
  NodePath.join(options.appDataDirectory, "t3code-v2"),
  NodePath.join(options.appDataDirectory, "T3 Code (Alpha)"),
  NodePath.join(options.appDataDirectory, "t3code"),
  NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile"),
];
function ordinaryBytes(root: string) {
  let files = 0,
    bytes = 0;
  const walk = (relative: string) => {
    const at = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(at);
    if (stat.isSymbolicLink()) fail("Storage estimate refuses redirected files.");
    if (stat.isDirectory()) {
      for (const name of NodeFS.readdirSync(at)) walk(relative ? relative + "/" + name : name);
      return;
    }
    if (
      [
        "native-admission.lock",
        "userdata/server-owner.sqlite",
        "userdata/server-owner.sqlite-journal",
        "userdata/statev2.sqlite-shm",
      ].includes(relative)
    )
      return;
    if (!stat.isFile() || stat.nlink !== 1 || ++files > 100000)
      fail("Storage estimate is not an ordinary bounded inventory.");
    bytes += stat.size;
    if (!Number.isSafeInteger(bytes)) fail("Storage estimate exceeds the safe byte range.");
  };
  walk("");
  return bytes;
}
function storageFor(
  options: PreviewOptions,
  preview: HomeRepairPreview,
  history: HistoryImportPreview,
  ports?: Pick<HistoryImportExecutionPorts, "availableStorageBytes">,
  completedSnapshots: readonly Snapshot[] = [],
) {
  const p = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const resources = resourcesFor(options, preview);
  const requiredBytes =
    3 * ordinaryBytes(p.originalHomeDirectory) +
    ordinaryBytes(p.lanHomeDirectory) +
    resources.electronProfiles.reduce((sum, profile) => sum + ordinaryBytes(profile), 0) +
    history.summary.attachmentBytes +
    1024 ** 3 -
    completedSnapshots.reduce((sum, snapshot) => sum + ordinaryBytes(snapshot.backup), 0);
  const disk =
    ports?.availableStorageBytes?.(NodePath.dirname(p.selectionPath)) ??
    (() => {
      const stat = NodeFS.statfsSync(NodePath.dirname(p.selectionPath), { bigint: true });
      return Number(stat.bavail * stat.bsize);
    })();
  if (
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes < 0 ||
    !Number.isSafeInteger(disk) ||
    disk < 0
  )
    fail("Available storage could not be established.");
  return { requiredBytes, availableBytes: disk, sufficient: disk >= requiredBytes };
}
function requireStorage(
  options: PreviewOptions,
  j: {
    cachedPreview: HomeRepairPreview;
    historyPreview: HistoryImportPreview;
    snapshots?: readonly Snapshot[];
  },
  ports: HistoryImportExecutionPorts,
) {
  const storage = storageFor(options, j.cachedPreview, j.historyPreview, ports, j.snapshots ?? []);
  if (!storage.sufficient)
    fail(
      `Insufficient disk space for safe history import: ${storage.requiredBytes} bytes required, ${storage.availableBytes} bytes available.`,
    );
}
function resourcesFor(
  options: PreviewOptions,
  preview: HomeRepairPreview,
): RepairAdmissionResources {
  const p = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const allowedProfiles = profiles(options);
  const selected = preview.electronProfiles
    .filter((item) => item.localState.present)
    .map((item) => item.profileDirectory);
  if (selected.some((profile) => !allowedProfiles.includes(profile)))
    fail("Import profile escaped the current user roots.");
  return { homes: [p.originalHomeDirectory, p.lanHomeDirectory], electronProfiles: selected };
}
function validateJournal(
  options: PreviewOptions,
  value: Record<string, unknown>,
  repairId: string,
): Journal {
  const p = locations(options, repairId);
  const j = value as unknown as Journal;
  if (
    j.schemaVersion !== 1 ||
    j.operation !== operation ||
    j.repairId !== repairId ||
    !hex.test(j.reviewGeneration) ||
    !hex.test(j.selectionSha256) ||
    !hex.test(j.targetAuxiliaryGeneration) ||
    j.cachedPreview?.original?.homeDirectory !== p.originalHomeDirectory ||
    j.cachedPreview?.lan?.homeDirectory !== p.lanHomeDirectory ||
    j.sourceEnvironmentId !== identity(p.lanHomeDirectory) ||
    j.targetEnvironmentId !== identity(p.originalHomeDirectory) ||
    !Array.isArray(j.snapshots) ||
    j.snapshots.length > 6 ||
    ![
      "backing-up",
      "staging",
      "publishing-attachments",
      "publishing-database",
      "published",
      "rolling-back",
      "completed",
      "rolled-back",
    ].includes(j.phase)
  )
    fail("Import journal does not match the exact source and target homes.");
  const resources = resourcesFor(options, j.cachedPreview);
  const sources = [...resources.homes, ...resources.electronProfiles];
  for (const [index, snapshot] of j.snapshots.entries())
    if (
      snapshot.source !== sources[index] ||
      snapshot.backup !== NodePath.join(p.root, `snapshot-${index}`) ||
      !hex.test(snapshot.sha256)
    )
      fail("Import snapshot inventory escaped its transaction.");
  for (const observation of [j.sourceBefore, j.targetBefore])
    if (
      !observation ||
      !hex.test(observation.dataGeneration) ||
      !hex.test(observation.workGeneration)
    )
      fail("Import journal lacks exact native generations.");
  return j;
}
export function pendingHistoryImportPreview(options: PreviewOptions) {
  const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  if (!NodeFS.existsSync(paths.journalPath)) return null;
  const value = boundedJson(paths.journalPath);
  if (value.operation !== operation) return null;
  const j = validateJournal(options, value, String(value.repairId));
  const p = locations(options, j.repairId);
  return {
    ...j.cachedPreview,
    state: "blocked" as const,
    applySupported: true,
    canApply: false,
    importRetainedLanHistorySupported: true,
    canImportRetainedLanHistory: false,
    historyImportPreview: j.historyPreview,
    historyImportBlockers: ["history-import-recovery-required"],
    historyImportRecovery: {
      repairId: j.repairId,
      phase: j.phase,
      receiptPath: p.receipt,
      sourceEnvironmentId: j.sourceEnvironmentId,
      targetEnvironmentId: j.targetEnvironmentId,
      reviewGeneration: j.reviewGeneration,
      recoverSupported: true,
      rollbackSupported: j.oldPins !== undefined,
    },
    blockers: [
      ...j.cachedPreview.blockers.filter((item) => item !== "incomplete-home-repair"),
      "incomplete-home-repair",
    ],
  };
}
function checkedManifest(p: ReturnType<typeof locations>, j: Journal): HistoryImportResult {
  if (
    !j.manifestSha256 ||
    !hex.test(j.manifestSha256) ||
    filePin(p.manifest)?.sha256 !== j.manifestSha256
  )
    fail("Import manifest is missing or changed.");
  const result = boundedJson(p.manifest, 64 * 1024 * 1024) as unknown as HistoryImportResult;
  const proof = result.proof;
  if (
    !proof ||
    proof.eventPrefixGenerationBefore !== proof.eventPrefixGenerationAfter ||
    proof.existingRowsGenerationBefore !== proof.existingRowsGenerationAfter ||
    proof.existingWorkGenerationBefore !== proof.existingWorkGenerationAfter ||
    ![
      proof.eventPrefixGenerationBefore,
      proof.existingRowsGenerationBefore,
      proof.existingWorkGenerationBefore,
    ].every((value) => hex.test(value)) ||
    !Array.isArray(result.attachmentManifest) ||
    result.attachmentManifest.length > 100000
  )
    fail("Import did not preserve existing events, rows and work.");
  const seen = new Set<string>();
  for (const attachment of result.attachmentManifest) {
    if (
      !/^userdata\/attachments\/[a-z0-9_-]+\.[a-z0-9]+$/iu.test(attachment.targetRelativePath) ||
      seen.has(attachment.targetRelativePath) ||
      !hex.test(attachment.sha256) ||
      !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes < 0 ||
      typeof attachment.alreadyPresent !== "boolean"
    )
      fail("Import attachment manifest is not an exact flat immutable inventory.");
    seen.add(attachment.targetRelativePath);
  }
  return result;
}
function requireUnchangedSources(
  options: PreviewOptions,
  j: Journal,
  allowedNewFiles: readonly string[],
) {
  const p = locations(options, j.repairId);
  if (
    selectionGeneration(options) !== j.selectionSha256 ||
    identity(p.originalHomeDirectory) !== j.targetEnvironmentId ||
    identity(p.lanHomeDirectory) !== j.sourceEnvironmentId ||
    auxiliaryGeneration(p.originalHomeDirectory, allowedNewFiles) !== j.targetAuxiliaryGeneration
  )
    fail("Original auxiliary state or selected-home binding changed during import.");
  for (const snapshot of j.snapshots) {
    if (treeDigest(snapshot.backup).sha256 !== snapshot.sha256)
      fail("Import opaque backup changed.");
    if (
      snapshot.source !== p.originalHomeDirectory &&
      treeDigest(snapshot.source).sha256 !== snapshot.sha256
    )
      fail("Retained source or Electron profile changed during import.");
  }
}
function sameObservation(left: Observation, right: Observation) {
  return (
    left.dataGeneration === right.dataGeneration && left.workGeneration === right.workGeneration
  );
}
function reply(
  p: ReturnType<typeof locations>,
  j: Journal,
  result: HistoryImportResult,
  source: Observation,
  target: Observation,
  status: HistoryImportReply["status"],
): HistoryImportReply {
  if (!sameObservation(source, j.sourceBefore))
    fail("Retained LAN data or work changed during import.");
  return {
    schemaVersion: 1,
    operation,
    status,
    repairId: j.repairId,
    receiptPath: p.receipt,
    sourceEnvironmentId: j.sourceEnvironmentId,
    targetEnvironmentId: j.targetEnvironmentId,
    reviewGeneration: j.reviewGeneration,
    sourceDataGenerationBefore: j.sourceBefore.dataGeneration,
    sourceDataGenerationAfter: source.dataGeneration,
    sourceWorkGenerationBefore: j.sourceBefore.workGeneration,
    sourceWorkGenerationAfter: source.workGeneration,
    targetDataGenerationBefore: j.targetBefore.dataGeneration,
    targetDataGenerationAfter: target.dataGeneration,
    targetWorkGenerationBefore: j.targetBefore.workGeneration,
    targetWorkGenerationAfter: target.workGeneration,
    summary: result.summary,
    proof: result.proof,
    existingWorkPreserved: true,
    eventPrefixPreserved: true,
    sourcePreserved: true,
  };
}
function moveFile(
  from: string,
  to: string,
  pin: NonNullable<FilePin>,
  label: string,
  ports: HistoryImportExecutionPorts,
) {
  assertOrdinaryNativePath(from, false);
  assertOrdinaryNativePath(to, false);
  if (samePin(filePin(from), pin) && filePin(to) === null) {
    ports.onPhase?.("before:" + label);
    NodeFS.renameSync(from, to);
    ports.onPhase?.("after:" + label);
    return;
  }
  if (filePin(from) === null && samePin(filePin(to), pin)) return;
  fail("SQLite publication or recovery encountered an unrecognized raw file state.");
}
function requireForwardState(p: ReturnType<typeof locations>, j: Journal) {
  if (!j.oldPins || !j.newDatabasePin) fail("Import has no validated SQLite publication plan.");
  const live = NodePath.join(p.originalHomeDirectory, "userdata");
  for (const name of databaseNames) {
    const old = j.oldPins[name];
    const actual = filePin(NodePath.join(live, name));
    const quarantined = filePin(NodePath.join(p.old, name));
    if (
      name === "statev2.sqlite" &&
      samePin(actual, j.newDatabasePin) &&
      samePin(quarantined, old) &&
      filePin(NodePath.join(p.staged, "userdata", name)) === null
    )
      continue;
    if (
      old === null
        ? actual !== null || quarantined !== null
        : !(
            (samePin(actual, old) && quarantined === null) ||
            (actual === null && samePin(quarantined, old))
          )
    )
      fail("Import SQLite set is not a recognized pre/publish state.");
  }
}
function finishDatabasePublish(
  p: ReturnType<typeof locations>,
  j: Journal,
  ports: HistoryImportExecutionPorts,
) {
  requireForwardState(p, j);
  NodeFS.mkdirSync(p.old, { recursive: true });
  const live = NodePath.join(p.originalHomeDirectory, "userdata");
  const mainPublished =
    samePin(filePin(NodePath.join(live, "statev2.sqlite")), j.newDatabasePin!) &&
    samePin(filePin(NodePath.join(p.old, "statev2.sqlite")), j.oldPins!["statev2.sqlite"]) &&
    filePin(NodePath.join(p.staged, "userdata", "statev2.sqlite")) === null;
  if (!mainPublished) {
    for (const name of ["statev2.sqlite-wal", "statev2.sqlite-shm", "statev2.sqlite"] as const)
      if (j.oldPins![name] !== null)
        moveFile(
          NodePath.join(live, name),
          NodePath.join(p.old, name),
          j.oldPins![name]!,
          "quarantine:" + name,
          ports,
        );
    moveFile(
      NodePath.join(p.staged, "userdata", "statev2.sqlite"),
      NodePath.join(live, "statev2.sqlite"),
      j.newDatabasePin!,
      "publish:statev2.sqlite",
      ports,
    );
  }
}
function newAttachmentPaths(result: HistoryImportResult) {
  return result.attachmentManifest
    .filter((item) => !item.alreadyPresent)
    .map((item) => item.targetRelativePath);
}
function partialAttachmentPath(relative: string, repairId: string) {
  return relative + `.history-import-${repairId}.partial`;
}
function allowedAttachmentPaths(result: HistoryImportResult, repairId: string) {
  return newAttachmentPaths(result).flatMap((relative) => [
    relative,
    partialAttachmentPath(relative, repairId),
  ]);
}
function fsyncFile(file: string) {
  const descriptor = NodeFS.openSync(file, "r+");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}
function isFilePrefix(partial: string, complete: string, maximum: number) {
  const actual = filePin(partial);
  if (actual === null || actual.bytes > maximum) return false;
  const left = NodeFS.openSync(partial, "r");
  const right = NodeFS.openSync(complete, "r");
  try {
    const a = Buffer.alloc(65536);
    const b = Buffer.alloc(65536);
    for (;;) {
      const n = NodeFS.readSync(left, a);
      if (!n) return true;
      if (NodeFS.readSync(right, b, 0, n, null) !== n || !a.subarray(0, n).equals(b.subarray(0, n)))
        return false;
    }
  } finally {
    NodeFS.closeSync(left);
    NodeFS.closeSync(right);
  }
}
function copyAttachments(
  p: ReturnType<typeof locations>,
  j: Journal,
  result: HistoryImportResult,
  ports: HistoryImportExecutionPorts,
) {
  for (const attachment of result.attachmentManifest) {
    const to = NodePath.join(p.originalHomeDirectory, attachment.targetRelativePath);
    const expected = { bytes: attachment.bytes, sha256: attachment.sha256 };
    const partial = NodePath.join(
      p.originalHomeDirectory,
      partialAttachmentPath(attachment.targetRelativePath, j.repairId),
    );
    const from = NodePath.join(p.staged, attachment.targetRelativePath);
    if (samePin(filePin(to), expected)) continue;
    if (filePin(to) !== null) fail("An import attachment path has different existing bytes.");
    if (attachment.alreadyPresent) fail("A pre-existing attachment disappeared.");
    if (!samePin(filePin(from), expected)) fail("Staged import attachment changed.");
    assertOrdinaryNativePath(NodePath.dirname(to), true);
    NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
    if (filePin(partial) !== null && !samePin(filePin(partial), expected)) {
      if (!isFilePrefix(partial, from, expected.bytes))
        fail("An owned attachment partial has unrecognized bytes.");
      const quarantine = NodePath.join(p.root, "attachment-partials");
      NodeFS.mkdirSync(quarantine, { recursive: true });
      NodeFS.renameSync(
        partial,
        NodePath.join(
          quarantine,
          NodePath.basename(partial) + "." + NodeCrypto.randomBytes(6).toString("hex"),
        ),
      );
    }
    if (filePin(partial) === null) {
      ports.onPhase?.("before:attachment-copy");
      NodeFS.copyFileSync(from, partial, NodeFS.constants.COPYFILE_EXCL);
      fsyncFile(partial);
      ports.onPhase?.("after:attachment-copy");
    }
    if (!samePin(filePin(partial), expected) || filePin(to) !== null)
      fail("Import attachment partial or immutable destination changed.");
    ports.onPhase?.("before:attachment-publish");
    NodeFS.renameSync(partial, to);
    ports.onPhase?.("after:attachment-publish");
  }
}
function baselineResult(preview: HistoryImportPreview): HistoryImportResult {
  return {
    schemaVersion: 1,
    summary: preview.summary,
    importedThreadIds: [],
    newProjectIds: [],
    attachmentManifest: [],
    proof: {
      targetEventHeadBefore: preview.baseline.targetEventHead,
      eventPrefixGenerationBefore: preview.baseline.eventPrefixGeneration,
      eventPrefixGenerationAfter: preview.baseline.eventPrefixGeneration,
      existingRowsGenerationBefore: preview.baseline.existingRowsGeneration,
      existingRowsGenerationAfter: preview.baseline.existingRowsGeneration,
      existingWorkGenerationBefore: preview.baseline.existingWorkGeneration,
      existingWorkGenerationAfter: preview.baseline.existingWorkGeneration,
    },
  } as HistoryImportResult;
}
function validateReview(
  preview: HistoryImportPreview,
  source: string,
  target: string,
  expected: string,
) {
  if (
    preview.schemaVersion !== 1 ||
    preview.reviewGeneration !== expected ||
    preview.sourceEnvironmentId !== source ||
    preview.targetEnvironmentId !== target ||
    preview.blockers.length !== 0 ||
    preview.summary.missingAttachments !== 0
  )
    fail("History import review is stale, incomplete or blocked.");
}
function archiveJournal(
  p: ReturnType<typeof locations>,
  j: Journal,
  ports: HistoryImportExecutionPorts,
) {
  const archive = NodePath.join(
    p.root,
    j.phase === "rolled-back" ? "rollback-journal.json" : "completed-journal.json",
  );
  if (NodeFS.existsSync(archive)) fail("Import journal archive already exists.");
  ports.onPhase?.("before:journal-archive");
  NodeFS.renameSync(p.journalPath, archive);
  ports.onPhase?.("after:journal-archive");
}
async function finishForward(
  options: PreviewOptions,
  j: Journal,
  ports: HistoryImportExecutionPorts,
  finalize = true,
): Promise<HistoryImportReply> {
  const p = locations(options, j.repairId);
  const result = checkedManifest(p, j);
  requireUnchangedSources(options, j, allowedAttachmentPaths(result, j.repairId));
  requireForwardState(p, j);
  copyAttachments(p, j, result, ports);
  j.phase = "publishing-database";
  metadata(p.journalPath, j, j.repairId);
  finishDatabasePublish(p, j, ports);
  j.phase = "published";
  metadata(p.journalPath, j, j.repairId);
  const source = observe(p.lanHomeDirectory);
  const target = observe(p.originalHomeDirectory);
  if (!j.expectedTargetAfter || !sameObservation(target, j.expectedTargetAfter))
    fail("Published SQLite state differs from the checked staged import.");
  requireUnchangedSources(options, j, allowedAttachmentPaths(result, j.repairId));
  j.result = reply(p, j, result, source, target, "imported-pending-verification");
  if (finalize) {
    j.phase = "completed";
    metadata(p.journalPath, j, j.repairId);
    metadata(p.receipt, j, j.repairId);
    archiveJournal(p, j, ports);
  } else metadata(p.journalPath, j, j.repairId);
  return j.result;
}
async function prepareStage(
  options: PreviewOptions,
  j: Journal,
  ports: HistoryImportExecutionPorts,
) {
  const p = locations(options, j.repairId);
  const resources = resourcesFor(options, j.cachedPreview);
  await ports.verifyStopped(resources);
  requireStorage(options, j, ports);
  if (
    !sameObservation(observe(p.originalHomeDirectory), j.targetBefore) ||
    !sameObservation(observe(p.lanHomeDirectory), j.sourceBefore) ||
    selectionGeneration(options) !== j.selectionSha256
  )
    fail("Import source or target changed before staging.");
  requireIdleSource(p.lanHomeDirectory);
  const sourcePaths = [...resources.homes, ...resources.electronProfiles];
  for (const [index, source] of sourcePaths.entries()) {
    if (j.snapshots[index]) {
      if (
        treeDigest(j.snapshots[index]!.backup).sha256 !== j.snapshots[index]!.sha256 ||
        treeDigest(source).sha256 !== j.snapshots[index]!.sha256
      )
        fail("Completed import backup changed.");
      continue;
    }
    const backup = NodePath.join(p.root, `snapshot-${index}`);
    if (NodeFS.existsSync(backup))
      NodeFS.renameSync(backup, backup + ".partial-" + NodeCrypto.randomBytes(6).toString("hex"));
    j.snapshots.push(copySnapshot(source, backup));
    metadata(p.journalPath, j, j.repairId);
  }
  j.phase = "staging";
  metadata(p.journalPath, j, j.repairId);
  if (NodeFS.existsSync(p.staged))
    NodeFS.renameSync(
      p.staged,
      NodePath.join(p.root, "retained-stage-" + NodeCrypto.randomBytes(6).toString("hex")),
    );
  NodeFS.cpSync(j.snapshots[0]!.backup, p.staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await migrateRepairStagedHome(p.staged);
  const imported = await (ports.importHistory ?? importHistory)({
    sourceHomeDirectory: p.lanHomeDirectory,
    stagedTargetHomeDirectory: p.staged,
    expectedReviewGeneration: j.reviewGeneration,
  });
  if (
    imported.proof.targetEventHeadBefore !== j.historyPreview.baseline.targetEventHead ||
    imported.proof.eventPrefixGenerationBefore !==
      j.historyPreview.baseline.eventPrefixGeneration ||
    imported.proof.existingRowsGenerationBefore !==
      j.historyPreview.baseline.existingRowsGeneration ||
    imported.proof.existingWorkGenerationBefore !== j.historyPreview.baseline.existingWorkGeneration
  )
    fail("Staged import did not use the exact reviewed target baseline.");
  if (NodeFS.existsSync(p.manifest))
    NodeFS.renameSync(
      p.manifest,
      p.manifest + ".retained-" + NodeCrypto.randomBytes(6).toString("hex"),
    );
  const manifest = JSON.stringify(imported) + "\n";
  if (Buffer.byteLength(manifest) > 64 * 1024 * 1024) fail("Import manifest exceeds its bound.");
  NodeFS.writeFileSync(p.manifest, manifest, { flag: "wx", mode: 0o600 });
  fsyncFile(p.manifest);
  j.manifestSha256 = filePin(p.manifest)!.sha256;
  checkedManifest(p, j);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(p.staged, "userdata", "statev2.sqlite"));
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  } finally {
    db.close();
  }
  await validateRepairStagedHome(p.staged);
  j.expectedTargetAfter = observe(p.staged);
  const stagedRaw = rawPins(NodePath.join(p.staged, "userdata"));
  if (
    stagedRaw["statev2.sqlite"] === null ||
    stagedRaw["statev2.sqlite-wal"]?.bytes ||
    stagedRaw["statev2.sqlite-shm"] !== null
  )
    fail("Staged import is not a closed standalone SQLite snapshot.");
  j.newDatabasePin = stagedRaw["statev2.sqlite"]!;
  if (!sameObservation(observe(p.originalHomeDirectory), j.targetBefore))
    fail("Original work changed while the import was staged.");
  requireUnchangedSources(options, j, []);
  j.oldPins = rawPins(NodePath.join(p.originalHomeDirectory, "userdata"));
  if (
    NodeFS.statSync(p.root).dev !==
    NodeFS.statSync(NodePath.join(p.originalHomeDirectory, "userdata")).dev
  )
    fail("Atomic SQLite import publication requires the same local volume.");
  j.phase = "publishing-attachments";
  metadata(p.journalPath, j, j.repairId);
  ports.onPhase?.("staged");
}
function validateRequest(request: HistoryImportRequest | HistoryImportRecoveryRequest) {
  if (
    request.schemaVersion !== 1 ||
    !/^[a-f0-9]{32}$/u.test(request.repairId) ||
    !hex.test(request.expectedReviewGeneration) ||
    !request.expectedSourceEnvironmentId ||
    !request.expectedTargetEnvironmentId ||
    request.expectedSourceEnvironmentId === request.expectedTargetEnvironmentId
  )
    fail("Import requires exact reviewed distinct home identities.");
}
export async function previewRetainedLanHistory(
  options: PreviewOptions,
  ports?: Pick<HistoryImportExecutionPorts, "previewHistory">,
) {
  const p = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const report = previewHomeRepair(options);
  let historyImportPreview: HistoryImportPreview | null = null;
  let historyImportStorage: {
    requiredBytes: number;
    availableBytes: number;
    sufficient: boolean;
  } | null = null;
  const historyImportBlockers: string[] = [];
  try {
    if (report.state === "blocked") historyImportBlockers.push("home-repair-preview-blocked");
    else if (report.original.state !== "initialized" || report.lan.state !== "initialized")
      historyImportBlockers.push("retained-lan-home-not-initialized");
    else if (report.original.activeWork === null || report.lan.activeWork === null)
      historyImportBlockers.push("native-work-unknown");
    else if (report.lan.activeWork !== 0)
      historyImportBlockers.push("retained-lan-has-unfinished-work");
    else if (
      [report.original, report.lan].some(
        (home) =>
          JSON.stringify(home.migrationIds) !== JSON.stringify(options.supportedMigrationIds),
      )
    )
      historyImportBlockers.push("history-import-requires-current-schema");
    else {
      const selected = resolveNativeHomeSelection(options);
      if (selected.homeDirectory !== p.originalHomeDirectory || selected.mode !== "drop-in")
        historyImportBlockers.push("original-home-not-selected");
      else {
        historyImportPreview = await (ports?.previewHistory ?? previewHistoryImport)({
          sourceHomeDirectory: p.lanHomeDirectory,
          targetHomeDirectory: p.originalHomeDirectory,
        });
        historyImportBlockers.push(...historyImportPreview.blockers);
      }
    }
  } catch {
    historyImportBlockers.push("retained-history-preview-failed");
  }
  if (historyImportPreview !== null) {
    try {
      historyImportStorage = storageFor(options, report, historyImportPreview);
      if (!historyImportStorage.sufficient)
        historyImportBlockers.push("history-import-insufficient-disk-space");
    } catch {
      historyImportBlockers.push("history-import-storage-unavailable");
    }
  }
  return {
    historyImportStorage,
    importRetainedLanHistorySupported: true as const,
    canImportRetainedLanHistory:
      historyImportPreview !== null &&
      historyImportBlockers.length === 0 &&
      historyImportPreview.summary.missingAttachments === 0,
    historyImportPreview,
    historyImportBlockers,
    historyImportRecovery: null,
  };
}
export async function importRetainedLanHistory(
  options: PreviewOptions,
  request: HistoryImportRequest,
  ports: HistoryImportExecutionPorts,
): Promise<HistoryImportReply> {
  validateRequest(request);
  for (const generation of [
    request.expectedPlanId,
    request.expectedSourceDataGeneration,
    request.expectedSourceWorkGeneration,
    request.expectedTargetDataGeneration,
    request.expectedTargetWorkGeneration,
  ])
    if (!hex.test(generation)) fail("Import requires exact current native generations.");
  if (request.opaqueBackupApproved !== true)
    fail("History import requires explicit fresh opaque backup consent.");
  const p = locations(options, request.repairId);
  if (NodeFS.existsSync(p.journalPath))
    fail("An unfinished native import requires matching recovery first.");
  if (NodeFS.existsSync(p.receipt))
    return recoverRetainedLanHistory(options, { ...request, recoveryOperation: "recover" }, ports);
  const before = previewHomeRepair(options);
  if (
    [before.original, before.lan].some(
      (home) => JSON.stringify(home.migrationIds) !== JSON.stringify(options.supportedMigrationIds),
    )
  )
    fail("History import requires both homes at the current supported schema.");
  const selected = resolveNativeHomeSelection(options);
  if (
    before.planId !== request.expectedPlanId ||
    before.state === "blocked" ||
    before.original.state !== "initialized" ||
    before.lan.state !== "initialized" ||
    before.original.activeWork === null ||
    before.lan.activeWork !== 0 ||
    selected.homeDirectory !== p.originalHomeDirectory ||
    selected.mode !== "drop-in" ||
    before.original.environmentId !== request.expectedTargetEnvironmentId ||
    before.lan.environmentId !== request.expectedSourceEnvironmentId
  )
    fail("History import requires the exact selected original and idle retained LAN homes.");
  const resources = resourcesFor(options, before);
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStopped(resources);
    requireIdleSource(p.lanHomeDirectory);
    const historyPreview = await (ports.previewHistory ?? previewHistoryImport)({
      sourceHomeDirectory: p.lanHomeDirectory,
      targetHomeDirectory: p.originalHomeDirectory,
    });
    validateReview(
      historyPreview,
      request.expectedSourceEnvironmentId,
      request.expectedTargetEnvironmentId,
      request.expectedReviewGeneration,
    );
    requireStorage(options, { cachedPreview: before, historyPreview }, ports);
    const sourceBefore = observe(p.lanHomeDirectory);
    const targetBefore = observe(p.originalHomeDirectory);
    if (
      sourceBefore.dataGeneration !== request.expectedSourceDataGeneration ||
      sourceBefore.workGeneration !== request.expectedSourceWorkGeneration ||
      targetBefore.dataGeneration !== request.expectedTargetDataGeneration ||
      targetBefore.workGeneration !== request.expectedTargetWorkGeneration
    )
      fail("Native import source or target generation changed after review.");
    assertOrdinaryNativePath(p.root, true);
    if (NodeFS.existsSync(p.root)) fail("Import recovery directory already exists.");
    NodeFS.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    const j: Journal = {
      schemaVersion: 1,
      operation,
      repairId: request.repairId,
      phase: "backing-up",
      sourceEnvironmentId: request.expectedSourceEnvironmentId,
      targetEnvironmentId: request.expectedTargetEnvironmentId,
      reviewGeneration: request.expectedReviewGeneration,
      cachedPreview: before,
      historyPreview,
      selectionSha256: selectionGeneration(options),
      snapshots: [],
      sourceBefore,
      targetBefore,
      targetAuxiliaryGeneration: auxiliaryGeneration(p.originalHomeDirectory),
    };
    metadata(p.journalPath, j, j.repairId);
    ports.onPhase?.("journaled");
    await prepareStage(options, j, ports);
    return finishForward(options, j, ports);
  });
}
function validateImportedAttachments(p: ReturnType<typeof locations>, result: HistoryImportResult) {
  for (const attachment of result.attachmentManifest)
    if (
      !samePin(filePin(NodePath.join(p.originalHomeDirectory, attachment.targetRelativePath)), {
        bytes: attachment.bytes,
        sha256: attachment.sha256,
      })
    )
      fail("Imported attachment changed after publication.");
}
function prepareRestoreFiles(p: ReturnType<typeof locations>, j: Journal) {
  NodeFS.mkdirSync(p.restore, { recursive: true });
  for (const name of databaseNames) {
    const expected = j.oldPins![name];
    if (expected === null) continue;
    const original = NodePath.join(p.old, name);
    const staged = NodePath.join(p.restore, name);
    if (!samePin(filePin(original), expected)) fail("Pre-import SQLite quarantine changed.");
    if (samePin(filePin(staged), expected)) continue;
    if (filePin(staged) !== null) {
      if (!isFilePrefix(staged, original, expected.bytes))
        fail("Rollback staging contains unrecognized bytes.");
      NodeFS.renameSync(staged, staged + ".partial-" + NodeCrypto.randomBytes(6).toString("hex"));
    }
    NodeFS.copyFileSync(original, staged, NodeFS.constants.COPYFILE_EXCL);
    fsyncFile(staged);
    if (!samePin(filePin(staged), expected))
      fail("Rollback copy differs from the pre-import quarantine.");
  }
}
async function finishRollback(
  options: PreviewOptions,
  j: Journal,
  ports: HistoryImportExecutionPorts,
): Promise<HistoryImportReply> {
  const p = locations(options, j.repairId);
  const result = checkedManifest(p, j);
  if (!j.oldPins || !j.rollbackPins || !j.rollbackStep)
    fail("Rollback has no checked raw SQLite plan.");
  requireUnchangedSources(options, j, allowedAttachmentPaths(result, j.repairId));
  const live = NodePath.join(p.originalHomeDirectory, "userdata");
  NodeFS.mkdirSync(p.rollback, { recursive: true });
  if (j.rollbackStep === "quarantine") {
    for (const name of databaseNames) {
      const pin = j.rollbackPins[name];
      const actual = filePin(NodePath.join(live, name));
      const quarantined = filePin(NodePath.join(p.rollback, name));
      if (
        pin === null
          ? actual !== null || quarantined !== null
          : !(
              (samePin(actual, pin) && quarantined === null) ||
              (actual === null && samePin(quarantined, pin))
            )
      )
        fail("Rollback found unrecognized post-import SQLite bytes.");
    }
    prepareRestoreFiles(p, j);
    for (const name of ["statev2.sqlite-wal", "statev2.sqlite-shm", "statev2.sqlite"] as const)
      if (j.rollbackPins[name] !== null)
        moveFile(
          NodePath.join(live, name),
          NodePath.join(p.rollback, name),
          j.rollbackPins[name]!,
          "rollback-quarantine:" + name,
          ports,
        );
    j.rollbackStep = "restore";
    metadata(p.journalPath, j, j.repairId);
  }
  if (j.rollbackStep === "restore") {
    for (const name of databaseNames)
      if (!samePin(filePin(NodePath.join(p.rollback, name)), j.rollbackPins[name]))
        fail("Post-import rollback quarantine changed.");
    for (const name of ["statev2.sqlite-wal", "statev2.sqlite-shm", "statev2.sqlite"] as const) {
      const pin = j.oldPins[name];
      if (pin === null) {
        if (filePin(NodePath.join(live, name)) !== null)
          fail("Rollback would overwrite an unexpected SQLite sidecar.");
      } else
        moveFile(
          NodePath.join(p.restore, name),
          NodePath.join(live, name),
          pin,
          "rollback-restore:" + name,
          ports,
        );
    }
    j.rollbackStep = "attachments";
    metadata(p.journalPath, j, j.repairId);
  }
  const attachmentQuarantine = NodePath.join(p.root, "retained-import-attachments");
  NodeFS.mkdirSync(attachmentQuarantine, { recursive: true });
  for (const attachment of result.attachmentManifest.filter((item) => !item.alreadyPresent)) {
    const expected = { bytes: attachment.bytes, sha256: attachment.sha256 };
    moveFile(
      NodePath.join(p.originalHomeDirectory, attachment.targetRelativePath),
      NodePath.join(attachmentQuarantine, NodePath.basename(attachment.targetRelativePath)),
      expected,
      "rollback-attachment",
      ports,
    );
    const relative = partialAttachmentPath(attachment.targetRelativePath, j.repairId);
    const partial = NodePath.join(p.originalHomeDirectory, relative);
    const actual = filePin(partial);
    if (actual !== null) {
      if (
        !isFilePrefix(
          partial,
          NodePath.join(p.staged, attachment.targetRelativePath),
          expected.bytes,
        )
      )
        fail("Rollback found an unrecognized owned attachment partial.");
      moveFile(
        partial,
        NodePath.join(attachmentQuarantine, NodePath.basename(relative)),
        actual,
        "rollback-attachment-partial",
        ports,
      );
    }
  }
  const source = observe(p.lanHomeDirectory);
  const target = observe(p.originalHomeDirectory);
  if (!sameObservation(target, j.targetBefore))
    fail("Rollback did not restore the exact pre-import data and work generation.");
  requireUnchangedSources(options, j, []);
  j.phase = "rolled-back";
  j.result = reply(p, j, result, source, target, "rolled-back");
  metadata(p.journalPath, j, j.repairId);
  metadata(p.receipt, j, j.repairId);
  archiveJournal(p, j, ports);
  return j.result;
}
function cancelBeforePublication(
  options: PreviewOptions,
  j: Journal,
  ports: HistoryImportExecutionPorts,
): HistoryImportReply {
  const p = locations(options, j.repairId);
  if (!sameObservation(observe(p.originalHomeDirectory), j.targetBefore))
    fail("Original work changed before import cancellation.");
  requireUnchangedSources(options, j, []);
  j.phase = "rolled-back";
  j.result = reply(
    p,
    j,
    baselineResult(j.historyPreview),
    observe(p.lanHomeDirectory),
    observe(p.originalHomeDirectory),
    "rolled-back",
  );
  metadata(p.journalPath, j, j.repairId);
  metadata(p.receipt, j, j.repairId);
  archiveJournal(p, j, ports);
  return j.result;
}
export async function recoverRetainedLanHistory(
  options: PreviewOptions,
  request: HistoryImportRecoveryRequest,
  ports: HistoryImportExecutionPorts,
): Promise<HistoryImportReply> {
  validateRequest(request);
  if (!["recover", "rollback"].includes(request.recoveryOperation))
    fail("Unknown history import recovery direction.");
  const p = locations(options, request.repairId);
  const journalPresent = NodeFS.existsSync(p.journalPath);
  let j: Journal;
  if (journalPresent) j = validateJournal(options, boundedJson(p.journalPath), request.repairId);
  else if (NodeFS.existsSync(p.receipt))
    j = validateJournal(options, boundedJson(p.receipt), request.repairId);
  else {
    if (NodeFS.existsSync(p.root) && NodeFS.readdirSync(p.root).length !== 0)
      fail("Unrecognized partial import evidence requires review.");
    const cachedPreview = previewHomeRepair(options);
    const selected = resolveNativeHomeSelection(options);
    if (
      cachedPreview.state === "blocked" ||
      selected.homeDirectory !== p.originalHomeDirectory ||
      selected.mode !== "drop-in"
    )
      fail("Prepared import recovery has no exact selected original.");
    const resources = resourcesFor(options, cachedPreview);
    return ports.withExclusiveAdmission(resources, async () => {
      await ports.verifyStopped(resources);
      requireIdleSource(p.lanHomeDirectory);
      const historyPreview = await (ports.previewHistory ?? previewHistoryImport)({
        sourceHomeDirectory: p.lanHomeDirectory,
        targetHomeDirectory: p.originalHomeDirectory,
      });
      validateReview(
        historyPreview,
        request.expectedSourceEnvironmentId,
        request.expectedTargetEnvironmentId,
        request.expectedReviewGeneration,
      );
      const sourceBefore = observe(p.lanHomeDirectory);
      const targetBefore = observe(p.originalHomeDirectory);
      NodeFS.mkdirSync(p.root, { recursive: true, mode: 0o700 });
      const empty: Journal = {
        schemaVersion: 1,
        operation,
        repairId: request.repairId,
        phase: "rolled-back",
        sourceEnvironmentId: request.expectedSourceEnvironmentId,
        targetEnvironmentId: request.expectedTargetEnvironmentId,
        reviewGeneration: request.expectedReviewGeneration,
        cachedPreview,
        historyPreview,
        selectionSha256: selectionGeneration(options),
        snapshots: [],
        sourceBefore,
        targetBefore,
        targetAuxiliaryGeneration: auxiliaryGeneration(p.originalHomeDirectory),
      };
      empty.result = reply(
        p,
        empty,
        baselineResult(historyPreview),
        sourceBefore,
        targetBefore,
        "rolled-back",
      );
      metadata(p.receipt, empty, empty.repairId);
      return empty.result;
    });
  }
  if (
    j.sourceEnvironmentId !== request.expectedSourceEnvironmentId ||
    j.targetEnvironmentId !== request.expectedTargetEnvironmentId ||
    j.reviewGeneration !== request.expectedReviewGeneration
  )
    fail("Recovery request does not match this reviewed history import.");
  const resources = resourcesFor(options, j.cachedPreview);
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStopped(resources);
    if (j.phase === "rolling-back") return finishRollback(options, j, ports);
    if (j.phase === "rolled-back") {
      if (
        !j.result ||
        !sameObservation(observe(p.originalHomeDirectory), j.targetBefore) ||
        !sameObservation(observe(p.lanHomeDirectory), j.sourceBefore)
      )
        fail("Rolled-back import has newer state.");
      requireUnchangedSources(options, j, []);
      if (journalPresent) {
        metadata(p.receipt, j, j.repairId);
        archiveJournal(p, j, ports);
      }
      return j.result;
    }
    if (j.phase === "backing-up" || j.phase === "staging") {
      if (request.recoveryOperation === "rollback")
        return cancelBeforePublication(options, j, ports);
      await prepareStage(options, j, ports);
    }
    if (j.phase === "completed" && !journalPresent) {
      if (
        !j.result ||
        !sameObservation(observe(p.originalHomeDirectory), {
          dataGeneration: j.result.targetDataGenerationAfter,
          workGeneration: j.result.targetWorkGenerationAfter,
        }) ||
        !sameObservation(observe(p.lanHomeDirectory), j.sourceBefore)
      )
        fail("Original or retained LAN state changed after import.");
      const result = checkedManifest(p, j);
      requireUnchangedSources(options, j, allowedAttachmentPaths(result, j.repairId));
      validateImportedAttachments(p, result);
      if (request.recoveryOperation === "recover") return j.result;
    } else await finishForward(options, j, ports, request.recoveryOperation === "recover");
    if (request.recoveryOperation === "recover") return j.result!;
    const result = checkedManifest(p, j);
    validateImportedAttachments(p, result);
    if (
      !j.result ||
      !sameObservation(observe(p.originalHomeDirectory), {
        dataGeneration: j.result.targetDataGenerationAfter,
        workGeneration: j.result.targetWorkGenerationAfter,
      })
    )
      fail("Rollback refuses newer original work or history.");
    requireUnchangedSources(options, j, allowedAttachmentPaths(result, j.repairId));
    j.rollbackPins = rawPins(NodePath.join(p.originalHomeDirectory, "userdata"));
    j.rollbackStep = "quarantine";
    j.phase = "rolling-back";
    metadata(p.journalPath, j, j.repairId);
    return finishRollback(options, j, ports);
  });
}
