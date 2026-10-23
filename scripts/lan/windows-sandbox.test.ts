// @effect-diagnostics nodeBuiltinImport:off - Public binary/source fixtures and new temporary snapshots only; no Sandbox, build tool or provider is launched.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import { APPROVED_NONBUILD_SOURCE_ENTRIES, inspectSourceGit } from "./source-git.ts";
import {
  committedSnapshotFile,
  assertSnapshotSourcePath,
  parseTrackedSourceEntries,
  renderWindowsSandboxConfiguration,
  writeNewSnapshotTree,
} from "./prepare-windows-sandbox.ts";
import { requirePinnedCacheBytes, verifySourceSnapshot } from "./windows-sandbox-guest.ts";
import {
  assertWindowsSandboxContext,
  validateSandboxGuestFacts,
  WINDOWS_SANDBOX_ROOTS,
} from "./windows-sandbox-context.ts";

const config = () => ({
  sourceRoot: "C:\\LAN Build & Fixture\\source",
  toolchainRoot: "C:\\LAN Tools\\tools",
  inputsRoot: "C:\\LAN Inputs\\inputs",
  outputRoot: "C:\\LAN Output\\build",
  nodeRelativePath: "node/node.exe",
  nodeSha256: "a".repeat(64),
  guestRequestSha256: "b".repeat(64),
  guestRunnerSha256: "c".repeat(64),
});
const blobId = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const facts = () => ({
  platform: "win32",
  username: "WDAGUtilityAccount",
  externalInterfaces: [],
  readOnlyMaps: [true, true, true],
});

it("generates an offline Sandbox with exactly three read-only maps and only the new output writable", () => {
  const xml = renderWindowsSandboxConfiguration(config());
  for (const element of [
    "vGPU",
    "Networking",
    "AudioInput",
    "VideoInput",
    "PrinterRedirection",
    "ClipboardRedirection",
  ])
    expect(xml).toContain(`<${element}>Disable</${element}>`);
  expect(xml).toContain("<ProtectedClient>Enable</ProtectedClient>");
  expect(xml.match(/<ReadOnly>true<\/ReadOnly>/gu)).toHaveLength(3);
  expect(xml.match(/<ReadOnly>false<\/ReadOnly>/gu)).toHaveLength(1);
  expect(xml).toContain("C:\\LAN Build &amp; Fixture\\source");
  expect(xml).toContain(
    `<SandboxFolder>${WINDOWS_SANDBOX_ROOTS.outputRoot}</SandboxFolder><ReadOnly>false</ReadOnly>`,
  );
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(xml)?.[1];
  expect(encoded).toBeDefined();
  const bootstrap = Buffer.from(encoded!, "base64").toString("utf16le");
  expect(bootstrap).toContain(
    `RequireHash 'C:\\T3LAN\\Inputs\\guest-request.json' '${"b".repeat(64)}'`,
  );
  expect(bootstrap).toContain(`RequireHash 'C:\\T3LAN\\Tools\\node\\node.exe' '${"a".repeat(64)}'`);
  expect(bootstrap).toContain(
    `RequireHash 'C:\\T3LAN\\Inputs\\guest-runner.mjs' '${"c".repeat(64)}'`,
  );
  expect(bootstrap).not.toContain("CreateDirectory");
  expect(bootstrap).not.toContain("ExecutionPolicy");
});

it.each([
  { sourceRoot: "C:\\Users\\fixture\\.t3\\source" },
  { outputRoot: "C:\\LAN Tools\\tools\\output" },
  { inputsRoot: "\\\\server\\share\\inputs" },
  { toolchainRoot: "C:\\LAN\\CON\\tools" },
  { sourceRoot: 'C:\\LAN\\bad"name' },
  { nodeRelativePath: "../node.exe" },
  { nodeRelativePath: "node/node.cmd" },
  { nodeSha256: "invented" },
])("refuses unsafe or overlapping mappings and unpinned bootstrap tools: %j", (change) => {
  expect(() => renderWindowsSandboxConfiguration({ ...config(), ...change })).toThrow();
});

it("selects only regular tracked portable files with exact stage-zero object identities", () => {
  const entries = parseTrackedSourceEntries(
    `100644 ${"b".repeat(40)} 0\tassets/icon.bin\0` +
      `100755 ${"a".repeat(40)} 0\tscripts/entry.ts\0`,
  );
  expect(entries).toEqual([
    { path: "assets/icon.bin", blob: "b".repeat(40) },
    { path: "scripts/entry.ts", blob: "a".repeat(40) },
  ]);
  for (const index of [
    `120000 ${"a".repeat(40)} 0\tlinked\0`,
    `160000 ${"a".repeat(40)} 0\tsubmodule\0`,
    `100644 ${"a".repeat(40)} 2\tunmerged\0`,
    `100644 ${"a".repeat(40)} 0\t.env\0`,
    `100644 ${"a".repeat(40)} 0\t.t3/state.sqlite\0`,
    `100644 ${"a".repeat(40)} 0\tnode_modules/package/index.js\0`,
    [`100644 ${"a".repeat(40)} 0\tA.ts\0`, `100644 ${"a".repeat(40)} 0\ta.ts\0`].join(""),
    `100644 ${"a".repeat(40)} 0\t../escaped.ts\0`,
  ])
    expect(() => parseTrackedSourceEntries(index)).toThrow();
});

it("omits only the exact approved reference entries from the real index without reading or following them", async () => {
  const index = await inspectSourceGit(NodePath.resolve(import.meta.dirname, "../.."), [
    "ls-files",
    "--stage",
    "-z",
  ]);
  const files = parseTrackedSourceEntries(index);
  expect(files.length).toBeGreaterThan(0);
  for (const entry of APPROVED_NONBUILD_SOURCE_ENTRIES)
    expect(files.some((file) => file.path === entry.path)).toBe(false);
});

it("includes committed vendored fixture bytes while refusing installed dependency paths and near-prefix aliases", () => {
  const fixture =
    ".repos/alchemy-effect/packages/cloudflare-runtime/src/rolldown/test/fixtures/cloudflare-imports/node_modules/@fixtures/example/index.js";
  expect(() => assertSnapshotSourcePath(fixture)).not.toThrow();
  for (const path of [
    "node_modules/example/index.js",
    fixture.replace("fixtures/", "fixtures-extra/"),
    fixture.replace("cloudflare-imports/", "unreviewed/"),
    fixture.replace("@fixtures/", "other-package/"),
    fixture.replace(".repos/", ".REPOS/"),
  ])
    expect(() => assertSnapshotSourcePath(path)).toThrow();
});

it("preserves binary bytes and trailing whitespace rather than decoding or trimming committed blobs", () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 32, 10]);
  expect(committedSnapshotFile(blobId(bytes), bytes)).toEqual({ length: 6, sha256: sha256(bytes) });
  expect(() => committedSnapshotFile(blobId(bytes), bytes.slice(0, -1))).toThrow(
    "committed Git blob",
  );
});

it("rejects transient cache replacement before writable copies can hide it from subsequent toolchain rechecks", () => {
  const approved = Buffer.from("approved offline package bytes");
  const pin = { length: approved.length, sha256: sha256(approved) };
  expect(requirePinnedCacheBytes(pin, approved)).toBe(approved);
  expect(() => requirePinnedCacheBytes(pin, Buffer.from("replaced offline package bytes"))).toThrow(
    "cache bytes changed",
  );
  expect(() => requirePinnedCacheBytes(pin, approved.slice(0, -1))).toThrow();
});

it("requires an exact complete snapshot, including blob identity, case, ordering and content hashes", () => {
  const bytes = Buffer.from("committed public fixture\n");
  const file = {
    path: "package.json",
    blob: blobId(bytes),
    length: bytes.length,
    sha256: sha256(bytes),
  };
  const snapshot = {
    schemaVersion: 1 as const,
    sourceCommit: "a".repeat(40),
    sourceDateEpoch: 123,
    exclusions: [],
    files: [file],
  };
  const files = new Map([[file.path, { bytes, length: bytes.length, sha256: file.sha256 }]]);
  expect(() => verifySourceSnapshot(snapshot, files)).not.toThrow();
  expect(() =>
    verifySourceSnapshot({ ...snapshot, exclusions: [...APPROVED_NONBUILD_SOURCE_ENTRIES] }, files),
  ).not.toThrow();
  expect(() =>
    verifySourceSnapshot(
      {
        ...snapshot,
        exclusions: [{ path: "unreviewed-reference", mode: "160000", blob: "b".repeat(40) }],
      },
      files,
    ),
  ).toThrow();
  expect(() => verifySourceSnapshot(snapshot, new Map())).toThrow();
  expect(() =>
    verifySourceSnapshot({ ...snapshot, files: [{ ...file, blob: "b".repeat(40) }] }, files),
  ).toThrow();
  expect(() =>
    verifySourceSnapshot({ ...snapshot, files: [{ ...file, path: "Package.json" }, file] }, files),
  ).toThrow();
  expect(() =>
    verifySourceSnapshot(
      snapshot,
      new Map([[file.path, { ...files.get(file.path)!, bytes: Buffer.from("changed") }]]),
    ),
  ).toThrow();
});

it("refuses normal hosts, networking or writable mappings and never accepts a structural context or env flag", () => {
  expect(() => validateSandboxGuestFacts(facts())).not.toThrow();
  for (const change of [
    { platform: "linux" },
    { username: "Owner" },
    { externalInterfaces: ["Ethernet"] },
    { readOnlyMaps: [true, false, true] },
    { readOnlyMaps: [true, true] },
  ])
    expect(() => validateSandboxGuestFacts({ ...facts(), ...change })).toThrow();
  for (const value of [
    undefined,
    { kind: "windows-sandbox", ...WINDOWS_SANDBOX_ROOTS },
    { T3CODE_LAN_SANDBOX: "true" },
  ])
    expect(() => assertWindowsSandboxContext(value)).toThrow("capability");
});

it("creates new byte-verified snapshots and refuses to overwrite existing foreign contents", async () => {
  const temporary = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-lan-sandbox-fixture-"),
  );
  const cleanup = async () => {
    const base = NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep;
    if (!NodePath.resolve(temporary).startsWith(base))
      throw new Error("Temporary fixture escaped its captured test root.");
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  };
  try {
    const root = NodePath.join(temporary, "snapshot");
    const files = new Map([["nested/source.bin", new Uint8Array([0, 255, 32, 10])]]);
    await writeNewSnapshotTree(root, files);
    expect(await NodeFSP.readFile(NodePath.join(root, "nested/source.bin"))).toEqual(
      Buffer.from(files.get("nested/source.bin")!),
    );
    await expect(
      writeNewSnapshotTree(root, new Map([["foreign.txt", Buffer.from("replacement")]])),
    ).rejects.toThrow();
    expect(await NodeFSP.readdir(root)).toEqual(["nested"]);
  } finally {
    await cleanup();
  }
});
