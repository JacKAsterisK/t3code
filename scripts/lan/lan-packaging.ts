// @effect-diagnostics nodeBuiltinImport:off - Reads approved public build inputs only; never installs or launches a build.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { BUILD_INPUT_FILES, BuildLock, sha256 } from "./hub-distribution.ts";
import type { LanBuildSelection } from "../lib/lan-build-policy.ts";
import { strictJson } from "../lib/strict-json.ts";
import { releasePackageFiles } from "../update-release-package-versions.ts";
import { verifyProductionStageLockFiles } from "./stage-locks.ts";

export const LAN_STAGE_LOCK_FILES = {
  desktop: "scripts/lan/locks/desktop.pnpm-lock.yaml",
  server: "scripts/lan/locks/server.pnpm-lock.yaml",
} as const;
const decodeLock = Schema.decodeUnknownSync(BuildLock);
export function readLanPackagingInputs(
  selection: LanBuildSelection,
  lockPath: string,
  root: string,
  read: (path: string) => Uint8Array = (path) => NodeFS.readFileSync(path),
) {
  if (!NodePath.isAbsolute(lockPath))
    throw new Error("Supply --lan-build-lock with an absolute approved build lock path.");
  const lockBytes = read(lockPath);
  if (lockBytes.length > 1024 * 1024) throw new Error("LAN build lock is oversized.");
  const lock = decodeLock(strictJson(lockBytes), {
    onExcessProperty: "error",
  });
  if (
    lock.forkCommit !== selection.identity.sourceCommit ||
    lock.applicationVersion !== selection.identity.applicationVersion ||
    lock.wslRuntime !== null
  )
    throw new Error(
      "LAN build lock and immutable policy source/version must agree; WSL is unsupported.",
    );
  const stageLocks: Record<keyof typeof LAN_STAGE_LOCK_FILES, Uint8Array> = {
    desktop: new Uint8Array(),
    server: new Uint8Array(),
  };
  const sourceFiles = new Map<string, Uint8Array>();
  for (const name of new Set([...BUILD_INPUT_FILES, ...Object.values(LAN_STAGE_LOCK_FILES)])) {
    if (!lock.files[name])
      throw new Error(`Approved LAN input is missing from build lock: ${name}.`);
    const bytes = read(NodePath.join(root, name));
    sourceFiles.set(name, bytes);
    if (sha256(bytes) !== lock.files[name])
      throw new Error(`Approved LAN input bytes differ: ${name}.`);
    if (name === LAN_STAGE_LOCK_FILES.desktop) stageLocks.desktop = bytes;
    if (name === LAN_STAGE_LOCK_FILES.server) stageLocks.server = bytes;
  }
  for (const name of releasePackageFiles) {
    const bytes = sourceFiles.get(name);
    const manifest = bytes === undefined ? undefined : strictJson(bytes);
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("version" in manifest) ||
      manifest.version !== selection.identity.applicationVersion
    )
      throw new Error(
        "Align all release package versions before final source commit/build lock; LAN compilation never rewrites tracked inputs.",
      );
  }
  verifyProductionStageLockFiles(root, (relative) => {
    const captured = sourceFiles.get(relative);
    if (captured !== undefined) return captured;
    const bytes = read(NodePath.join(root, relative));
    sourceFiles.set(relative, bytes);
    return bytes;
  });
  return { selection, lockPath, lock, lockBytes, stageLocks };
}
export type LanPackagingInputs = ReturnType<typeof readLanPackagingInputs>;

export function assertLanPackagingTarget(
  input: {
    platform: string;
    arch: string;
    target: string;
    skipBuild: boolean;
    signed: boolean;
    mockUpdates: boolean;
    wslRuntime: string | undefined;
  },
  selection: LanBuildSelection,
) {
  if (
    input.platform !== "win" ||
    input.arch !== "x64" ||
    input.target !== "zip" ||
    input.skipBuild ||
    input.signed ||
    input.mockUpdates ||
    input.wslRuntime !== undefined
  )
    throw new Error(
      "LAN packaging requires Windows x64 ZIP, a fresh compile, no WSL/mock updates and no upstream signing workflow.",
    );
  const name = selection.identity.productName;
  if (
    /[/\\:<>"|?*]/u.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) > 0x7e) ||
    /[ .]$/u.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name)
  )
    throw new Error("LAN product name must also be a safe portable Windows executable name.");
}
