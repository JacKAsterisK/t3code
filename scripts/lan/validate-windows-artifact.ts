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
  PORTABLE_ZIP_MAX_BYTES,
  strictJson,
  relativeWindowsPath,
  validateWindowsArtifact,
  parseToolchainManifest,
  NativeBuildValidationReceipt,
  readPortableZip,
  type ArtifactRun,
  type NativeEvidence,
} from "./windows-artifact.ts";

import { captureQualifiedToolchain } from "./native-toolchain-qualification.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const Run = Schema.Struct({
  sourceId: Schema.String,
  sourceRoot: Schema.String,
  buildRoot: Schema.String,
  artifactPath: Schema.String,
  extractedRoot: Schema.String,
  toolchainRoot: Schema.String,
  toolchainQualificationPath: Schema.optional(Schema.String),
  nativeBuildEvidence: Schema.optional(
    Schema.Struct({
      receiptPath: Schema.String,
      runnerPath: Schema.String,
      rawArtifactPath: Schema.String,
      inputsRoot: Schema.String,
    }),
  ),
});
export const WindowsValidationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyPath: Schema.String,
  buildLockPath: Schema.String,
  toolchainManifestPath: Schema.String,
  runs: Schema.Union([Schema.Tuple([Run]), Schema.Tuple([Run, Run])]),
});
export type WindowsValidationRun = typeof Run.Type;
const decodeRequest = Schema.decodeUnknownSync(WindowsValidationRequest);
const decodePolicy = Schema.decodeUnknownSync(WindowsArtifactPolicy);
const decodeBuildLock = Schema.decodeUnknownSync(BuildLock);
const decodeBuildReceipt = Schema.decodeUnknownSync(NativeBuildValidationReceipt, {
  onExcessProperty: "error",
});
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

const nativeInputNames = [
  "build-lock.json",
  "execution-request.json",
  "identity.json",
  "native-request.json",
  "preparation-request.json",
  "snapshot.json",
  "toolchain-manifest.json",
] as const;
const toolNames = ["node", "pnpm", "rust", "msvc", "windowsSdk", "nsis"] as const;

export function nativeInputSnapshotSha256(files: ReadonlyMap<string, Uint8Array>) {
  const pins = [...files]
    .map(([path, bytes]) => ({
      path: relativeWindowsPath(path),
      length: bytes.length,
      sha256: sha256(bytes),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(`${JSON.stringify(pins, null, 2)}\n`);
}

// This receipt is external owner-approved producer evidence, never a claim read
// from the candidate package. It permits reusing the producer's completed toolchain
// evidence while rehashing its immutable inputs, runner, ZIP and selected tools.
export function verifyNativeBuildReceipt(input: {
  readonly policy: WindowsArtifactPolicy;
  readonly receiptBytes: Uint8Array;
  readonly runnerBytes: Uint8Array;
  readonly rawArtifactBytes: Uint8Array;
  readonly rawExtractedFiles: ReadonlyMap<string, Uint8Array>;
  readonly inputs: ReadonlyMap<string, Uint8Array>;
  readonly selectedTools: ReadonlyMap<string, Uint8Array>;
  readonly buildLockBytes: Uint8Array;
  readonly toolchainManifestBytes: Uint8Array;
  readonly sourceCommit: string;
}) {
  const approval = input.policy.nativeBuildEvidence;
  if (input.policy.validationMode !== "candidate" || approval === undefined)
    throw new Error("A candidate policy must separately approve native build evidence.");
  if (sha256(input.receiptBytes) !== approval.receiptSha256)
    throw new Error("Native build receipt differs from the separately approved bytes.");
  const receipt = decodeBuildReceipt(strictJson(input.receiptBytes));
  const lock = decodeBuildLock(strictJson(input.buildLockBytes), { onExcessProperty: "error" });
  const getInput = (name: string) => {
    const bytes = input.inputs.get(name);
    if (!bytes) throw new Error(`Native input snapshot is incomplete: ${name}.`);
    return bytes;
  };
  if (
    input.inputs.size !== nativeInputNames.length ||
    nativeInputNames.some((name) => !input.inputs.has(name)) ||
    nativeInputSnapshotSha256(input.inputs) !== receipt.inputsSnapshotSha256
  )
    throw new Error("Native input snapshot differs from the approved producer receipt.");
  for (const [name, expected] of [
    ["native-request.json", receipt.nativeRequestSha256],
    ["preparation-request.json", receipt.preparationRequestSha256],
    ["execution-request.json", receipt.executionRequestSha256],
    ["snapshot.json", receipt.sourceSnapshotSha256],
    ["identity.json", receipt.identitySha256],
    ["build-lock.json", receipt.buildLockSha256],
    ["toolchain-manifest.json", receipt.toolchainManifestSha256],
  ] as const)
    if (sha256(getInput(name)) !== expected)
      throw new Error(`Native input snapshot hash differs: ${name}.`);
  const documents = [
    "native-request.json",
    "preparation-request.json",
    "execution-request.json",
    "snapshot.json",
  ].map((name) => {
    const value = strictJson(getInput(name));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1
    )
      throw new Error("Native producer input document is invalid.");
    return value as Record<string, unknown>;
  });
  const [native, preparation, execution, snapshot] = documents;
  if (
    native!.runnerSha256 !== receipt.runnerSha256 ||
    native!.preparationRequestSha256 !== receipt.preparationRequestSha256 ||
    native!.executionRequestSha256 !== receipt.executionRequestSha256 ||
    [preparation!, execution!].some(
      (value) =>
        value.buildLockSha256 !== receipt.buildLockSha256 ||
        value.identitySha256 !== receipt.identitySha256 ||
        value.toolchainManifestSha256 !== receipt.toolchainManifestSha256,
    ) ||
    snapshot!.sourceCommit !== receipt.sourceCommit ||
    receipt.sourceCommit !== input.sourceCommit ||
    receipt.sourceCommit !== lock.forkCommit ||
    receipt.buildLockSha256 !== input.policy.buildLockSha256 ||
    receipt.buildLockSha256 !== sha256(input.buildLockBytes) ||
    receipt.toolchainManifestSha256 !== input.policy.toolchainManifestSha256 ||
    receipt.toolchainManifestSha256 !== sha256(input.toolchainManifestBytes) ||
    receipt.runnerSha256 !== approval.runnerSha256 ||
    receipt.runnerSha256 !== sha256(input.runnerBytes)
  )
    throw new Error("Native producer source, runner or request bindings differ.");
  if (
    receipt.rawArtifactByteLength !== input.rawArtifactBytes.length ||
    receipt.rawArtifactSha256 !== sha256(input.rawArtifactBytes)
  )
    throw new Error("Native producer artifact differs from the approved receipt.");
  const raw = readPortableZip(input.rawArtifactBytes);
  if (
    raw.size !== input.rawExtractedFiles.size ||
    [...raw].some(([name, bytes]) => {
      const actual = input.rawExtractedFiles.get(name);
      return (
        actual === undefined || actual.length !== bytes.length || sha256(actual) !== sha256(bytes)
      );
    })
  )
    throw new Error(
      "Extracted candidate payload differs from the approved native producer artifact.",
    );
  const manifest = parseToolchainManifest(input.toolchainManifestBytes);
  const files = new Map<string, { readonly length: number; readonly sha256: string }>();
  const paths = new Set<string>();
  let byteLength = 0;
  for (const pin of manifest.files) {
    relativeWindowsPath(pin.path);
    if (pin.length < 0 || paths.has(pin.path.toLowerCase()))
      throw new Error("Approved native toolchain inventory is invalid.");
    paths.add(pin.path.toLowerCase());
    byteLength += pin.length;
    files.set(pin.path, { length: pin.length, sha256: pin.sha256 });
  }
  if (
    byteLength > TOOLCHAIN_LIMITS.bytes ||
    receipt.toolchainByteLength !== byteLength ||
    receipt.toolchainFileCount !== files.size
  )
    throw new Error("Native receipt toolchain inventory counts differ.");
  for (const name of toolNames) {
    const path = relativeWindowsPath(input.policy.toolFiles[name]),
      bytes = input.selectedTools.get(path),
      pin = files.get(path);
    if (
      !bytes ||
      !pin ||
      bytes.length !== pin.length ||
      sha256(bytes) !== pin.sha256 ||
      pin.sha256 !== lock.tools[name].sha256
    )
      throw new Error(`Native selected tool bytes differ: ${name}.`);
  }
  return files;
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
  const validationMode = policy.validationMode ?? "independent-rebuild";
  if (request.runs.length !== (validationMode === "candidate" ? 1 : 2))
    throw new Error(
      "Validation mode requires exactly one candidate or two independent rebuild runs.",
    );
  if (
    (policy.nativeBuildEvidence !== undefined ||
      policy.toolchainQualificationSha256 !== undefined) &&
    validationMode !== "candidate"
  )
    throw new Error("Approved native build receipts are available only for candidate validation.");
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
    const extracted = await tree(run.extractedRoot);
    const rawExtracted = new Map([...extracted].map(([name, value]) => [name, value.bytes]));
    const sourceCommit = await git("rev-parse", "HEAD");
    let tools: ArtifactRun["toolchainFiles"];
    if (policy.toolchainQualificationSha256 !== undefined) {
      if (
        !run.toolchainQualificationPath ||
        run.nativeBuildEvidence !== undefined ||
        policy.nativeBuildEvidence !== undefined
      )
        throw new Error(
          "Qualified toolchain evidence must be supplied without another toolchain proof mode.",
        );
      tools = (
        await captureQualifiedToolchain({
          root: run.toolchainRoot,
          manifestBytes: toolchainManifestBytes,
          manifestSha256: policy.toolchainManifestSha256,
          primaryFiles: toolNames.map((name) => ({
            path: policy.toolFiles[name],
            ...lock.tools[name],
          })),
          qualification: { path: run.toolchainQualificationPath },
          expectedQualificationSha256: policy.toolchainQualificationSha256,
        })
      ).files;
    } else if (policy.nativeBuildEvidence !== undefined) {
      const evidence = run.nativeBuildEvidence;
      if (!evidence) throw new Error("Approved native build evidence paths are missing.");
      const selectedTools = new Map<string, Uint8Array>();
      for (const name of toolNames) {
        const path = relativeWindowsPath(policy.toolFiles[name]);
        selectedTools.set(
          path,
          await safeFile(NodePath.join(run.toolchainRoot, path), 256 * 1024 ** 2),
        );
      }
      const inputs = new Map(
        [...(await tree(evidence.inputsRoot))].map(([name, value]) => [name, value.bytes]),
      );
      tools = verifyNativeBuildReceipt({
        policy,
        receiptBytes: await safeFile(evidence.receiptPath, 1024 * 1024),
        runnerBytes: await safeFile(evidence.runnerPath, 256 * 1024 ** 2),
        rawArtifactBytes: await safeFile(evidence.rawArtifactPath, PORTABLE_ZIP_MAX_BYTES),
        rawExtractedFiles: rawExtracted,
        inputs,
        selectedTools,
        buildLockBytes,
        toolchainManifestBytes,
        sourceCommit,
      });
    } else {
      if (run.nativeBuildEvidence !== undefined || run.toolchainQualificationPath !== undefined)
        throw new Error("Native toolchain evidence is not approved by the validation policy.");
      tools = await tree(run.toolchainRoot, true);
    }
    const materialized =
      options.artifactForRun === undefined
        ? {
            artifact: await safeFile(run.artifactPath, PORTABLE_ZIP_MAX_BYTES),
            extractedFiles: rawExtracted,
          }
        : await options.artifactForRun(run, rawExtracted);
    runs.push({
      sourceId: run.sourceId,
      buildRoot: run.buildRoot,
      source: {
        commit: sourceCommit,
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
    (second !== undefined &&
      (request.runs[0].sourceRoot.toLowerCase() === request.runs[1]!.sourceRoot.toLowerCase() ||
        request.runs[0].artifactPath.toLowerCase() === request.runs[1]!.artifactPath.toLowerCase()))
  )
    throw new Error("Two distinct source checkouts and artifact paths are required.");
  const result = await validateWindowsArtifact({
    policy,
    buildLockBytes,
    toolchainManifestBytes,
    runs,
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
    toolchainEvidence:
      policy.toolchainQualificationSha256 !== undefined
        ? ("approved-local-toolchain-qualification" as const)
        : policy.nativeBuildEvidence === undefined
          ? ("fresh-full-inventory" as const)
          : ("approved-native-build-receipt" as const),
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
