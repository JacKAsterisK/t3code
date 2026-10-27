// @effect-diagnostics nodeBuiltinImport:off - Synthetic cache fixtures exercise the actual downloader without network or extraction.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import { sha256 } from "./hub-distribution.ts";
import { preparePinnedElectronCache } from "./electron-cache.ts";

const version = "44.9.3";
const desktopRequire = NodeModule.createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);
const builderRequire = NodeModule.createRequire(
  desktopRequire.resolve("electron-builder/out/cli/cli.js"),
);
const helperPath = builderRequire.resolve("app-builder-lib/out/util/electronGet.js");
const { buildElectronArtifactConfig } = builderRequire(helperPath) as {
  buildElectronArtifactConfig: (options: object) => Promise<{
    cacheRoot: string;
    unsafelyDisableChecksums: boolean;
    checksums?: Record<string, string>;
  }>;
};
const getRequire = NodeModule.createRequire(helperPath);
const { Cache } = getRequire(
  NodePath.join(NodePath.dirname(getRequire.resolve("@electron/get")), "Cache.js"),
) as { Cache: { getCacheDirectory: (url: string) => string } };
function electronCacheArtifact(version: string) {
  const name = `electron-v${version}-win32-x64.zip`;
  return {
    name,
    relativePath: `${Cache.getCacheDirectory(`https://github.com/electron/electron/releases/download/v${version}/${name}`)}/${name}`,
    checksumName: `SHASUMS256.txt-${version}`,
  };
}
const { downloadArtifact } = NodeModule.createRequire(helperPath)("@electron/get") as {
  downloadArtifact: (options: object) => Promise<string>;
};

async function withFixture(
  run: (fixture: {
    root: string;
    cache: string;
    file: string;
    bytes: Buffer;
    artifact: ReturnType<typeof electronCacheArtifact>;
    pins: Map<string, { length: number; sha256: string }>;
  }) => Promise<void>,
) {
  const tempRoot = await NodeFSP.realpath(NodeOS.tmpdir());
  const root = await NodeFSP.mkdtemp(NodePath.join(tempRoot, "t3-electron-cache-"));
  if (!NodePath.resolve(root).startsWith(tempRoot + NodePath.sep))
    throw new Error("Electron cache fixture escaped its captured temporary root.");
  try {
    const cache = NodePath.join(root, "cache"),
      artifact = electronCacheArtifact(version);
    const file = NodePath.join(cache, artifact.relativePath),
      bytes = Buffer.from("approved synthetic Electron archive bytes");
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, bytes);
    const pins = new Map([
      [artifact.relativePath, { length: bytes.length, sha256: sha256(bytes) }],
    ]);
    await run({ root, cache, file, bytes, artifact, pins });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it.live(
  "uses the approved ZIP and derived checksums through the real downloader with zero network calls",
  () =>
    Effect.promise(() =>
      withFixture(async ({ root, cache, file, bytes, artifact, pins }) => {
        await preparePinnedElectronCache(cache, pins, version);
        await preparePinnedElectronCache(cache, pins, version);
        const config = await buildElectronArtifactConfig({
          electronDownload: { cache, isVerifyChecksum: true },
          version,
          arch: "x64",
          platformName: "win32",
          artifactName: "electron",
        });
        NodeAssert.equal(config.cacheRoot, cache);
        NodeAssert.equal(config.unsafelyDisableChecksums, false);
        NodeAssert.deepEqual(config.checksums, { [artifact.name]: sha256(bytes) });
        const requests: string[] = [];
        const result = await downloadArtifact({
          ...config,
          version,
          arch: "x64",
          platform: "win32",
          artifactName: "electron",
          mirrorOptions: {
            mirror: "https://github.com/electron/electron/releases/download/",
            customDir: `v${version}`,
          },
          tempDirectory: root,
          downloader: {
            download: async (url: string) => {
              requests.push(url);
              throw new Error("Unexpected network download");
            },
          },
        });
        NodeAssert.equal(result, file);
        NodeAssert.deepEqual(await NodeFSP.readFile(result), bytes);
        NodeAssert.deepEqual(requests, []);
      }),
    ),
);

it.live("rejects missing and corrupt archives before seeding checksums", () =>
  Effect.promise(() =>
    withFixture(async ({ cache, file, bytes, artifact, pins }) => {
      await NodeFSP.unlink(file);
      await NodeAssert.rejects(preparePinnedElectronCache(cache, pins, version), /ENOENT/u);
      await NodeFSP.writeFile(file, Buffer.concat([bytes, Buffer.from("changed")]));
      await NodeAssert.rejects(preparePinnedElectronCache(cache, pins, version), /approved hash/u);
      await NodeAssert.rejects(
        NodeFSP.stat(NodePath.join(cache, artifact.checksumName)),
        /ENOENT/u,
      );
    }),
  ),
);

it.live("rejects mismatched or absent approved pins and unsupported versions", () =>
  Effect.promise(() =>
    withFixture(async ({ cache, pins, artifact }) => {
      await NodeAssert.rejects(preparePinnedElectronCache(cache, new Map(), version), /absent/u);
      await NodeAssert.rejects(
        preparePinnedElectronCache(
          cache,
          new Map([
            [
              artifact.relativePath,
              { length: pins.get(artifact.relativePath)!.length, sha256: "0".repeat(64) },
            ],
          ]),
          version,
        ),
        /approved hash/u,
      );
      await NodeAssert.rejects(
        preparePinnedElectronCache(cache, pins, "../../outside"),
        /exact Electron version/u,
      );
      await NodeAssert.rejects(preparePinnedElectronCache(cache, pins, "99.0.0"), /absent/u);
    }),
  ),
);

it.live("does not overwrite a conflicting checksum seed or consume linked ZIP bytes", () =>
  Effect.promise(() =>
    withFixture(async ({ root, cache, file, artifact, pins }) => {
      const seed = NodePath.join(cache, artifact.checksumName);
      await NodeFSP.writeFile(seed, "unapproved checksum seed");
      await NodeAssert.rejects(preparePinnedElectronCache(cache, pins, version), /checksum seed/u);
      NodeAssert.equal(await NodeFSP.readFile(seed, "utf8"), "unapproved checksum seed");
      await NodeFSP.unlink(seed);
      await NodeFSP.link(file, NodePath.join(root, "linked.zip"));
      await NodeAssert.rejects(preparePinnedElectronCache(cache, pins, version), /linked/u);
    }),
  ),
);

it.live("the real downloader still validates a cached ZIP against the approved checksum", () =>
  Effect.promise(() =>
    withFixture(async ({ root, cache, file, pins }) => {
      await preparePinnedElectronCache(cache, pins, version);
      const config = await buildElectronArtifactConfig({
        electronDownload: { cache, isVerifyChecksum: true },
        version,
        arch: "x64",
        platformName: "win32",
        artifactName: "electron",
      });
      await NodeFSP.writeFile(file, "corrupt ZIP after cache preparation");
      const requests: string[] = [];
      await NodeAssert.rejects(
        downloadArtifact({
          ...config,
          version,
          arch: "x64",
          platform: "win32",
          artifactName: "electron",
          mirrorOptions: {
            mirror: "https://github.com/electron/electron/releases/download/",
            customDir: `v${version}`,
          },
          tempDirectory: root,
          downloader: {
            download: async (url: string) => {
              requests.push(url);
              throw new Error("Network refused after checksum mismatch");
            },
          },
        }),
        /Network refused after checksum mismatch/u,
      );
      NodeAssert.equal(requests.length, 1);
    }),
  ),
);
