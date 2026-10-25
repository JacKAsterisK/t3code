// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Builds only in a new independent directory using pinned tools; this ordinary Windows process does not enforce OS/network isolation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import { buildInventoryCounts, measureBuildStage } from "./build-metrics.ts";
import {
  inspectSourceGit,
  partitionTrackedSourceEntries,
  readCommittedSourceBlobs,
} from "./source-git.ts";
import { relativeWindowsPath, strictJson, TOOLCHAIN_LIMITS } from "./windows-artifact.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";
import {
  capturePinnedWindowsBuildPreparation,
  WindowsBuildPreparationRequest,
  verifyWindowsPreparationEvidence,
} from "./windows-build-preparation.ts";
import {
  asChildProcess,
  createWindowsBuildExecution,
  WindowsBuildExecutionRequest,
  PinnedWorkspaceInstallRefused,
} from "./windows-build-execution.ts";
import {
  committedSnapshotFile,
  parseTrackedSourceEntries,
  SourceSnapshot,
  writeNewSnapshotTree,
} from "./prepare-windows-sandbox.ts";
import {
  establishWindowsNativeContext,
  verifyWindowsNativeContextFacts,
  type WindowsNativeBinding,
} from "./windows-native-context.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const WindowsNativeBuildRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  preparationRequestPath: Schema.String,
  preparationRequestSha256: Hash,
  executionRequestPath: Schema.String,
  executionRequestSha256: Hash,
  runnerSha256: Hash,
  inputsRoot: Schema.String,
});
export type WindowsNativeBuildRequest = typeof WindowsNativeBuildRequest.Type;
const decodeNative = Schema.decodeUnknownSync(WindowsNativeBuildRequest, {
  onExcessProperty: "error",
});
const decodePreparation = Schema.decodeUnknownSync(WindowsBuildPreparationRequest, {
  onExcessProperty: "error",
});
const decodeExecution = Schema.decodeUnknownSync(WindowsBuildExecutionRequest, {
  onExcessProperty: "error",
});
const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });
const decodeSnapshot = Schema.decodeUnknownSync(SourceSnapshot, { onExcessProperty: "error" });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

export function requireNativeBuildInput(bytes: Uint8Array, digest: string, label: string) {
  if (!/^[a-f0-9]{64}$/u.test(digest) || sha256(bytes) !== digest)
    throw new Error(`Approved native ${label} bytes changed.`);
  return bytes;
}

export async function verifyNativeSnapshotFiles(
  sourceRoot: string,
  pins: ReadonlyArray<Pick<SourceSnapshot["files"][number], "path" | "length" | "sha256">>,
  readFile = readValidationFile,
) {
  for (const pin of pins) {
    relativeWindowsPath(pin.path);
    if (!Number.isSafeInteger(pin.length) || pin.length < 0 || pin.length > 256 * 1024 ** 2)
      throw new Error("Native source snapshot has an invalid or oversized file pin.");
  }
  const batch: Array<(typeof pins)[number]> = [];
  let batchBytes = 0;
  const flush = async () => {
    // Finish all reads before reporting a failure, preserving the failed build for inspection.
    const settled = await Promise.allSettled(
      batch.splice(0).map(async (pin) => {
        const bytes = await readFile(NodePath.join(sourceRoot, pin.path), pin.length);
        if (bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
          throw new Error("Native working source changed before a build subprocess.");
      }),
    );
    batchBytes = 0;
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length) throw failures[0]!.reason;
  };
  for (const pin of pins) {
    if (batch.length && (batch.length === 32 || batchBytes + pin.length > 32 * 1024 ** 2))
      await flush();
    batch.push(pin);
    batchBytes += pin.length;
  }
  await flush();
}

export async function copyNativePinnedCache(
  sourceRoot: string,
  outputRoot: string,
  pins: ReadonlyMap<string, { readonly length: number; readonly sha256: string }>,
) {
  if (!pins.size) throw new Error("An approved native cache is empty.");
  await assertValidationRoot(NodePath.dirname(outputRoot));
  await NodeFSP.mkdir(outputRoot);
  const directories = new Map<string, { readonly dev: number; readonly ino: number }>();
  const register = async (root: string) => {
    const stat = await NodeFSP.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Native cache parent changed.");
    directories.set(root, { dev: stat.dev, ino: stat.ino });
  };
  await register(outputRoot);
  const files: Array<{
    relative: string;
    parent: string;
    pin: { readonly length: number; readonly sha256: string };
  }> = [];
  for (const [relative, pin] of [...pins].sort(([left], [right]) => (left < right ? -1 : 1))) {
    relativeWindowsPath(relative);
    if (!Number.isSafeInteger(pin.length) || pin.length < 0 || pin.length > 256 * 1024 ** 2)
      throw new Error("Native offline cache has an invalid or oversized file pin.");
    let parent = outputRoot;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = NodePath.join(parent, part);
      if (!directories.has(parent)) {
        await NodeFSP.mkdir(parent);
        await register(parent);
      }
    }
    files.push({ relative, parent, pin });
  }
  const batch: typeof files = [];
  let batchBytes = 0;
  const flush = async () => {
    // Bound both handles and retained bytes, and finish every write before
    // returning an error so callers can safely preserve a failed build directory.
    const settled = await Promise.allSettled(
      batch.splice(0).map(async ({ relative, parent, pin }) => {
        if (!NodePath.isAbsolute(parent) || NodePath.resolve(parent) !== parent)
          throw new Error("Native cache output parent must be canonical and absolute.");
        let withinOutput = true;
        // Check each ancestor once, combining the link check with the captured
        // output-directory identity check. No path evidence survives this file.
        for (let at = parent; ; at = NodePath.dirname(at)) {
          const actual = await NodeFSP.lstat(at);
          if (!actual.isDirectory() || actual.isSymbolicLink())
            throw new Error("Native cache output parent changed.");
          if (withinOutput) {
            const expected = directories.get(at);
            if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino)
              throw new Error("Native cache output parent changed.");
            if (at === outputRoot) withinOutput = false;
          }
          if (NodePath.dirname(at) === at) break;
        }
        const bytes = await readValidationFile(NodePath.join(sourceRoot, relative), pin.length);
        if (bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
          throw new Error("Native offline cache changed during copy.");
        const output = await NodeFSP.open(NodePath.join(outputRoot, relative), "wx", 0o600);
        try {
          await output.writeFile(bytes);
        } finally {
          await output.close();
        }
      }),
    );
    batchBytes = 0;
    for (const item of settled) if (item.status === "rejected") throw item.reason;
  };
  for (const file of files) {
    if (batch.length && (batch.length === 32 || batchBytes + file.pin.length > 32 * 1024 ** 2))
      await flush();
    batch.push(file);
    batchBytes += file.pin.length;
  }
  await flush();
  const copied = await inspectValidationTree(outputRoot, true);
  if (
    copied.size !== pins.size ||
    [...pins].some(
      ([name, pin]) =>
        copied.get(name)?.length !== pin.length || copied.get(name)?.sha256 !== pin.sha256,
    )
  )
    throw new Error("Copied native cache differs from its approved inventory.");
}

export async function prepareNativePnpmMetadata(
  sourceRoot: string,
  outputRoot: string,
  pins: ReadonlyMap<string, { readonly length: number; readonly sha256: string }>,
) {
  const memo = pins.get("lockfile-verified.jsonl");
  const versions = new Set<string>();
  for (const relative of pins.keys()) {
    relativeWindowsPath(relative);
    if (relative === "lockfile-verified.jsonl") continue;
    const version = relative.split("/")[0]!;
    if (!relative.includes("/") || !/^v[1-9]\d*$/u.test(version))
      throw new Error("Unreviewed pnpm metadata layout.");
    versions.add(version);
  }
  if (!memo || !versions.size) throw new Error("Pinned pnpm policy metadata is incomplete.");
  await assertValidationRoot(sourceRoot);
  // This file is mutable even with frozen-store. Versioned registry records are
  // read offline; their complete pinned inventory still brackets every build.
  await copyNativePinnedCache(sourceRoot, outputRoot, new Map([["lockfile-verified.jsonl", memo]]));
  const links: Array<{ source: string; target: string; dev: number; ino: number }> = [];
  for (const version of versions) {
    const source = NodePath.join(sourceRoot, version),
      target = NodePath.join(outputRoot, version);
    await assertValidationRoot(source);
    await NodeFSP.symlink(source, target, "junction");
    const stat = await NodeFSP.lstat(target);
    links.push({ source, target, dev: stat.dev, ino: stat.ino });
  }
  const verify = async () => {
    await assertValidationRoot(outputRoot);
    for (const link of links) {
      const stat = await NodeFSP.lstat(link.target);
      await assertValidationRoot(link.source);
      if (
        !stat.isSymbolicLink() ||
        stat.dev !== link.dev ||
        stat.ino !== link.ino ||
        (await NodeFSP.realpath(link.target)) !== link.source
      )
        throw new Error("Native pnpm metadata mapping changed.");
    }
  };
  await verify();
  return verify;
}

export async function captureNativeBuildSource(
  sourceRoot: string,
  lock: BuildLock,
  sourceDateEpoch: number,
) {
  const git = (...args: string[]) => inspectSourceGit(sourceRoot, args);
  const commit = await git("rev-parse", "HEAD");
  const epoch = Number(await git("show", "-s", "--format=%ct", "HEAD"));
  if (
    commit !== lock.forkCommit ||
    !Number.isSafeInteger(epoch) ||
    epoch !== sourceDateEpoch ||
    (await git("status", "--porcelain", "--untracked-files=all"))
  )
    throw new Error("Native build requires the approved clean source commit and commit epoch.");
  const index = await git("ls-files", "--stage", "-z");
  const entries = parseTrackedSourceEntries(index);
  const blobs = await readCommittedSourceBlobs(
    sourceRoot,
    entries.map((entry) => entry.blob),
  );
  const files = new Map<string, Uint8Array>();
  const pins: SourceSnapshot["files"][number][] = [];
  let total = 0;
  for (const entry of entries) {
    const bytes = blobs.get(entry.blob);
    if (bytes === undefined) throw new Error("Native source capture omitted a committed blob.");
    const pin = committedSnapshotFile(entry.blob, bytes);
    total += pin.length;
    if (total > 2 * 1024 ** 3) throw new Error("Native tracked source exceeds the 2 GiB bound.");
    files.set(entry.path, bytes);
    pins.push({ ...entry, ...pin });
  }
  for (const [path, hash] of Object.entries(lock.files))
    if (!files.has(path) || sha256(files.get(path)!) !== hash)
      throw new Error(`Native source pin differs from committed bytes: ${path}.`);
  if (
    (await git("rev-parse", "HEAD")) !== commit ||
    (await git("ls-files", "--stage", "-z")) !== index ||
    (await git("status", "--porcelain", "--untracked-files=all"))
  )
    throw new Error("Native source/index changed during capture.");
  const snapshot = decodeSnapshot({
    schemaVersion: 1,
    sourceCommit: commit,
    sourceDateEpoch: epoch,
    exclusions: partitionTrackedSourceEntries(index).exclusions,
    files: pins,
  });
  return { files, snapshot, snapshotBytes: encode(snapshot) };
}

export async function runWorkingNativeWindowsBuild(input: {
  readonly sourceRoot: string;
  readonly binding: WindowsNativeBinding;
  readonly factoryInput: Omit<Parameters<typeof createWindowsBuildExecution>[0], "isolation">;
  readonly policyPath: string;
  readonly buildLockPath: string;
}) {
  const sourceModule = (relative: string) =>
    NodeURL.pathToFileURL(NodePath.join(input.sourceRoot, relative)).href;
  const contextModule = (await import(
    /* @vite-ignore */ sourceModule("scripts/lan/windows-native-context.ts")
  )) as typeof import("./windows-native-context.ts");
  const executionModule = (await import(
    /* @vite-ignore */ sourceModule("scripts/lan/windows-build-execution.ts")
  )) as typeof import("./windows-build-execution.ts");
  const execution = executionModule.createWindowsBuildExecution({
    ...input.factoryInput,
    isolation: await contextModule.establishWindowsNativeContext(input.binding),
  });
  const { runIsolatedWindowsDesktopBuild } = (await import(
    /* @vite-ignore */ sourceModule("scripts/build-desktop-artifact.ts")
  )) as Pick<typeof import("../build-desktop-artifact.ts"), "runIsolatedWindowsDesktopBuild">;
  return Effect.runPromise(
    runIsolatedWindowsDesktopBuild(execution, {
      policyPath: input.policyPath,
      buildLockPath: input.buildLockPath,
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

export async function runWindowsNativeBuild(requestPath: string, approvedRequestSha256: string) {
  // eslint-disable-next-line t3code/no-global-process-runtime -- The execution boundary checks the actual OS, not a supplied environment assertion.
  if (NodeOS.platform() !== "win32")
    throw new Error("Native-directory build execution requires Windows.");
  const requestBytes = requireNativeBuildInput(
    await readValidationFile(requestPath, 65536),
    approvedRequestSha256,
    "request",
  );
  const request = decodeNative(strictJson(requestBytes));
  if (!NodeURL.fileURLToPath(import.meta.url).endsWith(".mjs"))
    throw new Error(
      "Execute the separately reviewed self-contained native runner bundle, not a dependency-loading source entry.",
    );
  requireNativeBuildInput(
    await readValidationFile(NodeURL.fileURLToPath(import.meta.url), 64 * 1024 ** 2),
    request.runnerSha256,
    "runner",
  );
  console.log("[native-build] Verifying frozen source and full pinned toolchain inventory.");
  // Reuse the evidence just verified in this invocation; all source, ancestry,
  // path and pin checks remain in preparation, with full inventories still
  // checked again around lifecycle installation and the application build.
  const { toolchainFiles } = await measureBuildStage(
    "native.preparation",
    () =>
      capturePinnedWindowsBuildPreparation(
        request.preparationRequestPath,
        request.preparationRequestSha256,
      ),
    ({ toolchainFiles }) => buildInventoryCounts(toolchainFiles.values()),
  );
  const preparationBytes = requireNativeBuildInput(
    await readValidationFile(request.preparationRequestPath, 1024 * 1024),
    request.preparationRequestSha256,
    "preparation",
  );
  const preparation = decodePreparation(strictJson(preparationBytes));
  const executionBytes = requireNativeBuildInput(
    await readValidationFile(request.executionRequestPath, 1024 * 1024),
    request.executionRequestSha256,
    "execution",
  );
  const execution = decodeExecution(strictJson(executionBytes));
  const lockBytes = requireNativeBuildInput(
    await readValidationFile(preparation.buildLockPath, 1024 * 1024),
    preparation.buildLockSha256,
    "build lock",
  );
  const identityBytes = requireNativeBuildInput(
    await readValidationFile(preparation.identityPath, 65536),
    preparation.identitySha256,
    "identity",
  );
  const toolchainManifestBytes = requireNativeBuildInput(
    await readValidationFile(preparation.toolchainManifestPath, TOOLCHAIN_LIMITS.manifestBytes),
    preparation.toolchainManifestSha256,
    "toolchain inventory",
  );
  if (
    execution.buildLockSha256 !== preparation.buildLockSha256 ||
    execution.identitySha256 !== preparation.identitySha256 ||
    execution.toolchainManifestSha256 !== preparation.toolchainManifestSha256 ||
    execution.tools.node !== preparation.toolFiles.node
  )
    throw new Error("Native execution and preparation select different pinned inputs.");
  const lock = decodeLock(strictJson(lockBytes));
  if (
    process.versions.node !== lock.tools.node.version ||
    sha256(await readValidationFile(process.execPath, 256 * 1024 ** 2)) !== lock.tools.node.sha256
  )
    throw new Error("Native runner requires the exact approved Node executable/version.");
  const { files, snapshot, snapshotBytes } = await measureBuildStage(
    "native.source-capture",
    () => captureNativeBuildSource(preparation.sourceRoot, lock, execution.sourceDateEpoch),
    ({ snapshot }) => buildInventoryCounts(snapshot.files),
  );
  console.log("[native-build] Verified toolchain files: " + toolchainFiles.size);
  verifyWindowsPreparationEvidence({
    request: preparation,
    lockBytes,
    identityBytes,
    toolchainManifestBytes,
    source: { commit: snapshot.sourceCommit, clean: true, upstreamAncestor: true, files },
    toolchainFiles,
  });
  const binding: WindowsNativeBinding = {
    mappedSourceRoot: preparation.sourceRoot,
    outputRoot: preparation.buildRoot,
    inputsRoot: request.inputsRoot,
    toolchainRoot: preparation.toolchainRoot,
    sourceCommit: snapshot.sourceCommit,
    snapshotSha256: sha256(snapshotBytes),
    preparationRequestSha256: request.preparationRequestSha256,
  };
  const context = await establishWindowsNativeContext(binding);
  if ((await NodeFSP.readdir(context.outputRoot)).length)
    throw new Error("Native output contains existing work and is never cleaned.");
  await assertValidationRoot(NodePath.dirname(context.inputsRoot));
  try {
    await NodeFSP.lstat(context.inputsRoot);
    throw new Error("Native input snapshot already exists and is never overwritten.");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const lockPath = NodePath.join(context.outputRoot, ".native-build.lock");
  const ownership = await NodeFSP.open(lockPath, "wx", 0o600);
  const ownerIdentity = await ownership.stat();
  try {
    const inputFiles = new Map<string, Uint8Array>([
      ["native-request.json", requestBytes],
      ["preparation-request.json", preparationBytes],
      ["execution-request.json", executionBytes],
      ["build-lock.json", lockBytes],
      ["identity.json", identityBytes],
      ["toolchain-manifest.json", toolchainManifestBytes],
      ["snapshot.json", snapshotBytes],
    ]);
    await measureBuildStage(
      "native.input-snapshot",
      () => writeNewSnapshotTree(context.inputsRoot, inputFiles),
      () =>
        buildInventoryCounts([...inputFiles.values()].map((bytes) => ({ length: bytes.length }))),
    );
    await NodeFSP.mkdir(NodePath.dirname(context.sourceRoot));
    await measureBuildStage(
      "native.source-snapshot",
      () => writeNewSnapshotTree(context.sourceRoot, files),
      () => buildInventoryCounts(snapshot.files),
    );
    for (const name of ["temp", "home", "home/roaming", "home/local", "caches"])
      await NodeFSP.mkdir(NodePath.join(context.outputRoot, name));
    for (const name of ["empty.npmrc", "empty-global.npmrc"])
      await NodeFSP.writeFile(NodePath.join(context.outputRoot, name), "", {
        flag: "wx",
        mode: 0o600,
      });
    let verifyPnpmMetadata: (() => Promise<void>) | undefined;
    for (const name of ["pnpmStore", "cargoHome", "electronCache", "builderCache"] as const) {
      const prefix = relativeWindowsPath(execution.directories[name]) + "/";
      const pins = new Map(
        [...toolchainFiles]
          .filter(([relative]) => relative.startsWith(prefix))
          .map(([relative, pin]) => [relative.slice(prefix.length), pin]),
      );
      if (name === "pnpmStore") {
        if (!pins.size) throw new Error("The pinned pnpm store is empty.");
        console.log(
          "[native-build] Reusing pinned pnpm store with frozen-store and independent copy imports.",
        );
        await measureBuildStage(
          "native.cache-reuse.pnpmStore",
          () =>
            assertValidationRoot(
              NodePath.join(context.toolchainRoot, execution.directories.pnpmStore),
            ),
          () => buildInventoryCounts(pins.values()),
        );
        const metadataPrefix = prefix + "metadata-cache/";
        const metadataPins = new Map(
          [...toolchainFiles]
            .filter(([relative]) => relative.startsWith(metadataPrefix))
            .map(([relative, pin]) => [relative.slice(metadataPrefix.length), pin]),
        );
        verifyPnpmMetadata = await measureBuildStage("native.pnpm-metadata", () =>
          prepareNativePnpmMetadata(
            NodePath.join(context.toolchainRoot, metadataPrefix),
            NodePath.join(context.outputRoot, "caches", "pnpmMetadata"),
            metadataPins,
          ),
        );
        continue;
      }
      console.log("[native-build] Copying exact pinned mutable cache: " + name);
      await measureBuildStage(
        `native.cache-copy.${name}`,
        () =>
          copyNativePinnedCache(
            NodePath.join(context.toolchainRoot, prefix),
            NodePath.join(context.outputRoot, "caches", name),
            pins,
          ),
        () => buildInventoryCounts(pins.values()),
      );
    }
    const verifyUnchanged = async () => {
      if (!verifyPnpmMetadata) throw new Error("Native pnpm metadata was not prepared.");
      await verifyPnpmMetadata();
      await verifyWindowsNativeContextFacts(context);
      const actualInputs = await inspectValidationTree(context.inputsRoot, true);
      if (
        actualInputs.size !== inputFiles.size ||
        [...inputFiles].some(([name, bytes]) => actualInputs.get(name)?.sha256 !== sha256(bytes))
      )
        throw new Error("Native input snapshot changed before a build subprocess.");
    };
    // Ordinary processes do not make DLL/dependency closures immutable. Full inventories
    // bracket lifecycle installation and the build; selected tools are hashed per child.
    const verifyInventories = async (boundary: string) => {
      await verifyUnchanged();
      await measureBuildStage(
        `native.toolchain-inventory.${boundary}`,
        async () => {
          const actualTools = await inspectValidationTree(context.toolchainRoot, true);
          if (
            actualTools.size !== toolchainFiles.size ||
            [...toolchainFiles].some(([name, pin]) => actualTools.get(name)?.sha256 !== pin.sha256)
          )
            throw new Error("Native toolchain changed at a build boundary.");
          return actualTools;
        },
        (files) => buildInventoryCounts(files.values()),
      );
      await measureBuildStage(
        `native.source-inventory.${boundary}`,
        () => verifyNativeSnapshotFiles(context.sourceRoot, snapshot.files),
        () => buildInventoryCounts(snapshot.files),
      );
    };
    const header = async (name: string) => {
      const relative = `${relativeWindowsPath(execution.directories.nodeHeaders)}/include/node/${name}`;
      const bytes = await readValidationFile(
        NodePath.join(context.toolchainRoot, relative),
        1024 * 1024,
      );
      const pin = toolchainFiles.get(relative);
      if (!pin || bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
        throw new Error("Native header bytes changed during capture.");
      return bytes;
    };
    const factoryInput = {
      requestBytes: executionBytes,
      approvedRequestSha256: request.executionRequestSha256,
      lockBytes,
      identityBytes,
      toolchainManifestBytes,
      toolchainFiles,
      nodeHeaderFiles: {
        nodeVersionH: await header("node_version.h"),
        configGypi: await header("config.gypi"),
      },
      verifyUnchanged,
    };
    console.log("[native-build] Verifying unchanged inputs before frozen workspace installation.");
    const bootstrap = createWindowsBuildExecution({ ...factoryInput, isolation: context });
    await verifyInventories("before-install");
    await measureBuildStage("native.workspace-install", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* bootstrap.verify;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const code = yield* spawner.exitCode(
            bootstrap.prepare(asChildProcess(bootstrap.workspaceInstall(), "inherit")),
          );
          if (code !== 0) return yield* Effect.fail(new PinnedWorkspaceInstallRefused());
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      ),
    );
    await verifyInventories("after-install");
    console.log("[native-build] Building the application from the frozen working snapshot.");
    const result = await measureBuildStage("native.application-build", () =>
      runWorkingNativeWindowsBuild({
        sourceRoot: context.sourceRoot,
        binding,
        factoryInput,
        policyPath: NodePath.join(context.inputsRoot, "identity.json"),
        buildLockPath: NodePath.join(context.inputsRoot, "build-lock.json"),
      }),
    );
    console.log("[native-build] Verifying unchanged inventories after the application build.");
    await verifyInventories("after-build");
    return {
      schemaVersion: 1,
      backend: "windows-native-directory",
      osIsolation: false,
      networkIsolation: false,
      sourceCommit: snapshot.sourceCommit,
      snapshotSha256: binding.snapshotSha256,
      result,
      artifactValidationRequired: true,
      published: false,
      installed: false,
    };
  } finally {
    await ownership.close();
    const current = await NodeFSP.lstat(lockPath);
    if (current.dev !== ownerIdentity.dev || current.ino !== ownerIdentity.ino)
      // eslint-disable-next-line no-unsafe-finally -- Changed ownership must prevent deletion of another owner's lock, even after a build failure.
      throw new Error("Native build lock changed; owner recovery is required.");
    await NodeFSP.unlink(lockPath);
  }
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
      "Supply --request ABSOLUTE_JSON --approved-request-sha256 REVIEWED_SHA256 to execute the approved native-directory build.",
    );
  console.log(JSON.stringify(await runWindowsNativeBuild(args[1], args[3]), null, 2));
}
