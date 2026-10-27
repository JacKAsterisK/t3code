// @effect-diagnostics nodeBuiltinImport:off - Offline artifact inspection; no package code or build tool is executed.
import * as NodeZlib from "node:zlib";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  isIndependentDistributionScheme,
  LAN_PORTABLE_ZIP_MAX_BYTES as PORTABLE_ZIP_MAX_BYTES,
} from "@t3tools/shared/distribution";
import { strictJson } from "../lib/strict-json.ts";
export { strictJson };
import { BUILD_INPUT_FILES, BuildLock, sha256 } from "./hub-distribution.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const FilePin = Schema.Struct({ path: Schema.String, length: Schema.Int, sha256: Hash });
const ToolNames = ["node", "pnpm", "rust", "msvc", "windowsSdk", "nsis"] as const;
const Identity = Schema.Struct({
  appId: Schema.String,
  productName: Schema.String,
  protocolScheme: Schema.String,
  homeDirectoryName: Schema.Literal("T3CodeLAN"),
  telemetry: Schema.Literal("disabled"),
  cloudConfiguration: Schema.Literal("disabled"),
  nativeUpdater: Schema.Literal("disabled"),
});

// Approval pins audited compiled bytes, not an assertion supplied by the package.
// Hashes cannot establish the semantics of an unaudited policy implementation.
export const WindowsArtifactPolicy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  validationMode: Schema.optional(Schema.Literals(["candidate", "independent-rebuild"])),
  nativeBuildEvidence: Schema.optional(Schema.Struct({ receiptSha256: Hash, runnerSha256: Hash })),
  toolchainQualificationSha256: Schema.optional(Hash),
  buildLockSha256: Hash,
  toolchainManifestSha256: Hash,
  identity: Identity,
  nativeTrust: Schema.optional(Schema.Literals(["authenticode", "portal-pinned"])),
  certificateSha256: Schema.Array(Hash),
  toolFiles: Schema.Struct({
    node: Schema.String,
    pnpm: Schema.String,
    rust: Schema.String,
    msvc: Schema.String,
    windowsSdk: Schema.String,
    nsis: Schema.String,
  }),
  reviewedComponents: Schema.Array(
    Schema.Struct({
      role: Schema.Literals([
        "desktop-policy",
        "server-policy",
        "web-policy",
        "native-maintenance",
        "native-home-repair",
      ]),
      location: Schema.String,
      sha256: Hash,
    }),
  ),
  homeRepair: Schema.optional(
    Schema.Struct({
      interfaceVersion: Schema.Literal(1),
      admission: Schema.Literal("hub-held-windows-handles-v1"),
      defaultHomeMode: Schema.Literal("drop-in"),
      contractSha256: Hash,
      schemaSha256: Hash,
    }),
  ),
  runtimePolicyEvidenceSha256: Hash,
});
export type WindowsArtifactPolicy = typeof WindowsArtifactPolicy.Type;

export const NativeBuildValidationReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("windows-native-build-receipt"),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  buildLockSha256: Hash,
  toolchainManifestSha256: Hash,
  runnerSha256: Hash,
  nativeRequestSha256: Hash,
  preparationRequestSha256: Hash,
  executionRequestSha256: Hash,
  sourceSnapshotSha256: Hash,
  inputsSnapshotSha256: Hash,
  identitySha256: Hash,
  rawArtifactSha256: Hash,
  rawArtifactByteLength: Schema.Int,
  toolchainVerification: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["full-inventory", "qualified-primary-pins"]),
      qualificationSha256: Schema.NullOr(Hash),
      primaryFileCount: Schema.Int,
      fullInventoryVerifiedDuringBuild: Schema.Boolean,
    }),
  ),
  toolchainFileCount: Schema.Int,
  toolchainByteLength: Schema.Int,
  verifiedBoundaries: Schema.Tuple([
    Schema.Literal("before-execution"),
    Schema.Literal("after-execution"),
  ]),
});
export type NativeBuildValidationReceipt = typeof NativeBuildValidationReceipt.Type;

// The pinned workspace store alone contains over 200,000 public package files.
// Keep tool inventories bounded separately from the much smaller shipped payload.
export const TOOLCHAIN_LIMITS = Object.freeze({
  files: 400_000,
  bytes: 16 * 1024 ** 3,
  manifestBytes: 64 * 1024 ** 2,
});

export const ToolchainManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  files: Schema.Array(FilePin),
});
export type ToolchainManifest = typeof ToolchainManifest.Type;
const decodeBuildLock = Schema.decodeUnknownSync(BuildLock);
const decodeToolchainManifest = Schema.decodeUnknownSync(ToolchainManifest);
const decodeFilePins = Schema.decodeUnknownSync(Schema.Array(FilePin));

let cachedToolchainManifest:
  | { readonly sha256: string; readonly value: ToolchainManifest }
  | undefined;

export function parseToolchainManifest(bytes: Uint8Array): ToolchainManifest {
  if (bytes.length > TOOLCHAIN_LIMITS.manifestBytes)
    throw new Error("Toolchain manifest exceeds its bounded local size.");
  // Cache only immutable decoded data, never filesystem evidence. Rehash the
  // current bytes even for the same buffer; retain at most one manifest per process.
  const snapshot = Uint8Array.from(bytes);
  const digest = sha256(snapshot);
  if (cachedToolchainManifest?.sha256 === digest) return cachedToolchainManifest.value;
  const value = decodeToolchainManifest(strictJson(snapshot), { onExcessProperty: "error" });
  if (!value.files.length || value.files.length > TOOLCHAIN_LIMITS.files)
    throw new Error("Toolchain manifest has an invalid file count.");
  for (const pin of value.files) Object.freeze(pin);
  Object.freeze(value.files);
  Object.freeze(value);
  cachedToolchainManifest = { sha256: digest, value };
  return value;
}

export interface NativeEvidence {
  readonly sha256: string;
  readonly trustStatus: number;
  readonly certificateSha256: string | null;
  readonly fileVersion: string | null;
  readonly productName: string | null;
}
export interface SourceEvidence {
  readonly commit: string;
  readonly clean: boolean;
  readonly upstreamAncestor: boolean;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

function verifyNativeSignatureEvidence(
  expectedSha256: string,
  evidence: NativeEvidence,
  approvedCertificates: readonly string[],
) {
  if (
    evidence.sha256 !== expectedSha256 ||
    evidence.trustStatus !== 0 ||
    evidence.certificateSha256 === null ||
    !approvedCertificates.includes(evidence.certificateSha256)
  )
    fail("Native executable signature is untrusted or differs from the approved signer.");
}
export interface ArtifactRun {
  readonly sourceId: string;
  readonly buildRoot: string;
  readonly source: SourceEvidence;
  readonly artifact: Uint8Array;
  readonly extractedFiles: ReadonlyMap<string, Uint8Array>;
  readonly toolchainFiles: ReadonlyMap<
    string,
    { readonly length: number; readonly sha256: string }
  >;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function fail(reason: string): never {
  throw new Error(reason);
}
const validChecks = (checks: unknown, required: readonly string[]) => {
  if (!Array.isArray(checks) || checks.length < 3 || checks.length > 100) return false;
  const names = new Set<string>();
  for (const check of checks) {
    if (
      !object(check) ||
      typeof check.name !== "string" ||
      !check.name.trim() ||
      names.has(check.name) ||
      check.passed !== true
    )
      return false;
    names.add(check.name);
  }
  return required.every((name) => names.has(name));
};
export function relativeWindowsPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 240 ||
    /[\\:<>"|?*]/u.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) > 0x7e,
    ) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[ .]$/u.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
      )
  )
    fail("Unsafe Windows payload path.");
  return value;
}

const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export { PORTABLE_ZIP_MAX_BYTES };

export function assertPortableZipLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 22 || length > PORTABLE_ZIP_MAX_BYTES)
    fail(`ZIP exceeds the local validator's ${PORTABLE_ZIP_MAX_BYTES / 1024 ** 2} MiB bound.`);
}

// This intentionally supports bounded, single-disk ZIP32 portable packages only.
// Unsupported archive variants refuse instead of delegating to a shell extractor.
export function readPortableZip(input: Uint8Array): ReadonlyMap<string, Uint8Array> {
  assertPortableZipLength(input.byteLength);
  const bytes = Buffer.from(input);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < 0 ||
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    fail("ZIP end record is invalid.");
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    count < 3 ||
    count > 20001 ||
    start + size !== end
  )
    fail("ZIP32 single-disk directory is required.");
  const files = new Map<string, Uint8Array>(),
    names = new Set<string>(),
    ranges: Array<[number, number]> = [];
  let offset = start,
    expanded = 0;
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      fail("Invalid ZIP directory.");
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20),
      length = bytes.readUInt32LE(offset + 24),
      nameLength = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32),
      attributes = bytes.readUInt32LE(offset + 38),
      local = bytes.readUInt32LE(offset + 42);
    if (
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(offset + 34) ||
      [compressed, length, local].includes(0xffffffff) ||
      offset + 46 + nameLength + extra + comment > end ||
      ((attributes >>> 16) & 0xf000) === 0xa000 ||
      (attributes & 0x410) !== 0
    )
      fail("Unsupported ZIP flags, links or directories.");
    const name = relativeWindowsPath(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      ),
    );
    if (
      names.has(name.toLowerCase()) ||
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      fail("Duplicate or inconsistent ZIP entry.");
    names.add(name.toLowerCase());
    const localName = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28),
      data = local + 30 + localName + localExtra;
    if (
      localName !== nameLength ||
      !bytes
        .subarray(local + 30, local + 30 + localName)
        .equals(bytes.subarray(offset + 46, offset + 46 + nameLength)) ||
      data + compressed > start ||
      (!(flags & 8) &&
        (bytes.readUInt32LE(local + 14) !== crc ||
          bytes.readUInt32LE(local + 18) !== compressed ||
          bytes.readUInt32LE(local + 22) !== length))
    )
      fail("ZIP local header differs from directory.");
    expanded += length;
    if (length > 256 * 1024 ** 2 || expanded > 2 * 1024 ** 3) fail("Expanded ZIP exceeds bounds.");
    const encoded = bytes.subarray(data, data + compressed);
    const decoded =
      method === 0
        ? encoded
        : NodeZlib.inflateRawSync(encoded, { maxOutputLength: Math.max(1, length) });
    if (decoded.length !== length || crc32(decoded) !== crc) fail("ZIP length or CRC differs.");
    let recordEnd = data + compressed;
    if (flags & 8) {
      const descriptor =
        recordEnd + 4 <= start && bytes.readUInt32LE(recordEnd) === 0x08074b50
          ? recordEnd + 4
          : recordEnd;
      if (
        descriptor + 12 > start ||
        bytes.readUInt32LE(descriptor) !== crc ||
        bytes.readUInt32LE(descriptor + 4) !== compressed ||
        bytes.readUInt32LE(descriptor + 8) !== length
      )
        fail("ZIP data descriptor differs from directory.");
      recordEnd = descriptor + 12;
    }
    files.set(name, decoded);
    ranges.push([local, recordEnd]);
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) fail("ZIP directory length differs.");
  ranges.sort(([a], [b]) => a - b);
  if (
    ranges[0]?.[0] !== 0 ||
    ranges.some(([from, to], index) => to > (ranges[index + 1]?.[0] ?? start) || from >= to)
  )
    fail("ZIP records overlap or contain an executable preamble.");
  return files;
}

function readAsar(bytes: Uint8Array, unpacked: ReadonlyMap<string, Uint8Array>, archive: string) {
  const input = Buffer.from(bytes);
  if (input.length < 16 || input.readUInt32LE(0) !== 4) fail("Invalid ASAR header.");
  const headerSize = input.readUInt32LE(4),
    jsonSize = input.readUInt32LE(12);
  if (
    headerSize > 16 * 1024 ** 2 ||
    headerSize < 8 ||
    8 + headerSize > input.length ||
    jsonSize > headerSize - 8 ||
    input.readUInt32LE(8) !== headerSize - 4
  )
    fail("Invalid ASAR header bounds.");
  const root = strictJson(input.subarray(16, 16 + jsonSize)),
    files = new Map<string, Uint8Array>(),
    names = new Set<string>();
  const entries = new Set<string>();
  const ranges: Array<[number, number]> = [];
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 64 || !object(node) || Object.hasOwn(node, "link"))
      fail("ASAR links or invalid entries are refused.");
    if (prefix) {
      relativeWindowsPath(prefix);
      if (entries.has(prefix.toLowerCase()) || entries.size >= 20000) fail("Duplicate ASAR entry.");
      entries.add(prefix.toLowerCase());
    }
    if (
      (Object.hasOwn(node, "unpacked") && typeof node.unpacked !== "boolean") ||
      (Object.hasOwn(node, "executable") && typeof node.executable !== "boolean") ||
      (Object.hasOwn(node, "integrity") && !object(node.integrity))
    )
      fail("ASAR flags or integrity have invalid types.");
    if (object(node.files)) {
      if (Object.keys(node).some((key) => !["files", "unpacked"].includes(key)))
        fail("Invalid ASAR directory form.");
      for (const [name, child] of Object.entries(node.files)) {
        if (name.includes("/")) fail("Invalid ASAR directory entry name.");
        walk(child, prefix ? `${prefix}/${name}` : name, depth + 1);
      }
      return;
    }
    if (
      Object.keys(node).some(
        (key) => !["size", "offset", "unpacked", "executable", "integrity"].includes(key),
      )
    )
      fail("Invalid ASAR file form.");
    relativeWindowsPath(prefix);
    if (
      names.has(prefix.toLowerCase()) ||
      names.size >= 20000 ||
      !Number.isSafeInteger(node.size) ||
      (node.size as number) < 0
    )
      fail("Invalid ASAR file.");
    names.add(prefix.toLowerCase());
    const length = node.size as number;
    let content: Uint8Array;
    if (node.unpacked === true) {
      content =
        unpacked.get(`${archive}.unpacked/${prefix}`) ?? fail("An ASAR unpacked file is missing.");
    } else {
      if (typeof node.offset !== "string" || !/^\d+$/u.test(node.offset))
        fail("Invalid ASAR offset.");
      const from = 8 + headerSize + Number(node.offset),
        to = from + length;
      if (!Number.isSafeInteger(from) || to > input.length)
        fail("ASAR file is outside the archive.");
      content = input.subarray(from, to);
      if (length > 0) ranges.push([from, to]);
      if (nativeFile(prefix, content))
        fail("Native ASAR files must be unpacked for signature verification.");
    }
    if (content.length !== length) fail("ASAR unpacked size differs.");
    if (
      object(node.integrity) &&
      (node.integrity.algorithm !== "SHA256" || node.integrity.hash !== sha256(content))
    )
      fail("ASAR integrity differs.");
    if (
      object(node.integrity) &&
      (Object.hasOwn(node.integrity, "blockSize") || Object.hasOwn(node.integrity, "blocks"))
    ) {
      const size = node.integrity.blockSize,
        blocks = node.integrity.blocks;
      if (
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        !Array.isArray(blocks) ||
        // Electron's ASAR writer emits the empty digest as one block for an empty file.
        (blocks.length !== Math.max(1, Math.ceil(content.length / size)) &&
          // ASAR 3 also flushes an empty block after exact positive 4 MiB multiples.
          !(
            size === 4 * 1024 ** 2 &&
            content.length > 0 &&
            content.length % size === 0 &&
            blocks.length === content.length / size + 1
          )) ||
        blocks.some(
          (block: unknown, index: number) =>
            block !== sha256(content.subarray(index * size, (index + 1) * size)),
        )
      )
        fail("ASAR block integrity differs.");
    }
    files.set(prefix, content);
  };
  walk(root, "", 0);
  ranges.sort(([a], [b]) => a - b);
  // ASAR 4 deduplicates identical contents into one exact extent, never partial overlaps.
  if (
    ranges.some(([from, to], index) => {
      const next = ranges[index + 1];
      return next !== undefined && to > next[0] && (from !== next[0] || to !== next[1]);
    })
  )
    fail("ASAR file ranges overlap.");
  return files;
}

function nativeFile(path: string, bytes: Uint8Array) {
  return /\.(?:exe|dll|node)$/iu.test(path) || (bytes[0] === 0x4d && bytes[1] === 0x5a);
}
function requirePeX64(bytes: Uint8Array) {
  const input = Buffer.from(bytes);
  if (input.length < 64 || input.readUInt16LE(0) !== 0x5a4d)
    fail("Native payload is not a PE executable.");
  const offset = input.readUInt32LE(60);
  if (
    offset + 24 > input.length ||
    input.readUInt32LE(offset) !== 0x4550 ||
    input.readUInt16LE(offset + 4) !== 0x8664
  )
    fail("Native payload is not x64 PE.");
}

function get(files: ReadonlyMap<string, Uint8Array>, name: string) {
  return files.get(name) ?? fail(`Required file is missing: ${name}.`);
}
function jsonObject(files: ReadonlyMap<string, Uint8Array>, name: string) {
  const value = strictJson(get(files, name));
  return object(value) ? value : fail(`Expected JSON object: ${name}.`);
}
function exactTree(files: ReadonlyMap<string, Uint8Array>, pins: readonly (typeof FilePin.Type)[]) {
  if (pins.length === 0 || pins.length > 100000 || files.size !== pins.length)
    fail("File inventory is incomplete or contains unlisted files.");
  const names = new Set<string>();
  for (const pin of pins) {
    relativeWindowsPath(pin.path);
    if (names.has(pin.path.toLowerCase())) fail("Duplicate inventory path.");
    names.add(pin.path.toLowerCase());
    const bytes = get(files, pin.path);
    if (pin.length < 0 || bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
      fail(`File bytes differ: ${pin.path}.`);
  }
}

export async function validateWindowsArtifact(input: {
  readonly policy: WindowsArtifactPolicy;
  readonly buildLockBytes: Uint8Array;
  readonly toolchainManifestBytes: Uint8Array;
  readonly runs: readonly ArtifactRun[];
  readonly inspectNative: (run: ArtifactRun, path: string) => Promise<NativeEvidence>;
}) {
  const { policy } = input;
  const validationMode = policy.validationMode ?? "independent-rebuild";
  if (
    (validationMode !== "candidate" && validationMode !== "independent-rebuild") ||
    input.runs.length !== (validationMode === "candidate" ? 1 : 2)
  )
    fail("Validation mode requires exactly one candidate or two independent rebuild runs.");
  if (
    (policy.nativeBuildEvidence !== undefined ||
      policy.toolchainQualificationSha256 !== undefined) &&
    validationMode !== "candidate"
  )
    fail("Approved native build receipts are available only for candidate validation.");
  if (policy.nativeBuildEvidence !== undefined && policy.toolchainQualificationSha256 !== undefined)
    fail("Choose one approved toolchain evidence mode.");
  const nativeTrust = policy.nativeTrust ?? "authenticode";
  if (
    !["authenticode", "portal-pinned"].includes(nativeTrust) ||
    (nativeTrust === "authenticode" && !policy.certificateSha256.length) ||
    (nativeTrust === "portal-pinned" && policy.certificateSha256.length !== 0) ||
    new Set(policy.certificateSha256).size !== policy.certificateSha256.length
  )
    fail(
      "Approve a native signer certificate allowlist or an explicit Portal-pinned package policy.",
    );
  if (
    input.buildLockBytes.length > 1024 * 1024 ||
    input.toolchainManifestBytes.length > TOOLCHAIN_LIMITS.manifestBytes ||
    sha256(input.buildLockBytes) !== policy.buildLockSha256 ||
    sha256(input.toolchainManifestBytes) !== policy.toolchainManifestSha256
  )
    fail("Approved build or toolchain lock bytes differ.");
  const lock = decodeBuildLock(strictJson(input.buildLockBytes), {
    onExcessProperty: "error",
  });
  const toolchain = parseToolchainManifest(input.toolchainManifestBytes);
  if (
    !/^[a-z0-9][a-z0-9.-]{2,127}$/iu.test(policy.identity.appId) ||
    policy.identity.appId.toLowerCase().startsWith("com.t3tools.") ||
    !policy.identity.productName.trim() ||
    /^T3 Code(?: \((?:Beta|Nightly)\))?$/iu.test(policy.identity.productName) ||
    !isIndependentDistributionScheme(policy.identity.protocolScheme)
  )
    fail("Independent identity is required.");
  if (
    [lock.applicationVersion, lock.distributionVersion].some((version) =>
      version
        .split(".")
        .some((part) => !Number.isSafeInteger(Number(part)) || Number(part) > 2147483647),
    )
  )
    fail("Version exceeds the Hub's native version range.");
  const first = input.runs[0]!,
    second = input.runs[1];
  if (
    second !== undefined &&
    (first.sourceId === second.sourceId ||
      first.buildRoot.toLowerCase() === second.buildRoot.toLowerCase())
  )
    fail("Two distinct supplied build provenance/workspace bindings are required.");
  const results = [];
  for (const run of input.runs) {
    if (!run.source.clean || run.source.commit !== lock.forkCommit || !run.source.upstreamAncestor)
      fail("Source must be clean, pinned and descend from upstreamCommit.");
    for (const name of BUILD_INPUT_FILES)
      if (lock.files[name] === undefined) fail(`Build lock input is absent: ${name}.`);
    for (const [name, hash] of Object.entries(lock.files))
      if (sha256(get(run.source.files, relativeWindowsPath(name))) !== hash)
        fail(`Pinned source input differs: ${name}.`);
    const sourcePackage = jsonObject(run.source.files, "package.json");
    if (
      !object(sourcePackage.engines) ||
      sourcePackage.engines.node !== lock.tools.node.version ||
      sourcePackage.packageManager !== `pnpm@${lock.tools.pnpm.version}`
    )
      fail("Source tool versions differ from the approved lock.");
    if (
      run.toolchainFiles.size !== toolchain.files.length ||
      toolchain.files.length === 0 ||
      toolchain.files.length > TOOLCHAIN_LIMITS.files
    )
      fail("Toolchain inventory is incomplete or contains extra files.");
    const toolPaths = new Set<string>();
    for (const pin of toolchain.files) {
      relativeWindowsPath(pin.path);
      const actual = run.toolchainFiles.get(pin.path);
      if (
        toolPaths.has(pin.path.toLowerCase()) ||
        actual?.length !== pin.length ||
        actual.sha256 !== pin.sha256
      )
        fail(`Toolchain file bytes differ: ${pin.path}.`);
      toolPaths.add(pin.path.toLowerCase());
    }
    for (const name of ToolNames) {
      if (
        !/^\d+\.\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?$/iu.test(lock.tools[name].version) ||
        run.toolchainFiles.get(relativeWindowsPath(policy.toolFiles[name]))?.sha256 !==
          lock.tools[name].sha256
      )
        fail(`Pinned tool binary differs: ${name}.`);
    }
    const files = readPortableZip(run.artifact);
    if (
      get(files, "t3code-lan-package.json").length > 4 * 1024 * 1024 ||
      get(files, "t3code-lan-build-lock.json").length > 1024 * 1024 ||
      get(files, "t3code-lan-test-receipt.json").length > 1024 * 1024
    )
      fail("Package manifest or build/test evidence exceeds Hub size bounds.");
    const manifest = jsonObject(files, "t3code-lan-package.json");
    const pins = decodeFilePins(manifest.files, {
      onExcessProperty: "error",
    });
    if (
      typeof manifest.builtUtc !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(manifest.builtUtc) ||
      !Number.isFinite(Date.parse(manifest.builtUtc)) ||
      Date.parse(manifest.builtUtc) <= 0 ||
      DateTime.formatIso(DateTime.makeUnsafe(manifest.builtUtc)).replace(".000Z", "Z") !==
        manifest.builtUtc.replace(".000Z", "Z")
    )
      fail("Package build time is missing or invalid.");
    if (
      pins.length < 2 ||
      pins.length > 20000 ||
      pins.some(
        (pin, index) =>
          index > 0 && (pins[index - 1]?.path.toLowerCase() ?? "") >= pin.path.toLowerCase(),
      )
    )
      fail("Package manifest files must be sorted and distinct.");
    if (pins.some((pin) => pin.path.toLowerCase() === "t3code-lan-install.json"))
      fail("Package includes a reserved local installation receipt.");
    const payload = new Map(files);
    payload.delete("t3code-lan-package.json");
    exactTree(payload, pins);
    exactTree(run.extractedFiles, [
      ...pins,
      {
        path: "t3code-lan-package.json",
        length: get(files, "t3code-lan-package.json").length,
        sha256: sha256(get(files, "t3code-lan-package.json")),
      },
    ]);
    if (
      manifest.schemaVersion !== 1 ||
      manifest.packageId !== `t3code-lan-${lock.distributionVersion}` ||
      manifest.version !== lock.distributionVersion ||
      manifest.platform !== "Win64" ||
      manifest.architecture !== "x64" ||
      manifest.protocolVersion !== 2 ||
      manifest.sourceDirty !== false ||
      manifest.sourceCommit !== lock.forkCommit ||
      manifest.upstreamCommit !== lock.upstreamCommit ||
      manifest.desktopVersion !== lock.applicationVersion ||
      manifest.backendVersion !== lock.applicationVersion ||
      manifest.buildLockSha256 !== policy.buildLockSha256 ||
      typeof manifest.executablePath !== "string" ||
      !/\.exe$/iu.test(manifest.executablePath) ||
      typeof manifest.testReceiptSha256 !== "string"
    )
      fail("Package provenance or versions differ from the approved build lock.");
    for (const name of [
      "appId",
      "productName",
      "protocolScheme",
      "homeDirectoryName",
      "nativeUpdater",
    ] as const)
      if (manifest[name] !== policy.identity[name]) fail(`Package identity differs: ${name}.`);
    if (
      sha256(get(files, "t3code-lan-build-lock.json")) !== policy.buildLockSha256 ||
      sha256(get(files, "t3code-lan-test-receipt.json")) !== manifest.testReceiptSha256
    )
      fail("Package build/test receipt bytes differ.");
    get(files, "THIRD-PARTY-NOTICES.txt");
    get(files, manifest.executablePath);
    if (
      lock.wslRuntime !== null ||
      [...files.keys()].some((name) =>
        /(?:wsl-runtime|app-update\.yml|dev-app-update\.yml|latest(?:-[a-z0-9]+)?\.yml)$/iu.test(
          name,
        ),
      )
    )
      fail("WSL or native update feeds require a separately implemented validation policy.");
    const receipt = jsonObject(files, "t3code-lan-test-receipt.json");
    if (
      receipt.schemaVersion !== 1 ||
      receipt.sourceCommit !== lock.forkCommit ||
      receipt.buildLockSha256 !== policy.buildLockSha256 ||
      receipt.passed !== true ||
      !validChecks(receipt.checks, [
        "focused-tests",
        "windows-smoke",
        policy.homeRepair ? "home-selection-and-retention" : "identity-isolation",
      ])
    )
      fail("Required build test evidence is missing.");
    const asars = new Map<string, ReadonlyMap<string, Uint8Array>>();
    for (const [name, bytes] of files)
      if (name.endsWith(".asar")) asars.set(name, readAsar(bytes, files, name));
    const desktop = asars.get("resources/app.asar") ?? fail("Desktop ASAR is missing.");
    const server = asars.get("resources/server.asar") ?? fail("Server ASAR is missing.");
    const packaged = jsonObject(desktop, "package.json");
    if (
      packaged.version !== lock.applicationVersion ||
      packaged.buildVersion !== lock.applicationVersion ||
      packaged.t3codeCommitHash !== lock.forkCommit ||
      !object(packaged.t3codeLanIdentity) ||
      packaged.t3codeLanIdentity.schemaVersion !== 1 ||
      packaged.t3codeLanIdentity.sourceCommit !== lock.forkCommit ||
      packaged.t3codeLanIdentity.applicationVersion !== lock.applicationVersion ||
      Object.entries(policy.identity).some(
        ([name, value]) =>
          !object(packaged.t3codeLanIdentity) || packaged.t3codeLanIdentity[name] !== value,
      )
    )
      fail("Extracted desktop package identity, protocol or updater configuration differs.");
    get(server, "apps/server/dist/bin.mjs");
    get(files, "resources/resource-monitor/t3-resource-monitor.exe");
    get(files, "resources/native-maintenance.mjs");
    const repairPresent = files.has("resources/native-home-repair.mjs");
    if (repairPresent !== (policy.homeRepair !== undefined))
      fail("Home repair resources require an explicit matching approved repair policy.");
    if (policy.homeRepair) {
      if (
        sha256(get(files, "resources/native-home-repair.contract.json")) !==
          policy.homeRepair.contractSha256 ||
        sha256(get(files, "resources/native-home-repair.schema.json")) !==
          policy.homeRepair.schemaSha256
      )
        fail("Home repair contract or schema differs from approved pins.");
      if (!policy.reviewedComponents.some((component) => component.role === "native-home-repair"))
        fail("Audited native home repair component is missing.");
    }
    const roles = new Set(policy.reviewedComponents.map((component) => component.role));
    if (
      ["desktop-policy", "server-policy", "web-policy", "native-maintenance"].some(
        (role) => !roles.has(role as (typeof policy.reviewedComponents)[number]["role"]),
      )
    )
      fail("Approved audited compiled policy components are incomplete.");
    for (const component of policy.reviewedComponents) {
      const [archive, entry, extra] = component.location.split("::");
      if (
        !archive ||
        extra !== undefined ||
        (component.role === "native-maintenance" &&
          component.location !== "resources/native-maintenance.mjs") ||
        (component.role === "native-home-repair" &&
          component.location !== "resources/native-home-repair.mjs")
      )
        fail("Invalid reviewed component location.");
      const bytes =
        entry === undefined
          ? get(files, relativeWindowsPath(archive))
          : get(
              asars.get(relativeWindowsPath(archive)) ??
                fail("Reviewed component archive is missing."),
              relativeWindowsPath(entry),
            );
      if (sha256(bytes) !== component.sha256)
        fail(`Audited compiled policy component differs: ${component.role}.`);
    }
    const runtimeEvidenceBytes = get(files, "t3code-lan-runtime-policy-evidence.json");
    if (sha256(runtimeEvidenceBytes) !== policy.runtimePolicyEvidenceSha256)
      fail("Approved runtime policy evidence differs.");
    const evidence = strictJson(runtimeEvidenceBytes);
    if (
      !object(evidence) ||
      evidence.schemaVersion !== 1 ||
      evidence.sourceCommit !== lock.forkCommit ||
      evidence.buildLockSha256 !== policy.buildLockSha256 ||
      !NodeUtil.isDeepStrictEqual(evidence.identity, policy.identity) ||
      !NodeUtil.isDeepStrictEqual(evidence.components, policy.reviewedComponents) ||
      !validChecks(evidence.checks, [
        policy.homeRepair ? "default-home-selection" : "default-home-isolation",
        "native-updater-disabled",
        "cloud-disabled",
        "telemetry-disabled",
      ])
    )
      fail("Runtime enforcement evidence is not bound to the audited policy/components.");
    const native = [];
    for (const [name, bytes] of files)
      if (nativeFile(name, bytes)) {
        requirePeX64(bytes);
        const signature = await input.inspectNative(run, name);
        if (nativeTrust === "authenticode")
          verifyNativeSignatureEvidence(sha256(bytes), signature, policy.certificateSha256);
        else if (signature.sha256 !== sha256(bytes))
          fail("Native evidence differs from package bytes.");
        if (
          name === manifest.executablePath &&
          (signature.productName !== policy.identity.productName ||
            (signature.fileVersion !== lock.applicationVersion &&
              signature.fileVersion !== `${lock.applicationVersion}.0`))
        )
          fail("Native desktop product or file version differs from the approved identity.");
        native.push({ path: name, ...signature });
      }
    if (native.length < 3 || !native.some((item) => item.path.endsWith(".node")))
      fail("Desktop, resource monitor and native addon signature evidence is incomplete.");
    results.push({
      sourceId: run.sourceId,
      artifactSha256: sha256(run.artifact),
      manifestSha256: sha256(get(files, "t3code-lan-package.json")),
      payloadFiles: pins.length,
      native,
    });
  }
  if (
    second !== undefined &&
    (sha256(first.artifact) !== sha256(second.artifact) ||
      first.artifact.length !== second.artifact.length)
  )
    fail("Independent supplied artifact bytes are not reproducible.");
  return {
    schemaVersion: 1 as const,
    passed: true as const,
    buildAuthorized: false as const,
    distributionAuthorized: false as const,
    approvedBuildLockSha256: policy.buildLockSha256,
    nativeTrust,
    validationMode,
    byteReproducibilityVerified: validationMode === "independent-rebuild",
    reviewedCompiledBindingsVerified: true as const,
    policySemanticsRequireIndependentAudit: true as const,
    buildProcessIndependenceNotEstablishedByByteComparison: true as const,
    toolVersionsBoundToApprovedHashes: true as const,
    toolVersionCommandsExecuted: false as const,
    runs: results,
  };
}
