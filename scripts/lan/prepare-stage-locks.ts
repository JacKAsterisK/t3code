// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Projects existing locked bytes only; never invokes a resolver, install, script or network.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { deriveWindowsProductionStages } from "../lib/production-stage.ts";
import { strictJson } from "../lib/strict-json.ts";
import { sha256 } from "./hub-distribution.ts";
import { projectProductionStageLock } from "./stage-locks.ts";
import { assertValidationRoot, readValidationFile } from "./validate-windows-artifact.ts";
import { writeNewValidatedArtifacts } from "./seal-windows-payload.ts";
import { relativeWindowsPath } from "./windows-artifact.ts";

const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
export const STAGE_PROJECTION_INPUTS = [
  "package.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
] as const;
export function describeProductionStages(read: (relative: string) => Uint8Array) {
  const workspace = decodeYaml(
    new TextDecoder("utf-8", { fatal: true }).decode(read("pnpm-workspace.yaml")),
  );
  return {
    workspace,
    stages: deriveWindowsProductionStages({
      rootPackage: strictJson(read("package.json")),
      desktopPackage: strictJson(read("apps/desktop/package.json")),
      serverPackage: strictJson(read("apps/server/package.json")),
      workspace,
    }),
  };
}
export function projectProductionStageFiles(read: (relative: string) => Uint8Array) {
  const inputs = new Map(STAGE_PROJECTION_INPUTS.map((path) => [path as string, read(path)]));
  const { workspace, stages } = describeProductionStages((path) => inputs.get(path)!);
  const sourcePackageExtensions =
    typeof workspace === "object" && workspace !== null && "packageExtensions" in workspace
      ? workspace.packageExtensions
      : {};
  for (const stage of Object.values(stages))
    for (const path of Object.values(stage.workspace.patchedDependencies ?? {})) {
      relativeWindowsPath(path);
      inputs.set(path, read(path));
    }
  const projections = (["desktop", "server"] as const).map((name) => ({
    name,
    ...projectProductionStageLock({
      stage: stages[name],
      rootLockBytes: inputs.get("pnpm-lock.yaml")!,
      sourcePackageExtensions,
      readPatch: (path) => inputs.get(path)!,
    }),
  }));
  const files = new Map(
    projections.map(({ name, lockBytes }) => [`${name}.pnpm-lock.yaml`, lockBytes]),
  );
  files.set(
    "preparation.json",
    Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, mode: "exact-root-lock-projection", sourceInputs: Object.fromEntries([...inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => [name, sha256(bytes)])), stages: Object.fromEntries(projections.map(({ name, report }) => [name, report])), fullPeerAndOptionalClosurePreserved: true, pinnedPackageManagerAcceptance: "pending-pnpm@12.14.0-frozen-offline-verification", dependencyInstallExecuted: false, releaseBuildExecuted: false }, null, 2)}\n`,
    ),
  );
  return { files, inputs };
}
export async function prepareProductionStageLocks(root: string, write = false) {
  await assertValidationRoot(root);
  const supplied = new Map<string, Uint8Array>();
  for (const path of STAGE_PROJECTION_INPUTS)
    supplied.set(path, await readValidationFile(NodePath.join(root, path), 16 * 1024 ** 2));
  const snapshot = (path: string) => {
    const bytes = supplied.get(path);
    if (!bytes) throw new Error("Missing snapshotted production-stage input.");
    return bytes;
  };
  for (const stage of Object.values(describeProductionStages(snapshot).stages))
    for (const path of Object.values(stage.workspace.patchedDependencies ?? {})) {
      relativeWindowsPath(path);
      supplied.set(path, await readValidationFile(NodePath.join(root, path), 1024 ** 2));
    }
  const { files, inputs } = projectProductionStageFiles(snapshot);
  for (const [path, bytes] of inputs)
    if (
      sha256(await readValidationFile(NodePath.join(root, path), 16 * 1024 ** 2)) !== sha256(bytes)
    )
      throw new Error("Production-stage source input changed during preparation.");
  const directory = NodePath.join(root, "scripts", "lan", "locks");
  if (write) {
    try {
      await NodeFSP.mkdir(directory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await assertValidationRoot(directory);
    await writeNewValidatedArtifacts(
      [...files].map(([name, bytes]) => ({ path: NodePath.join(directory, name), bytes })),
    );
  } else
    for (const [name, bytes] of files)
      if (
        sha256(await readValidationFile(NodePath.join(directory, name), 16 * 1024 ** 2)) !==
        sha256(bytes)
      )
        throw new Error(`Production-stage projection is stale: ${name}.`);
  return {
    passed: true,
    mode: write ? "write-new-only" : "check",
    files: [...files.keys()],
    pinnedPackageManagerAcceptance: "pending",
    dependencyInstallExecuted: false,
    releaseBuildExecuted: false,
  };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && !["--check", "--write"].includes(args[0])))
    throw new Error(
      "Use --check (default) or --write (new files only); no dependency installation is performed.",
    );
  console.log(
    JSON.stringify(
      await prepareProductionStageLocks(
        NodePath.resolve(import.meta.dirname, "../.."),
        args[0] === "--write",
      ),
      null,
      2,
    ),
  );
}
