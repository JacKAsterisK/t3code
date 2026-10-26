// @effect-diagnostics nodeBuiltinImport:off - Approved installed dependencies are copied into fresh build roots; this does not enforce OS isolation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { sha256 } from "./hub-distribution.ts";
import { relativeWindowsPath, strictJson } from "./windows-artifact.ts";
import { assertValidationRoot, readValidationFile } from "./validate-windows-artifact.ts";

type FilePin = {
  readonly path: string;
  readonly kind: "file";
  readonly length: number;
  readonly sha256: string;
};
type DirectoryPin = { readonly path: string; readonly kind: "directory" };
type LinkPin = { readonly path: string; readonly kind: "link"; readonly target: string };
type Entry = FilePin | DirectoryPin | LinkPin;
export interface NativeDependencyInputs {
  readonly keySha256: string;
  readonly packageRoots: readonly string[];
}
export interface NativeDependencyCacheManifest {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly originRoot: string;
  readonly relocationRoots: Readonly<Record<string, string>>;
  readonly keySha256: string;
  readonly moduleRoots: readonly string[];
  readonly entries: readonly Entry[];
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const hashPattern = /^[a-f0-9]{64}$/u;
const lifecycleNames = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
];
const MAX_ENTRIES = 300000;
const MAX_BYTES = 8 * 1024 ** 3;
const MAX_FILE = 256 * 1024 ** 2;
const keyPaths = (relative: string) =>
  relative === "package.json" ||
  relative.endsWith("/package.json") ||
  ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs"].includes(relative) ||
  relative.startsWith("patches/");

export function nativeDependencyRecipeSha256(
  command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
  roots: Readonly<Record<string, string>>,
) {
  if (command.env.SOURCE_DATE_EPOCH !== "0")
    throw new Error("Reusable dependency installation requires its stable zero build epoch.");
  const hookFlags = command.args.filter((arg) =>
    /^--(?:no-)?(?:config\.)?ignore[-_]?pnpmfile(?:=|$)/iu.test(arg),
  );
  const hookEnvironment = Object.entries(command.env).filter(
    ([name]) => name.toLowerCase() === "npm_config_ignore_pnpmfile",
  );
  const separator = command.args.indexOf("--");
  if (
    hookFlags.length !== 1 ||
    hookFlags[0] !== "--ignore-pnpmfile" ||
    (separator >= 0 && command.args.indexOf("--ignore-pnpmfile") > separator) ||
    hookEnvironment.length !== 1 ||
    command.env.npm_config_ignore_pnpmfile !== "true"
  )
    throw new Error("Dependency reuse requires both explicit package-manager hook ignore guards.");
  const entries = Object.entries(roots).sort(([, a], [, b]) => b.length - a.length);
  for (const [name, root] of entries) {
    if (!/^[A-Z_]+$/u.test(name)) throw new Error("Invalid dependency recipe root name.");
    canonical(root);
  }
  const normalize = (value: string) => {
    for (const [name, root] of entries) {
      value = value.split(root).join("<" + name + ">");
      value = value.split(root.split(NodePath.sep).join("/")).join("<" + name + ">");
    }
    return value;
  };
  return sha256(
    encode({
      schemaVersion: 1,
      executable: normalize(command.executable),
      args: command.args.map(normalize),
      cwd: normalize(command.cwd),
      env: Object.fromEntries(
        Object.entries(command.env)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, value]) => [name, normalize(value)]),
      ),
    }),
  );
}

export function nativeDependencyInputs(
  files: ReadonlyMap<string, Uint8Array>,
  toolchainManifestSha256: string,
  recipeSha256: string,
): NativeDependencyInputs {
  if (!hashPattern.test(toolchainManifestSha256) || !hashPattern.test(recipeSha256))
    throw new Error("Dependency reuse requires the exact toolchain inventory digest.");
  const pins: Array<{ path: string; length: number; sha256: string }> = [];
  const packageRoots: string[] = [];
  const localFiles = new Set<string>();
  for (const [relative, bytes] of files) {
    // Only the root hook disabled by both validated recipe guards is approved.
    // Its bytes still participate in the key; other hook/config surfaces fail closed.
    if (
      relative !== ".pnpmfile.cjs" &&
      /(?:^|\/)(?:\.pnpmfile\.[cm]?js|pnpm\.config\.[^/]+)$/u.test(relative)
    )
      throw new Error("Dependency reuse refuses an unreviewed package-manager hook.");
    if (!(relative === "package.json" || relative.endsWith("/package.json"))) continue;
    const value = strictJson(bytes) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    for (const name of lifecycleNames) {
      const script = value.scripts?.[name];
      if (
        script !== undefined &&
        !(relative === "package.json" && name === "prepare" && script === "vp config --no-agent")
      )
        throw new Error("Dependency reuse refuses an unreviewed workspace lifecycle script.");
    }
    const packageRoot =
      relative === "package.json" ? "" : relative.slice(0, -"/package.json".length);
    packageRoots.push(packageRoot);
    for (const group of [value.dependencies, value.devDependencies, value.optionalDependencies])
      for (const dependency of Object.values(group ?? {})) {
        if (typeof dependency !== "string" || !dependency.startsWith("file:")) continue;
        if (
          NodePath.posix.isAbsolute(dependency.slice(5)) ||
          NodePath.win32.isAbsolute(dependency.slice(5))
        )
          throw new Error("Dependency reuse refuses an absolute local file dependency.");
        const target = NodePath.posix.normalize(
          NodePath.posix.join(packageRoot, dependency.slice(5)),
        );
        if (target !== ".") relativeWindowsPath(target);
        if (
          ![...files.keys()].some(
            (file) => target === "." || file === target || file.startsWith(target + "/"),
          )
        )
          throw new Error("Dependency reuse has an uncaptured local file dependency.");
        localFiles.add(target);
      }
  }
  for (const [relative, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (
      !keyPaths(relative) &&
      relative !== "scripts/lan/windows-build-execution.ts" &&
      !relative.endsWith("/.npmrc") &&
      ![...localFiles].some(
        (local) => local === "." || relative === local || relative.startsWith(local + "/"),
      )
    )
      continue;
    relativeWindowsPath(relative);
    if (
      (relative === "pnpm-workspace.yaml" || relative.endsWith(".npmrc")) &&
      /^\s*(?:pnpmfile|globalPnpmfile|global-pnpmfile|hooksDir|configDependencies)\s*[:=]/imu.test(
        Buffer.from(bytes).toString("utf8"),
      )
    )
      throw new Error("Dependency reuse refuses an unreviewed package-manager hook.");
    pins.push({ path: relative, length: bytes.length, sha256: sha256(bytes) });
  }
  packageRoots.sort();
  for (const required of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/lan/windows-build-execution.ts",
  ])
    if (!pins.some((pin) => pin.path === required))
      throw new Error("Dependency reuse installation inputs are incomplete.");
  return {
    keySha256: sha256(
      encode({
        schemaVersion: 1,
        strategy: "pnpm12-native-copy-relocate-v1",
        toolchainManifestSha256,
        recipeSha256,
        pins,
      }),
    ),
    packageRoots,
  };
}

const inside = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(".." + NodePath.sep) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};
function canonical(root: string) {
  if (
    root.startsWith("\\\\") ||
    !NodePath.isAbsolute(root) ||
    NodePath.resolve(root) !== root ||
    /(?:^|[\\/])(?:\.t3|T3CodeLAN)(?:[\\/]|$)/iu.test(root)
  )
    throw new Error("Dependency cache requires a canonical local path outside T3 homes.");
}
export function assertNativeDependencyCacheSeparation(root: string, others: readonly string[]) {
  canonical(root);
  for (const other of others)
    if (inside(root, other) || inside(other, root))
      throw new Error(
        "Dependency cache must be separate from source, tools, inputs and build output.",
      );
}
async function missing(file: string) {
  try {
    await NodeFSP.lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
const isWithinModules = (relative: string, roots: readonly string[]) =>
  roots.some((root) => relative === root || relative.startsWith(root + "/"));
const isRelocatedMetadata = (relative: string) =>
  /(?:^|\/)node_modules\/(?:\.modules\.yaml|\.pnpm-workspace-state-v1\.json)$/u.test(relative) ||
  /(?:^|\/)node_modules\/\.bin\/[^/]+$/u.test(relative);
function dependencyRelocationRoots(
  sourceRoot: string,
  supplied: Readonly<Record<string, string>> | undefined,
) {
  const roots = supplied ?? { SOURCE: sourceRoot };
  if (roots.SOURCE !== sourceRoot || Object.keys(roots).length > 8)
    throw new Error("Dependency cache relocation roots are incomplete.");
  for (const [name, root] of Object.entries(roots)) {
    if (!/^[A-Z_]+$/u.test(name)) throw new Error("Invalid dependency cache relocation root.");
    canonical(root);
  }
  return roots;
}
function materializedBytes(
  bytes: Uint8Array,
  relative: string,
  origins: Readonly<Record<string, string>>,
  targets: Readonly<Record<string, string>>,
) {
  if (!isRelocatedMetadata(relative)) return bytes;
  let text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text).equals(Buffer.from(bytes)))
    throw new Error("Generated dependency metadata is not UTF-8.");
  const entries = Object.entries(origins).sort(([, a], [, b]) => b.length - a.length);
  for (const [name, origin] of entries) {
    const target = targets[name];
    if (target === undefined) throw new Error("Dependency cache relocation target is missing.");
    for (const [before, after] of [
      [JSON.stringify(origin).slice(1, -1), JSON.stringify(target).slice(1, -1)],
      [origin, target],
      [origin.split(NodePath.sep).join("/"), target.split(NodePath.sep).join("/")],
    ])
      text = text.split(before!).join(after!);
  }
  return Buffer.from(text);
}

async function eachBatch<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  size: (item: T) => number = () => 0,
) {
  for (let index = 0; index < items.length;) {
    const batch: T[] = [];
    let bytes = 0;
    while (index < items.length && batch.length < 32) {
      const item = items[index]!;
      if (batch.length && bytes + size(item) > 32 * 1024 ** 2) break;
      batch.push(item);
      bytes += size(item);
      index++;
    }
    const results = await Promise.allSettled(batch.map(fn));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}
async function scanModules(sourceRoot: string, moduleRoots: readonly string[]) {
  const entries: Entry[] = [];
  let bytes = 0;
  const pending: Array<{ relative: string; length: number }> = [];
  let pendingBytes = 0;
  const flush = async () => {
    const batch = pending.splice(0);
    pendingBytes = 0;
    await eachBatch(
      batch,
      async ({ relative, length }) => {
        const content = await readValidationFile(NodePath.join(sourceRoot, relative), length);
        if (content.length !== length) throw new Error("Dependency file changed during capture.");
        bytes += content.length;
        if (bytes > MAX_BYTES) throw new Error("Dependency cache exceeds its byte bound.");
        entries.push({
          path: relative,
          kind: "file",
          length: content.length,
          sha256: sha256(content),
        });
      },
      (entry) => entry.length,
    );
  };
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 64 || entries.length + pending.length >= MAX_ENTRIES)
      throw new Error("Dependency cache exceeds its bounded tree size.");
    relativeWindowsPath(relative);
    const file = NodePath.join(sourceRoot, relative),
      stat = await NodeFSP.lstat(file);
    if (stat.isSymbolicLink()) {
      const destination = await NodeFSP.realpath(file);
      if (!inside(destination, sourceRoot))
        throw new Error("Dependency link escapes its source tree.");
      const target = NodePath.relative(sourceRoot, destination).split(NodePath.sep).join("/");
      if (target) relativeWindowsPath(target);
      entries.push({ path: relative, kind: "link", target });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of await NodeFSP.readdir(file)) await visit(relative + "/" + name, depth + 1);
    } else if (stat.isFile() && stat.size <= MAX_FILE) {
      if (pending.length && pendingBytes + stat.size > 32 * 1024 ** 2) await flush();
      pending.push({ relative, length: stat.size });
      pendingBytes += stat.size;
      if (pending.length === 32) await flush();
    } else throw new Error("Dependency cache contains a special or oversized file.");
  };
  for (const root of moduleRoots) await visit(root, 0);
  await flush();
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export async function captureNativeDependencyCache(input: {
  readonly sourceRoot: string;
  readonly cacheRoot: string;
  readonly sourceCommit: string;
  readonly inputs: NativeDependencyInputs;
  readonly relocationRoots?: Readonly<Record<string, string>>;
}) {
  canonical(input.sourceRoot);
  assertNativeDependencyCacheSeparation(input.cacheRoot, [input.sourceRoot]);
  await assertValidationRoot(input.sourceRoot);
  await assertValidationRoot(NodePath.dirname(input.cacheRoot));
  if (!/^[a-f0-9]{40}$/u.test(input.sourceCommit) || !hashPattern.test(input.inputs.keySha256))
    throw new Error("Dependency cache provenance is incomplete.");
  const moduleRoots: string[] = [];
  for (const packageRoot of input.inputs.packageRoots) {
    const relative = packageRoot ? packageRoot + "/node_modules" : "node_modules";
    if (!(await missing(NodePath.join(input.sourceRoot, relative)))) moduleRoots.push(relative);
  }
  if (!moduleRoots.includes("node_modules"))
    throw new Error("Dependency capture requires an installed workspace.");
  const entries = await scanModules(input.sourceRoot, moduleRoots);
  const relocationRoots = dependencyRelocationRoots(input.sourceRoot, input.relocationRoots);
  const manifest: NativeDependencyCacheManifest = {
    schemaVersion: 1,
    sourceCommit: input.sourceCommit,
    originRoot: input.sourceRoot,
    relocationRoots,
    keySha256: input.inputs.keySha256,
    moduleRoots,
    entries,
  };
  await NodeFSP.mkdir(input.cacheRoot);
  const payload = NodePath.join(input.cacheRoot, "payload");
  await NodeFSP.mkdir(payload);
  for (const entry of entries)
    if (entry.kind === "directory")
      await NodeFSP.mkdir(NodePath.join(payload, entry.path), { recursive: true });
  await eachBatch(
    entries.filter((entry): entry is FilePin => entry.kind === "file"),
    async (entry) => {
      const content = await readValidationFile(
        NodePath.join(input.sourceRoot, entry.path),
        entry.length,
      );
      if (content.length !== entry.length || sha256(content) !== entry.sha256)
        throw new Error("Installed dependency changed during cache capture.");
      await assertValidationRoot(NodePath.dirname(NodePath.join(payload, entry.path)));
      await NodeFSP.writeFile(NodePath.join(payload, entry.path), content, {
        flag: "wx",
        mode: 0o600,
      });
    },
    (entry) => entry.length,
  );
  if (JSON.stringify(await scanModules(input.sourceRoot, moduleRoots)) !== JSON.stringify(entries))
    throw new Error("Installed dependency tree changed during cache capture.");
  const bytes = encode(manifest);
  await NodeFSP.writeFile(NodePath.join(input.cacheRoot, "manifest.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    root: input.cacheRoot,
    manifestSha256: sha256(bytes),
    files: entries.filter((entry) => entry.kind === "file").length,
    links: entries.filter((entry) => entry.kind === "link").length,
    byteLength: entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.length : 0), 0),
  };
}

function decodeManifest(bytes: Uint8Array, expectedInputs: NativeDependencyInputs) {
  const value = strictJson(bytes) as NativeDependencyCacheManifest;
  if (
    value.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/u.test(value.sourceCommit) ||
    value.keySha256 !== expectedInputs.keySha256 ||
    !Array.isArray(value.moduleRoots) ||
    !value.moduleRoots.includes("node_modules") ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > MAX_ENTRIES
  )
    throw new Error("Approved dependency cache has incompatible installation inputs.");
  canonical(value.originRoot);
  dependencyRelocationRoots(value.originRoot, value.relocationRoots);
  if (!value.relocationRoots)
    throw new Error("Approved dependency cache lacks relocation provenance.");
  const expectedRoots = new Set(
    expectedInputs.packageRoots.map((root) => (root ? root + "/node_modules" : "node_modules")),
  );
  for (const root of value.moduleRoots)
    if (!expectedRoots.has(root))
      throw new Error("Approved dependency cache has an unknown workspace root.");
  const names = new Set<string>();
  let total = 0;
  for (const entry of value.entries) {
    relativeWindowsPath(entry.path);
    if (!isWithinModules(entry.path, value.moduleRoots) || names.has(entry.path.toLowerCase()))
      throw new Error("Approved dependency cache has an escaping or duplicate entry.");
    names.add(entry.path.toLowerCase());
    if (entry.kind === "file") {
      if (
        !Number.isSafeInteger(entry.length) ||
        entry.length < 0 ||
        entry.length > MAX_FILE ||
        !hashPattern.test(entry.sha256)
      )
        throw new Error("Approved dependency cache has an invalid file pin.");
      total += entry.length;
    } else if (entry.kind === "link") {
      if (entry.target) relativeWindowsPath(entry.target);
      if (
        !isWithinModules(entry.target, value.moduleRoots) &&
        !expectedInputs.packageRoots.includes(entry.target)
      )
        throw new Error("Approved dependency cache link escapes the workspace or dependencies.");
    } else if (entry.kind !== "directory")
      throw new Error("Approved dependency cache has an unknown entry kind.");
  }
  if (total > MAX_BYTES) throw new Error("Approved dependency cache exceeds the byte bound.");
  const directories = new Set(
    value.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  );
  for (const entry of value.entries) {
    const parent = entry.path.split("/").slice(0, -1).join("/");
    if (!value.moduleRoots.includes(entry.path) && !directories.has(parent))
      throw new Error("Approved dependency cache entry lacks its directory parent.");
  }
  return value;
}

export async function restoreNativeDependencyCache(input: {
  readonly sourceRoot: string;
  readonly cache: { readonly root: string; readonly manifestSha256: string };
  readonly inputs: NativeDependencyInputs;
  readonly relocationRoots?: Readonly<Record<string, string>>;
}) {
  canonical(input.sourceRoot);
  assertNativeDependencyCacheSeparation(input.cache.root, [input.sourceRoot]);
  await assertValidationRoot(input.sourceRoot);
  await assertValidationRoot(input.cache.root);
  if (!hashPattern.test(input.cache.manifestSha256))
    throw new Error("Dependency reuse requires a separately approved manifest digest.");
  const bytes = await readValidationFile(
    NodePath.join(input.cache.root, "manifest.json"),
    64 * 1024 ** 2,
  );
  if (sha256(bytes) !== input.cache.manifestSha256)
    throw new Error("Approved dependency cache manifest changed.");
  const targets = dependencyRelocationRoots(input.sourceRoot, input.relocationRoots);
  const manifest = decodeManifest(bytes, input.inputs),
    payload = NodePath.join(input.cache.root, "payload");
  if (Object.keys(manifest.relocationRoots).sort().join() !== Object.keys(targets).sort().join())
    throw new Error("Dependency cache relocation roots changed.");
  await assertValidationRoot(payload);
  for (const root of manifest.moduleRoots)
    if (!(await missing(NodePath.join(input.sourceRoot, root))))
      throw new Error("Dependency restore never overwrites an existing workspace installation.");
  // Every ordinary byte is copied independently. Junctions are rebuilt against
  // this snapshot, so no workspace package resolves back into the cache origin.
  const directories = manifest.entries.filter(
    (entry): entry is DirectoryPin => entry.kind === "directory",
  );
  for (const directory of directories.sort((a, b) => a.path.length - b.path.length)) {
    await assertValidationRoot(NodePath.dirname(NodePath.join(input.sourceRoot, directory.path)));
    await NodeFSP.mkdir(NodePath.join(input.sourceRoot, directory.path));
  }
  const files = manifest.entries.filter((entry): entry is FilePin => entry.kind === "file");
  await eachBatch(
    files,
    async (entry) => {
      const original = await readValidationFile(NodePath.join(payload, entry.path), entry.length);
      if (original.length !== entry.length || sha256(original) !== entry.sha256)
        throw new Error("Approved dependency cache content changed.");
      const output = NodePath.join(input.sourceRoot, entry.path);
      await assertValidationRoot(NodePath.dirname(output));
      await NodeFSP.writeFile(
        output,
        materializedBytes(original, entry.path, manifest.relocationRoots, targets),
        { flag: "wx", mode: 0o600 },
      );
    },
    (entry) => entry.length,
  );
  const links = manifest.entries.filter((entry): entry is LinkPin => entry.kind === "link");
  for (const link of links) {
    const output = NodePath.join(input.sourceRoot, link.path),
      target = NodePath.join(input.sourceRoot, link.target);
    await assertValidationRoot(NodePath.dirname(output));
    await assertValidationRoot(target);
    await NodeFSP.symlink(target, output, "junction");
  }
  await eachBatch(
    files,
    async (entry) => {
      const original = await readValidationFile(NodePath.join(payload, entry.path), entry.length);
      if (original.length !== entry.length || sha256(original) !== entry.sha256)
        throw new Error("Dependency cache content changed during restore.");
      const expected = materializedBytes(original, entry.path, manifest.relocationRoots, targets);
      const actual = await readValidationFile(
        NodePath.join(input.sourceRoot, entry.path),
        expected.length,
      );
      if (actual.length !== expected.length || sha256(actual) !== sha256(expected))
        throw new Error("Restored dependency differs from approved bytes.");
    },
    (entry) => entry.length,
  );
  for (const link of links)
    if (
      (await NodeFSP.realpath(NodePath.join(input.sourceRoot, link.path))) !==
      NodePath.join(input.sourceRoot, link.target)
    )
      throw new Error("Restored dependency link changed.");
  if (
    sha256(
      await readValidationFile(NodePath.join(input.cache.root, "manifest.json"), bytes.length),
    ) !== input.cache.manifestSha256
  )
    throw new Error("Dependency cache manifest changed during restore.");
  return {
    files: files.length,
    links: links.length,
    byteLength: files.reduce((sum, entry) => sum + entry.length, 0),
    independentlyCopied: true,
  };
}
