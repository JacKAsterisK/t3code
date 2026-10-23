// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Prepares a new offline Sandbox configuration and public tracked-source snapshot; never launches a guest or build.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import {
  inspectSourceGit,
  partitionTrackedSourceEntries,
  readCommittedSourceBlobs,
} from "./source-git.ts";
import {
  nativeBuildRoot,
  preparePinnedWindowsBuild,
  WindowsBuildPreparationRequest,
} from "./windows-build-preparation.ts";
import { WindowsBuildExecutionRequest } from "./windows-build-execution.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";
import { relativeWindowsPath, strictJson, TOOLCHAIN_LIMITS } from "./windows-artifact.ts";
import { WINDOWS_SANDBOX_ROOTS } from "./windows-sandbox-context.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const WindowsSandboxPreparationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  preparationRequestPath: Schema.String,
  preparationRequestSha256: Hash,
  executionRequestPath: Schema.String,
  executionRequestSha256: Hash,
  guestRunnerPath: Schema.String,
  guestRunnerSha256: Hash,
  bundleRoot: Schema.String,
});
export type WindowsSandboxPreparationRequest = typeof WindowsSandboxPreparationRequest.Type;
export const SourceSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  sourceDateEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  exclusions: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.Literals(["120000", "160000"]),
      blob: Schema.String,
    }),
  ),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, blob: Schema.String, length: Schema.Int, sha256: Hash }),
  ),
});
export type SourceSnapshot = typeof SourceSnapshot.Type;
export const WindowsSandboxGuestRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  preparationRequestSha256: Hash,
  executionRequestSha256: Hash,
  guestRunnerSha256: Hash,
  snapshotSha256: Hash,
  buildLockSha256: Hash,
  identitySha256: Hash,
  toolchainManifestSha256: Hash,
});
const decodePreparation = Schema.decodeUnknownSync(WindowsBuildPreparationRequest, {
  onExcessProperty: "error",
});
const decodeSandbox = Schema.decodeUnknownSync(WindowsSandboxPreparationRequest, {
  onExcessProperty: "error",
});
const decodeExecution = Schema.decodeUnknownSync(WindowsBuildExecutionRequest, {
  onExcessProperty: "error",
});
const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

export function assertSnapshotSourcePath(path: string) {
  relativeWindowsPath(path);
  const parts = path.split("/").map((part) => part.toLowerCase());
  const fixtureRoot =
    ".repos/alchemy-effect/packages/cloudflare-runtime/src/rolldown/test/fixtures/";
  const committedNodeFixture =
    path.startsWith(fixtureRoot + "cloudflare-imports/node_modules/@fixtures/") ||
    path.startsWith(fixtureRoot + "module-resolution/node_modules/@fixtures/");
  if (
    parts.some((part) => [".git", ".t3", ".env"].includes(part)) ||
    (parts.includes("node_modules") && !committedNodeFixture)
  )
    throw new Error("Source snapshot contains a forbidden state/configuration path.");
}

export function parseTrackedSourceEntries(index: string) {
  const files = partitionTrackedSourceEntries(index).files.map((entry) => {
    const path = entry.path;
    assertSnapshotSourcePath(path);
    return { path, blob: entry.blob };
  });
  if (
    !files.length ||
    files.length > 100000 ||
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length
  )
    throw new Error("Source snapshot inventory is empty, ambiguous or oversized.");
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

export function committedSnapshotFile(blob: string, bytes: Uint8Array) {
  const hash = NodeCrypto.createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (hash !== blob) throw new Error("Source snapshot bytes differ from the committed Git blob.");
  return { length: bytes.length, sha256: sha256(bytes) };
}

function hostRoot(value: string) {
  const normalized = nativeBuildRoot(value);
  relativeWindowsPath(value.slice(3).replaceAll("\\", "/").replace(/\/$/u, ""));
  return normalized;
}
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function renderWindowsSandboxConfiguration(input: {
  readonly sourceRoot: string;
  readonly toolchainRoot: string;
  readonly inputsRoot: string;
  readonly outputRoot: string;
  readonly nodeRelativePath: string;
  readonly nodeSha256: string;
  readonly guestRequestSha256: string;
  readonly guestRunnerSha256: string;
}) {
  const roots = [input.sourceRoot, input.toolchainRoot, input.inputsRoot, input.outputRoot].map(
    hostRoot,
  );
  for (let left = 0; left < roots.length; left++)
    for (let right = left + 1; right < roots.length; right++)
      if (
        roots[left] === roots[right] ||
        roots[left]!.startsWith(roots[right]! + "\\") ||
        roots[right]!.startsWith(roots[left]! + "\\")
      )
        throw new Error("Sandbox mappings must be separate nonoverlapping native directories.");
  relativeWindowsPath(input.nodeRelativePath);
  if (
    !input.nodeRelativePath.endsWith(".exe") ||
    ![input.nodeSha256, input.guestRequestSha256, input.guestRunnerSha256].every((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    )
  )
    throw new Error("Sandbox bootstrap requires the approved native Node and input hashes.");
  const node = NodePath.win32.join(WINDOWS_SANDBOX_ROOTS.toolchainRoot, input.nodeRelativePath);
  const inputs = WINDOWS_SANDBOX_ROOTS.inputsRoot;
  // The bootstrap itself is encoded in the reviewable WSB, not loaded from a mutable script path.
  const bootstrap = `$ErrorActionPreference='Stop'
function RequireHash($p,$h) { if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $h) { throw 'Approved Sandbox bootstrap bytes changed' } }
RequireHash ${ps(inputs + "\\guest-request.json")} ${ps(input.guestRequestSha256)}
RequireHash ${ps(inputs + "\\guest-runner.mjs")} ${ps(input.guestRunnerSha256)}
RequireHash ${ps(node)} ${ps(input.nodeSha256)}
Get-ChildItem Env: | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$env:SystemRoot='C:\\Windows'; $env:WINDIR='C:\\Windows'; $env:PATH=${ps(NodePath.win32.dirname(node))}
$env:TEMP='C:\\Windows\\Temp'; $env:TMP=$env:TEMP
Set-Location -LiteralPath ${ps(inputs)}
& ${ps(node)} ${ps(inputs + "\\guest-runner.mjs")} '--guest-request-sha256' ${ps(input.guestRequestSha256)}
if ($LASTEXITCODE -ne 0) { throw 'Isolated build failed; inspect the new output only' }`;
  const command = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(bootstrap, "utf16le").toString("base64")}`;
  const mappings = [
    [input.sourceRoot, WINDOWS_SANDBOX_ROOTS.mappedSourceRoot, true],
    [input.toolchainRoot, WINDOWS_SANDBOX_ROOTS.toolchainRoot, true],
    [input.inputsRoot, WINDOWS_SANDBOX_ROOTS.inputsRoot, true],
    [input.outputRoot, WINDOWS_SANDBOX_ROOTS.outputRoot, false],
  ] as const;
  return `<Configuration>
  <vGPU>Disable</vGPU><Networking>Disable</Networking>
  <AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>${mappings.map(([host, guest, readOnly]) => `\n    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${guest}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`).join("")}
  </MappedFolders>
  <LogonCommand><Command>${xml(command)}</Command></LogonCommand>
</Configuration>\n`;
}

export async function writeNewSnapshotTree(root: string, files: ReadonlyMap<string, Uint8Array>) {
  await assertValidationRoot(NodePath.dirname(root));
  await NodeFSP.mkdir(root); // Exclusive creation; partial failures require owner recovery, never cleanup.
  const identities = new Map<string, { dev: number; ino: number }>();
  const register = async (directory: string) => {
    const state = await NodeFSP.lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("New snapshot directory changed.");
    identities.set(directory, { dev: state.dev, ino: state.ino });
  };
  await register(root);
  for (const [name, bytes] of [...files].sort(([left], [right]) => (left < right ? -1 : 1))) {
    relativeWindowsPath(name);
    const directories = name.split("/").slice(0, -1);
    let parent = root;
    for (const part of directories) {
      parent = NodePath.join(parent, part);
      if (!identities.has(parent)) {
        await NodeFSP.mkdir(parent);
        await register(parent);
      }
    }
    await assertValidationRoot(parent);
    let directory = parent;
    for (;;) {
      const owned = identities.get(directory);
      const state = await NodeFSP.lstat(directory);
      if (
        !owned ||
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        state.dev !== owned.dev ||
        state.ino !== owned.ino
      )
        throw new Error("Snapshot parent identity changed; owner recovery is required.");
      if (directory === root) break;
      directory = NodePath.dirname(directory);
    }
    const handle = await NodeFSP.open(NodePath.join(root, name), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const actual = await inspectValidationTree(root, true);
  if (
    actual.size !== files.size ||
    [...files].some(([path, bytes]) => actual.get(path)?.sha256 !== sha256(bytes))
  )
    throw new Error("Created source/input snapshot differs from the captured bytes.");
}

export async function prepareWindowsSandbox(requestPath: string, approvedRequestSha256: string) {
  const requestBytes = await readValidationFile(requestPath, 1024 * 1024);
  if (
    !/^[a-f0-9]{64}$/u.test(approvedRequestSha256) ||
    sha256(requestBytes) !== approvedRequestSha256
  )
    throw new Error("Sandbox preparation requires the separately reviewed request bytes.");
  const request = decodeSandbox(strictJson(requestBytes));
  await preparePinnedWindowsBuild(request.preparationRequestPath, request.preparationRequestSha256);
  const preparationBytes = await readValidationFile(request.preparationRequestPath, 1024 * 1024);
  const preparation = decodePreparation(strictJson(preparationBytes));
  const executionBytes = await readValidationFile(request.executionRequestPath, 1024 * 1024);
  const runnerBytes = await readValidationFile(request.guestRunnerPath, 64 * 1024 ** 2);
  if (
    sha256(preparationBytes) !== request.preparationRequestSha256 ||
    sha256(executionBytes) !== request.executionRequestSha256 ||
    sha256(runnerBytes) !== request.guestRunnerSha256
  )
    throw new Error("Sandbox approved inputs changed during capture.");
  const execution = decodeExecution(strictJson(executionBytes));
  const lockBytes = await readValidationFile(preparation.buildLockPath, 1024 * 1024);
  const identityBytes = await readValidationFile(preparation.identityPath, 65536);
  const toolchainBytes = await readValidationFile(
    preparation.toolchainManifestPath,
    TOOLCHAIN_LIMITS.manifestBytes,
  );
  const lock = decodeLock(strictJson(lockBytes));
  if (
    sha256(lockBytes) !== preparation.buildLockSha256 ||
    sha256(identityBytes) !== preparation.identitySha256 ||
    sha256(toolchainBytes) !== preparation.toolchainManifestSha256 ||
    execution.toolchainManifestSha256 !== preparation.toolchainManifestSha256 ||
    execution.buildLockSha256 !== preparation.buildLockSha256 ||
    execution.identitySha256 !== preparation.identitySha256 ||
    execution.tools.node !== preparation.toolFiles.node
  )
    throw new Error("Sandbox input/toolchain identity differs from preparation.");
  const git = (...args: string[]) => inspectSourceGit(preparation.sourceRoot, args);
  const commit = await git("rev-parse", "HEAD");
  const epoch = Number(await git("show", "-s", "--format=%ct", "HEAD"));
  if (
    commit !== lock.forkCommit ||
    !Number.isSafeInteger(epoch) ||
    epoch !== execution.sourceDateEpoch ||
    (await git("status", "--porcelain", "--untracked-files=all"))
  )
    throw new Error(
      "Sandbox source changed or SOURCE_DATE_EPOCH differs from its approved commit.",
    );
  const index = await git("ls-files", "--stage", "-z");
  const files = new Map<string, Uint8Array>();
  const pins: SourceSnapshot["files"][number][] = [];
  const entries = parseTrackedSourceEntries(index);
  const blobs = await readCommittedSourceBlobs(
    preparation.sourceRoot,
    entries.map((entry) => entry.blob),
  );
  let total = 0;
  for (const file of entries) {
    const bytes = blobs.get(file.blob);
    if (bytes === undefined) throw new Error("Committed source capture omitted a tracked blob.");
    const pin = committedSnapshotFile(file.blob, bytes);
    total += pin.length;
    if (total > 2 * 1024 ** 3) throw new Error("Tracked source snapshot exceeds the 2 GiB bound.");
    files.set(file.path, bytes);
    pins.push({ ...file, ...pin });
  }
  for (const [path, hash] of Object.entries(lock.files))
    if (!files.has(path) || sha256(files.get(path)!) !== hash)
      throw new Error(`Approved source pin differs from exact commit blob bytes: ${path}.`);
  if (
    (await git("rev-parse", "HEAD")) !== commit ||
    (await git("ls-files", "--stage", "-z")) !== index ||
    (await git("status", "--porcelain", "--untracked-files=all"))
  )
    throw new Error("Source/index changed during snapshot capture.");
  const bundle = hostRoot(request.bundleRoot);
  for (const other of [preparation.sourceRoot, preparation.toolchainRoot, preparation.buildRoot]) {
    const normalized = hostRoot(other);
    if (
      bundle === normalized ||
      bundle.startsWith(normalized + "\\") ||
      normalized.startsWith(bundle + "\\")
    )
      throw new Error("Sandbox bundle must be separate from source, tools and output.");
  }
  await assertValidationRoot(NodePath.dirname(request.bundleRoot));
  await NodeFSP.mkdir(request.bundleRoot);
  const snapshotBytes = encode({
    schemaVersion: 1,
    sourceCommit: commit,
    sourceDateEpoch: epoch,
    exclusions: partitionTrackedSourceEntries(index).exclusions,
    files: pins,
  });
  const guestRequest = {
    schemaVersion: 1,
    preparationRequestSha256: request.preparationRequestSha256,
    executionRequestSha256: request.executionRequestSha256,
    guestRunnerSha256: request.guestRunnerSha256,
    snapshotSha256: sha256(snapshotBytes),
    buildLockSha256: preparation.buildLockSha256,
    identitySha256: preparation.identitySha256,
    toolchainManifestSha256: preparation.toolchainManifestSha256,
  };
  const guestBytes = encode(guestRequest);
  const sourceRoot = NodePath.join(request.bundleRoot, "source"),
    inputsRoot = NodePath.join(request.bundleRoot, "inputs");
  await writeNewSnapshotTree(sourceRoot, files);
  await writeNewSnapshotTree(
    inputsRoot,
    new Map([
      ["preparation-request.json", preparationBytes],
      ["execution-request.json", executionBytes],
      ["build-lock.json", lockBytes],
      ["identity.json", identityBytes],
      ["toolchain-manifest.json", toolchainBytes],
      ["snapshot.json", snapshotBytes],
      ["guest-request.json", guestBytes],
      ["guest-runner.mjs", runnerBytes],
    ]),
  );
  if ((await NodeFSP.readdir(preparation.buildRoot)).length)
    throw new Error("Sandbox output is no longer empty; it was not modified.");
  const configuration = renderWindowsSandboxConfiguration({
    sourceRoot,
    inputsRoot,
    toolchainRoot: preparation.toolchainRoot,
    outputRoot: preparation.buildRoot,
    nodeRelativePath: execution.tools.node,
    nodeSha256: lock.tools.node.sha256,
    guestRequestSha256: sha256(guestBytes),
    guestRunnerSha256: request.guestRunnerSha256,
  });
  const configurationPath = NodePath.join(request.bundleRoot, "build.wsb");
  const output = await NodeFSP.open(configurationPath, "wx", 0o600);
  try {
    await output.writeFile(configuration);
    await output.sync();
  } finally {
    await output.close();
  }
  if (
    sha256(await readValidationFile(configurationPath, 65536)) !==
    sha256(Buffer.from(configuration))
  )
    throw new Error("Sandbox configuration changed after creation.");
  return {
    schemaVersion: 1,
    prepared: true,
    launched: false,
    buildAuthorized: false,
    configurationPath,
    configurationSha256: sha256(Buffer.from(configuration)),
    guestRequestSha256: sha256(guestBytes),
    snapshotSha256: sha256(snapshotBytes),
    sourceFiles: files.size,
    actualSandboxAcceptance: "not-run",
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--request" ||
    args[2] !== "--approved-request-sha256" ||
    !args[1] ||
    !args[3]
  )
    throw new Error(
      "Supply --request ABSOLUTE_JSON --approved-request-sha256 REVIEWED_SHA256; this prepares files only and never launches Sandbox.",
    );
  console.log(JSON.stringify(await prepareWindowsSandbox(args[1], args[3]), null, 2));
}
