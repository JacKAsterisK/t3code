// @effect-diagnostics nodeBuiltinImport:off - Synthetic in-memory preparation inputs; no compiler, installer or application process is launched.
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { BUILD_INPUT_FILES, sha256, type BuildLock } from "./hub-distribution.ts";
import { LAN_STAGE_LOCK_FILES } from "./lan-packaging.ts";
import { populateProductionStageFixture } from "./stage-locks.fixtures.ts";
import {
  LAN_WINDOWS_EXECUTION_BLOCKERS,
  nativeBuildRoot,
  preparePinnedWindowsBuild,
  verifyWindowsPreparationEvidence,
} from "./windows-build-preparation.ts";

function fixture() {
  const identity = {
    appId: "com.example.lanfixture",
    productName: "LAN Fixture",
    protocolScheme: "lan-fixture",
    homeDirectoryName: "T3CodeLAN",
    telemetry: "disabled",
    cloudConfiguration: "disabled",
    nativeUpdater: "disabled",
    protocolVersion: 2,
    applicationVersion: "0.1.2",
    sourceCommit: "a".repeat(40),
  };
  const files = new Map<string, Buffer>(
    [...BUILD_INPUT_FILES, ...Object.values(LAN_STAGE_LOCK_FILES)].map((name) => [
      name,
      Buffer.from(`synthetic source:${name}`),
    ]),
  );
  files.set(
    "package.json",
    Buffer.from(JSON.stringify({ engines: { node: "26.12.1" }, packageManager: "pnpm@12.14.0" })),
  );
  for (const name of [
    "apps/desktop/package.json",
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ])
    files.set(name, Buffer.from(JSON.stringify({ version: "0.1.2" })));
  populateProductionStageFixture(files);
  const names = ["node", "pnpm", "rust", "msvc", "windowsSdk", "nsis"] as const;
  const toolFiles = {
    node: "node/node.exe",
    pnpm: "pnpm/pnpm.cjs",
    rust: "rust/rustc.exe",
    msvc: "msvc/cl.exe",
    windowsSdk: "sdk/rc.exe",
    nsis: "nsis/makensis.exe",
  };
  const toolchainFiles = new Map(
    names.map((name) => {
      const bytes = Buffer.from(`synthetic tool:${name}`);
      return [toolFiles[name], { length: bytes.length, sha256: sha256(bytes) }];
    }),
  );
  const pin = (name: (typeof names)[number], version: string) => ({
    version,
    sha256: toolchainFiles.get(toolFiles[name])!.sha256,
  });
  const lock = {
    schemaVersion: 1,
    upstreamCommit: "b".repeat(40),
    forkCommit: identity.sourceCommit,
    distributionVersion: "1.0.0",
    applicationVersion: "0.1.2",
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])),
    tools: {
      node: pin("node", "26.12.1"),
      pnpm: pin("pnpm", "12.14.0"),
      rust: pin("rust", "1.0.0"),
      msvc: pin("msvc", "1.0.0"),
      windowsSdk: pin("windowsSdk", "1.0.0"),
      nsis: pin("nsis", "1.0.0"),
    },
    wslRuntime: null,
    cloudConfiguration: "disabled",
    telemetry: "disabled",
    nativeUpdater: "disabled",
  } satisfies BuildLock;
  const lockBytes = Buffer.from(JSON.stringify(lock));
  const identityBytes = Buffer.from(JSON.stringify(identity));
  const toolchainManifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      files: [...toolchainFiles].map(([path, pin]) => ({ path, ...pin })),
    }),
  );
  const input = {
    request: {
      schemaVersion: 1 as const,
      sourceRoot: "C:\\LANBuild\\source",
      buildRoot: "C:\\LANBuild\\output",
      toolchainRoot: "C:\\LANBuild\\tools",
      buildLockPath: "C:\\LANBuild\\inputs\\build-lock.json",
      buildLockSha256: sha256(lockBytes),
      identityPath: "C:\\LANBuild\\inputs\\identity.json",
      identitySha256: sha256(identityBytes),
      toolchainManifestPath: "C:\\LANBuild\\inputs\\toolchain.json",
      toolchainManifestSha256: sha256(toolchainManifestBytes),
      toolFiles,
    },
    lockBytes,
    identityBytes,
    toolchainManifestBytes,
    source: { commit: identity.sourceCommit, clean: true, upstreamAncestor: true, files },
    toolchainFiles,
  };
  const replaceLock = () => {
    input.lockBytes = Buffer.from(JSON.stringify(lock));
    input.request.buildLockSha256 = sha256(input.lockBytes);
  };
  return { input, lock, replaceLock };
}

describe("pinned Windows preparation", () => {
  it.live(
    "refuses a populated build directory before reading tools or source and preserves its files",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        yield* Effect.tryPromise(async () => {
          const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-build-prep-"));
          try {
            const { input } = fixture();
            const request = {
              ...input.request,
              sourceRoot: NodePath.join(root, "source"),
              buildRoot: NodePath.join(root, "build"),
              toolchainRoot: NodePath.join(root, "tools"),
            };
            for (const directory of [request.sourceRoot, request.buildRoot, request.toolchainRoot])
              await NodeFSP.mkdir(directory);
            const sentinel = NodePath.join(request.buildRoot, "preserve.txt");
            await NodeFSP.writeFile(sentinel, "existing work");
            const requestPath = NodePath.join(root, "request.json");
            const bytes = Buffer.from(JSON.stringify(request));
            await NodeFSP.writeFile(requestPath, bytes);
            await expect(preparePinnedWindowsBuild(requestPath, sha256(bytes))).rejects.toThrow(
              platform === "win32" ? /must be empty/u : /requires native Windows/u,
            );
            expect(await NodeFSP.readFile(sentinel, "utf8")).toBe("existing work");
            expect(await NodeFSP.readdir(request.sourceRoot)).toEqual([]);
            expect(await NodeFSP.readdir(request.toolchainRoot)).toEqual([]);
          } finally {
            await NodeFSP.rm(root, { recursive: true, force: true });
          }
        });
      }),
  );

  it("verifies supplied bytes without granting build execution or claiming runner isolation", () => {
    const { input } = fixture();
    const before = JSON.stringify(input.request);
    const result = verifyWindowsPreparationEvidence(input);
    expect(result).toMatchObject({
      inputsVerified: true,
      buildAuthorized: false,
      distributionAuthorized: false,
      executionSupported: false,
      toolchainFilesVerified: 6,
      sourceCommit: "a".repeat(40),
      blockers: [...LAN_WINDOWS_EXECUTION_BLOCKERS],
    });
    expect(result.tools.node).toMatchObject({
      version: "26.12.1",
      path: "C:\\LANBuild\\tools\\node\\node.exe",
    });
    expect(JSON.stringify(input.request)).toBe(before);
  });

  it.each(["lockBytes", "identityBytes", "toolchainManifestBytes"] as const)(
    "refuses changed reviewed %s bytes",
    (name) => {
      const { input } = fixture();
      input[name] = Buffer.from("changed input");
      expect(() => verifyWindowsPreparationEvidence(input)).toThrow(
        /reviewed preparation request/u,
      );
    },
  );

  it("accepts a pinned public package store beyond 100,000 files and still rejects changed entries", () => {
    const { input } = fixture();
    const packageFile = { length: 0, sha256: sha256("") };
    for (let index = 0; index < 100_001; index++)
      input.toolchainFiles.set(`public-pnpm-store/files/${index}`, packageFile);
    input.toolchainManifestBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        files: [...input.toolchainFiles].map(([path, pin]) => ({ path, ...pin })),
      }),
    );
    input.request.toolchainManifestSha256 = sha256(input.toolchainManifestBytes);
    expect(verifyWindowsPreparationEvidence(input).toolchainFilesVerified).toBe(100_007);
    input.toolchainFiles.set("public-pnpm-store/files/100000", { ...packageFile, length: 1 });
    expect(() => verifyWindowsPreparationEvidence(input)).toThrow(/inventory differs/u);
  });

  it.each([{ commit: "a".repeat(12) }, { clean: false }, { upstreamAncestor: false }])(
    "refuses incomplete or unapproved source evidence %j",
    (change) => {
      const { input } = fixture();
      Object.assign(input.source, change);
      expect(() => verifyWindowsPreparationEvidence(input)).toThrow(/full-commit source/u);
    },
  );

  it("refuses omitted stage locks, changed source and unaligned versions", () => {
    const omitted = fixture();
    delete omitted.lock.files[LAN_STAGE_LOCK_FILES.desktop];
    omitted.replaceLock();
    expect(() => verifyWindowsPreparationEvidence(omitted.input)).toThrow(/source input/u);
    const changed = fixture();
    changed.input.source.files.set("package.json", Buffer.from("changed source"));
    expect(() => verifyWindowsPreparationEvidence(changed.input)).toThrow(/source input/u);
    const versions = fixture();
    versions.lock.applicationVersion = "0.1.3";
    versions.input.identityBytes = Buffer.from(
      JSON.stringify({
        ...JSON.parse(versions.input.identityBytes.toString()),
        applicationVersion: "0.1.3",
      }),
    );
    versions.input.request.identitySha256 = sha256(versions.input.identityBytes);
    versions.replaceLock();
    expect(() => verifyWindowsPreparationEvidence(versions.input)).toThrow(
      /Align release package versions/u,
    );
  });

  it("refuses altered, extra and primary-tool-mismatched inventories", () => {
    const changed = fixture();
    changed.input.toolchainFiles.set("node/node.exe", { length: 1, sha256: "c".repeat(64) });
    expect(() => verifyWindowsPreparationEvidence(changed.input)).toThrow(/inventory differs/u);
    const extra = fixture();
    extra.input.toolchainFiles.set("undeclared.dll", { length: 1, sha256: "c".repeat(64) });
    expect(() => verifyWindowsPreparationEvidence(extra.input)).toThrow(/extra files/u);
    const primary = fixture();
    primary.lock.tools.rust.sha256 = "c".repeat(64);
    primary.replaceLock();
    expect(() => verifyWindowsPreparationEvidence(primary.input)).toThrow(
      /Primary tool pin differs: rust/u,
    );
  });

  it.each([
    "relative",
    "C:\\LANBuild\\..\\official",
    "C:\\Users\\owner\\.t3",
    "C:\\Users\\owner\\.codex\\build",
    "C:\\cache\\tools",
    "C:\\Users\\owner\\AppData\\Local\\Packages\\sandbox",
    "C:\\Users\\owner\\AppData\\Local\\T3CodeLAN\\data",
  ])("refuses an installed/virtualized/noncanonical root: %s", (root) => {
    expect(() => nativeBuildRoot(root)).toThrow();
  });

  it("refuses overlapping source/build/toolchain directories", () => {
    const { input } = fixture();
    input.request.buildRoot = "C:\\LANBuild\\source\\output";
    expect(() => verifyWindowsPreparationEvidence(input)).toThrow(/nonoverlapping/u);
  });
});
