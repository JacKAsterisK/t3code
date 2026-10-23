// @effect-diagnostics nodeBuiltinImport:off - Checks public generated output ownership before any build cleanup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { sha256 } from "./hub-distribution.ts";
import { strictJson } from "../lib/strict-json.ts";

export interface OwnedNativeHelperOutput {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly bytes: number;
  readonly sha256: string;
}

export function assertOwnedNativeHelperFile(file: OwnedNativeHelperOutput) {
  const current = NodeFS.lstatSync(file.path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    current.dev !== file.dev ||
    current.ino !== file.ino ||
    current.size !== file.bytes ||
    sha256(NodeFS.readFileSync(file.path)) !== file.sha256
  )
    throw new Error("Native helper output changed before owned cleanup.");
}

export function inspectNativeHelperOutput(
  outDir: string,
  checkoutRoot: string,
  ownLock?: { readonly dev: number; readonly ino: number },
): readonly OwnedNativeHelperOutput[] {
  if (!NodePath.isAbsolute(outDir) || NodePath.resolve(outDir) !== outDir)
    throw new Error("Native helper output requires a canonical absolute path.");
  let ancestor = outDir;
  for (;;) {
    if (NodeFS.existsSync(ancestor)) {
      const stat = NodeFS.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Native helper output cannot traverse links or non-directories.");
    }
    const parent = NodePath.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!NodeFS.existsSync(outDir)) return [];
  const entries = NodeFS.readdirSync(outDir);
  if (ownLock !== undefined) {
    const lock = NodeFS.lstatSync(NodePath.join(outDir, ".native-helper-build.lock"));
    if (
      !lock.isFile() ||
      lock.isSymbolicLink() ||
      lock.nlink !== 1 ||
      lock.dev !== ownLock.dev ||
      lock.ino !== ownLock.ino
    )
      throw new Error("Native helper build ownership changed.");
  }
  const inventory = entries.filter(
    (name) => ownLock === undefined || name !== ".native-helper-build.lock",
  );
  if (inventory.length === 0) return [];
  if (outDir !== NodePath.join(checkoutRoot, ".t3", "native-maintenance"))
    throw new Error("Native helper staging refuses nonempty foreign output.");
  const manifestPath = NodePath.join(outDir, "manifest.json"),
    stat = NodeFS.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
    throw new Error("Native helper output has no owned build manifest.");
  const manifestBytes = NodeFS.readFileSync(manifestPath);
  const value = strictJson(manifestBytes);
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("kind" in value) ||
    value.kind !== "native-maintenance-test-build" ||
    !("release" in value) ||
    value.release !== false ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 12
  )
    throw new Error("Native helper output has no owned build manifest.");
  const names = ["manifest.json"];
  const owned: OwnedNativeHelperOutput[] = [
    {
      path: manifestPath,
      dev: stat.dev,
      ino: stat.ino,
      bytes: stat.size,
      sha256: sha256(manifestBytes),
    },
  ];
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.name !== "string" ||
      !/^[a-zA-Z0-9_-]+\.mjs$/u.test(file.name) ||
      names.includes(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("Native helper inventory is invalid.");
    const path = NodePath.join(outDir, file.name),
      info = NodeFS.lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size !== file.bytes ||
      sha256(NodeFS.readFileSync(path)) !== file.sha256
    )
      throw new Error("Native helper output changed since its owned manifest.");
    names.push(file.name);
    owned.push({
      path,
      dev: info.dev,
      ino: info.ino,
      bytes: file.bytes,
      sha256: file.sha256,
    });
  }
  if (JSON.stringify(inventory.sort()) !== JSON.stringify([...names].sort()))
    throw new Error("Native helper output contains foreign files.");
  return owned;
}
