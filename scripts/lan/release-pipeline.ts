// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Explicit release subprocesses, durable receipts and end-to-end wall-clock timing; no live application state is accessed.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface Phase {
  id: string;
  dependsOn: string[];
  command: { executable: string; args: string[]; cwd: string; env?: Record<string, string> };
  inputs: { path: string; sha256: string }[];
  outputs: string[];
  retryInterrupted?: boolean;
  idempotent?: boolean;
}
export interface ReleasePlan {
  schemaVersion: 1;
  sourceRoot: string;
  sourceCommit: string;
  codeFinishedUtc: string;
  outputRoot: string;
  maxParallel: number;
  phases: Phase[];
  downloadProof: {
    phase: string;
    path: string;
    version: string;
    remoteMachine: string;
    artifactPinsPath: string;
  };
}
interface FilePin {
  path: string;
  sha256: string;
}
export interface PhaseReceipt {
  status: "running" | "passed" | "failed";
  startedUtc: string;
  completedUtc?: string;
  exitCode?: number | null;
  outputs?: { path: string; sha256: string }[];
  log?: FilePin;
  failedOutputs?: { path: string; sha256: string | null }[];
  history?: { receipt: FilePin; log: FilePin }[];
}
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export const releasePhaseReceiptSha256 = (receipt: PhaseReceipt) =>
  digest(Buffer.from(JSON.stringify(receipt)));
export interface ReleaseRecovery {
  staleLockSha256?: string;
  failedPhases?: readonly { id: string; receiptSha256: string }[];
}
async function hashFile(file: string) {
  if (!(await NodeFSP.lstat(file)).isFile()) throw new Error(`Expected regular file: ${file}`);
  return digest(await NodeFSP.readFile(file));
}
export async function runReleasePlan(plan: ReleasePlan, recovery: ReleaseRecovery = {}) {
  if (plan.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(plan.sourceCommit))
    throw new Error("Invalid release identity");
  if (!Number.isInteger(plan.maxParallel) || plan.maxParallel < 1 || plan.maxParallel > 4)
    throw new Error("Invalid concurrency");
  const finished = Date.parse(plan.codeFinishedUtc);
  if (!Number.isFinite(finished) || finished > Date.now())
    throw new Error("Invalid code-finished time");
  const committed =
    Number(
      NodeChildProcess.execFileSync(
        "git.exe",
        ["-C", plan.sourceRoot, "show", "-s", "--format=%ct", plan.sourceCommit],
        { windowsHide: true, encoding: "utf8" },
      ).trim(),
    ) * 1000;
  if (finished !== committed)
    throw new Error("Code-finished time must equal the final source commit time");
  const pending = new Map(plan.phases.map((phase) => [phase.id, phase]));
  if (pending.size !== plan.phases.length || !pending.has(plan.downloadProof.phase))
    throw new Error("Invalid phase ids");
  if (!pending.get(plan.downloadProof.phase)!.outputs.includes(plan.downloadProof.path))
    throw new Error("Download proof must be a phase output");
  const requested = new Map(recovery.failedPhases?.map((entry) => [entry.id, entry]) ?? []);
  if (
    requested.size !== (recovery.failedPhases?.length ?? 0) ||
    [...requested.values()].some(
      (entry) => !pending.has(entry.id) || !/^[a-f0-9]{64}$/u.test(entry.receiptSha256),
    )
  )
    throw new Error("Invalid failed-phase recovery request");
  for (const phase of plan.phases) {
    if (
      !/^[a-z0-9-]+$/u.test(phase.id) ||
      phase.dependsOn.some((id) => !pending.has(id) || id === phase.id)
    )
      throw new Error("Invalid phase dependency");
    if (!NodePath.isAbsolute(phase.command.cwd) || !phase.outputs.every(NodePath.isAbsolute))
      throw new Error("Release paths must be absolute");
    if (
      new Set(phase.outputs.map((file) => NodePath.resolve(file).toLowerCase())).size !==
      phase.outputs.length
    )
      throw new Error("Duplicate phase outputs");
  }
  const allOutputs = plan.phases.flatMap((phase) =>
    phase.outputs.map((file) => NodePath.resolve(file).toLowerCase()),
  );
  if (new Set(allOutputs).size !== allOutputs.length)
    throw new Error("Phase outputs must be globally unique");
  const reachable = new Set<string>();
  while (reachable.size < pending.size) {
    const next = plan.phases.filter(
      (p) => !reachable.has(p.id) && p.dependsOn.every((id) => reachable.has(id)),
    );
    if (!next.length) throw new Error("Cyclic release phases");
    for (const phase of next) reachable.add(phase.id);
  }
  const ancestors = new Set<string>();
  function visit(id: string) {
    for (const dependency of pending.get(id)!.dependsOn)
      if (!ancestors.has(dependency)) {
        ancestors.add(dependency);
        visit(dependency);
      }
  }
  visit(plan.downloadProof.phase);
  if (ancestors.size !== plan.phases.length - 1)
    throw new Error("Download verification must follow every release gate");
  const pinOwners = plan.phases.filter(
    (phase) =>
      ancestors.has(phase.id) && phase.outputs.includes(plan.downloadProof.artifactPinsPath),
  );
  if (pinOwners.length !== 1)
    throw new Error("Artifact pins must come from one prerequisite phase");
  if (!NodePath.isAbsolute(plan.outputRoot))
    throw new Error("Release output root must be absolute");
  await NodeFSP.mkdir(plan.outputRoot, { recursive: true });
  const file = NodePath.join(plan.outputRoot, "release-progress.json"),
    planSha256 = digest(Buffer.from(JSON.stringify(plan)));
  const lockPath = NodePath.join(plan.outputRoot, ".release.lock"),
    ownerFile = NodePath.join(
      plan.outputRoot,
      ".release-owner-" + NodeCrypto.randomUUID() + ".json",
    );
  const ownerBytes = Buffer.from(JSON.stringify({ pid: process.pid, planSha256, ownerFile }));
  await NodeFSP.writeFile(ownerFile, ownerBytes, { flag: "wx" });
  try {
    try {
      await NodeFSP.link(ownerFile, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !recovery.staleLockSha256)
        throw error;
      const recoveryPath = NodePath.join(plan.outputRoot, ".release.recovery.lock");
      await NodeFSP.link(ownerFile, recoveryPath);
      try {
        const bytes = await NodeFSP.readFile(lockPath),
          previous = JSON.parse(bytes.toString());
        if (
          digest(bytes) !== recovery.staleLockSha256 ||
          previous.planSha256 !== planSha256 ||
          !Number.isInteger(previous.pid) ||
          previous.pid <= 0
        )
          throw new Error("Reviewed stale lock differs", { cause: error });
        let dead = false;
        try {
          process.kill(previous.pid, 0);
        } catch (probe) {
          dead = (probe as NodeJS.ErrnoException).code === "ESRCH";
        }
        if (!dead) throw new Error("Release lock owner is alive or unknown", { cause: error });
        if (digest(await NodeFSP.readFile(lockPath)) !== recovery.staleLockSha256)
          throw new Error("Release lock changed during recovery", { cause: error });
        await NodeFSP.unlink(lockPath);
        await NodeFSP.link(ownerFile, lockPath);
        await NodeFSP.writeFile(
          ownerFile + ".recovery.json",
          JSON.stringify({
            previousPid: previous.pid,
            reviewedSha256: recovery.staleLockSha256,
            processAbsent: true,
          }),
        );
      } finally {
        if ((await NodeFSP.readFile(recoveryPath)).equals(ownerBytes))
          await NodeFSP.unlink(recoveryPath);
      }
    }
  } catch (error) {
    await NodeFSP.unlink(ownerFile);
    throw error;
  }
  let receipts: Record<string, PhaseReceipt> = {};
  try {
    try {
      const previous = JSON.parse(await NodeFSP.readFile(file, "utf8"));
      if (previous.planSha256 !== planSha256) throw new Error("Release plan changed during resume");
      receipts = previous.phases;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Atomic journal updates are serialized even while independent child commands run.
    let journal = Promise.resolve();
    const save = () => {
      journal = journal.then(async () => {
        const bytes =
          JSON.stringify(
            {
              schemaVersion: 1,
              sourceCommit: plan.sourceCommit,
              codeFinishedUtc: plan.codeFinishedUtc,
              planSha256,
              phases: receipts,
            },
            null,
            2,
          ) + "\n";
        await NodeFSP.writeFile(file + ".new", bytes);
        await NodeFSP.rename(file + ".new", file);
      });
      return journal;
    };
    const assertSource = () => {
      const head = NodeChildProcess.execFileSync(
        "git.exe",
        ["-C", plan.sourceRoot, "rev-parse", "HEAD"],
        {
          windowsHide: true,
          encoding: "utf8",
        },
      ).trim();
      if (head !== plan.sourceCommit) throw new Error("Release source changed");
      if (
        NodeChildProcess.execFileSync(
          "git.exe",
          ["-C", plan.sourceRoot, "status", "--porcelain", "--untracked-files=all"],
          { windowsHide: true, encoding: "utf8" },
        ).trim()
      )
        throw new Error("Release source is dirty");
    };
    const assertInputs = async (phase: Phase) => {
      assertSource();
      for (const input of phase.inputs)
        if ((await hashFile(input.path)) !== input.sha256)
          throw new Error(`Release input changed: ${phase.id}`);
    };
    const snapshotOutputs = async (phase: Phase) =>
      Promise.all(
        phase.outputs.map(async (path) => {
          try {
            return { path, sha256: await hashFile(path) };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, sha256: null };
            throw error;
          }
        }),
      );
    const histories = new Map<string, NonNullable<PhaseReceipt["history"]>>();
    for (const phase of plan.phases) {
      const previous = receipts[phase.id];
      if (!previous) {
        if (requested.has(phase.id)) throw new Error("No failed phase receipt to recover");
        continue;
      }
      await assertInputs(phase);
      if (previous.log && (await hashFile(previous.log.path)) !== previous.log.sha256)
        throw new Error("Phase log changed");
      for (const attempt of previous.history ?? [])
        for (const pin of [attempt.receipt, attempt.log])
          if ((await hashFile(pin.path)) !== pin.sha256)
            throw new Error("Archived phase evidence changed");
      if (previous.status === "passed") {
        if (requested.has(phase.id)) throw new Error("Completed phases cannot be retried");
        const started = Date.parse(previous.startedUtc),
          completed = Date.parse(previous.completedUtc ?? "");
        if (
          previous.exitCode !== 0 ||
          !Number.isFinite(started) ||
          !Number.isFinite(completed) ||
          started < finished ||
          completed < started ||
          completed > Date.now()
        )
          throw new Error("Invalid completed phase timing");
        if (previous.outputs?.length !== phase.outputs.length)
          throw new Error("Incomplete phase receipt");
        if (new Set(previous.outputs.map((output) => output.path)).size !== phase.outputs.length)
          throw new Error("Duplicate output receipts");
        for (const output of previous.outputs)
          if (
            !phase.outputs.includes(output.path) ||
            (await hashFile(output.path)) !== output.sha256
          )
            throw new Error(`Completed output changed: ${phase.id}`);
        pending.delete(phase.id);
      } else {
        const request = requested.get(phase.id);
        if (!request) throw new Error(`Review interrupted phase before retry: ${phase.id}`);
        if (phase.idempotent !== true || previous.status !== "failed")
          throw new Error("Only opted-in idempotent failed phases may be recovered");
        if (releasePhaseReceiptSha256(previous) !== request.receiptSha256)
          throw new Error("Reviewed failed receipt differs");
        if (!previous.log || !previous.failedOutputs || !previous.completedUtc)
          throw new Error("Incomplete failed phase receipt");
        const started = Date.parse(previous.startedUtc);
        const completed = Date.parse(previous.completedUtc);
        if (
          !Number.isFinite(started) ||
          !Number.isFinite(completed) ||
          started < finished ||
          completed < started ||
          completed > Date.now()
        )
          throw new Error("Invalid failed phase timing");
        if ((await hashFile(previous.log.path)) !== previous.log.sha256)
          throw new Error("Failed phase log changed");
        if (JSON.stringify(await snapshotOutputs(phase)) !== JSON.stringify(previous.failedOutputs))
          throw new Error(`Failed phase output changed: ${phase.id}`);
        const historyRoot = NodePath.join(plan.outputRoot, "attempts");
        await NodeFSP.mkdir(historyRoot, { recursive: true });
        const historyStat = await NodeFSP.lstat(historyRoot);
        if (!historyStat.isDirectory() || historyStat.isSymbolicLink())
          throw new Error("Invalid phase history directory");
        const stem = NodePath.join(historyRoot, phase.id + "-" + request.receiptSha256);
        const receiptPath = stem + ".json";
        const logPath = stem + ".log";
        const writeOnce = async (path: string, bytes: Uint8Array) => {
          try {
            await NodeFSP.writeFile(path, bytes, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (!(await NodeFSP.readFile(path)).equals(bytes))
              throw new Error("Archived phase evidence differs", { cause: error });
          }
        };
        await writeOnce(receiptPath, Buffer.from(JSON.stringify(previous)));
        await writeOnce(logPath, await NodeFSP.readFile(previous.log.path));
        histories.set(phase.id, [
          ...(previous.history ?? []),
          {
            receipt: { path: receiptPath, sha256: request.receiptSha256 },
            log: { path: logPath, sha256: previous.log.sha256 },
          },
        ]);
      }
    }
    const running = new Map<string, Promise<void>>();
    let failure: unknown;
    while (pending.size || running.size) {
      if (!failure)
        for (const phase of pending.values()) {
          if (running.size >= plan.maxParallel) break;
          if (!phase.dependsOn.every((id) => receipts[id]?.status === "passed")) continue;
          pending.delete(phase.id);
          const task = (async () => {
            await assertInputs(phase);
            const receipt: PhaseReceipt = {
              status: "running",
              startedUtc: new Date().toISOString(),
              ...(histories.has(phase.id) ? { history: histories.get(phase.id)! } : {}),
            };
            receipts[phase.id] = receipt;
            await save();
            const logPath = NodePath.join(
              plan.outputRoot,
              phase.id + (receipt.history ? `.attempt-${receipt.history.length + 1}` : "") + ".log",
            );
            let log: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
            try {
              log = await NodeFSP.open(logPath, "wx");
              const child = NodeChildProcess.spawn(phase.command.executable, phase.command.args, {
                cwd: phase.command.cwd,
                env: { ...process.env, ...phase.command.env },
                windowsHide: true,
                shell: false,
                stdio: ["ignore", log.fd, log.fd],
              });
              receipt.exitCode = await new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", resolve);
              });
              if (receipt.exitCode !== 0)
                throw new Error(`Release phase failed: ${phase.id} (${receipt.exitCode})`);
              await assertInputs(phase);
              receipt.outputs = await Promise.all(
                phase.outputs.map(async (output) => ({
                  path: output,
                  sha256: await hashFile(output),
                })),
              );
              receipt.status = "passed";
            } catch (error) {
              receipt.status = "failed";
              receipt.failedOutputs = await snapshotOutputs(phase);
              throw error;
            } finally {
              receipt.completedUtc = new Date().toISOString();
              if (log) {
                await log.close();
                receipt.log = { path: logPath, sha256: await hashFile(logPath) };
              }
              await save();
            }
          })()
            .catch((error) => {
              failure ??= error;
            })
            .finally(() => {
              running.delete(phase.id);
            });
          running.set(phase.id, task);
        }
      if (running.size) await Promise.race(running.values());
      else if (failure) throw failure;
      else if (pending.size) throw new Error("Release dependencies did not complete");
    }
    if (failure) throw failure;
    const proof = JSON.parse(await NodeFSP.readFile(plan.downloadProof.path, "utf8"));
    const finalPhase = receipts[plan.downloadProof.phase]!;
    const remoteVerified = Date.parse(proof.verifiedUtc),
      verified = Date.parse(finalPhase.completedUtc!);
    const pinsReceipt = receipts[pinOwners[0]!.id]!.outputs!.find(
      (output) => output.path === plan.downloadProof.artifactPinsPath,
    )!;
    if ((await hashFile(pinsReceipt.path)) !== pinsReceipt.sha256)
      throw new Error("Sealed artifact pins changed");
    const pins = JSON.parse(await NodeFSP.readFile(plan.downloadProof.artifactPinsPath, "utf8"));
    if (
      pins.sourceCommit !== plan.sourceCommit ||
      pins.version !== plan.downloadProof.version ||
      pins.zipSha256 !== proof.artifactSha256
    )
      throw new Error("Remote download differs from sealed artifact");
    if (
      proof.passed !== true ||
      proof.verifiedDownload !== true ||
      proof.sourceCommit !== plan.sourceCommit ||
      proof.remoteMachine !== plan.downloadProof.remoteMachine ||
      proof.version !== plan.downloadProof.version ||
      !/^[a-f0-9]{64}$/u.test(proof.artifactSha256) ||
      !Number.isFinite(remoteVerified) ||
      !Number.isFinite(verified) ||
      remoteVerified < Date.parse(finalPhase.startedUtc) ||
      remoteVerified > verified ||
      verified < finished ||
      verified > Date.now()
    )
      throw new Error("Remote download proof is incomplete");
    const report = {
      schemaVersion: 1,
      passed: true,
      sourceCommit: plan.sourceCommit,
      codeFinishedUtc: plan.codeFinishedUtc,
      updateDownloadableUtc: finalPhase.completedUtc,
      remoteVerifiedUtc: proof.verifiedUtc,
      elapsedSeconds: (verified - finished) / 1000,
      artifactSha256: proof.artifactSha256,
      remoteMachine: proof.remoteMachine,
      planSha256,
      phases: receipts,
    };
    await NodeFSP.writeFile(
      NodePath.join(plan.outputRoot, "release-result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  } finally {
    if ((await NodeFSP.readFile(lockPath)).equals(ownerBytes)) await NodeFSP.unlink(lockPath);
    await NodeFSP.unlink(ownerFile);
  }
}
if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  const file = process.argv[2];
  if (!file) throw new Error("Supply an explicit release plan JSON file");
  const recovery: ReleaseRecovery = {};
  for (let index = 3; index < process.argv.length; index++) {
    if (process.argv[index] === "--recover-stale-lock")
      recovery.staleLockSha256 = process.argv[++index]!;
    else if (process.argv[index] === "--retry-failed") {
      const entry = { id: process.argv[++index]!, receiptSha256: process.argv[++index]! };
      recovery.failedPhases = [...(recovery.failedPhases ?? []), entry];
    } else throw new Error("Unknown release recovery argument");
  }
  console.log(
    JSON.stringify(
      await runReleasePlan(JSON.parse(await NodeFSP.readFile(file, "utf8")), recovery),
    ),
  );
}
