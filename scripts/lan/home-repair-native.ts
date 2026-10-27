// @effect-diagnostics nodeBuiltinImport:off -- Hub owns the held Windows kernel handles; this offline bridge never launches a provider or server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as HostProcess from "../../packages/shared/src/HostProcess.ts";
import {
  homeRepairMain,
  previewHomeRepair,
  supportedMigrationIds,
  type PreviewOptions,
} from "./home-repair.ts";
import {
  executeHomeRepair,
  rollbackHomeRepair,
  recoverHomeRepair,
  type HomeRepairApplyRequest,
  type RepairAdmissionResources,
  type HomeRepairExecutionPorts,
} from "./home-repair-executor.ts";
import { migrateRepairStagedHome, validateRepairStagedHome } from "./home-repair-migrations.ts";
import {
  assertOrdinaryNativePath,
  nativeHomePaths,
} from "../../packages/shared/src/nativeHomeSelection.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";
import {
  cancelOriginalWork,
  rollbackOriginalWorkCancellation,
  type WorkCancellationRequest,
  type WorkCancellationPorts,
} from "./home-repair-cancel.ts";
import { strictJson } from "../../packages/shared/src/strictJson.ts";

function heldByHost(file: string) {
  assertOrdinaryNativePath(file, false);
  if (!NodeFS.existsSync(file)) throw new Error("Required Hub-held admission file is missing.");
  let descriptor: number;
  try {
    descriptor = NodeFS.openSync(file, "r+");
  } catch (error) {
    if (["EACCES", "EPERM", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code)))
      return;
    throw error;
  }
  NodeFS.closeSync(descriptor);
  throw new Error(
    "Hub must hold exclusive home and stopped-profile admission for the full transaction.",
  );
}

/** Conflicting opens check protocol sanity only. Hub must establish actual kernel ownership, process/profile quiescence, and hold it until this process exits. */
export function verifyHostAdmission(
  resources: RepairAdmissionResources,
  cancellationOriginal?: string,
  preserveWorkHomes?: ReadonlySet<string>,
) {
  if (Effect.runSync(HostProcess.Platform) !== "win32")
    throw new Error("Native home repair requires Windows admission.");
  for (const home of resources.homes) {
    heldByHost(NodePath.join(home, "native-admission.lock"));
    heldByHost(NodePath.join(home, "userdata", "server-owner.sqlite"));
    if (home === cancellationOriginal) continue;
    const work = inspectStoppedRepairWork(NodePath.join(home, "userdata", "statev2.sqlite"));
    if (
      !preserveWorkHomes?.has(home) &&
      [
        work.activeRuns,
        work.queuedRuns,
        work.pendingRequests,
        work.backgroundAgents,
        work.scheduledWork,
        work.restartContinuations,
      ].some((count) => count !== 0)
    )
      throw new Error("Pending, scheduled, active, or restart-continuation work prevents repair.");
  }
  for (const profile of resources.electronProfiles)
    heldByHost(NodePath.join(profile, "Local State"));
}

const nativePorts: HomeRepairExecutionPorts = {
  withExclusiveAdmission: async (resources, operation) => {
    verifyHostAdmission(resources);
    return operation();
  },
  verifyStoppedAndIdle: async (resources) => {
    verifyHostAdmission(resources);
  },
  migrateStagedHome: migrateRepairStagedHome,
  validateStagedHome: validateRepairStagedHome,
};

// The Hub-owned session keeps its actual Windows handles across all children and awaits exit before disposal.
// The child checks the live parent and incompatible kernel opens; it cannot acquire locks already held by that parent.
function verifyCancellationAdmission(resources: RepairAdmissionResources, original: string) {
  if (original !== NodePath.join(NodeOS.homedir(), ".t3"))
    throw new Error("Cancellation is limited to the current user original home.");
  if (process.ppid <= 0) throw new Error("Cancellation requires a live owning Hub parent.");
  process.kill(process.ppid, 0);
  verifyHostAdmission(resources, original);
}
const cancellationPorts: WorkCancellationPorts = {
  withExclusiveAdmission: async (resources, operation) => {
    verifyCancellationAdmission(resources, NodePath.join(NodeOS.homedir(), ".t3"));
    return operation();
  },
  verifyStoppedForCancellation: async (resources, original) =>
    verifyCancellationAdmission(resources, original),
};
function decodeRequest(raw: unknown, operation: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid repair request.");
  const request = raw as Record<string, unknown>;
  const allowed =
    operation === "apply"
      ? ["schemaVersion", "expectedPlanId", "choice", "opaqueBackupApproved", "repairId"]
      : operation === "retain-selected-lan"
        ? [
            "schemaVersion",
            "expectedPlanId",
            "choice",
            "opaqueBackupApproved",
            "repairId",
            "expectedLanEnvironmentId",
            "admissionOwnerPid",
          ]
        : operation === "recover-retain-selected-lan"
          ? [
              "schemaVersion",
              "repairId",
              "expectedLanEnvironmentId",
              "admissionOwnerPid",
              "recoveryOperation",
            ]
          : operation === "cancel-original-work"
            ? [
                "schemaVersion",
                "expectedPlanId",
                "cancelUnfinishedWorkApproved",
                "opaqueBackupApproved",
                "repairId",
                "admissionOwnerPid",
              ]
            : operation.endsWith("work-cancellation")
              ? ["schemaVersion", "repairId", "admissionOwnerPid"]
              : ["schemaVersion", "repairId"];
  if (
    request.schemaVersion !== 1 ||
    typeof request.repairId !== "string" ||
    !/^[a-f0-9]{32}$/.test(request.repairId) ||
    Object.keys(request).some((name) => !allowed.includes(name)) ||
    allowed.some((name) => !(name in request))
  )
    throw new Error("Invalid or incomplete repair request.");
  if (
    (operation === "retain-selected-lan" ||
      operation === "recover-retain-selected-lan" ||
      operation === "cancel-original-work" ||
      operation.endsWith("work-cancellation")) &&
    (!Number.isSafeInteger(request.admissionOwnerPid) || request.admissionOwnerPid !== process.ppid)
  )
    throw new Error("Cancellation admission owner is not this native child parent.");
  return request;
}

export async function runNativeHomeRepair(
  operation: string,
  raw: unknown,
  options: PreviewOptions,
  ports: HomeRepairExecutionPorts = nativePorts,
  cancellation: WorkCancellationPorts = cancellationPorts,
) {
  if (
    ![
      "apply",
      "retain-selected-lan",
      "recover-retain-selected-lan",
      "rollback",
      "recover",
      "cancel-original-work",
      "rollback-work-cancellation",
      "recover-work-cancellation",
    ].includes(operation)
  )
    throw new Error("Unknown repair operation.");
  const request = decodeRequest(raw, operation);
  if (operation === "retain-selected-lan" || operation === "recover-retain-selected-lan") {
    if (process.ppid <= 0) throw new Error("LAN retention requires a live owning Hub parent.");
    process.kill(process.ppid, 0);
    const lan = NodePath.join(options.localAppData, "T3CodeLAN", "data");
    const original =
      options.originalHomeDirectory ?? NodePath.join(options.userHomeDirectory, ".t3");
    if (operation === "retain-selected-lan") {
      const preview = previewHomeRepair(options);
      const selectionPath = NodePath.join(options.localAppData, "T3CodeLAN", "home-selection.json");
      if (
        request.choice !== "side-by-side-retain-original" ||
        request.opaqueBackupApproved !== true ||
        preview.planId !== request.expectedPlanId ||
        preview.state === "blocked" ||
        preview.lan.state !== "initialized" ||
        preview.lan.homeDirectory !== lan ||
        preview.lan.environmentId !== request.expectedLanEnvironmentId ||
        preview.lan.activeWork === null ||
        (preview.original.state === "initialized" && preview.original.activeWork === null) ||
        NodeFS.existsSync(selectionPath) ||
        !NodeFS.existsSync(
          NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile", "Local State"),
        )
      )
        throw new Error(
          "Retaining selected LAN work requires the exact known LAN home and profile.",
        );
    } else {
      const identityFile = NodePath.join(lan, "userdata", "environment-id");
      assertOrdinaryNativePath(identityFile, false);
      if (
        NodeFS.statSync(identityFile).size > 256 ||
        NodeFS.readFileSync(identityFile, "utf8").trim() !== request.expectedLanEnvironmentId ||
        !["recover", "rollback"].includes(String(request.recoveryOperation))
      )
        throw new Error("Retention recovery requires the matching selected LAN identity.");
      const paths = nativeHomePaths(options.userHomeDirectory, options.localAppData);
      const receiptPath = NodePath.join(
        NodePath.dirname(paths.selectionPath),
        "recovery",
        String(request.repairId),
        "receipt.json",
      );
      const readMetadata = (file: string): Record<string, unknown> | null => {
        if (!NodeFS.existsSync(file)) return null;
        assertOrdinaryNativePath(file, false);
        if (NodeFS.statSync(file).size > 16_384)
          throw new Error("Retention recovery metadata is oversized.");
        const value = strictJson(NodeFS.readFileSync(file));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid retention recovery metadata.");
        return value as Record<string, unknown>;
      };
      const journal = readMetadata(paths.journalPath);
      const receipt = readMetadata(receiptPath);
      const matching = (value: Record<string, unknown>) =>
        value.schemaVersion === 1 &&
        value.repairId === request.repairId &&
        value.operation === "retain-selected-lan" &&
        value.expectedLanEnvironmentId === request.expectedLanEnvironmentId &&
        value.previousSelection === null;
      if (
        (request.recoveryOperation === "recover" && !journal) ||
        (request.recoveryOperation === "rollback" && !receipt) ||
        (journal && (!matching(journal) || journal.receiptPath !== receiptPath)) ||
        (receipt &&
          (!matching(receipt) ||
            receipt.selectionPath !== paths.selectionPath ||
            receipt.selectedHomeDirectory !== lan ||
            receipt.retainedHomeDirectory !== original ||
            receipt.electronProfileDirectory !==
              NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile")))
      )
        throw new Error("Recovery does not match the retained LAN transaction.");
    }
    const generations = new Map<string, string>();
    const homes = new Set([lan, original]);
    const check = (resources: RepairAdmissionResources) => {
      verifyHostAdmission(resources, undefined, homes);
      for (const home of resources.homes) {
        if (!homes.has(home)) throw new Error("Unexpected home in retention admission.");
        const work = inspectStoppedRepairWork(NodePath.join(home, "userdata", "statev2.sqlite"));
        const previous = generations.get(home);
        if (previous !== undefined && previous !== work.workGeneration)
          throw new Error("Work changed while retaining the selected LAN home.");
        generations.set(home, work.workGeneration);
      }
    };
    const retainPorts: HomeRepairExecutionPorts =
      ports === nativePorts
        ? {
            ...nativePorts,
            withExclusiveAdmission: async (resources, run) => {
              check(resources);
              return run();
            },
            verifyStoppedAndIdle: async (resources) => {
              check(resources);
            },
          }
        : ports;
    if (operation === "retain-selected-lan")
      return executeHomeRepair(
        options,
        {
          ...request,
          retainedLanEnvironmentId: String(request.expectedLanEnvironmentId),
        } as unknown as HomeRepairApplyRequest,
        retainPorts,
      );
    return request.recoveryOperation === "rollback"
      ? rollbackHomeRepair(options, String(request.repairId), retainPorts)
      : recoverHomeRepair(options, String(request.repairId), retainPorts);
  }
  if (operation === "cancel-original-work")
    return cancelOriginalWork(options, request as unknown as WorkCancellationRequest, cancellation);
  if (operation === "rollback-work-cancellation" || operation === "recover-work-cancellation")
    return rollbackOriginalWorkCancellation(
      options,
      String(request.repairId),
      cancellation,
      operation === "recover-work-cancellation",
    );
  return operation === "apply"
    ? executeHomeRepair(options, request as unknown as HomeRepairApplyRequest, ports)
    : operation === "rollback"
      ? rollbackHomeRepair(options, String(request.repairId), ports)
      : recoverHomeRepair(options, String(request.repairId), ports);
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "preview") {
      const report = homeRepairMain(args);
      // Eligibility does not replace Hub's process checks, held admission or explicit backup confirmation.
      const initialized = [report.original, report.lan].filter(
        (home) => home.state === "initialized",
      );
      const originalProfile = report.electronProfiles.some(
        (profile) =>
          profile.localState.present &&
          !profile.profileDirectory.endsWith(NodePath.sep + "electron-profile"),
      );
      const lanProfile = report.electronProfiles.some(
        (profile) =>
          profile.localState.present &&
          profile.profileDirectory.endsWith(NodePath.sep + "electron-profile"),
      );
      const eligible =
        report.state !== "blocked" &&
        initialized.length > 0 &&
        initialized.every((home) => home.activeWork === 0) &&
        ((report.original.state === "initialized" && originalProfile) ||
          (report.lan.state === "initialized" && lanProfile));
      process.stdout.write(
        JSON.stringify({
          ...report,
          applySupported: true,
          canApply: eligible,
          cancellationSupported: true,
          canCancelOriginalWork:
            report.state !== "blocked" &&
            report.original.state === "initialized" &&
            report.original.activeWork !== null &&
            report.original.activeWork > 0 &&
            (report.lan.state !== "initialized" || report.lan.activeWork === 0) &&
            originalProfile,
        }) + "\n",
      );
    } else {
      if (args.length !== 2 || args[1] !== "--json") throw new Error("Invalid repair arguments.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 8192) throw new Error("Oversized repair request.");
        chunks.push(bytes);
      }
      const options: PreviewOptions = {
        userHomeDirectory: NodeOS.homedir(),
        localAppData:
          process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local"),
        appDataDirectory:
          process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Roaming"),
        supportedMigrationIds,
      };
      const result = await runNativeHomeRepair(
        args[0] ?? "",
        strictJson(Buffer.concat(chunks)),
        options,
      );
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch {
    process.stderr.write("native_home_repair_refused\n");
    process.exitCode = 1;
  }
}
