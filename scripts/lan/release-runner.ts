// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Durable release coordination only; temporary retries preserve guarded receipts and never replay unmarked commands.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  releasePhaseReceiptSha256,
  runReleasePlan,
  type PhaseReceipt,
  type ReleasePlan,
  type ReleaseRecovery,
} from "./release-pipeline.ts";

import { syncPortalReleasePinCommit, type PortalReleasePinSync } from "./release-git-pins.ts";

export const RELEASE_TEMPORARY_FAILURE = 75;
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Commands opt in only when their own durable intent makes a repeated invocation safe. */
export async function runReleaseWithRecovery(
  plan: ReleasePlan,
  options: { maxTemporaryRetries?: number; staleLockSha256?: string } = {},
) {
  const maximum = options.maxTemporaryRetries ?? 2;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 3)
    throw new Error("Invalid temporary release retry bound");
  const planSha256 = digest(plan);
  let recovery: ReleaseRecovery = options.staleLockSha256
    ? { staleLockSha256: options.staleLockSha256 }
    : {};
  for (;;) {
    try {
      return await runReleasePlan(plan, recovery);
    } catch (error) {
      if (maximum === 0 || !(error instanceof Error)) throw error;
      // A live or unreviewed stale owner is never an automatic retry opportunity.
      if (
        await NodeFSP.lstat(NodePath.join(plan.outputRoot, ".release.lock")).catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return null;
            throw cause;
          },
        )
      )
        throw error;
      const file = NodePath.join(plan.outputRoot, "release-progress.json");
      const progress = JSON.parse(await NodeFSP.readFile(file, "utf8")) as {
        sourceCommit: string;
        codeFinishedUtc: string;
        planSha256: string;
        phases: Record<string, PhaseReceipt>;
      };
      if (
        progress.sourceCommit !== plan.sourceCommit ||
        progress.codeFinishedUtc !== plan.codeFinishedUtc ||
        progress.planSha256 !== planSha256
      )
        throw error;
      const failed = Object.entries(progress.phases).filter(
        ([, receipt]) => receipt.status === "failed",
      );
      if (
        failed.length === 0 ||
        Object.values(progress.phases).some((receipt) => receipt.status === "running") ||
        failed.some(
          ([id, receipt]) =>
            receipt.exitCode !== RELEASE_TEMPORARY_FAILURE ||
            plan.phases.find((phase) => phase.id === id)?.idempotent !== true,
        ) ||
        !failed.some(
          ([id]) =>
            error.message === `Release phase failed: ${id} (${RELEASE_TEMPORARY_FAILURE})` ||
            error.message === `Review interrupted phase before retry: ${id}`,
        )
      )
        throw error;
      const directory = NodePath.join(plan.outputRoot, "automatic-recovery");
      await NodeFSP.mkdir(directory, { recursive: true });
      const prior = [] as { planSha256: string; phases: { id: string }[] }[];
      for (const name of await NodeFSP.readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name))
          throw new Error("Unknown automatic recovery evidence", { cause: error });
        const entry = NodePath.join(directory, name);
        const stat = await NodeFSP.lstat(entry);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Unsafe automatic recovery evidence", { cause: error });
        const value = JSON.parse(await NodeFSP.readFile(entry, "utf8"));
        if (value.planSha256 !== planSha256)
          throw new Error("Automatic recovery belongs to a different release plan", {
            cause: error,
          });
        prior.push(value);
      }
      if (
        failed.some(
          ([id]) =>
            prior.filter((attempt) => attempt.phases.some((x) => x.id === id)).length >= maximum,
        )
      )
        throw error;
      const phases = failed.map(([id, receipt]) => ({
        id,
        receiptSha256: releasePhaseReceiptSha256(receipt),
      }));
      const intent = { schemaVersion: 1, planSha256, sourceCommit: plan.sourceCommit, phases };
      // Exclusive intent creation prevents concurrent wrappers or restarts from spending
      // the same retry twice. A reserved but interrupted attempt needs explicit review.
      await NodeFSP.writeFile(
        NodePath.join(directory, digest(intent) + ".json"),
        JSON.stringify(intent, null, 2) + "\n",
        { flag: "wx" },
      );
      recovery = { failedPhases: phases };
    }
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const pinRequest = process.argv[2] === "sync-portal-pins";
  const file = process.argv[pinRequest ? 3 : 2];
  if (!file) throw new Error("Usage: release-runner.ts PLAN_JSON | sync-portal-pins REQUEST_JSON");
  const request = JSON.parse(await NodeFSP.readFile(NodePath.resolve(file), "utf8"));
  console.log(
    JSON.stringify(
      pinRequest
        ? await syncPortalReleasePinCommit(request as PortalReleasePinSync)
        : await runReleaseWithRecovery(request as ReleasePlan),
    ),
  );
}
