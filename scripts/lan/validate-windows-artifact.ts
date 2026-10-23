// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Local validation only; no build, install, credential or provider operation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import { inspectSourceGit, partitionTrackedSourceEntries } from "./source-git.ts";
import { BUILD_INPUT_FILES, BuildLock, sha256 } from "./hub-distribution.ts";
import {
  WindowsArtifactPolicy,
  TOOLCHAIN_LIMITS,
  strictJson,
  relativeWindowsPath,
  validateWindowsArtifact,
  type ArtifactRun,
  type NativeEvidence,
} from "./windows-artifact.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const Run = Schema.Struct({
  sourceId: Schema.String,
  sourceRoot: Schema.String,
  buildRoot: Schema.String,
  artifactPath: Schema.String,
  extractedRoot: Schema.String,
  toolchainRoot: Schema.String,
});
export const WindowsValidationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyPath: Schema.String,
  buildLockPath: Schema.String,
  toolchainManifestPath: Schema.String,
  runs: Schema.Tuple([Run, Run]),
});
export type WindowsValidationRun = typeof Run.Type;
const decodeRequest = Schema.decodeUnknownSync(WindowsValidationRequest);
const decodePolicy = Schema.decodeUnknownSync(WindowsArtifactPolicy);
const decodeBuildLock = Schema.decodeUnknownSync(BuildLock);
const decodeNative = Schema.decodeUnknownSync(
  Schema.Struct({
    sha256: Schema.String,
    trustStatus: Schema.Int,
    certificateSha256: Schema.NullOr(Schema.String),
    fileVersion: Schema.NullOr(Schema.String),
    productName: Schema.NullOr(Schema.String),
  }),
);
const safeFile = async (file: string, maximum: number) => {
  if (!NodePath.isAbsolute(file)) throw new Error("Validation paths must be absolute.");
  await safeRoot(NodePath.dirname(file));
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum)
    throw new Error("Validation input is missing, linked or oversized.");
  const handle = await NodeFSP.open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
      throw new Error("Validation input changed while opening.");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error("Validation input changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
};
const safeRoot = async (root: string) => {
  if (!NodePath.isAbsolute(root) || NodePath.resolve(root) !== root)
    throw new Error("Validation roots must be canonical absolute paths.");
  let current = root;
  for (;;) {
    const stat = await NodeFSP.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Validation roots cannot traverse links or reparse points.");
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
};
const tree = async (root: string, hashesOnly = false) => {
  await safeRoot(root);
  const result = new Map<string, { bytes: Uint8Array; length: number; sha256: string }>();
  let total = 0;
  const pendingTools: Array<{ name: string; file: string }> = [];
  const flushTools = async () => {
    const batch = pendingTools.splice(0);
    // Drain every handle before propagating a failure; tool inventories contain
    // hundreds of thousands of tiny files, so serial opens dominate hashing.
    const settled = await Promise.allSettled(
      batch.map(async ({ name, file }) => {
        const stat = await NodeFSP.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error("Toolchain file changed while opening.");
        total += stat.size;
        if (total > TOOLCHAIN_LIMITS.bytes)
          throw new Error("Validation tree exceeds its bounded local inventory size.");
        const handle = await NodeFSP.open(file, "r");
        try {
          const opened = await handle.stat();
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== stat.dev ||
            opened.ino !== stat.ino ||
            opened.size !== stat.size
          )
            throw new Error("Toolchain file changed while opening.");
          const digest = NodeCrypto.createHash("sha256");
          let length = 0;
          if (opened.size <= 256 * 1024) {
            const bytes = await handle.readFile();
            digest.update(bytes);
            length = bytes.length;
          } else {
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
              digest.update(chunk);
              length += chunk.length;
            }
          }
          const after = await handle.stat();
          if (
            length !== stat.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.size !== opened.size
          )
            throw new Error("Toolchain file changed while hashing.");
          return {
            name,
            pin: { bytes: new Uint8Array(), length, sha256: digest.digest("hex") },
          };
        } finally {
          await handle.close();
        }
      }),
    );
    for (const item of settled) {
      if (item.status === "rejected") throw item.reason;
      result.set(item.value.name, item.value.pin);
    }
  };
  const queueTool = async (name: string, file: string) => {
    if (result.size + pendingTools.length >= TOOLCHAIN_LIMITS.files)
      throw new Error("Validation tree has too many files.");
    relativeWindowsPath(name);
    pendingTools.push({ name, file });
    if (pendingTools.length === 32) await flushTools();
  };
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Validation tree is too deep.");
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = NodePath.join(directory, entry.name);
      if (hashesOnly && !entry.isDirectory()) {
        await queueTool(name, file);
        continue;
      }
      const stat = await NodeFSP.lstat(file);
      if (stat.isSymbolicLink())
        throw new Error("Validation tree contains a link or reparse point.");
      if (stat.isDirectory()) await visit(file, name, depth + 1);
      else {
        if (hashesOnly) {
          await queueTool(name, file);
          continue;
        }
        if (result.size >= 100000) throw new Error("Validation tree has too many files.");
        relativeWindowsPath(name);
        total += stat.size;
        if (total > 8 * 1024 ** 3)
          throw new Error("Validation tree exceeds its bounded local inventory size.");
        const bytes = await safeFile(file, 256 * 1024 ** 2);
        result.set(name, { bytes, length: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  await visit(root, "", 0);
  if (hashesOnly) await flushTools();
  return result;
};

export async function inspectWindowsSignature(file: string): Promise<NativeEvidence> {
  // eslint-disable-next-line t3code/no-global-process-runtime -- This CLI boundary invokes only the local Windows trust provider.
  if (process.platform !== "win32")
    throw new Error("Native signature inspection requires Windows.");
  const before = await safeFile(file, 256 * 1024 ** 2);
  const helper = NodePath.join(import.meta.dirname, "windows-signature.ps1");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const { stdout } = await execFile(
    NodePath.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-File", helper, "-LiteralPath", file],
    {
      timeout: 30000,
      maxBuffer: 65536,
      windowsHide: true,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: NodePath.join(systemRoot, "System32"),
        TEMP: NodeOS.tmpdir(),
        TMP: NodeOS.tmpdir(),
      },
    },
  );
  const value = strictJson(Buffer.from(stdout, "utf8"));
  const evidence = decodeNative(value, { onExcessProperty: "error" });
  if (
    evidence.sha256 !== sha256(before) ||
    sha256(await safeFile(file, 256 * 1024 ** 2)) !== evidence.sha256
  )
    throw new Error("Native file changed during signature inspection.");
  return evidence;
}

export async function validateRequest(
  requestPath: string,
  approvalSha256: string,
  options: {
    readonly requestBytes?: Uint8Array;
    readonly artifactForRun?: (
      run: WindowsValidationRun,
      extracted: ReadonlyMap<string, Uint8Array>,
    ) => Promise<{
      readonly artifact: Uint8Array;
      readonly extractedFiles: ReadonlyMap<string, Uint8Array>;
    }>;
  } = {},
) {
  if (!/^[a-f0-9]{64}$/u.test(approvalSha256))
    throw new Error("A separately approved policy SHA-256 is required.");
  const request = decodeRequest(
    strictJson(options.requestBytes ?? (await safeFile(requestPath, 1024 * 1024))),
    {
      onExcessProperty: "error",
    },
  );
  const policyBytes = await safeFile(request.policyPath, 1024 * 1024);
  if (sha256(policyBytes) !== approvalSha256)
    throw new Error("Validation policy differs from the separately approved SHA-256.");
  const policy = decodePolicy(strictJson(policyBytes), {
    onExcessProperty: "error",
  });
  const buildLockBytes = await safeFile(request.buildLockPath, 1024 * 1024);
  if (sha256(buildLockBytes) !== policy.buildLockSha256)
    throw new Error("Build lock differs from the approved policy.");
  const lock = decodeBuildLock(strictJson(buildLockBytes), {
    onExcessProperty: "error",
  });
  const runnerBytes = await safeFile(process.execPath, 256 * 1024 ** 2);
  if (
    process.versions.node !== lock.tools.node.version ||
    sha256(runnerBytes) !== lock.tools.node.sha256
  )
    throw new Error(
      "Run validation with the exact approved Node binary/version, outside virtualized caches.",
    );
  const toolchainManifestBytes = await safeFile(
    request.toolchainManifestPath,
    TOOLCHAIN_LIMITS.manifestBytes,
  );
  const runs: ArtifactRun[] = [];
  for (const run of request.runs) {
    await safeRoot(run.sourceRoot);
    await safeRoot(run.buildRoot);
    const git = (...args: string[]) => inspectSourceGit(run.sourceRoot, args);
    const status = await git("status", "--porcelain", "--untracked-files=all");
    let ancestor = true;
    try {
      await git("merge-base", "--is-ancestor", lock.upstreamCommit, lock.forkCommit);
    } catch {
      ancestor = false;
    }
    const selection = partitionTrackedSourceEntries(await git("ls-files", "--stage", "-z"));
    for (const entry of selection.exclusions)
      if (
        Object.hasOwn(lock.files, entry.path) ||
        BUILD_INPUT_FILES.some((name) => name === entry.path)
      )
        throw new Error("A required validation input cannot be excluded from the source snapshot.");
    const files = new Map<string, Uint8Array>();
    for (const name of new Set([...BUILD_INPUT_FILES, ...Object.keys(lock.files)]))
      files.set(
        name,
        await safeFile(
          NodePath.resolve(run.sourceRoot, relativeWindowsPath(name)),
          32 * 1024 * 1024,
        ),
      );
    const extracted = await tree(run.extractedRoot),
      tools = await tree(run.toolchainRoot, true);
    const rawExtracted = new Map([...extracted].map(([name, value]) => [name, value.bytes]));
    const materialized =
      options.artifactForRun === undefined
        ? {
            artifact: await safeFile(run.artifactPath, 512 * 1024 ** 2),
            extractedFiles: rawExtracted,
          }
        : await options.artifactForRun(run, rawExtracted);
    runs.push({
      sourceId: run.sourceId,
      buildRoot: run.buildRoot,
      source: {
        commit: await git("rev-parse", "HEAD"),
        clean: status.length === 0,
        upstreamAncestor: ancestor,
        files,
      },
      ...materialized,
      toolchainFiles: tools,
    });
  }
  const first = runs[0],
    second = runs[1];
  if (
    !first ||
    !second ||
    request.runs[0].sourceRoot.toLowerCase() === request.runs[1].sourceRoot.toLowerCase() ||
    request.runs[0].artifactPath.toLowerCase() === request.runs[1].artifactPath.toLowerCase()
  )
    throw new Error("Two distinct source checkouts and artifact paths are required.");
  const result = await validateWindowsArtifact({
    policy,
    buildLockBytes,
    toolchainManifestBytes,
    runs: [first, second],
    inspectNative: async (run, file) => {
      const selected = request.runs.find((item) => item.sourceId === run.sourceId);
      if (!selected) throw new Error("Native evidence lost its supplied build binding.");
      return inspectWindowsSignature(NodePath.join(selected.extractedRoot, ...file.split("/")));
    },
  });
  return {
    ...result,
    validatorNodeVersion: process.versions.node,
    validatorNodeSha256: sha256(runnerBytes),
  };
}

export {
  safeFile as readValidationFile,
  safeRoot as assertValidationRoot,
  tree as inspectValidationTree,
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          passed: false,
          buildAuthorized: false,
          distributionAuthorized: false,
          blockers: [
            "No approved policy SHA-256, complete toolchain lock, two clean pinned build checkouts or supplied artifacts were provided.",
            "Run prepare-hub.ts for current checkout evidence; preparation alone cannot prove artifact identity, runtime policy or reproducibility.",
          ],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else if (
    args.length !== 4 ||
    args[0] !== "--request" ||
    args[2] !== "--approved-policy-sha256"
  ) {
    throw new Error(
      "Usage: node scripts/lan/validate-windows-artifact.ts --request <absolute-request.json> --approved-policy-sha256 <separately-approved-sha256>",
    );
  } else {
    try {
      console.log(JSON.stringify(await validateRequest(args[1] ?? "", args[3] ?? ""), null, 2));
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            passed: false,
            buildAuthorized: false,
            distributionAuthorized: false,
            blockers: [error instanceof Error ? error.message : "Local validation failed."],
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
  }
}
