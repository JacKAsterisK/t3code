// @effect-diagnostics nodeBuiltinImport:off - Reads public dependency locks and patch bytes; never installs or starts subprocesses.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import {
  deriveWindowsProductionStages,
  type WindowsProductionStage,
} from "../lib/production-stage.ts";
import { strictJson } from "../lib/strict-json.ts";
import { relativeWindowsPath } from "./windows-artifact.ts";

const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
const encodeYaml = Schema.encodeSync(fromYaml(Schema.Unknown));
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
};
const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const map = (value: unknown, label: string) => (value === undefined ? {} : record(value, label));
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
};
const base = (snapshot: string) => snapshot.split("(", 1)[0]!;
const refKey = (name: string, reference: string) =>
  reference.startsWith("@") || /^[a-z][a-z0-9._-]*@/u.test(reference)
    ? reference
    : `${name}@${reference}`;
const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function lockDocumentTexts(bytes: Uint8Array) {
  if (bytes.length > 16 * 1024 ** 2) throw new Error("Dependency lock exceeds bounds.");
  const documents = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .split(/^---[ \t]*\r?$/mu)
    .filter((document) => document.trim());
  if (documents.length !== 2)
    throw new Error(
      "Pinned pnpm 12 locks require exactly two documents: bootstrap and dependency graph.",
    );
  return documents;
}

function readLockDocuments(bytes: Uint8Array) {
  const documents = lockDocumentTexts(bytes);
  const locks = documents.map((document) => record(decodeYaml(document), "pnpm lock"));
  if (documents.length === 2) {
    const header = locks[0]!;
    const importer = record(
      record(header.importers, "bootstrap importers")["."],
      "bootstrap importer",
    );
    const manager = record(
      record(importer.packageManagerDependencies, "bootstrap manager").pnpm,
      "bootstrap pnpm",
    );
    if (
      header.settings !== undefined ||
      manager.specifier !== "12.14.0" ||
      manager.version !== "12.14.0"
    )
      throw new Error("Unexpected package-manager bootstrap document.");
  }
  return locks;
}

export function encodeProductionStageLock(
  rootLockBytes: Uint8Array,
  graph: Record<string, unknown>,
) {
  const [, root] = readLockDocuments(rootLockBytes);
  const documents = lockDocumentTexts(rootLockBytes);
  const blocks = (source: string, indent: number) => {
    const matches = [...source.matchAll(new RegExp(`^ {${indent}}(?!: )\\S.*$`, "gmu"))];
    const entries = matches.map((match, index) => {
      let header: Record<string, unknown>;
      try {
        header = record(decodeYaml(match[0]!.trimStart()), "lock block header");
      } catch {
        throw new Error(`Unsupported lock block header: ${match[0]!.trimStart()}`);
      }
      const keys = Object.keys(header);
      if (keys.length !== 1 || keys[0] === "?") throw new Error("Unsupported lock block header.");
      return [keys[0]!, source.slice(match.index, matches[index + 1]?.index).trimEnd()] as const;
    });
    if (new Set(entries.map(([name]) => name)).size !== entries.length)
      throw new Error("Duplicate lock block header.");
    return new Map(entries);
  };
  const rootBlocks = blocks(documents[1]!, 0);
  if (!same([...rootBlocks.keys()], Object.keys(root!)))
    throw new Error("Unsupported multiline lock block boundary.");
  const scalar = (value: unknown) => {
    const result = encodeYaml(value).trimEnd();
    if (result.includes("\n")) throw new Error("Unsupported multiline lock scalar.");
    return result.startsWith('"') ? `'${String(value).replaceAll("'", "''")}'` : result;
  };
  const emit = (value: unknown, indent: number): string => {
    const prefix = " ".repeat(indent);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Unsupported lock importer.");
    const entries = Object.entries(value);
    if (indent === 6) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries
      .map(([key, child]) =>
        typeof child === "object" &&
        child !== null &&
        !Array.isArray(child) &&
        Object.keys(child).length
          ? `${prefix}${scalar(key)}:\n${emit(child, indent + 2)}`
          : `${prefix}${scalar(key)}: ${scalar(child)}`,
      )
      .join("\n");
  };
  const section = (name: string) => {
    if (same(graph[name], root![name])) return rootBlocks.get(name)!;
    if (["packages", "snapshots", "patchedDependencies"].includes(name)) {
      const wanted = record(graph[name], "projected lock entries");
      if (!Object.keys(wanted).length) return `${name}: {}`;
      const originals = map(root![name], "root lock entries");
      const originalBlocks = blocks(rootBlocks.get(name) ?? "", 2);
      if (!same([...originalBlocks.keys()], Object.keys(originals)))
        throw new Error("Unsupported multiline lock entry boundary.");
      const order = [...originalBlocks.keys()].filter((key) => Object.hasOwn(wanted, key));
      order.push(
        ...Object.keys(wanted)
          .filter((key) => !originalBlocks.has(key))
          .sort(),
      );
      const entries = order.map((key) =>
        same(wanted[key], originals[key])
          ? originalBlocks.get(key)!
          : encodeYaml({ [key]: wanted[key] })
              .trimEnd()
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n"),
      );
      const gap = name === "patchedDependencies" ? "\n" : "\n\n";
      return `${name}:${name === "patchedDependencies" ? "\n" : "\n\n"}${entries.join(gap)}`;
    }
    if (name === "importers") {
      const importers = record(graph.importers, "projected importers");
      return `importers:\n\n${Object.entries(importers)
        .map(([key, value]) => `  ${scalar(key)}:\n${emit(value, 4)}`)
        .join("\n\n")}`;
    }
    return encodeYaml({ [name]: graph[name] }).trimEnd();
  };
  // Reusing parsed-and-verified source blocks preserves pnpm's canonical flow
  // metadata and blank lines without reproducing its complete YAML formatter.
  // The independent graph verifier below rejects altered or missing fields.
  const order = [
    "lockfileVersion",
    "settings",
    "overrides",
    "packageExtensionsChecksum",
    "patchedDependencies",
    "importers",
    "packages",
    "snapshots",
  ];
  const keys = [
    ...order.filter((key) => Object.hasOwn(graph, key)),
    ...Object.keys(graph).filter((key) => !order.includes(key)),
  ];
  return Buffer.from(
    `---\n${documents[0]!.trim()}\n---\n${keys
      .filter((key) => graph[key] !== undefined)
      .map(section)
      .join("\n\n")}\n`,
  );
}

export function readWorkspaceLock(bytes: Uint8Array, _sourceWorkspace = false) {
  const locks = readLockDocuments(bytes);
  const candidates = locks.filter(
    (lock) => lock.settings !== undefined && lock.snapshots !== undefined,
  );
  if (candidates.length !== 1) throw new Error("Expected one workspace dependency graph.");
  const lock = candidates[0]!;
  if (String(lock.lockfileVersion) !== "9.0") throw new Error("Unsupported pnpm lock version.");
  record(lock.importers, "lock importers");
  record(lock.packages, "lock packages");
  record(lock.snapshots, "lock snapshots");
  return lock;
}

// pnpm's object-hash checksum for the plain string/boolean metadata used here.
// Other forms require a reviewed implementation instead of a guessed checksum.
export function stageExtensionsChecksum(value: unknown) {
  if (Object.keys(record(value, "package extensions")).length === 0) return undefined;
  const visit = (value: unknown): string => {
    if (typeof value === "string") return `string:${value.length}:${value}`;
    if (typeof value === "boolean") return `bool:${value}`;
    const entries = Object.entries(record(value, "stage package extensions")).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `object:${entries.length}:${entries.map(([key, item]) => `${visit(key)}:${visit(item)},`).join("")}`;
  };
  return `sha256-${NodeCrypto.createHash("sha256").update(visit(value)).digest("base64")}`;
}

function roots(stage: WindowsProductionStage, rootLock: Record<string, unknown>) {
  const rootImporters = record(rootLock.importers, "root importers");
  const importer = record(
    rootImporters[stage.workspace.nodeLinker === "hoisted" ? "apps/server" : "apps/desktop"],
    "source importer",
  );
  const snapshots = record(rootLock.snapshots, "root snapshots");
  const result: Record<string, Record<string, { specifier: string; version: string }>> = {};
  for (const section of sections) {
    const dependencies = map(
      stage.packageJson[section as keyof typeof stage.packageJson],
      "stage dependencies",
    );
    for (const [name, specifier] of Object.entries(dependencies)) {
      let entry: unknown;
      for (const sourceSection of sections)
        entry ??= map(importer[sourceSection], "source dependencies")[name];
      let version: string;
      if (entry !== undefined)
        version = text(record(entry, "source dependency").version, "source version");
      else {
        const exact = `${name}@${text(specifier, "native dependency version")}`;
        if (!Object.hasOwn(snapshots, exact))
          throw new Error(`No existing locked resolution for ${name}.`);
        version = text(specifier, "native dependency version");
      }
      (result[section] ??= {})[name] = { specifier: text(specifier, "stage specifier"), version };
    }
  }
  return result;
}

export function createStageLockSeed(stage: WindowsProductionStage, rootLockBytes: Uint8Array) {
  const root = readWorkspaceLock(rootLockBytes, true);
  // Root hooks and catalogs do not apply to the standalone stages. Projection
  // preserves the resolved graph and replaces only the extension checksum.
  const { pnpmfileChecksum: _hook, catalogs: _catalogs, ...seed } = root;
  const rootPatches = map(root.patchedDependencies, "root patches");
  const importer = roots(stage, root);
  const originalSnapshots = record(root.snapshots, "root snapshots"),
    originalPackages = record(root.packages, "root packages");
  const pending = Object.values(importer).flatMap((section) =>
    Object.entries(section).map(([name, entry]) => refKey(name, entry.version)),
  );
  const snapshots: Record<string, unknown> = {},
    packages: Record<string, unknown> = {};
  for (let index = 0; index < pending.length; index++) {
    const key = pending[index]!;
    if (Object.hasOwn(snapshots, key)) continue;
    const snapshot = record(originalSnapshots[key], `source closure ${key}`),
      packageKey = base(key);
    snapshots[key] = snapshot;
    packages[packageKey] = record(originalPackages[packageKey], `source package ${packageKey}`);
    for (const section of ["dependencies", "optionalDependencies"] as const)
      for (const [name, value] of Object.entries(map(snapshot[section], "source closure edges")))
        pending.push(refKey(name, text(value, "source closure version")));
  }
  return encodeProductionStageLock(rootLockBytes, {
    ...seed,
    importers: { ".": importer },
    packages,
    snapshots,
    patchedDependencies: Object.fromEntries(
      Object.keys(stage.workspace.patchedDependencies ?? {}).map((key) => {
        if (rootPatches[key] === undefined) throw new Error(`No existing patch pin for ${key}.`);
        return [key, rootPatches[key]];
      }),
    ),
  });
}

export function verifyProductionStageLock(input: {
  readonly stage: WindowsProductionStage;
  readonly lockBytes: Uint8Array;
  readonly rootLockBytes: Uint8Array;
  readonly readPatch: (relative: string) => Uint8Array;
  readonly sourcePackageExtensions: unknown;
}) {
  const { stage } = input;
  const lock = readWorkspaceLock(input.lockBytes),
    root = readWorkspaceLock(input.rootLockBytes, true);
  if (!same(readLockDocuments(input.lockBytes)[0], readLockDocuments(input.rootLockBytes)[0]))
    throw new Error("Stage package-manager bootstrap differs from the exact root lock.");
  if (root.packageExtensionsChecksum !== stageExtensionsChecksum(input.sourcePackageExtensions))
    throw new Error("Source package-extension checksum does not match the existing root lock.");
  const importers = record(lock.importers, "stage importers");
  if (!same(Object.keys(importers), ["."]))
    throw new Error("Stage lock must contain only its exact importer.");
  const importer = record(importers["."], "stage importer"),
    expected = roots(stage, root);
  if (
    !same(lock.overrides ?? {}, stage.workspace.overrides ?? {}) ||
    lock.pnpmfileChecksum !== undefined ||
    lock.packageExtensionsChecksum !== stageExtensionsChecksum(stage.workspace.packageExtensions)
  )
    throw new Error("Stage lock configuration/checksum differs from the generated workspace.");
  if (!same(lock.settings, root.settings))
    throw new Error("Stage lock settings differ from the root resolution.");
  const rootPackages = record(root.packages, "root packages"),
    packages = record(lock.packages, "stage packages");
  const rootSnapshots = record(root.snapshots, "root snapshots"),
    snapshots = record(lock.snapshots, "stage snapshots");
  const queued: string[] = [];
  for (const section of sections) {
    const actual = map(importer[section], "stage importer dependencies");
    if (!same(Object.keys(actual).sort(), Object.keys(expected[section] ?? {}).sort()))
      throw new Error("Stage lock importer differs from the generated manifest.");
    for (const [name, expectedEntry] of Object.entries(expected[section] ?? {})) {
      const entry = record(actual[name], "locked dependency");
      if (
        entry.specifier !== expectedEntry.specifier ||
        text(entry.version, "locked version") !== expectedEntry.version
      )
        throw new Error(`Stage root resolution differs: ${name}.`);
      queued.push(refKey(name, text(entry.version, "locked version")));
    }
  }
  const expectedPatches = Object.keys(stage.workspace.patchedDependencies ?? {}).sort();
  const patches = map(lock.patchedDependencies, "stage patches");
  if (!same(Object.keys(patches).sort(), expectedPatches))
    throw new Error("Stage patch selection differs.");
  for (const key of expectedPatches) {
    relativeWindowsPath(stage.workspace.patchedDependencies![key]!);
    const pin =
      typeof patches[key] === "string" ? patches[key] : record(patches[key], "patch pin").hash;
    if (
      !same(patches[key], map(root.patchedDependencies, "root patches")[key]) ||
      digest(input.readPatch(stage.workspace.patchedDependencies![key]!)) !== pin
    )
      throw new Error(`Stage patch bytes differ: ${key}.`);
  }
  const visited = new Set<string>();
  for (let index = 0; index < queued.length; index++) {
    const key = queued[index]!;
    if (visited.has(key)) continue;
    visited.add(key);
    if (key.startsWith(`${base(key)}(patch_hash=`) && !Object.hasOwn(patches, base(key)))
      throw new Error(`A reachable patched package is not selected by the stage: ${base(key)}.`);
    const snapshot = record(snapshots[key], `stage snapshot ${key}`),
      packageKey = base(key);
    const pkg = record(packages[packageKey], `stage package ${packageKey}`),
      original = record(rootPackages[packageKey], `root package ${packageKey}`);
    if (!same(pkg, original)) throw new Error(`Stage package metadata differs: ${packageKey}.`);
    if (!same(snapshot, rootSnapshots[key]))
      throw new Error(`Stage snapshot/peer context differs: ${key}.`);
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      for (const [name, value] of Object.entries(map(snapshot[section], "snapshot dependencies"))) {
        const target = refKey(name, text(value, "snapshot version"));
        queued.push(target);
      }
    }
  }
  if (!same([...visited].sort(), Object.keys(snapshots).sort()))
    throw new Error("Stage lock contains unreachable or missing snapshots.");
  if (!same([...new Set([...visited].map(base))].sort(), Object.keys(packages).sort()))
    throw new Error("Stage lock package inventory differs from its dependency closure.");
  const expectedLock = readWorkspaceLock(createStageLockSeed(stage, input.rootLockBytes));
  expectedLock.packageExtensionsChecksum = stageExtensionsChecksum(
    stage.workspace.packageExtensions,
  );
  if (!same(lock, expectedLock))
    throw new Error("Stage lock differs from the exact root projection.");
  return {
    sha256: digest(input.lockBytes),
    snapshots: visited.size,
    packageManagerVerificationRequired: "pnpm@12.14.0" as const,
  };
}

export function projectProductionStageLock(input: {
  readonly stage: WindowsProductionStage;
  readonly rootLockBytes: Uint8Array;
  readonly readPatch: (relative: string) => Uint8Array;
  readonly sourcePackageExtensions: unknown;
}) {
  const lock = readWorkspaceLock(createStageLockSeed(input.stage, input.rootLockBytes));
  lock.packageExtensionsChecksum = stageExtensionsChecksum(input.stage.workspace.packageExtensions);
  const lockBytes = encodeProductionStageLock(input.rootLockBytes, lock);
  return { lockBytes, report: verifyProductionStageLock({ ...input, lockBytes }) };
}

export function verifyProductionStageLockFiles(
  root: string,
  read: (relative: string) => Uint8Array = (relative) =>
    NodeFS.readFileSync(NodePath.join(root, relative)),
) {
  const workspace = decodeYaml(new TextDecoder().decode(read("pnpm-workspace.yaml")));
  const stages = deriveWindowsProductionStages({
    rootPackage: strictJson(read("package.json")),
    desktopPackage: strictJson(read("apps/desktop/package.json")),
    serverPackage: strictJson(read("apps/server/package.json")),
    workspace,
  });
  const rootLockBytes = read("pnpm-lock.yaml");
  return Object.fromEntries(
    (["desktop", "server"] as const).map((name) => [
      name,
      verifyProductionStageLock({
        stage: stages[name],
        lockBytes: read(`scripts/lan/locks/${name}.pnpm-lock.yaml`),
        rootLockBytes,
        readPatch: read,
        sourcePackageExtensions: record(workspace, "source workspace").packageExtensions ?? {},
      }),
    ]),
  );
}
