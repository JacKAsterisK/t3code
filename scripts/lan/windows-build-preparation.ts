// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Read-only verification of supplied public inputs; no build tools, lifecycle scripts or installers are launched.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { parseLanBuildIdentity } from "@t3tools/shared/distribution";
import { BUILD_INPUT_FILES, BuildLock, sha256 } from "./hub-distribution.ts";
import { LAN_STAGE_LOCK_FILES, readLanPackagingInputs } from "./lan-packaging.ts";
import {
  relativeWindowsPath,
  strictJson,
  ToolchainManifest,
  TOOLCHAIN_LIMITS,
} from "./windows-artifact.ts";
import { inspectSourceGit, partitionTrackedSourceEntries } from "./source-git.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const toolNames = ["node", "pnpm", "rust", "msvc", "windowsSdk", "nsis"] as const;
const ToolFiles = Schema.Struct({
  node: Schema.String,
  pnpm: Schema.String,
  rust: Schema.String,
  msvc: Schema.String,
  windowsSdk: Schema.String,
  nsis: Schema.String,
});
export const WindowsBuildPreparationRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceRoot: Schema.String,
  buildRoot: Schema.String,
  toolchainRoot: Schema.String,
  buildLockPath: Schema.String,
  buildLockSha256: Hash,
  identityPath: Schema.String,
  identitySha256: Hash,
  toolchainManifestPath: Schema.String,
  toolchainManifestSha256: Hash,
  toolFiles: ToolFiles,
});
export type WindowsBuildPreparationRequest = typeof WindowsBuildPreparationRequest.Type;
const decodeRequest = Schema.decodeUnknownSync(WindowsBuildPreparationRequest);
const decodeLock = Schema.decodeUnknownSync(BuildLock);
const decodeToolchain = Schema.decodeUnknownSync(ToolchainManifest);

// Matching a supplied inventory proves its bytes, not that a later subprocess
// uses those bytes or that native lifecycle scripts cannot fetch dependencies.
export const LAN_WINDOWS_EXECUTION_BLOCKERS = Object.freeze([
  "Read-only preparation does not execute a build; the selected native-directory or Windows Sandbox runner requires reviewed source, execution, tool/cache and runner inputs.",
  "Actual offline/native lifecycle acceptance and two independent pinned builds remain required; fixture tests and an inventory alone do not prove execution or OS/network isolation.",
]);

export function nativeBuildRoot(value: string): string {
  if (
    !/^[a-z]:[\\/].+/iu.test(value) ||
    NodePath.win32.normalize(value).replaceAll("/", "\\").replace(/\\$/u, "") !==
      value.replaceAll("/", "\\").replace(/\\$/u, "") ||
    value
      .split(/[\\/]/u)
      .some((part) =>
        [
          ".t3",
          ".codex",
          "codex",
          "cache",
          ".cache",
          "codex-runtimes",
          "packages",
          "localcache",
          "t3codelan",
        ].includes(part.toLowerCase()),
      )
  )
    throw new Error(
      "Build roots require independent canonical native Windows directories outside installed T3 homes and caches.",
    );
  return value.replaceAll("/", "\\").replace(/\\$/u, "").toLowerCase();
}

function separateRoots(request: WindowsBuildPreparationRequest) {
  const roots = [request.sourceRoot, request.buildRoot, request.toolchainRoot].map(nativeBuildRoot);
  for (let at = 0; at < roots.length; at++)
    for (let other = at + 1; other < roots.length; other++)
      if (
        roots[at] === roots[other] ||
        roots[at]!.startsWith(`${roots[other]}\\`) ||
        roots[other]!.startsWith(`${roots[at]}\\`)
      )
        throw new Error(
          "Source, build and toolchain roots must be separate nonoverlapping directories.",
        );
}

const manifestObject = (bytes: Uint8Array | undefined) => {
  if (bytes === undefined) throw new Error("A required source manifest is absent.");
  const value = strictJson(bytes);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("A source manifest is not an object.");
  return value as Record<string, unknown>;
};

export function verifyWindowsPreparationEvidence(input: {
  readonly request: WindowsBuildPreparationRequest;
  readonly lockBytes: Uint8Array;
  readonly identityBytes: Uint8Array;
  readonly toolchainManifestBytes: Uint8Array;
  readonly source: {
    readonly commit: string;
    readonly clean: boolean;
    readonly upstreamAncestor: boolean;
    readonly files: ReadonlyMap<string, Uint8Array>;
  };
  readonly toolchainFiles: ReadonlyMap<
    string,
    { readonly length: number; readonly sha256: string }
  >;
}) {
  const { request } = input;
  separateRoots(request);
  if (
    sha256(input.lockBytes) !== request.buildLockSha256 ||
    sha256(input.identityBytes) !== request.identitySha256 ||
    sha256(input.toolchainManifestBytes) !== request.toolchainManifestSha256
  )
    throw new Error(
      "Supplied build inputs differ from the separately reviewed preparation request.",
    );
  const lock = decodeLock(strictJson(input.lockBytes), { onExcessProperty: "error" });
  const identity = parseLanBuildIdentity(strictJson(input.identityBytes));
  if (
    !input.source.clean ||
    !input.source.upstreamAncestor ||
    input.source.commit !== lock.forkCommit ||
    identity.sourceCommit !== lock.forkCommit ||
    identity.applicationVersion !== lock.applicationVersion ||
    lock.wslRuntime !== null
  )
    throw new Error(
      "Preparation requires clean full-commit source, approved upstream ancestry and aligned LAN identity/version without WSL.",
    );
  for (const name of new Set([
    ...BUILD_INPUT_FILES,
    ...Object.values(LAN_STAGE_LOCK_FILES),
    ...Object.keys(lock.files),
  ])) {
    relativeWindowsPath(name);
    const bytes = input.source.files.get(name);
    if (!lock.files[name] || bytes === undefined || sha256(bytes) !== lock.files[name])
      throw new Error(`Approved source input differs or is missing: ${name}.`);
  }
  const rootPackage = manifestObject(input.source.files.get("package.json"));
  const rootEngines = rootPackage.engines;
  if (
    typeof rootEngines !== "object" ||
    rootEngines === null ||
    !("node" in rootEngines) ||
    rootEngines.node !== lock.tools.node.version ||
    rootPackage.packageManager !== `pnpm@${lock.tools.pnpm.version}`
  )
    throw new Error("Approved Node/pnpm versions differ from source pins.");
  for (const name of [
    "apps/desktop/package.json",
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ])
    if (manifestObject(input.source.files.get(name)).version !== lock.applicationVersion)
      throw new Error("Align release package versions before freezing source/build inputs.");
  readLanPackagingInputs(
    { path: request.identityPath, sha256: request.identitySha256, identity },
    request.buildLockPath,
    request.sourceRoot,
    (file) => {
      if (NodePath.resolve(file) === NodePath.resolve(request.buildLockPath))
        return input.lockBytes;
      const bytes = input.source.files.get(
        NodePath.relative(request.sourceRoot, file).replaceAll("\\", "/"),
      );
      if (bytes === undefined) throw new Error("Preparation source snapshot is incomplete.");
      return bytes;
    },
  );
  const inventory = decodeToolchain(strictJson(input.toolchainManifestBytes), {
    onExcessProperty: "error",
  });
  if (
    !inventory.files.length ||
    inventory.files.length > TOOLCHAIN_LIMITS.files ||
    inventory.files.length !== input.toolchainFiles.size
  )
    throw new Error("The supplied toolchain closure is incomplete or contains extra files.");
  const names = new Set<string>();
  for (const pin of inventory.files) {
    relativeWindowsPath(pin.path);
    const actual = input.toolchainFiles.get(pin.path);
    if (
      names.has(pin.path.toLowerCase()) ||
      pin.length < 0 ||
      actual?.length !== pin.length ||
      actual.sha256 !== pin.sha256
    )
      throw new Error(`Toolchain inventory differs: ${pin.path}.`);
    names.add(pin.path.toLowerCase());
  }
  const tools = Object.fromEntries(
    toolNames.map((name) => {
      const file = relativeWindowsPath(request.toolFiles[name]);
      if (
        !/^\d+\.\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?$/iu.test(lock.tools[name].version) ||
        input.toolchainFiles.get(file)?.sha256 !== lock.tools[name].sha256
      )
        throw new Error(`Primary tool pin differs: ${name}.`);
      return [
        name,
        { path: NodePath.win32.join(request.toolchainRoot, file), ...lock.tools[name] },
      ];
    }),
  );
  return {
    schemaVersion: 1 as const,
    mode: "read-only" as const,
    inputsVerified: true as const,
    sourceCommit: lock.forkCommit,
    upstreamCommit: lock.upstreamCommit,
    applicationVersion: lock.applicationVersion,
    distributionVersion: lock.distributionVersion,
    sourceFilesVerified: input.source.files.size,
    toolchainFilesVerified: input.toolchainFiles.size,
    productionStageLocksVerified: true as const,
    pinnedPackageManagerAcceptance: "pending" as const,
    tools,
    buildAuthorized: false as const,
    distributionAuthorized: false as const,
    executionSupported: false as const,
    executionBackends: ["windows-native-directory", "windows-sandbox"] as const,
    nativeExecutionVerified: false as const,
    blockers: [...LAN_WINDOWS_EXECUTION_BLOCKERS],
  };
}

export async function preparePinnedWindowsBuild(
  requestPath: string,
  approvedRequestSha256: string,
) {
  // eslint-disable-next-line t3code/no-global-process-runtime -- This read-only CLI boundary requires native Windows path and filesystem semantics.
  if (process.platform !== "win32") throw new Error("Preparation requires native Windows.");
  if (!/^[a-f0-9]{64}$/u.test(approvedRequestSha256))
    throw new Error("Supply the separately reviewed preparation request SHA-256.");
  const requestBytes = await readValidationFile(requestPath, 1024 * 1024);
  if (sha256(requestBytes) !== approvedRequestSha256)
    throw new Error("Preparation request differs from the separately reviewed bytes.");
  const request = decodeRequest(strictJson(requestBytes), { onExcessProperty: "error" });
  separateRoots(request);
  for (const root of [request.sourceRoot, request.buildRoot, request.toolchainRoot])
    await assertValidationRoot(root);
  if ((await NodeFSP.readdir(request.buildRoot)).length)
    throw new Error("The supplied build workspace must be empty; preparation never cleans it.");
  const lockBytes = await readValidationFile(request.buildLockPath, 1024 * 1024);
  const identityBytes = await readValidationFile(request.identityPath, 65536);
  const toolchainManifestBytes = await readValidationFile(
    request.toolchainManifestPath,
    TOOLCHAIN_LIMITS.manifestBytes,
  );
  const lock = decodeLock(strictJson(lockBytes), { onExcessProperty: "error" });
  const sourceFiles = new Map<string, Uint8Array>();
  for (const name of new Set([
    ...BUILD_INPUT_FILES,
    ...Object.values(LAN_STAGE_LOCK_FILES),
    ...Object.keys(lock.files),
  ]))
    sourceFiles.set(
      name,
      await readValidationFile(
        NodePath.join(request.sourceRoot, relativeWindowsPath(name)),
        32 * 1024 * 1024,
      ),
    );
  const git = (...args: string[]) => inspectSourceGit(request.sourceRoot, args);
  const selection = partitionTrackedSourceEntries(await git("ls-files", "--stage", "-z"));
  for (const entry of selection.exclusions)
    if (
      Object.hasOwn(lock.files, entry.path) ||
      BUILD_INPUT_FILES.some((name) => name === entry.path)
    )
      throw new Error("A required build input cannot be excluded from the source snapshot.");
  let upstreamAncestor = true;
  try {
    await git("merge-base", "--is-ancestor", lock.upstreamCommit, lock.forkCommit);
  } catch {
    upstreamAncestor = false;
  }
  const result = verifyWindowsPreparationEvidence({
    request,
    lockBytes,
    identityBytes,
    toolchainManifestBytes,
    source: {
      commit: await git("rev-parse", "HEAD"),
      clean: !(await git("status", "--porcelain", "--untracked-files=all")),
      upstreamAncestor,
      files: sourceFiles,
    },
    toolchainFiles: await inspectValidationTree(request.toolchainRoot, true),
  });
  const currentNode = await readValidationFile(process.execPath, 256 * 1024 * 1024);
  return {
    ...result,
    preparationRequestSha256: approvedRequestSha256,
    preparationNodeMatches:
      process.versions.node === lock.tools.node.version &&
      sha256(currentNode) === lock.tools.node.sha256,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          inputsVerified: false,
          executionSupported: false,
          executionBackends: ["windows-native-directory", "windows-sandbox"],
          nativeExecutionVerified: false,
          buildAuthorized: false,
          distributionAuthorized: false,
          blockers: [
            "No separately reviewed preparation request, frozen source, production stage locks or verified toolchain closure was supplied.",
            ...LAN_WINDOWS_EXECUTION_BLOCKERS,
          ],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    if (
      args.length !== 4 ||
      args[0] !== "--request" ||
      args[2] !== "--approved-request-sha256" ||
      !args[1] ||
      !args[3]
    )
      throw new Error(
        "Supply --request ABSOLUTE_JSON --approved-request-sha256 REVIEWED_SHA256; preparation only reads local inputs.",
      );
    console.log(JSON.stringify(await preparePinnedWindowsBuild(args[1], args[3]), null, 2));
  }
}
