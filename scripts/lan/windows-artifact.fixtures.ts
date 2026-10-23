// @effect-diagnostics nodeBuiltinImport:off - Public synthetic archive and toolchain bytes; never a production pin or signature.
import * as NodeZlib from "node:zlib";
import { BUILD_INPUT_FILES, sha256, type BuildLock } from "./hub-distribution.ts";
import { crc32, type ArtifactRun, type WindowsArtifactPolicy } from "./windows-artifact.ts";
export const json = (value: unknown) => Buffer.from(JSON.stringify(value));
export const commit = "a".repeat(40),
  certificate = "b".repeat(64);
const pin = (path: string, bytes: Uint8Array) => ({
  path,
  length: bytes.length,
  sha256: sha256(bytes),
});

export function zip(files: ReadonlyMap<string, Uint8Array>, stamp = 0, compress = false) {
  const parts: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const encoded = compress ? NodeZlib.deflateRawSync(bytes) : bytes;
    const label = Buffer.from(name),
      header = Buffer.alloc(30),
      central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(stamp, 10);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(encoded.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(label.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stamp, 12);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt32LE(encoded.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(label.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(header, label, Buffer.from(encoded));
    directory.push(central, label);
    offset += header.length + label.length + encoded.length;
  }
  const end = Buffer.alloc(22),
    central = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

export function asar(files: ReadonlyMap<string, Uint8Array>) {
  const root: { files: Record<string, unknown> } = { files: {} },
    data: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const segments = name.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current.files[segment] ??= { files: {} };
      current = current.files[segment] as typeof root;
    }
    current.files[segments.at(-1) ?? ""] = {
      offset: String(offset),
      size: bytes.length,
      integrity: { algorithm: "SHA256", hash: sha256(bytes) },
    };
    offset += bytes.length;
    data.push(Buffer.from(bytes));
  }
  const header = json(root),
    headerSize = 8 + Math.ceil(header.length / 4) * 4,
    prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(header.length, 12);
  header.copy(prefix, 16);
  return Buffer.concat([prefix, ...data]);
}

export function pe() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d);
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  return bytes;
}

export function fixture(
  edit?: (files: Map<string, Uint8Array>) => void,
  protocolScheme = "t3code-lan",
) {
  const source = new Map(BUILD_INPUT_FILES.map((name) => [name, Buffer.from(`source:${name}`)]));
  source.set(
    "package.json",
    json({ engines: { node: "26.12.1" }, packageManager: "pnpm@12.14.0" }),
  );
  const tools = new Map(
    ["node", "pnpm", "rust", "msvc", "windowsSdk", "nsis"].map((name) => [
      `bin/${name}`,
      Buffer.from(`synthetic tool:${name}`),
    ]),
  );
  const lock: BuildLock = {
    schemaVersion: 1,
    upstreamCommit: commit,
    forkCommit: commit,
    distributionVersion: "1.0.0",
    applicationVersion: "0.1.2",
    files: Object.fromEntries([...source].map(([name, bytes]) => [name, sha256(bytes)])),
    tools: {
      node: { version: "26.12.1", sha256: sha256(tools.get("bin/node")!) },
      pnpm: { version: "12.14.0", sha256: sha256(tools.get("bin/pnpm")!) },
      rust: { version: "1.0.0", sha256: sha256(tools.get("bin/rust")!) },
      msvc: { version: "1.0.0", sha256: sha256(tools.get("bin/msvc")!) },
      windowsSdk: { version: "1.0.0", sha256: sha256(tools.get("bin/windowsSdk")!) },
      nsis: { version: "1.0.0", sha256: sha256(tools.get("bin/nsis")!) },
    },
    wslRuntime: null,
    cloudConfiguration: "disabled",
    telemetry: "disabled",
    nativeUpdater: "disabled",
  };
  const buildLockBytes = json(lock),
    toolchainManifestBytes = json({
      schemaVersion: 1,
      files: [...tools].map(([name, bytes]) => pin(name, bytes)),
    });
  const identity = {
    appId: "com.owner.t3code.lan",
    productName: "T3 Code LAN",
    protocolScheme,
    homeDirectoryName: "T3CodeLAN" as const,
    telemetry: "disabled" as const,
    cloudConfiguration: "disabled" as const,
    nativeUpdater: "disabled" as const,
  };
  const desktopCode = Buffer.from("audited fixture desktop policy enforcement"),
    serverCode = Buffer.from("audited fixture server policy enforcement"),
    webCode = Buffer.from("audited fixture web policy enforcement"),
    helperCode = Buffer.from("audited fixture native maintenance identity binding");
  const reviewedComponents: WindowsArtifactPolicy["reviewedComponents"] = [
    {
      role: "desktop-policy",
      location: "resources/app.asar::apps/desktop/dist-electron/main.cjs",
      sha256: sha256(desktopCode),
    },
    {
      role: "server-policy",
      location: "resources/server.asar::apps/server/dist/bin.mjs",
      sha256: sha256(serverCode),
    },
    {
      role: "web-policy",
      location: "resources/server.asar::apps/server/dist/web/assets/main.js",
      sha256: sha256(webCode),
    },
    {
      role: "native-maintenance",
      location: "resources/native-maintenance.mjs",
      sha256: sha256(helperCode),
    },
  ];
  const runtimeEvidence = json({
    schemaVersion: 1,
    sourceCommit: commit,
    buildLockSha256: sha256(buildLockBytes),
    identity,
    components: reviewedComponents,
    checks: [
      "default-home-isolation",
      "native-updater-disabled",
      "cloud-disabled",
      "telemetry-disabled",
    ].map((name) => ({ name, passed: true })),
  });
  const policy: WindowsArtifactPolicy = {
    schemaVersion: 1,
    buildLockSha256: sha256(buildLockBytes),
    toolchainManifestSha256: sha256(toolchainManifestBytes),
    identity,
    certificateSha256: [certificate],
    toolFiles: {
      node: "bin/node",
      pnpm: "bin/pnpm",
      rust: "bin/rust",
      msvc: "bin/msvc",
      windowsSdk: "bin/windowsSdk",
      nsis: "bin/nsis",
    },
    reviewedComponents,
    runtimePolicyEvidenceSha256: sha256(runtimeEvidence),
  };
  const packageJson = json({
    version: "0.1.2",
    buildVersion: "0.1.2",
    t3codeCommitHash: commit,
    t3codeLanIdentity: {
      schemaVersion: 1,
      sourceCommit: commit,
      applicationVersion: "0.1.2",
      ...identity,
    },
  });
  const desktop = new Map<string, Uint8Array>([
    ["package.json", packageJson],
    ["apps/desktop/dist-electron/main.cjs", desktopCode],
  ]);
  const server = new Map<string, Uint8Array>([
    ["apps/server/dist/bin.mjs", serverCode],
    ["apps/server/dist/web/assets/main.js", webCode],
  ]);
  const receipt = json({
    schemaVersion: 1,
    sourceCommit: commit,
    buildLockSha256: sha256(buildLockBytes),
    passed: true,
    checks: ["focused-tests", "windows-smoke", "identity-isolation"].map((name) => ({
      name,
      passed: true,
    })),
  });
  const files = new Map<string, Uint8Array>([
    ["T3CodeLAN.exe", pe()],
    ["resources/resource-monitor/t3-resource-monitor.exe", pe()],
    ["resources/app.asar.unpacked/node_modules/addon.node", pe()],
    ["resources/app.asar", asar(desktop)],
    ["resources/server.asar", asar(server)],
    ["resources/native-maintenance.mjs", helperCode],
    ["THIRD-PARTY-NOTICES.txt", Buffer.from("fixture notices")],
    ["t3code-lan-build-lock.json", buildLockBytes],
    ["t3code-lan-test-receipt.json", receipt],
    ["t3code-lan-runtime-policy-evidence.json", runtimeEvidence],
  ]);
  edit?.(files);
  files.set(
    "t3code-lan-package.json",
    json({
      schemaVersion: 1,
      packageId: "t3code-lan-1.0.0",
      version: "1.0.0",
      platform: "Win64",
      architecture: "x64",
      protocolVersion: 2,
      builtUtc: "2026-10-23T00:00:00Z",
      sourceDirty: false,
      sourceCommit: commit,
      upstreamCommit: commit,
      desktopVersion: "0.1.2",
      backendVersion: "0.1.2",
      ...identity,
      executablePath: "T3CodeLAN.exe",
      buildLockSha256: sha256(buildLockBytes),
      testReceiptSha256: sha256(files.get("t3code-lan-test-receipt.json")!),
      files: [...files]
        .sort(([left], [right]) => (left.toLowerCase() < right.toLowerCase() ? -1 : 1))
        .map(([name, bytes]) => pin(name, bytes)),
    }),
  );
  const artifact = zip(files);
  const run = (id: string): ArtifactRun => ({
    sourceId: id,
    buildRoot: `C:\\Builds\\${id}`,
    source: { commit, clean: true, upstreamAncestor: true, files: source },
    artifact,
    extractedFiles: new Map(files),
    toolchainFiles: new Map(
      [...tools].map(([name, bytes]) => [name, { length: bytes.length, sha256: sha256(bytes) }]),
    ),
  });
  const runs: [ArtifactRun, ArtifactRun] = [run("one"), run("two")];
  const calls: string[] = [];
  const inspectNative = async (selected: ArtifactRun, name: string) => {
    calls.push(`${selected.sourceId}:${name}`);
    return {
      sha256: sha256(selected.extractedFiles.get(name)!),
      trustStatus: 0,
      certificateSha256: certificate,
      fileVersion: "0.1.2",
      productName: "T3 Code LAN",
    };
  };
  return { policy, buildLockBytes, toolchainManifestBytes, runs, inspectNative, calls, files };
}
