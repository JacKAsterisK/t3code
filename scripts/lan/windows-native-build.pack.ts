// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Bundles approved native runner source locally; does not execute a build, install dependencies or change Windows.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { build } from "vite-plus/pack";
import * as Schema from "effect/Schema";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import { inspectSourceGit } from "./source-git.ts";
import { nativeBuildRoot } from "./windows-build-preparation.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";
import { relativeWindowsPath, strictJson } from "./windows-artifact.ts";
import { windowsSandboxGuestBundleOptions } from "./windows-sandbox-guest.pack.ts";

const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });
export const windowsNativeBuildBundleOptions = (root: string, outDir: string) =>
  windowsSandboxGuestBundleOptions(root, outDir, {
    name: "native-runner",
    file: "scripts/lan/windows-native-build.ts",
  });

export async function buildWindowsNativeRunner(
  buildLockPath: string,
  approvedBuildLockSha256: string,
  outDir: string,
) {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const lockBytes = await readValidationFile(buildLockPath, 1024 * 1024);
  if (
    !/^[a-f0-9]{64}$/u.test(approvedBuildLockSha256) ||
    sha256(lockBytes) !== approvedBuildLockSha256
  )
    throw new Error("Native runner bundling requires the reviewed build lock bytes.");
  const lock = decodeLock(strictJson(lockBytes));
  if (
    (await inspectSourceGit(root, ["rev-parse", "HEAD"])) !== lock.forkCommit ||
    (await inspectSourceGit(root, ["status", "--porcelain", "--untracked-files=all"]))
  )
    throw new Error(
      "Native runner bundling requires clean frozen source at the approved full commit.",
    );
  if (
    process.versions.node !== lock.tools.node.version ||
    sha256(await readValidationFile(process.execPath, 256 * 1024 ** 2)) !== lock.tools.node.sha256
  )
    throw new Error("Native runner bundling requires the exact approved Node executable/version.");
  for (const [relative, digest] of Object.entries(lock.files))
    if (
      sha256(
        await readValidationFile(
          NodePath.join(root, relativeWindowsPath(relative)),
          32 * 1024 ** 2,
        ),
      ) !== digest
    )
      throw new Error("Native runner source input differs from the approved build lock.");
  nativeBuildRoot(outDir);
  await assertValidationRoot(NodePath.dirname(outDir));
  await NodeFSP.mkdir(outDir);
  await build(windowsNativeBuildBundleOptions(root, outDir));
  const files = await inspectValidationTree(outDir, true);
  if (files.size !== 1 || !files.has("native-runner.mjs"))
    throw new Error("Native runner must be one self-contained reviewed bundle.");
  const receipt = {
    schemaVersion: 1,
    kind: "windows-native-runner-bundle",
    sourceCommit: lock.forkCommit,
    buildLockSha256: approvedBuildLockSha256,
    recipe: "scripts/lan/windows-native-build.pack.ts",
    files: [...files].map(([path, pin]) => ({ path, length: pin.length, sha256: pin.sha256 })),
    reproducibilityAcceptance: "pending",
    release: false,
    launched: false,
    osIsolation: false,
    networkIsolation: false,
  };
  await NodeFSP.writeFile(
    NodePath.join(outDir, "bundle-recipe.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--build-lock" ||
    args[2] !== "--approved-build-lock-sha256" ||
    args[4] !== "--output" ||
    !args[1] ||
    !args[3] ||
    !args[5]
  )
    throw new Error(
      "Supply --build-lock ABSOLUTE_JSON --approved-build-lock-sha256 REVIEWED_SHA256 --output NEW_ABSOLUTE_DIRECTORY.",
    );
  console.log(JSON.stringify(await buildWindowsNativeRunner(args[1], args[3], args[5]), null, 2));
}
