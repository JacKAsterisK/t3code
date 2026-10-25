// @effect-diagnostics nodeBuiltinImport:off -- Explicit offline transactions operate only while the host holds admission; credentials remain opaque backup bytes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { previewHomeRepair, type PreviewOptions } from "./home-repair.ts";
import {
  assertOrdinaryNativePath,
  nativeHomePaths,
  type NativeHomeSelection,
} from "../../packages/shared/src/nativeHomeSelection.ts";

export interface RepairAdmissionResources {
  readonly homes: readonly string[];
  readonly electronProfiles: readonly string[];
}

/** The host must keep Windows kernel leases and stopped-profile admission for the entire callback, including rollback. */
export interface HomeRepairExecutionPorts {
  readonly withExclusiveAdmission: <A>(
    resources: RepairAdmissionResources,
    operation: () => Promise<A>,
  ) => Promise<A>;
  readonly verifyStoppedAndIdle: (resources: RepairAdmissionResources) => Promise<void>;
  readonly migrateStagedHome: (stagedHome: string) => Promise<void>;
  readonly validateStagedHome: (stagedHome: string) => Promise<void>;
}

export interface HomeRepairApplyRequest {
  readonly schemaVersion: 1;
  readonly expectedPlanId: string;
  readonly choice: "adopt-original-retain-lan" | "side-by-side-retain-original";
  readonly opaqueBackupApproved: true;
  readonly repairId: string;
}

interface Snapshot {
  readonly source: string;
  readonly backup: string;
  readonly sha256: string;
  readonly files: number;
}

interface RepairReceipt {
  readonly schemaVersion: 1;
  readonly repairId: string;
  readonly status: "selected-pending-verification" | "rolled-back";
  readonly selectionSha256: string;
  readonly selectionPath: string;
  readonly previousSelection: string | null;
  readonly selectedHomeDirectory: string;
  readonly retainedHomeDirectory: string;
  readonly electronProfileDirectory: string;
  readonly snapshots: readonly Snapshot[];
}

const ignoredLocks = new Set([
  "native-admission.lock",
  "userdata/server-owner.sqlite",
  "userdata/server-owner.sqlite-journal",
  "userdata/statev2.sqlite-shm",
  "userdata/state.sqlite-shm",
]);

function treeDigest(directory: string) {
  const hash = NodeCrypto.createHash("sha256");
  let files = 0;
  const walk = (relative: string) => {
    const at = NodePath.join(directory, relative);
    const stat = NodeFS.lstatSync(at);
    if (stat.isSymbolicLink())
      throw new Error("Repair requires review of redirected storage before opaque backup.");
    if (stat.isDirectory()) {
      hash.update(`directory:${relative}\0`);
      for (const name of NodeFS.readdirSync(at).sort())
        walk(relative ? `${relative}/${name}` : name);
      return;
    }
    if (ignoredLocks.has(relative)) return;
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Repair refuses nonordinary backup files.");
    if (++files > 100_000)
      throw new Error("Repair backup inventory exceeds the reviewed file bound.");
    hash.update(`file:${relative}:${stat.size}\0`);
    const descriptor = NodeFS.openSync(at, "r");
    try {
      const buffer = Buffer.alloc(65_536);
      for (;;) {
        const n = NodeFS.readSync(descriptor, buffer);
        if (!n) break;
        hash.update(buffer.subarray(0, n));
      }
    } finally {
      NodeFS.closeSync(descriptor);
    }
  };
  walk("");
  return { sha256: hash.digest("hex"), files };
}

function copySnapshot(source: string, backup: string): Snapshot {
  assertOrdinaryNativePath(source, true);
  const before = treeDigest(source);
  NodeFS.cpSync(source, backup, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    dereference: false,
    filter: (file) =>
      !ignoredLocks.has(NodePath.relative(source, file).split(NodePath.sep).join("/")),
  });
  const copied = treeDigest(backup);
  const after = treeDigest(source);
  if (before.sha256 !== copied.sha256 || before.sha256 !== after.sha256)
    throw new Error("Source state changed or its coherent backup could not be verified.");
  return { source, backup, ...copied };
}

function atomicWrite(file: string, text: string, repairId: string) {
  assertOrdinaryNativePath(file, false);
  const temporary = `${file}.${repairId}.tmp`;
  const descriptor = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, text);
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
  NodeFS.renameSync(temporary, file);
}

function originalProfile(options: PreviewOptions): string {
  for (const name of ["t3code-v2", "T3 Code (Alpha)", "t3code"]) {
    const directory = NodePath.join(options.appDataDirectory, name);
    if (NodeFS.existsSync(NodePath.join(directory, "Local State"))) return directory;
  }
  throw new Error(
    "Original Electron protection context is missing; repair cannot promise saved connection compatibility.",
  );
}

export async function executeHomeRepair(
  options: PreviewOptions,
  request: HomeRepairApplyRequest,
  ports: HomeRepairExecutionPorts,
) {
  if (
    request.schemaVersion !== 1 ||
    request.opaqueBackupApproved !== true ||
    !/^[a-f0-9]{32}$/.test(request.repairId) ||
    !/^[a-f0-9]{64}$/.test(request.expectedPlanId) ||
    !["adopt-original-retain-lan", "side-by-side-retain-original"].includes(request.choice)
  )
    throw new Error(
      "Repair requires an exact reviewed preview, explicit retention choice, and opaque-backup approval.",
    );
  const preview = previewHomeRepair(options);
  if (
    preview.planId !== request.expectedPlanId ||
    preview.state === "blocked" ||
    (request.choice === "adopt-original-retain-lan" && preview.original.state !== "initialized")
  )
    throw new Error("Repair preview is stale or the requested original home is unavailable.");
  const profile =
    request.choice === "adopt-original-retain-lan"
      ? originalProfile(options)
      : NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile");
  if (!NodeFS.existsSync(NodePath.join(profile, "Local State")))
    throw new Error("Selected Electron protection context is missing.");
  if (request.choice === "side-by-side-retain-original" && preview.lan.state !== "initialized")
    throw new Error("Side-by-side selection requires an existing initialized LAN home.");
  const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const preserved = [preview.original, preview.lan].filter((home) => home.state === "initialized");
  const homes = preserved.map((home) => home.homeDirectory);
  const validationSource = preserved[0]!;
  const profiles = preview.electronProfiles
    .filter((item) => item.localState.present)
    .map((item) => item.profileDirectory);
  const resources = { homes, electronProfiles: profiles };
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStoppedAndIdle(resources);
    const current = previewHomeRepair(options);
    if (current.planId !== request.expectedPlanId)
      throw new Error("Repair state changed before exclusive admission.");
    if (NodeFS.existsSync(paths.journalPath))
      throw new Error("An unresolved home repair requires recovery first.");
    const recovery = NodePath.join(
      NodePath.dirname(paths.selectionPath),
      "recovery",
      request.repairId,
    );
    assertOrdinaryNativePath(recovery, true);
    if (NodeFS.existsSync(recovery))
      throw new Error("Repair recovery directory already exists; it is never overwritten.");
    NodeFS.mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const previousSelection = NodeFS.existsSync(paths.selectionPath)
      ? NodeFS.readFileSync(paths.selectionPath, "utf8")
      : null;
    if (previousSelection !== null && Buffer.byteLength(previousSelection) > 4096)
      throw new Error("Previous home selection is oversized.");
    const receiptPath = NodePath.join(recovery, "receipt.json");
    atomicWrite(
      paths.journalPath,
      JSON.stringify({
        schemaVersion: 1,
        repairId: request.repairId,
        receiptPath,
        previousSelection,
      }) + "\n",
      request.repairId,
    );
    let selectionWritten = false;
    try {
      const snapshots = [...homes, ...profiles].map((source, index) =>
        copySnapshot(source, NodePath.join(recovery, `snapshot-${index}`)),
      );
      atomicWrite(
        paths.journalPath,
        JSON.stringify({
          schemaVersion: 1,
          repairId: request.repairId,
          receiptPath,
          previousSelection,
          snapshots,
        }) + "\n",
        request.repairId,
      );
      const staged = NodePath.join(recovery, "staged-original");
      NodeFS.cpSync(snapshots[0]!.backup, staged, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await ports.migrateStagedHome(staged);
      await ports.validateStagedHome(staged);
      const stagedPreview = previewHomeRepair({ ...options, originalHomeDirectory: staged });
      if (
        stagedPreview.original.state !== "initialized" ||
        stagedPreview.original.environmentId !== validationSource.environmentId ||
        stagedPreview.original.counts.messages + stagedPreview.original.counts.legacyMessages <
          validationSource.counts.messages + validationSource.counts.legacyMessages ||
        stagedPreview.original.counts.threads + stagedPreview.original.counts.legacyThreads <
          validationSource.counts.threads + validationSource.counts.legacyThreads
      )
        throw new Error(
          "Staged migrations did not preserve the original identity and readable history.",
        );
      await ports.verifyStoppedAndIdle(resources);
      for (const snapshot of snapshots)
        if (treeDigest(snapshot.source).sha256 !== snapshot.sha256)
          throw new Error("Source state changed during staged verification.");
      const finalInventory = previewHomeRepair(options);
      const stableInventory = (inventory: typeof preview) =>
        JSON.stringify(
          [inventory.original, inventory.lan, inventory.electronProfiles],
          (key, value: unknown) => (key.endsWith("-shm") ? undefined : value),
        );
      if (stableInventory(finalInventory) !== stableInventory(preview))
        throw new Error("Home or profile inventory changed during staged verification.");
      const selection: NativeHomeSelection = {
        schemaVersion: 1,
        mode: request.choice === "adopt-original-retain-lan" ? "drop-in" : "side-by-side",
        originalHomeDirectory: preview.original.homeDirectory,
        originalEnvironmentId: preview.original.environmentId,
        lanHomeDirectory: preview.lan.homeDirectory,
        lanEnvironmentId: preview.lan.environmentId,
        electronProfileDirectory: profile,
        repairId: request.repairId,
        receiptPath,
      };
      const selectionText = JSON.stringify(selection) + "\n";
      const receipt: RepairReceipt = {
        schemaVersion: 1,
        repairId: request.repairId,
        status: "selected-pending-verification",
        selectionSha256: NodeCrypto.createHash("sha256").update(selectionText).digest("hex"),
        selectionPath: paths.selectionPath,
        previousSelection,
        selectedHomeDirectory:
          selection.mode === "drop-in"
            ? selection.originalHomeDirectory
            : selection.lanHomeDirectory,
        retainedHomeDirectory:
          selection.mode === "drop-in"
            ? selection.lanHomeDirectory
            : selection.originalHomeDirectory,
        electronProfileDirectory: profile,
        snapshots,
      };
      if (Buffer.byteLength(JSON.stringify(receipt)) > 16_384)
        throw new Error("Repair receipt exceeds the startup metadata bound.");
      atomicWrite(paths.selectionPath, selectionText, request.repairId);
      selectionWritten = true;
      atomicWrite(receiptPath, JSON.stringify(receipt) + "\n", request.repairId);
      NodeFS.unlinkSync(paths.journalPath);
      return {
        schemaVersion: 1 as const,
        status: "selected-pending-verification" as const,
        receiptPath,
        homeDirectory: receipt.selectedHomeDirectory,
        retainedHomeDirectory: receipt.retainedHomeDirectory,
        environmentId:
          selection.mode === "drop-in"
            ? selection.originalEnvironmentId
            : selection.lanEnvironmentId,
        electronProfileDirectory: profile,
        restoredHistoryVerified: false as const,
      };
    } catch (error) {
      if (selectionWritten) {
        if (previousSelection === null) NodeFS.unlinkSync(paths.selectionPath);
        else atomicWrite(paths.selectionPath, previousSelection, request.repairId);
      }
      NodeFS.unlinkSync(paths.journalPath);
      throw error;
    }
  });
}

function validateSnapshots(
  options: PreviewOptions,
  repairId: string,
  snapshots: readonly Snapshot[],
) {
  const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const recovery = NodePath.join(NodePath.dirname(paths.selectionPath), "recovery", repairId);
  const allowed = new Set([
    NodePath.resolve(options.originalHomeDirectory ?? paths.originalHomeDirectory),
    NodePath.resolve(paths.lanHomeDirectory),
    ...["t3code-v2", "T3 Code (Alpha)", "t3code"].map((name) =>
      NodePath.resolve(options.appDataDirectory, name),
    ),
    NodePath.resolve(options.localAppData, "T3CodeLAN", "electron-profile"),
  ]);
  if (!Array.isArray(snapshots) || snapshots.length > 6)
    throw new Error("Invalid repair backup inventory.");
  for (const [index, snapshot] of snapshots.entries()) {
    if (
      !allowed.has(NodePath.resolve(snapshot.source)) ||
      NodePath.resolve(snapshot.backup) !== NodePath.join(recovery, `snapshot-${index}`) ||
      !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    )
      throw new Error("Repair backup paths do not match this user's approved home inventory.");
  }
}

/** Only selection rollback before source data changes is automatic. A started/migrated home requires separate reviewed recovery. */
export async function rollbackHomeRepair(
  options: PreviewOptions,
  repairId: string,
  ports: Pick<HomeRepairExecutionPorts, "withExclusiveAdmission" | "verifyStoppedAndIdle">,
) {
  if (!/^[a-f0-9]{32}$/.test(repairId)) throw new Error("Invalid repair receipt identity.");
  const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  const receiptPath = NodePath.join(
    NodePath.dirname(paths.selectionPath),
    "recovery",
    repairId,
    "receipt.json",
  );
  assertOrdinaryNativePath(receiptPath, false);
  if (NodeFS.statSync(receiptPath).size > 16_384) throw new Error("Repair receipt is oversized.");
  const receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")) as RepairReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.repairId !== repairId ||
    !["selected-pending-verification", "rolled-back"].includes(receipt.status) ||
    receipt.selectionPath !== paths.selectionPath ||
    (receipt.previousSelection !== null &&
      (typeof receipt.previousSelection !== "string" ||
        Buffer.byteLength(receipt.previousSelection) > 4096)) ||
    !/^[a-f0-9]{64}$/.test(receipt.selectionSha256)
  )
    throw new Error("Repair receipt does not describe the current selection.");
  validateSnapshots(options, repairId, receipt.snapshots);
  const homes = new Set([
    options.originalHomeDirectory ?? paths.originalHomeDirectory,
    paths.lanHomeDirectory,
  ]);
  if (
    !homes.has(receipt.selectedHomeDirectory) ||
    !homes.has(receipt.retainedHomeDirectory) ||
    receipt.selectedHomeDirectory === receipt.retainedHomeDirectory
  )
    throw new Error("Repair receipt does not match the original and retained home inventory.");
  if (
    !receipt.snapshots.some((snapshot) => snapshot.source === receipt.selectedHomeDirectory) ||
    !receipt.snapshots.some((snapshot) => snapshot.source === receipt.electronProfileDirectory)
  )
    throw new Error("Repair receipt has incomplete selected-state preservation.");
  const resources = {
    homes: receipt.snapshots
      .filter((snapshot) => homes.has(snapshot.source))
      .map((snapshot) => snapshot.source),
    electronProfiles: receipt.snapshots
      .filter((snapshot) => !homes.has(snapshot.source))
      .map((snapshot) => snapshot.source),
  };
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStoppedAndIdle(resources);
    const selection = NodeFS.existsSync(paths.selectionPath)
      ? NodeFS.readFileSync(paths.selectionPath, "utf8")
      : null;
    if (
      selection !== receipt.previousSelection &&
      (selection === null ||
        receipt.status === "rolled-back" ||
        NodeCrypto.createHash("sha256").update(selection).digest("hex") !== receipt.selectionSha256)
    )
      throw new Error("A newer home selection prevents automatic rollback.");
    for (const snapshot of receipt.snapshots) {
      assertOrdinaryNativePath(snapshot.source, true);
      if (treeDigest(snapshot.source).sha256 !== snapshot.sha256)
        throw new Error(
          "Source data changed after selection; manual recovery is required to avoid losing new work.",
        );
      if (treeDigest(snapshot.backup).sha256 !== snapshot.sha256)
        throw new Error("Repair backup is not intact.");
    }
    if (NodeFS.existsSync(paths.journalPath)) {
      assertOrdinaryNativePath(paths.journalPath, false);
      if (NodeFS.statSync(paths.journalPath).size > 16_384)
        throw new Error("Repair journal is oversized.");
      const journal = JSON.parse(NodeFS.readFileSync(paths.journalPath, "utf8")) as {
        schemaVersion?: number;
        repairId?: string;
        receiptPath?: string;
        previousSelection?: string | null;
      };
      if (
        journal.schemaVersion !== 1 ||
        journal.repairId !== repairId ||
        journal.receiptPath !== receiptPath ||
        journal.previousSelection !== receipt.previousSelection
      )
        throw new Error("A different interrupted transaction prevents rollback.");
    } else {
      atomicWrite(
        paths.journalPath,
        JSON.stringify({
          schemaVersion: 1,
          repairId,
          receiptPath,
          previousSelection: receipt.previousSelection,
          snapshots: receipt.snapshots,
        }) + "\n",
        repairId,
      );
    }
    if (selection !== receipt.previousSelection) {
      if (receipt.previousSelection === null) NodeFS.unlinkSync(paths.selectionPath);
      else atomicWrite(paths.selectionPath, receipt.previousSelection, repairId);
    }
    atomicWrite(
      receiptPath,
      JSON.stringify({ ...receipt, status: "rolled-back" }) + "\n",
      repairId,
    );
    NodeFS.unlinkSync(paths.journalPath);
    return { schemaVersion: 1 as const, status: "rolled-back" as const };
  });
}

export async function recoverHomeRepair(
  options: PreviewOptions,
  repairId: string,
  ports: Pick<HomeRepairExecutionPorts, "withExclusiveAdmission" | "verifyStoppedAndIdle">,
) {
  if (!/^[a-f0-9]{32}$/.test(repairId)) throw new Error("Invalid repair recovery identity.");
  const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
  assertOrdinaryNativePath(paths.journalPath, false);
  if (NodeFS.statSync(paths.journalPath).size > 16_384)
    throw new Error("Repair journal is oversized.");
  const journal = JSON.parse(NodeFS.readFileSync(paths.journalPath, "utf8")) as {
    schemaVersion: number;
    repairId: string;
    receiptPath: string;
    previousSelection: string | null;
    snapshots?: readonly Snapshot[];
  };
  const expectedReceipt = NodePath.join(
    NodePath.dirname(paths.selectionPath),
    "recovery",
    repairId,
    "receipt.json",
  );
  if (
    journal.schemaVersion !== 1 ||
    journal.repairId !== repairId ||
    journal.receiptPath !== expectedReceipt ||
    (journal.previousSelection !== null &&
      (typeof journal.previousSelection !== "string" ||
        Buffer.byteLength(journal.previousSelection) > 4096))
  )
    throw new Error("Repair journal does not match this recovery request.");
  if (NodeFS.existsSync(expectedReceipt)) {
    return rollbackHomeRepair(options, repairId, ports);
  }
  const snapshots = journal.snapshots ?? [];
  validateSnapshots(options, repairId, snapshots);
  const currentInventory = previewHomeRepair(options);
  const resources = {
    homes: [currentInventory.original, currentInventory.lan]
      .filter((home) => home.state === "initialized")
      .map((home) => home.homeDirectory),
    electronProfiles: currentInventory.electronProfiles
      .filter((profile) => profile.localState.present)
      .map((profile) => profile.profileDirectory),
  };
  return ports.withExclusiveAdmission(resources, async () => {
    await ports.verifyStoppedAndIdle(resources);
    const selection = NodeFS.existsSync(paths.selectionPath)
      ? NodeFS.readFileSync(paths.selectionPath, "utf8")
      : null;
    if (selection !== journal.previousSelection) {
      const current = selection === null ? null : (JSON.parse(selection) as NativeHomeSelection);
      if (!current || current.repairId !== repairId || snapshots.length === 0)
        throw new Error("A different home selection prevents automatic recovery.");
      for (const snapshot of snapshots)
        if (
          treeDigest(snapshot.source).sha256 !== snapshot.sha256 ||
          treeDigest(snapshot.backup).sha256 !== snapshot.sha256
        )
          throw new Error("State changed after interrupted repair; manual recovery is required.");
      if (journal.previousSelection === null) NodeFS.unlinkSync(paths.selectionPath);
      else atomicWrite(paths.selectionPath, journal.previousSelection, repairId);
    }
    NodeFS.unlinkSync(paths.journalPath);
    return { schemaVersion: 1 as const, status: "rolled-back" as const };
  });
}
