// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This entry is invoked only by the explicitly approved offline Sandbox bootstrap, never by normal desktop packaging.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import { assertSourceSnapshotExclusions } from "./source-git.ts";
import { relativeWindowsPath, strictJson } from "./windows-artifact.ts";
import {
  readValidationFile,
  inspectValidationTree,
  assertValidationRoot,
} from "./validate-windows-artifact.ts";
import {
  WindowsBuildPreparationRequest,
  verifyWindowsPreparationEvidence,
} from "./windows-build-preparation.ts";
import {
  asChildProcess,
  createWindowsBuildExecution,
  WindowsBuildExecutionRequest,
} from "./windows-build-execution.ts";
import {
  committedSnapshotFile,
  assertSnapshotSourcePath,
  SourceSnapshot,
  WindowsSandboxGuestRequest,
  writeNewSnapshotTree,
} from "./prepare-windows-sandbox.ts";
import {
  establishWindowsSandboxContext,
  verifyWindowsSandboxContextFacts,
  WINDOWS_SANDBOX_ROOTS,
} from "./windows-sandbox-context.ts";

const decodeGuest = Schema.decodeUnknownSync(WindowsSandboxGuestRequest, {
  onExcessProperty: "error",
});
const decodeSnapshot = Schema.decodeUnknownSync(SourceSnapshot, { onExcessProperty: "error" });
const decodePreparation = Schema.decodeUnknownSync(WindowsBuildPreparationRequest, {
  onExcessProperty: "error",
});
const decodeExecution = Schema.decodeUnknownSync(WindowsBuildExecutionRequest, {
  onExcessProperty: "error",
});
const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });

export function requirePinnedCacheBytes(
  pin: { readonly length: number; readonly sha256: string },
  bytes: Uint8Array,
) {
  if (bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
    throw new Error("Approved cache bytes changed during capture.");
  return bytes;
}

export async function runWorkingWindowsBuild(input: {
  readonly sourceRoot: string;
  readonly factoryInput: Omit<Parameters<typeof createWindowsBuildExecution>[0], "isolation">;
  readonly binding: Parameters<typeof establishWindowsSandboxContext>[0];
  readonly policyPath: string;
  readonly buildLockPath: string;
}) {
  const sourceModule = (relative: string) =>
    new URL(`file:///${input.sourceRoot.replaceAll("\\", "/")}/${relative}`).href;
  const workingContext = (await import(
    /* @vite-ignore */ sourceModule("scripts/lan/windows-sandbox-context.ts")
  )) as typeof import("./windows-sandbox-context.ts");
  const workingExecution = (await import(
    /* @vite-ignore */ sourceModule("scripts/lan/windows-build-execution.ts")
  )) as typeof import("./windows-build-execution.ts");
  const service = workingExecution.createWindowsBuildExecution({
    ...input.factoryInput,
    isolation: await workingContext.establishWindowsSandboxContext(input.binding),
  });
  const { runIsolatedWindowsDesktopBuild } = (await import(
    /* @vite-ignore */ sourceModule("scripts/build-desktop-artifact.ts")
  )) as Pick<typeof import("../build-desktop-artifact.ts"), "runIsolatedWindowsDesktopBuild">;
  return Effect.runPromise(
    runIsolatedWindowsDesktopBuild(service, {
      policyPath: input.policyPath,
      buildLockPath: input.buildLockPath,
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

export function verifySourceSnapshot(
  snapshot: SourceSnapshot,
  files: ReadonlyMap<
    string,
    { readonly bytes: Uint8Array; readonly length: number; readonly sha256: string }
  >,
) {
  assertSourceSnapshotExclusions(snapshot.exclusions);
  if (snapshot.exclusions.some((entry) => files.has(entry.path)))
    throw new Error("A nonbuild exclusion was unexpectedly materialized.");
  if (
    !snapshot.files.length ||
    snapshot.files.length > 100000 ||
    files.size !== snapshot.files.length
  )
    throw new Error("Sandbox source snapshot inventory differs.");
  const names = new Set<string>();
  let previous = "";
  for (const file of snapshot.files) {
    assertSnapshotSourcePath(file.path);
    if (file.path <= previous || names.has(file.path.toLowerCase()))
      throw new Error("Sandbox snapshot contains ambiguous or forbidden paths.");
    previous = file.path;
    names.add(file.path.toLowerCase());
    const actual = files.get(file.path);
    if (
      !actual ||
      actual.length !== file.length ||
      actual.sha256 !== file.sha256 ||
      committedSnapshotFile(file.blob, actual.bytes).sha256 !== file.sha256
    )
      throw new Error("Sandbox source bytes differ from their approved committed snapshot.");
  }
}

export async function runWindowsSandboxGuest(approvedGuestRequestSha256: string) {
  const roots = WINDOWS_SANDBOX_ROOTS;
  const inputFile = (name: string) => NodePath.win32.join(roots.inputsRoot, name);
  const guestBytes = await readValidationFile(inputFile("guest-request.json"), 65536);
  if (
    !/^[a-f0-9]{64}$/u.test(approvedGuestRequestSha256) ||
    sha256(guestBytes) !== approvedGuestRequestSha256
  )
    throw new Error("Guest request differs from the approved WSB bootstrap.");
  const request = decodeGuest(strictJson(guestBytes));
  const expected = new Map([
    ["preparation-request.json", request.preparationRequestSha256],
    ["execution-request.json", request.executionRequestSha256],
    ["guest-runner.mjs", request.guestRunnerSha256],
    ["snapshot.json", request.snapshotSha256],
    ["build-lock.json", request.buildLockSha256],
    ["identity.json", request.identitySha256],
    ["toolchain-manifest.json", request.toolchainManifestSha256],
    ["guest-request.json", approvedGuestRequestSha256],
  ]);
  const inputs = await inspectValidationTree(roots.inputsRoot);
  if (
    inputs.size !== expected.size ||
    [...expected].some(([name, hash]) => inputs.get(name)?.sha256 !== hash)
  )
    throw new Error("Sandbox input inventory changed.");
  const bytes = (name: string) => {
    const file = inputs.get(name);
    if (!file) throw new Error("Sandbox input is absent.");
    return file.bytes;
  };
  const preparation = decodePreparation(strictJson(bytes("preparation-request.json")));
  const execution = decodeExecution(strictJson(bytes("execution-request.json")));
  const snapshot = decodeSnapshot(strictJson(bytes("snapshot.json")));
  if (snapshot.sourceDateEpoch !== execution.sourceDateEpoch)
    throw new Error("Sandbox source epoch differs from the approved execution request.");
  const sourceFiles = await inspectValidationTree(roots.mappedSourceRoot);
  verifySourceSnapshot(snapshot, sourceFiles);
  const toolchainFiles = await inspectValidationTree(roots.toolchainRoot, true);
  const guestPreparation = {
    ...preparation,
    sourceRoot: roots.sourceRoot,
    buildRoot: NodePath.win32.join(roots.outputRoot, "artifacts"),
    toolchainRoot: roots.toolchainRoot,
    buildLockPath: inputFile("build-lock.json"),
    identityPath: inputFile("identity.json"),
    toolchainManifestPath: inputFile("toolchain-manifest.json"),
  };
  verifyWindowsPreparationEvidence({
    request: guestPreparation,
    lockBytes: bytes("build-lock.json"),
    identityBytes: bytes("identity.json"),
    toolchainManifestBytes: bytes("toolchain-manifest.json"),
    // The approved host snapshot binds the clean commit/ancestry inspection; no guest Git checkout is fabricated.
    source: {
      commit: snapshot.sourceCommit,
      clean: true,
      upstreamAncestor: true,
      files: new Map([...sourceFiles].map(([name, file]) => [name, file.bytes])),
    },
    toolchainFiles,
  });
  const lock = decodeLock(strictJson(bytes("build-lock.json")));
  if (
    process.versions.node !== lock.tools.node.version ||
    sha256(await readValidationFile(process.execPath, 256 * 1024 ** 2)) !== lock.tools.node.sha256
  )
    throw new Error("The guest is not running the exact approved Node binary/version.");
  const isolation = await establishWindowsSandboxContext({
    sourceCommit: snapshot.sourceCommit,
    snapshotSha256: request.snapshotSha256,
    preparationRequestSha256: request.preparationRequestSha256,
  });
  await assertValidationRoot(roots.outputRoot);
  if ((await NodeFSP.readdir(roots.outputRoot)).length)
    throw new Error("Sandbox output contains preexisting work; it is never cleaned.");
  await NodeFSP.mkdir(NodePath.win32.dirname(roots.sourceRoot));
  await writeNewSnapshotTree(
    roots.sourceRoot,
    new Map([...sourceFiles].map(([name, file]) => [name, file.bytes])),
  );
  for (const relative of ["temp", "home", "home/roaming", "home/local"])
    await NodeFSP.mkdir(NodePath.win32.join(roots.outputRoot, relative));
  for (const name of ["empty.npmrc", "empty-global.npmrc"])
    await NodeFSP.writeFile(NodePath.win32.join(roots.outputRoot, name), "", {
      flag: "wx",
      mode: 0o600,
    });
  await NodeFSP.mkdir(NodePath.win32.join(roots.outputRoot, "caches"));
  for (const name of ["pnpmStore", "cargoHome", "electronCache", "builderCache"] as const) {
    const prefix = relativeWindowsPath(execution.directories[name]) + "/";
    const cacheFiles = new Map<string, Uint8Array>();
    for (const [path, pin] of toolchainFiles)
      if (path.startsWith(prefix)) {
        const copied = await readValidationFile(
          NodePath.win32.join(roots.toolchainRoot, path),
          256 * 1024 ** 2,
        );
        cacheFiles.set(path.slice(prefix.length), requirePinnedCacheBytes(pin, copied));
      }
    if (!cacheFiles.size) throw new Error(`Approved offline cache is empty: ${name}.`);
    await writeNewSnapshotTree(NodePath.win32.join(roots.outputRoot, "caches", name), cacheFiles);
  }
  const verifyUnchanged = async () => {
    await verifyWindowsSandboxContextFacts(isolation);
    const currentInputs = await inspectValidationTree(roots.inputsRoot, true);
    const currentSource = await inspectValidationTree(roots.mappedSourceRoot, true);
    const currentTools = await inspectValidationTree(roots.toolchainRoot, true);
    for (const [expectedFiles, actual] of [
      [inputs, currentInputs],
      [sourceFiles, currentSource],
      [toolchainFiles, currentTools],
    ] as const)
      if (
        actual.size !== expectedFiles.size ||
        [...expectedFiles].some(([name, file]) => actual.get(name)?.sha256 !== file.sha256)
      )
        throw new Error("Approved read-only Sandbox input changed before a subprocess.");
    for (const file of snapshot.files)
      if (
        sha256(
          await readValidationFile(
            NodePath.win32.join(roots.sourceRoot, file.path),
            256 * 1024 ** 2,
          ),
        ) !== file.sha256
      )
        throw new Error("Working tracked source changed before a subprocess.");
  };
  const headerRoot = relativeWindowsPath(execution.directories.nodeHeaders);
  const header = async (name: string) => {
    const relative = `${headerRoot}/include/node/${name}`;
    const pin = toolchainFiles.get(relative);
    const value = await readValidationFile(
      NodePath.win32.join(roots.toolchainRoot, relative),
      1024 * 1024,
    );
    if (!pin || value.length !== pin.length || sha256(value) !== pin.sha256)
      throw new Error("Approved Node header bytes changed during capture.");
    return value;
  };
  const nodeHeaderFiles = {
    nodeVersionH: await header("node_version.h"),
    configGypi: await header("config.gypi"),
  };
  const factoryInput = {
    approvedRequestSha256: request.executionRequestSha256,
    requestBytes: bytes("execution-request.json"),
    lockBytes: bytes("build-lock.json"),
    identityBytes: bytes("identity.json"),
    toolchainManifestBytes: bytes("toolchain-manifest.json"),
    toolchainFiles,
    nodeHeaderFiles,
    isolation,
    verifyUnchanged,
  };
  const bootstrapExecution = createWindowsBuildExecution(factoryInput);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* bootstrapExecution.verify;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exitCode = yield* spawner.exitCode(
        bootstrapExecution.prepare(
          asChildProcess(bootstrapExecution.workspaceInstall(), "inherit"),
        ),
      );
      if (exitCode !== 0)
        return yield* Effect.fail(
          new Error("Pinned offline workspace installation refused; no build was started."),
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  await verifyUnchanged();
  // Source modules share their own opaque capability issuer, rather than accepting the bootstrap bundle's distinct module instance.
  const result = await runWorkingWindowsBuild({
    sourceRoot: roots.sourceRoot,
    factoryInput,
    binding: {
      sourceCommit: snapshot.sourceCommit,
      snapshotSha256: request.snapshotSha256,
      preparationRequestSha256: request.preparationRequestSha256,
    },
    policyPath: inputFile("identity.json"),
    buildLockPath: inputFile("build-lock.json"),
  });
  return {
    schemaVersion: 1,
    result,
    artifactValidationRequired: true,
    published: false,
    installed: false,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--guest-request-sha256" || !args[1])
    throw new Error("This runner requires the exact approved offline Sandbox bootstrap request.");
  console.log(JSON.stringify(await runWindowsSandboxGuest(args[1]), null, 2));
}
