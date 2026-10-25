// @effect-diagnostics nodeBuiltinImport:off -- Hub owns the held Windows kernel handles; this offline bridge never launches a provider or server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as HostProcess from "../../packages/shared/src/HostProcess.ts";
import { homeRepairMain, supportedMigrationIds, type PreviewOptions } from "./home-repair.ts";
import {
  executeHomeRepair,
  rollbackHomeRepair,
  recoverHomeRepair,
  type HomeRepairApplyRequest,
  type RepairAdmissionResources,
  type HomeRepairExecutionPorts,
} from "./home-repair-executor.ts";
import { migrateRepairStagedHome, validateRepairStagedHome } from "./home-repair-migrations.ts";
import { assertOrdinaryNativePath } from "../../packages/shared/src/nativeHomeSelection.ts";
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
) {
  if (Effect.runSync(HostProcess.Platform) !== "win32")
    throw new Error("Native home repair requires Windows admission.");
  for (const home of resources.homes) {
    heldByHost(NodePath.join(home, "native-admission.lock"));
    heldByHost(NodePath.join(home, "userdata", "server-owner.sqlite"));
    if (home === cancellationOriginal) continue;
    const work = inspectStoppedRepairWork(NodePath.join(home, "userdata", "statev2.sqlite"));
    if (
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
    (operation === "cancel-original-work" || operation.endsWith("work-cancellation")) &&
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
      "rollback",
      "recover",
      "cancel-original-work",
      "rollback-work-cancellation",
      "recover-work-cancellation",
    ].includes(operation)
  )
    throw new Error("Unknown repair operation.");
  const request = decodeRequest(raw, operation);
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
