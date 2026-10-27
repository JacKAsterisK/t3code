// @effect-diagnostics nodeBuiltinImport:off - Synthetic subprocess and receipt tests use an isolated Git commit and local verifier.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { releasePhaseReceiptSha256, runReleasePlan, type ReleasePlan } from "./release-pipeline.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-release-pipeline-"));
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
      "synthetic release",
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
    {
      encoding: "utf8",
    },
  ).trim();
  const proof = NodePath.join(root, "download.json");
  const artifactPinsPath = NodePath.join(root, "pins.json");
  const command = (script: string) => ({
    executable: process.execPath,
    args: ["-e", script],
    cwd: root,
  });
  const proofBody = {
    passed: true,
    sourceCommit,
    remoteMachine: "synthetic",
    verifiedDownload: true,
    version: "1.2.3",
    artifactSha256: "a".repeat(64),
  };
  const plan: ReleasePlan = {
    schemaVersion: 1,
    sourceRoot,
    sourceCommit,
    codeFinishedUtc: "2020-01-01T00:00:00Z",
    outputRoot: NodePath.join(root, "receipt"),
    maxParallel: 2,
    phases: [
      {
        id: "seal",
        dependsOn: [],
        command: command(
          `require('node:fs').writeFileSync(${JSON.stringify(artifactPinsPath)}, ${JSON.stringify(JSON.stringify({ sourceCommit, version: "1.2.3", zipSha256: "a".repeat(64) }))})`,
        ),
        inputs: [],
        outputs: [artifactPinsPath],
      },
      {
        id: "download",
        dependsOn: ["seal"],
        command: command(
          `require('node:fs').writeFileSync(${JSON.stringify(proof)}, JSON.stringify({...${JSON.stringify(proofBody)},verifiedUtc:new Date().toISOString()}))`,
        ),
        inputs: [],
        outputs: [proof],
      },
    ],
    downloadProof: {
      phase: "download",
      path: proof,
      version: "1.2.3",
      remoteMachine: "synthetic",
      artifactPinsPath,
    },
  };
  return {
    root,
    plan,
    proof,
    command,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("preserves code-finished time across verified resume without rerunning completed publication", async () => {
  await using f = await fixture();
  const first = await runReleasePlan(f.plan);
  expect(first.updateDownloadableUtc).toBe(first.phases.download!.completedUtc);
  const second = await runReleasePlan(f.plan);
  expect(second.phases).toEqual(first.phases);
  expect(second.codeFinishedUtc).toBe("2020-01-01T00:00:00Z");
});

it("refuses resumed publication if a verified output changes", async () => {
  await using f = await fixture();
  await runReleasePlan(f.plan);
  await NodeFSP.writeFile(f.proof, "tampered");
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Completed output changed");
});

it("waits for prerequisites and stops publication after a validation failure", async () => {
  await using f = await fixture();
  const marker = NodePath.join(f.root, "validated");
  f.plan.phases.unshift({
    id: "validate",
    dependsOn: [],
    command: f.command("process.exit(7)"),
    inputs: [],
    outputs: [marker],
  });
  f.plan.phases[2]!.dependsOn.push("validate");
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Release phase failed: validate (7)");
  await expect(NodeFSP.stat(f.proof)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(runReleasePlan(f.plan)).rejects.toThrow(
    "Review interrupted phase before retry: validate",
  );
});

it("rejects a local completion receipt lacking the remote download proof", async () => {
  await using f = await fixture();
  f.plan.phases[1]!.command = f.command(
    `require('node:fs').writeFileSync(${JSON.stringify(f.proof)}, '{}')`,
  );
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Remote download");
});

it("rejects a download verification that can precede another release gate", async () => {
  await using f = await fixture();
  f.plan.phases.push({
    id: "approval",
    dependsOn: [],
    command: f.command("process.exit(0)"),
    inputs: [],
    outputs: [],
  });
  await expect(runReleasePlan(f.plan)).rejects.toThrow(
    "Download verification must follow every release gate",
  );
});

it("rejects a stale proof copied into a new verification phase", async () => {
  await using f = await fixture();
  f.plan.phases[1]!.command.args[1] = f.plan.phases[1]!.command.args[1]!.replace(
    "new Date().toISOString()",
    "'2021-01-01T00:00:00Z'",
  );
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Remote download proof is incomplete");
});

it("refuses a completed receipt with an invalid timestamp instead of reporting NaN time", async () => {
  await using f = await fixture();
  await runReleasePlan(f.plan);
  const journal = NodePath.join(f.plan.outputRoot, "release-progress.json");
  const state = JSON.parse(await NodeFSP.readFile(journal, "utf8"));
  state.phases.download.completedUtc = "invalid";
  await NodeFSP.writeFile(journal, JSON.stringify(state));
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Invalid completed phase timing");
});

it("rejects phase outputs that would overwrite another phase", async () => {
  await using f = await fixture();
  f.plan.phases[0]!.outputs.push(f.proof);
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Phase outputs must be globally unique");
});

async function failedIdempotentSeal(f: Awaited<ReturnType<typeof fixture>>, idempotent = true) {
  const marker = NodePath.join(f.root, "seal-started");
  const count = NodePath.join(f.root, "seal-count");
  const pins = f.plan.downloadProof.artifactPinsPath;
  f.plan.phases[0]!.idempotent = idempotent;
  f.plan.phases[0]!.command = f.command(
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(count)},'x');
     if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'intent');fs.writeFileSync(${JSON.stringify(pins)},'partial');process.exit(7);}
     fs.writeFileSync(${JSON.stringify(pins)},${JSON.stringify(JSON.stringify({ sourceCommit: f.plan.sourceCommit, version: "1.2.3", zipSha256: "a".repeat(64) }))});`,
  );
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Release phase failed: seal (7)");
  const journal = NodePath.join(f.plan.outputRoot, "release-progress.json");
  const previous = JSON.parse(await NodeFSP.readFile(journal, "utf8"));
  return {
    count,
    journal,
    previous: previous.phases.seal,
    request: {
      failedPhases: [
        { id: "seal", receiptSha256: releasePhaseReceiptSha256(previous.phases.seal) },
      ],
    },
  };
}

it("resumes an opted-in failed phase with exact receipt and partial-output guards while preserving failure evidence", async () => {
  await using f = await fixture();
  const failed = await failedIdempotentSeal(f);
  const result = await runReleasePlan(f.plan, failed.request);
  expect(await NodeFSP.readFile(failed.count, "utf8")).toBe("xx");
  expect(result.codeFinishedUtc).toBe(f.plan.codeFinishedUtc);
  const history = result.phases.seal!.history!;
  expect(history).toHaveLength(1);
  expect(JSON.parse(await NodeFSP.readFile(history[0]!.receipt.path, "utf8"))).toEqual(
    failed.previous,
  );
  expect(await NodeFSP.readFile(history[0]!.log.path, "utf8")).toEqual(
    await NodeFSP.readFile(failed.previous.log.path, "utf8"),
  );
  await runReleasePlan(f.plan);
  expect(await NodeFSP.readFile(failed.count, "utf8")).toBe("xx");
});

it("refuses a changed failed receipt or changed partial output before repeating a command", async () => {
  await using f = await fixture();
  const failed = await failedIdempotentSeal(f);
  await expect(
    runReleasePlan(f.plan, { failedPhases: [{ id: "seal", receiptSha256: "0".repeat(64) }] }),
  ).rejects.toThrow("Reviewed failed receipt differs");
  await NodeFSP.writeFile(f.plan.downloadProof.artifactPinsPath, "foreign output");
  await expect(runReleasePlan(f.plan, failed.request)).rejects.toThrow(
    "Failed phase output changed",
  );
  expect(await NodeFSP.readFile(failed.count, "utf8")).toBe("x");
});

it("does not turn an ordinary failed command into an automatic retry", async () => {
  await using f = await fixture();
  const failed = await failedIdempotentSeal(f, false);
  await expect(runReleasePlan(f.plan, failed.request)).rejects.toThrow("Only opted-in idempotent");
  expect(await NodeFSP.readFile(failed.count, "utf8")).toBe("x");
});

it("still refuses changed inputs before recovering an idempotent failure", async () => {
  await using f = await fixture();
  const input = NodePath.join(f.root, "input");
  await NodeFSP.writeFile(input, "reviewed");
  f.plan.phases[0]!.inputs.push({
    path: input,
    sha256: NodeCrypto.createHash("sha256").update("reviewed").digest("hex"),
  });
  const failed = await failedIdempotentSeal(f);
  await NodeFSP.writeFile(input, "changed");
  await expect(runReleasePlan(f.plan, failed.request)).rejects.toThrow("Release input changed");
  expect(await NodeFSP.readFile(failed.count, "utf8")).toBe("x");
});

it("refuses running or incomplete legacy receipts even for an idempotent command", async () => {
  await using f = await fixture();
  const failed = await failedIdempotentSeal(f);
  const journal = JSON.parse(await NodeFSP.readFile(failed.journal, "utf8"));
  delete journal.phases.seal.failedOutputs;
  await NodeFSP.writeFile(failed.journal, JSON.stringify(journal));
  await expect(
    runReleasePlan(f.plan, {
      failedPhases: [{ id: "seal", receiptSha256: releasePhaseReceiptSha256(journal.phases.seal) }],
    }),
  ).rejects.toThrow("Incomplete failed phase receipt");
  journal.phases.seal.status = "running";
  await NodeFSP.writeFile(failed.journal, JSON.stringify(journal));
  await expect(
    runReleasePlan(f.plan, {
      failedPhases: [{ id: "seal", receiptSha256: releasePhaseReceiptSha256(journal.phases.seal) }],
    }),
  ).rejects.toThrow("Only opted-in idempotent failed");
  expect(await NodeFSP.readFile(failed.count, "utf8")).toBe("x");
});

it("requires fresh remote verification when reconciling uncertain publication", async () => {
  await using f = await fixture();
  const marker = NodePath.join(f.root, "publication-intent");
  const original = f.plan.phases[1]!.command.args[1]!;
  f.plan.phases[1]!.idempotent = true;
  f.plan.phases[1]!.command = f.command(
    `if(!require('node:fs').existsSync(${JSON.stringify(marker)})){${original};require('node:fs').writeFileSync(${JSON.stringify(marker)},'published');process.exit(75);}`,
  );
  await expect(runReleasePlan(f.plan)).rejects.toThrow("Release phase failed: download (75)");
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(f.plan.outputRoot, "release-progress.json"), "utf8"),
  );
  await expect(
    runReleasePlan(f.plan, {
      failedPhases: [
        { id: "download", receiptSha256: releasePhaseReceiptSha256(journal.phases.download) },
      ],
    }),
  ).rejects.toThrow("Remote download proof is incomplete");
});

it("does not recover a phase while another release owner is still active", async () => {
  await using f = await fixture();
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as NodeNet.AddressInfo;
  const connected = new Promise<NodeNet.Socket>((resolve) => server.once("connection", resolve));
  const original = f.plan.phases[0]!.command.args[1]!;
  f.plan.phases[0]!.command = f.command(
    `const socket=require('node:net').connect(${address.port},'127.0.0.1');socket.once('data',()=>{${original};socket.end();});`,
  );
  const first = runReleasePlan(f.plan);
  const socket = await connected;
  try {
    await expect(runReleasePlan(f.plan)).rejects.toMatchObject({ code: "EEXIST" });
  } finally {
    socket.end("continue");
    await first;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
