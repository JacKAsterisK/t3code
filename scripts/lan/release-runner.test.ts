// @effect-diagnostics nodeBuiltinImport:off - Isolated Git/subprocess fixtures exercise real durable release resumption without publishing anything.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { type ReleasePlan } from "./release-pipeline.ts";
import { runReleaseWithRecovery } from "./release-runner.ts";

async function fixture(exitCode: number, idempotent = true, alwaysFail = false) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-release-resume-"));
  const sourceRoot = NodePath.join(root, "source");
  await NodeFSP.mkdir(sourceRoot);
  NodeChildProcess.execFileSync("git.exe", ["init", sourceRoot], { windowsHide: true });
  NodeChildProcess.execFileSync(
    "git.exe",
    [
      "-C",
      sourceRoot,
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=" + NodePath.join(root, "no-hooks"),
      "commit",
      "--allow-empty",
      "-m",
      "synthetic",
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    },
  );
  const sourceCommit = NodeChildProcess.execFileSync(
    "git.exe",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const sealCount = NodePath.join(root, "seal-count"),
    operation = NodePath.join(root, "operation"),
    invocations = NodePath.join(root, "invocations"),
    pins = NodePath.join(root, "pins.json"),
    proof = NodePath.join(root, "download.json");
  const command = (script: string) => ({
    executable: process.execPath,
    args: ["-e", script],
    cwd: root,
  });
  const plan: ReleasePlan = {
    schemaVersion: 1,
    sourceRoot,
    sourceCommit,
    codeFinishedUtc: "2020-01-01T00:00:00Z",
    outputRoot: NodePath.join(root, "receipts"),
    maxParallel: 1,
    phases: [
      {
        id: "seal",
        dependsOn: [],
        command: command(
          `const f=require('node:fs');f.appendFileSync(${JSON.stringify(sealCount)},'x');f.writeFileSync(${JSON.stringify(pins)},JSON.stringify({sourceCommit:${JSON.stringify(sourceCommit)},version:'1.2.3',zipSha256:'${"a".repeat(64)}'}));`,
        ),
        inputs: [],
        outputs: [pins],
      },
      {
        id: "publish",
        dependsOn: ["seal"],
        idempotent,
        command: command(
          `const f=require('node:fs');f.appendFileSync(${JSON.stringify(invocations)},'x');if(!f.existsSync(${JSON.stringify(operation)})){f.writeFileSync(${JSON.stringify(operation)},'one immutable publication');process.exit(${exitCode});}if(${alwaysFail})process.exit(${exitCode});f.writeFileSync(${JSON.stringify(proof)},JSON.stringify({passed:true,sourceCommit:${JSON.stringify(sourceCommit)},remoteMachine:'synthetic',verifiedDownload:true,version:'1.2.3',artifactSha256:'${"a".repeat(64)}',verifiedUtc:new Date().toISOString()}));`,
        ),
        inputs: [],
        outputs: [proof],
      },
    ],
    downloadProof: {
      phase: "publish",
      path: proof,
      version: "1.2.3",
      remoteMachine: "synthetic",
      artifactPinsPath: pins,
    },
  };
  return {
    root,
    plan,
    sealCount,
    operation,
    invocations,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("resumes a marked temporary publication on the same plan without resealing or duplicating the operation", async () => {
  await using f = await fixture(75);
  const result = await runReleaseWithRecovery(f.plan);
  expect(result.passed).toBe(true);
  expect(result.codeFinishedUtc).toBe("2020-01-01T00:00:00Z");
  expect(await NodeFSP.readFile(f.sealCount, "utf8")).toBe("x");
  expect(await NodeFSP.readFile(f.invocations, "utf8")).toBe("xx");
  expect(await NodeFSP.readFile(f.operation, "utf8")).toBe("one immutable publication");
  const progress = JSON.parse(
    await NodeFSP.readFile(NodePath.join(f.plan.outputRoot, "release-progress.json"), "utf8"),
  );
  expect(progress.phases.publish.history).toHaveLength(1);
  expect(
    JSON.parse(await NodeFSP.readFile(progress.phases.publish.history[0].receipt.path, "utf8"))
      .exitCode,
  ).toBe(75);
});

it.each([
  { code: 1, marked: true },
  { code: 75, marked: false },
])("does not retry terminal or unmarked commands: $code/$marked", async ({ code, marked }) => {
  await using f = await fixture(code, marked);
  await expect(runReleaseWithRecovery(f.plan)).rejects.toThrow("Release phase failed: publish");
  expect(await NodeFSP.readFile(f.invocations, "utf8")).toBe("x");
});

it("keeps its retry budget across process-level resumes", async () => {
  await using f = await fixture(75, true, true);
  await expect(runReleaseWithRecovery(f.plan, { maxTemporaryRetries: 1 })).rejects.toThrow(
    "Release phase failed: publish",
  );
  expect(await NodeFSP.readFile(f.invocations, "utf8")).toBe("xx");
  await expect(runReleaseWithRecovery(f.plan, { maxTemporaryRetries: 1 })).rejects.toThrow();
  expect(await NodeFSP.readFile(f.invocations, "utf8")).toBe("xx");
});
