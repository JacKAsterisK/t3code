// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Explicit offline package-manager acceptance in a new workspace; lifecycle scripts are disabled.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import { LAN_STAGE_LOCK_FILES } from "./lan-packaging.ts";
import {
  describeProductionStages,
  projectProductionStageFiles,
  STAGE_PROJECTION_INPUTS,
} from "./prepare-stage-locks.ts";
import {
  preparePinnedWindowsBuild,
  WindowsBuildPreparationRequest,
} from "./windows-build-preparation.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";
import {
  relativeWindowsPath,
  strictJson,
  ToolchainManifest,
  TOOLCHAIN_LIMITS,
} from "./windows-artifact.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeRequest = Schema.decodeUnknownSync(WindowsBuildPreparationRequest);
const decodeLock = Schema.decodeUnknownSync(BuildLock);
const decodeInventory = Schema.decodeUnknownSync(ToolchainManifest);
const stages = ["desktop", "server"] as const;
export interface AcceptanceCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export function stageAcceptanceCommands(input: {
  readonly workRoot: string;
  readonly node: string;
  readonly pnpm: string;
  readonly systemRoot: string;
}) {
  const path = NodePath.win32;
  // No inherited npm credentials, NODE_OPTIONS, proxies or user/global config.
  // Package-manager version management is also disabled so a mismatched pin
  // cannot bootstrap a different executable before frozen resolution starts.
  const env = {
    SystemRoot: input.systemRoot,
    WINDIR: input.systemRoot,
    PATH: path.dirname(input.node),
    TEMP: path.join(input.workRoot, "temp"),
    TMP: path.join(input.workRoot, "temp"),
    USERPROFILE: path.join(input.workRoot, "home"),
    HOME: path.join(input.workRoot, "home"),
    APPDATA: path.join(input.workRoot, "home", "roaming"),
    LOCALAPPDATA: path.join(input.workRoot, "home", "local"),
    CI: "true",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    npm_config_userconfig: path.join(input.workRoot, "empty.npmrc"),
    npm_config_globalconfig: path.join(input.workRoot, "empty-global.npmrc"),
    npm_config_manage_package_manager_versions: "false",
    npm_config_ignore_scripts: "true",
    npm_config_ignore_pnpmfile: "true",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  if (!/\.exe$/iu.test(input.pnpm))
    throw new Error(
      "Pin pnpm 12's native executable; its JavaScript entry can bootstrap another binary.",
    );
  const command = (
    executable: string,
    args: readonly string[],
    cwd: string,
  ): AcceptanceCommand => ({
    executable,
    args,
    cwd,
    env,
  });
  return {
    nodeVersion: command(input.node, ["--version"], input.workRoot),
    pnpmVersion: command(input.pnpm, ["--version"], input.workRoot),
    stages: stages.map((name) => ({
      name,
      command: command(
        input.pnpm,
        [
          "install",
          "--prod",
          "--lockfile-only",
          "--offline",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--ignore-pnpmfile",
          "--config.manage-package-manager-versions=false",
          "--config.package-manager-strict-version=true",
          "--config.verify-store-integrity=true",
          `--config.cache-dir=${path.join(input.workRoot, "pnpm-store", "metadata-cache")}`,
          "--store-dir",
          path.join(input.workRoot, "pnpm-store"),
        ],
        path.join(input.workRoot, name),
      ),
    })),
  };
}

export async function executeStageAcceptance(input: {
  readonly commands: ReturnType<typeof stageAcceptanceCommands>;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly verifyUnchanged: () => Promise<void>;
  readonly run: (command: AcceptanceCommand) => Promise<string>;
}) {
  await input.verifyUnchanged();
  if ((await input.run(input.commands.nodeVersion)).trim() !== `v${input.nodeVersion}`)
    throw new Error("The verified Node executable reported a different version.");
  if ((await input.run(input.commands.pnpmVersion)).trim() !== input.pnpmVersion)
    throw new Error("The verified pnpm executable reported a different version.");
  const accepted: string[] = [];
  for (const stage of input.commands.stages) {
    await input.verifyUnchanged();
    await input.run(stage.command);
    await input.verifyUnchanged();
    accepted.push(stage.name);
  }
  return {
    schemaVersion: 1 as const,
    pinnedPackageManagerAcceptance: "passed" as const,
    nodeVersion: input.nodeVersion,
    pnpmVersion: input.pnpmVersion,
    stages: accepted,
    lifecycleScriptsExecuted: false as const,
    productionDependenciesInstalled: false as const,
    nativeBuildIsolationProven: false as const,
    releaseBuildExecuted: false as const,
  };
}

export async function acceptProductionStageLocks(requestPath: string, approvedSha256: string) {
  // This invokes only the explicit pinned package manager. The release runner
  // remains separately gated: offline resolution cannot isolate native scripts.
  const preparation = await preparePinnedWindowsBuild(requestPath, approvedSha256);
  const requestBytes = await readValidationFile(requestPath, 1024 ** 2);
  if (sha256(requestBytes) !== approvedSha256) throw new Error("Preparation request changed.");
  const request = decodeRequest(strictJson(requestBytes), { onExcessProperty: "error" });
  const lockBytes = await readValidationFile(request.buildLockPath, 1024 ** 2);
  if (sha256(lockBytes) !== request.buildLockSha256) throw new Error("Build lock changed.");
  const lock = decodeLock(strictJson(lockBytes), { onExcessProperty: "error" });
  const source = new Map<string, Uint8Array>();
  const readSource = async (name: string) => {
    const bytes = await readValidationFile(
      NodePath.join(request.sourceRoot, relativeWindowsPath(name)),
      32 * 1024 ** 2,
    );
    if (sha256(bytes) !== lock.files[name]) throw new Error(`Source changed: ${name}.`);
    source.set(name, bytes);
    return bytes;
  };
  for (const name of STAGE_PROJECTION_INPUTS) await readSource(name);
  const read = (name: string) => {
    const bytes = source.get(name);
    if (!bytes) throw new Error(`Missing stage input: ${name}.`);
    return bytes;
  };
  const descriptors = describeProductionStages(read).stages;
  for (const stage of Object.values(descriptors))
    for (const name of Object.values(stage.workspace.patchedDependencies ?? {}))
      await readSource(name);
  const projected = projectProductionStageFiles(read);
  for (const name of stages) {
    const bytes = await readSource(LAN_STAGE_LOCK_FILES[name]);
    if (sha256(bytes) !== sha256(projected.files.get(`${name}.pnpm-lock.yaml`)!))
      throw new Error("Production lock differs from the exact source projection.");
  }
  const toolchainBefore = await inspectValidationTree(request.toolchainRoot, true);
  const manifestBytes = await readValidationFile(
    request.toolchainManifestPath,
    TOOLCHAIN_LIMITS.manifestBytes,
  );
  if (sha256(manifestBytes) !== request.toolchainManifestSha256)
    throw new Error("Toolchain manifest changed.");
  const inventory = decodeInventory(strictJson(manifestBytes), {
    onExcessProperty: "error",
  });
  if (
    inventory.files.length !== toolchainBefore.size ||
    inventory.files.some((pin) => {
      const actual = toolchainBefore.get(pin.path);
      return actual?.sha256 !== pin.sha256 || actual.length !== pin.length;
    })
  )
    throw new Error("Toolchain changed after preparation.");
  const toolchainFingerprint = (files: typeof toolchainBefore) =>
    JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)));
  const initialFingerprint = toolchainFingerprint(toolchainBefore);
  // pnpm 12's supply-chain checks also require registry metadata. Bind its
  // cache beneath the reviewed store so offline acceptance cannot silently
  // consult an ambient profile. Copying protects the approved closure from
  // bookkeeping writes, including the metadata cache.
  const store = NodePath.join(request.toolchainRoot, "pnpm-store");
  await assertValidationRoot(store);
  const work = NodePath.join(request.buildRoot, "stage-acceptance");
  for (let ancestor = request.buildRoot; ; ancestor = NodePath.dirname(ancestor)) {
    for (const name of [".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs", "pnpm-workspace.yaml"])
      try {
        await NodeFSP.lstat(NodePath.join(ancestor, name));
        throw new Error("Acceptance workspace ancestors contain package-manager configuration.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    if (ancestor === NodePath.dirname(ancestor)) break;
  }
  await NodeFSP.mkdir(work);
  const expected = new Map<string, Uint8Array>();
  const write = async (relative: string, bytes: Uint8Array) => {
    const file = NodePath.join(work, relativeWindowsPath(relative));
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, bytes, { flag: "wx" });
    expected.set(file, bytes);
  };
  for (const name of stages) {
    const descriptor = descriptors[name];
    await write(`${name}/package.json`, Buffer.from(JSON.stringify(descriptor.packageJson)));
    // JSON is a YAML subset, matching the actual packager's workspace encoding.
    await write(`${name}/pnpm-workspace.yaml`, Buffer.from(JSON.stringify(descriptor.workspace)));
    await write(`${name}/pnpm-lock.yaml`, read(LAN_STAGE_LOCK_FILES[name]));
    for (const patch of Object.values(descriptor.workspace.patchedDependencies ?? {}))
      await write(`${name}/${patch}`, read(patch));
  }
  await write("empty.npmrc", Buffer.from(""));
  await write("empty-global.npmrc", Buffer.from(""));
  for (const directory of ["temp", "home", "home/roaming", "home/local"])
    await NodeFSP.mkdir(NodePath.join(work, directory), { recursive: true });
  await NodeFSP.cp(store, NodePath.join(work, "pnpm-store"), {
    recursive: true,
    errorOnExist: true,
  });
  const node = NodePath.join(request.toolchainRoot, relativeWindowsPath(request.toolFiles.node));
  const pnpm = NodePath.join(request.toolchainRoot, relativeWindowsPath(request.toolFiles.pnpm));
  if (!/\.exe$/iu.test(pnpm))
    throw new Error("Use the reviewed pnpm native executable, not a bootstrap shim.");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\Windows$/iu.test(systemRoot))
    throw new Error("A native Windows system root is required.");
  const verifyUnchanged = async () => {
    for (const [file, bytes] of expected)
      if (sha256(await readValidationFile(file, 32 * 1024 ** 2)) !== sha256(bytes))
        throw new Error("Pinned package-manager acceptance changed a staged input.");
    for (const [name, bytes] of source)
      if (
        sha256(
          await readValidationFile(NodePath.join(request.sourceRoot, name), 32 * 1024 ** 2),
        ) !== sha256(bytes)
      )
        throw new Error("Source changed during package-manager acceptance.");
    if (
      toolchainFingerprint(await inspectValidationTree(request.toolchainRoot, true)) !==
      initialFingerprint
    )
      throw new Error("Toolchain changed during package-manager acceptance.");
  };
  const result = await executeStageAcceptance({
    commands: stageAcceptanceCommands({ workRoot: work, node, pnpm, systemRoot }),
    nodeVersion: lock.tools.node.version,
    pnpmVersion: lock.tools.pnpm.version,
    verifyUnchanged,
    run: async (command) => {
      try {
        return (
          await execFile(command.executable, [...command.args], {
            cwd: command.cwd,
            env: command.env,
            windowsHide: true,
            maxBuffer: 1024 ** 2,
          })
        ).stdout;
      } catch {
        // A package-manager diagnostic may contain credentials from malformed
        // package metadata. Keep public receipts limited to the failed boundary.
        throw new Error("Pinned offline package-manager command failed; no acceptance recorded.");
      }
    },
  });
  const receipt = {
    ...result,
    preparationRequestSha256: preparation.preparationRequestSha256,
    buildLockSha256: request.buildLockSha256,
    toolchainManifestSha256: request.toolchainManifestSha256,
    stageLockSha256: Object.fromEntries(
      stages.map((name) => [name, sha256(read(LAN_STAGE_LOCK_FILES[name]))]),
    ),
  };
  await NodeFSP.writeFile(
    NodePath.join(work, "acceptance.json"),
    JSON.stringify(receipt, null, 2),
    { flag: "wx" },
  );
  return receipt;
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
    throw new Error("Supply --request ABSOLUTE_JSON --approved-request-sha256 REVIEWED_SHA256.");
  console.log(JSON.stringify(await acceptProductionStageLocks(args[1], args[3]), null, 2));
}
