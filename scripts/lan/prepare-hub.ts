// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Read-only local build planning; no commands in its output are executed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { BUILD_INPUT_FILES, BuildLock, prepareWindowsBuild, sha256 } from "./hub-distribution.ts";
import { readLanBuildPolicyFile } from "../lib/lan-build-policy.ts";
import { strictJson } from "../lib/strict-json.ts";
import { readLanPackagingInputs } from "./lan-packaging.ts";
import { LAN_WINDOWS_EXECUTION_BLOCKERS } from "./windows-build-preparation.ts";

const RootPackage = Schema.Struct({
  engines: Schema.Struct({ node: Schema.String }),
  packageManager: Schema.String,
});
const DesktopPackage = Schema.Struct({
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
});
const decodeRoot = Schema.decodeUnknownSync(Schema.fromJsonString(RootPackage));
const decodeDesktop = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopPackage));
const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });
const encodeReport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

function inspectCheckout(root: string) {
  const read = (path: string) => NodeFS.readFileSync(NodePath.resolve(root, path), "utf8");
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const rootPackage = decodeRoot(read("package.json"));
  const desktopPackage = decodeDesktop(read("apps/desktop/package.json"));
  const packager = read("scripts/build-desktop-artifact.ts");
  const appId = /const\s+DESKTOP_APP_ID\s*=\s*["']([^"']+)["']/u.exec(packager)?.[1];
  const home = /input\.homeDirectory,\s*["']([^"']+)["']/u.exec(
    read("apps/desktop/src/app/DesktopStatePaths.ts"),
  )?.[1];
  const schemeLists = [...packager.matchAll(/schemes:\s*\[([^\]]+)\]/gu)].map((match) => match[1]);
  const branding = /const\s+APP_BASE_NAME\s*=\s*["']([^"']+)["']/u.exec(
    read("apps/desktop/src/app/DesktopEnvironment.ts"),
  )?.[1];
  return {
    commit: git("rev-parse", "HEAD"),
    clean: git("status", "--porcelain").length === 0,
    node: rootPackage.engines.node,
    packageManager: rootPackage.packageManager,
    electron: desktopPackage.dependencies.electron ?? "unresolved",
    electronBuilder: desktopPackage.devDependencies["electron-builder"] ?? "unresolved",
    files: Object.fromEntries(
      BUILD_INPUT_FILES.map((path) => [
        path,
        sha256(NodeFS.readFileSync(NodePath.resolve(root, path))),
      ]),
    ),
    officialAppId: appId === undefined || appId.startsWith("com.t3tools."),
    officialHomeDefault: home === undefined || home.toLowerCase() === ".t3",
    officialProtocols:
      schemeLists.length === 0 ||
      schemeLists.some(
        (schemes) => schemes === undefined || /["']t3code(?:-dev)?["']/u.test(schemes),
      ),
    officialBranding: branding === undefined || branding === "T3 Code",
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const key = args[at];
    const value = args[at + 1];
    if (!key || !["--lock", "--lan-policy"].includes(key) || !value || options.has(key))
      throw new Error(
        "Usage: node scripts/lan/prepare-hub.ts [--lock <approved-lock.json>] [--lan-policy <absolute-public-identity.json>]",
      );
    options.set(key, value);
  }
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const lockPath = options.get("--lock");
  const lock =
    lockPath === undefined
      ? undefined
      : decodeLock(strictJson(NodeFS.readFileSync(NodePath.resolve(lockPath))));
  const policyPath = options.get("--lan-policy");
  const selection = policyPath === undefined ? undefined : readLanBuildPolicyFile(policyPath);
  const checkout = inspectCheckout(root);
  const report = prepareWindowsBuild(
    selection === undefined
      ? checkout
      : {
          ...checkout,
          officialAppId: false,
          officialHomeDefault: false,
          officialProtocols: false,
          officialBranding: false,
        },
    lock,
  );
  if (selection !== undefined) {
    if (lockPath === undefined)
      report.blockers.push("LAN preparation requires --lock and reviewed frozen stage inputs.");
    else {
      try {
        readLanPackagingInputs(selection, NodePath.resolve(lockPath), root);
      } catch (cause) {
        report.blockers.push(
          cause instanceof Error ? cause.message : "Selected LAN build inputs failed validation.",
        );
      }
    }
  }
  console.log(
    encodeReport({
      ...report,
      ready: report.blockers.length === 0,
      target: selection === undefined ? "upstream-default" : "lan",
      ...(selection === undefined
        ? {}
        : { identity: selection.identity, identitySha256: selection.sha256 }),
      compiledArtifactVerified: false,
      executionSupported: selection === undefined ? null : false,
      executionBackend: selection === undefined ? null : "windows-sandbox",
      nativeExecutionVerified: false,
      executionBlockers: selection === undefined ? [] : LAN_WINDOWS_EXECUTION_BLOCKERS,
    }),
  );
}
