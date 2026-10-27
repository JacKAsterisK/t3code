// @effect-diagnostics nodeBuiltinImport:off - Reuses only separately pinned public native output with the current source, command and toolchain closure.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { sha256 } from "./hub-distribution.ts";
import { relativeWindowsPath, strictJson } from "./windows-artifact.ts";
import { assertValidationRoot, readValidationFile } from "./validate-windows-artifact.ts";
import type { PinnedWindowsBuildCommand } from "./windows-build-execution.ts";

export interface ResourceMonitorCacheDescriptor {
  readonly root: string;
  readonly manifestSha256: string;
}
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Pin = Schema.Struct({ path: Schema.String, length: Schema.Int, sha256: Hash });
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("windows-resource-monitor-cache"),
  target: Schema.Literal("x86_64-pc-windows-msvc"),
  toolchainManifestSha256: Hash,
  recipeSha256: Hash,
  sourceFiles: Schema.Array(Pin),
  output: Pin,
});
const decodeManifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" });
const encode = (value: unknown) => JSON.stringify(value);

export function resourceMonitorRecipeSha256(
  command: PinnedWindowsBuildCommand,
  input: {
    readonly sourceRoot: string;
    readonly outputRoot: string;
    readonly toolchainRoot: string;
    readonly toolchainManifestSha256: string;
  },
) {
  if (!/^[a-f0-9]{64}$/u.test(input.toolchainManifestSha256))
    throw new Error("Native output reuse requires a pinned toolchain recipe.");
  const roots = [
    [input.sourceRoot, "<source>"],
    [input.outputRoot, "<output>"],
    [input.toolchainRoot, "<toolchain>"],
  ] as const;
  for (const [root] of roots)
    if (!NodePath.win32.isAbsolute(root) || root.length < 4)
      throw new Error("Native output reuse requires explicit absolute build roots.");
  const normalize = (raw: string) => {
    let value = raw;
    for (const [root, replacement] of roots) {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      value = value.replace(new RegExp(escaped, "giu"), replacement);
    }
    return value;
  };
  return sha256(
    Buffer.from(
      encode({
        schemaVersion: 1,
        target: "x86_64-pc-windows-msvc",
        toolchainManifestSha256: input.toolchainManifestSha256,
        command: {
          executable: normalize(command.executable),
          args: command.args.map(normalize),
          cwd: normalize(command.cwd),
          env: Object.fromEntries(
            Object.entries(command.env)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, value]) => [key, normalize(value)]),
          ),
        },
      }),
    ),
  );
}

async function captureSourceFiles(sourceRoot: string) {
  // Desktop RepoRoot comes from a directory file URL and retains one final separator.
  // Accept only that spelling of an otherwise canonical absolute source directory.
  const resolved = NodePath.resolve(sourceRoot);
  if (sourceRoot === resolved + NodePath.sep) sourceRoot = resolved;
  await assertValidationRoot(sourceRoot);
  for (let parent = NodePath.dirname(sourceRoot); ; parent = NodePath.dirname(parent)) {
    for (const name of ["config", "config.toml"])
      try {
        await readValidationFile(NodePath.join(parent, ".cargo", name), 8 * 1024 ** 2);
        throw new Error("Native cache refuses unpinned ancestor Cargo configuration.");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    if (NodePath.dirname(parent) === parent) break;
  }
  const files: Array<{ path: string; length: number; sha256: string }> = [];
  let total = 0;
  const add = async (relative: string) => {
    relativeWindowsPath(relative);
    const bytes = await readValidationFile(NodePath.join(sourceRoot, relative), 8 * 1024 ** 2);
    total += bytes.length;
    if (files.length >= 128 || total > 16 * 1024 ** 2)
      throw new Error("Native source closure exceeds its cache bound.");
    files.push({ path: relative, length: bytes.length, sha256: sha256(bytes) });
  };
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("Native source closure is too deep.");
    const current = NodePath.join(sourceRoot, relative);
    await assertValidationRoot(current);
    for (const entry of await NodeFSP.readdir(current, { withFileTypes: true })) {
      if (relative === "native/resource-monitor" && entry.name === "target") continue;
      const child = relative + "/" + entry.name;
      if (entry.isDirectory()) await visit(child, depth + 1);
      else await add(child);
    }
  };
  await visit("native/resource-monitor", 0);
  for (const parent of ["", "native/"])
    for (const name of [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain",
      "rust-toolchain.toml",
      ".cargo/config",
      ".cargo/config.toml",
    ]) {
      const relative = parent + name;
      try {
        await add(relative);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  if (
    !files.some((file) => file.path === "native/resource-monitor/Cargo.lock") ||
    !files.some((file) => file.path === "native/resource-monitor/Cargo.toml") ||
    !files.some((file) => file.path.startsWith("native/resource-monitor/src/"))
  )
    throw new Error("Native source closure is incomplete.");
  return files;
}

export async function captureResourceMonitorCacheManifest(input: {
  readonly sourceRoot: string;
  readonly binaryPath: string;
  readonly recipeSha256: string;
  readonly toolchainManifestSha256: string;
}) {
  const sourceFiles = await captureSourceFiles(input.sourceRoot);
  const bytes = await readValidationFile(input.binaryPath, 32 * 1024 ** 2);
  if (!bytes.length) throw new Error("Native cache output is empty.");
  return decodeManifest({
    schemaVersion: 1,
    kind: "windows-resource-monitor-cache",
    target: "x86_64-pc-windows-msvc",
    toolchainManifestSha256: input.toolchainManifestSha256,
    recipeSha256: input.recipeSha256,
    sourceFiles,
    output: { path: "t3-resource-monitor.exe", length: bytes.length, sha256: sha256(bytes) },
  });
}

export async function readResourceMonitorCache(input: {
  readonly sourceRoot: string;
  readonly descriptor: ResourceMonitorCacheDescriptor;
  readonly recipeSha256: string;
  readonly toolchainManifestSha256: string;
}) {
  await assertValidationRoot(input.descriptor.root);
  const bytes = await readValidationFile(
    NodePath.join(input.descriptor.root, "manifest.json"),
    65536,
  );
  if (sha256(bytes) !== input.descriptor.manifestSha256)
    throw new Error("Approved native cache manifest changed.");
  const manifest = decodeManifest(strictJson(bytes));
  if (
    manifest.recipeSha256 !== input.recipeSha256 ||
    manifest.toolchainManifestSha256 !== input.toolchainManifestSha256
  )
    throw new Error("Native cache recipe differs from the pinned command or toolchain.");
  if (
    manifest.output.path !== "t3-resource-monitor.exe" ||
    manifest.output.length < 1 ||
    manifest.output.length > 32 * 1024 ** 2
  )
    throw new Error("Native cache output pin is invalid.");
  if (encode(await captureSourceFiles(input.sourceRoot)) !== encode(manifest.sourceFiles))
    throw new Error("Native cache source closure differs from the current build.");
  const names = (await NodeFSP.readdir(input.descriptor.root)).sort();
  if (encode(names) !== encode(["manifest.json", "t3-resource-monitor.exe"]))
    throw new Error("Native cache contains foreign output.");
  const output = await readValidationFile(
    NodePath.join(input.descriptor.root, manifest.output.path),
    32 * 1024 ** 2,
  );
  if (output.length !== manifest.output.length || sha256(output) !== manifest.output.sha256)
    throw new Error("Native cache output changed from its approved pin.");
  return output;
}

export async function writeResourceMonitorCache(input: {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly binaryPath: string;
  readonly recipeSha256: string;
  readonly toolchainManifestSha256: string;
}) {
  await assertValidationRoot(input.outputRoot);
  const manifest = await captureResourceMonitorCacheManifest(input);
  const output = await readValidationFile(input.binaryPath, 32 * 1024 ** 2);
  if (output.length !== manifest.output.length || sha256(output) !== manifest.output.sha256)
    throw new Error("Native output changed while capturing its cache receipt.");
  const artifactsRoot = NodePath.join(input.outputRoot, "artifacts");
  await NodeFSP.mkdir(artifactsRoot, { recursive: true });
  await assertValidationRoot(artifactsRoot);
  const root = NodePath.join(artifactsRoot, "resource-monitor-cache");
  // Existing output is preserved for inspection rather than replaced during a build.
  await NodeFSP.mkdir(root);
  await assertValidationRoot(root);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await NodeFSP.writeFile(NodePath.join(root, "t3-resource-monitor.exe"), output, { flag: "wx" });
  await NodeFSP.writeFile(NodePath.join(root, "manifest.json"), bytes, { flag: "wx" });
  const descriptor = { root, manifestSha256: sha256(bytes) };
  await readResourceMonitorCache({ ...input, descriptor });
  return descriptor;
}
