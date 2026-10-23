// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Bundles the reviewed guest bootstrap into a new directory; does not start Sandbox, install dependencies or build a release.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { transformWithOxc } from "vite-plus";
import { build } from "vite-plus/pack";
import * as Schema from "effect/Schema";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import { inspectSourceGit } from "./source-git.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";
import { relativeWindowsPath, strictJson } from "./windows-artifact.ts";
import { nativeBuildRoot } from "./windows-build-preparation.ts";

const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });

export const windowsSandboxGuestBundleOptions = (
  root: string,
  outDir: string,
  runner = { name: "guest-runner", file: "scripts/lan/windows-sandbox-guest.ts" },
) => ({
  config: false as const,
  entry: { [runner.name]: NodePath.join(root, runner.file) },
  plugins: [
    {
      name: "lan-runner-module-main",
      async transform(code: string, id: string) {
        if (
          NodePath.resolve(id) === NodePath.resolve(root, runner.file) ||
          !code.includes("import.meta")
        )
          return;
        // Bundling otherwise gives every imported CLI the entry module's main status.
        // Keep the entry's real guard so importing the finished bundle stays inert.
        const transformed = await transformWithOxc(code, id, {
          define: { "import.meta.main": "false" },
        });
        return {
          code: transformed.code,
          map: transformed.map ? JSON.stringify(transformed.map) : null,
        };
      },
    },
  ],
  outDir,
  format: "esm" as const,
  platform: "node" as const,
  target: "node26",
  dts: false,
  clean: false,
  outputOptions: { codeSplitting: false },
  deps: { alwaysBundle: (id: string) => !id.startsWith("node:"), onlyBundle: false as const },
});

export async function buildWindowsSandboxGuestRunner(
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
    throw new Error("Guest bundling requires the separately reviewed build lock.");
  const lock = decodeLock(strictJson(lockBytes));
  if (
    (await inspectSourceGit(root, ["rev-parse", "HEAD"])) !== lock.forkCommit ||
    (await inspectSourceGit(root, ["status", "--porcelain", "--untracked-files=all"]))
  )
    throw new Error(
      "Guest runner bundling requires clean frozen source at the approved full commit.",
    );
  if (
    process.versions.node !== lock.tools.node.version ||
    sha256(await readValidationFile(process.execPath, 256 * 1024 ** 2)) !== lock.tools.node.sha256
  )
    throw new Error("Guest bundling requires the exact approved Node binary/version.");
  for (const [relative, hash] of Object.entries(lock.files))
    if (
      sha256(
        await readValidationFile(
          NodePath.join(root, relativeWindowsPath(relative)),
          32 * 1024 ** 2,
        ),
      ) !== hash
    )
      throw new Error("Guest bundling source input differs from the approved build lock.");
  nativeBuildRoot(outDir);
  await assertValidationRoot(NodePath.dirname(outDir));
  await NodeFSP.mkdir(outDir); // Never clean or reuse a computed output directory.
  await build(windowsSandboxGuestBundleOptions(root, outDir));
  const files = await inspectValidationTree(outDir, true);
  if (files.size !== 1 || !files.has("guest-runner.mjs"))
    throw new Error("Guest bootstrap must be a single self-contained reviewed bundle.");
  const receipt = {
    schemaVersion: 1,
    kind: "windows-sandbox-guest-bundle",
    sourceCommit: lock.forkCommit,
    buildLockSha256: approvedBuildLockSha256,
    recipe: "scripts/lan/windows-sandbox-guest.pack.ts",
    files: [...files].map(([path, pin]) => ({ path, length: pin.length, sha256: pin.sha256 })),
    reproducibilityAcceptance: "pending",
    release: false,
    launched: false,
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
  console.log(
    JSON.stringify(await buildWindowsSandboxGuestRunner(args[1], args[3], args[5]), null, 2),
  );
}
