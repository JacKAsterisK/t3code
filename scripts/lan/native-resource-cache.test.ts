// @effect-diagnostics nodeBuiltinImport:off - Synthetic native artifact fixtures; no compiler or helper is executed.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import {
  captureResourceMonitorCacheManifest,
  readResourceMonitorCache,
  resourceMonitorRecipeSha256,
  writeResourceMonitorCache,
} from "./native-resource-cache.ts";

const roots = (name: string) => ({
  sourceRoot: `C:\\${name}\\work\\source`,
  outputRoot: `C:\\${name}`,
  toolchainRoot: "C:\\tools",
});
const command = (name: string) => ({
  executable: "C:\\tools\\cargo.exe",
  cwd: roots(name).sourceRoot,
  args: [
    "build",
    "--frozen",
    "--offline",
    "--locked",
    "--release",
    "--manifest-path",
    roots(name).sourceRoot + "\\native\\resource-monitor\\Cargo.toml",
    "--target",
    "x86_64-pc-windows-msvc",
  ],
  env: {
    SOURCE_DATE_EPOCH: "0",
    CARGO_TARGET_DIR: roots(name).sourceRoot + "\\native\\resource-monitor\\target",
    CARGO_ENCODED_RUSTFLAGS: `-C\x1flink-arg=/Brepro\x1f--remap-path-prefix=${roots(name).outputRoot}=C:\\T3LanBuild`,
  },
});
const recipe = (name = "build-one") =>
  resourceMonitorRecipeSha256(command(name), {
    ...roots(name),
    toolchainManifestSha256: "a".repeat(64),
  });

it("normalizes only independent build roots while retaining the full command and toolchain pins", () => {
  expect(recipe("build-one")).toBe(recipe("build-two"));
  expect(
    resourceMonitorRecipeSha256(
      { ...command("build-one"), env: { ...command("build-one").env, SOURCE_DATE_EPOCH: "1" } },
      { ...roots("build-one"), toolchainManifestSha256: "a".repeat(64) },
    ),
  ).not.toBe(recipe());
  expect(
    resourceMonitorRecipeSha256(command("build-one"), {
      ...roots("build-one"),
      toolchainManifestSha256: "b".repeat(64),
    }),
  ).not.toBe(recipe());
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-artifact-cache-"));
  const sourceRoot = NodePath.join(root, "source"),
    cacheRoot = NodePath.join(root, "artifacts");
  await NodeFSP.mkdir(NodePath.join(sourceRoot, "native/resource-monitor/src"), {
    recursive: true,
  });
  await NodeFSP.mkdir(cacheRoot);
  await NodeFSP.writeFile(
    NodePath.join(sourceRoot, "native/resource-monitor/Cargo.toml"),
    "synthetic Cargo manifest",
  );
  await NodeFSP.writeFile(
    NodePath.join(sourceRoot, "native/resource-monitor/Cargo.lock"),
    "synthetic Cargo lock",
  );
  await NodeFSP.writeFile(
    NodePath.join(sourceRoot, "native/resource-monitor/src/main.rs"),
    "fn main() {}",
  );
  const binaryPath = NodePath.join(cacheRoot, "t3-resource-monitor.exe"),
    bytes = Buffer.from("synthetic native binary");
  await NodeFSP.writeFile(binaryPath, bytes);
  const manifest = await captureResourceMonitorCacheManifest({
    sourceRoot,
    binaryPath,
    recipeSha256: recipe(),
    toolchainManifestSha256: "a".repeat(64),
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await NodeFSP.writeFile(NodePath.join(cacheRoot, "manifest.json"), manifestBytes);
  return {
    root,
    sourceRoot,
    cacheRoot,
    binaryPath,
    bytes,
    manifestBytes,
    input: {
      sourceRoot,
      descriptor: { root: cacheRoot, manifestSha256: sha256(manifestBytes) },
      recipeSha256: recipe(),
      toolchainManifestSha256: "a".repeat(64),
    },
  };
}

it("reuses the separately pinned native output only when the current complete source closure matches", async () => {
  const f = await fixture();
  try {
    expect(await readResourceMonitorCache(f.input)).toEqual(f.bytes);
    await NodeFSP.writeFile(
      NodePath.join(f.sourceRoot, "native/resource-monitor/src/main.rs"),
      "fn main() { panic!() }",
    );
    await expect(readResourceMonitorCache(f.input)).rejects.toThrow(/source/u);
  } finally {
    await NodeFSP.rm(f.root, { recursive: true, force: true });
  }
});

it("refuses output, manifest, recipe and toolchain changes instead of silently using them", async () => {
  const f = await fixture();
  try {
    await expect(
      readResourceMonitorCache({ ...f.input, recipeSha256: "c".repeat(64) }),
    ).rejects.toThrow(/recipe/u);
    await expect(
      readResourceMonitorCache({ ...f.input, toolchainManifestSha256: "c".repeat(64) }),
    ).rejects.toThrow(/recipe/u);
    await NodeFSP.writeFile(f.binaryPath, "changed output");
    await expect(readResourceMonitorCache(f.input)).rejects.toThrow(/output/u);
    await NodeFSP.writeFile(f.binaryPath, f.bytes);
    await NodeFSP.writeFile(NodePath.join(f.cacheRoot, "manifest.json"), "{}");
    await expect(readResourceMonitorCache(f.input)).rejects.toThrow(/manifest/u);
  } finally {
    await NodeFSP.rm(f.root, { recursive: true, force: true });
  }
});

it("invalidates the cache when ancestor Cargo configuration or additional native source is introduced", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.sourceRoot, ".cargo"));
    await NodeFSP.writeFile(
      NodePath.join(f.sourceRoot, ".cargo/config.toml"),
      "[build]\nrustflags = []",
    );
    await expect(readResourceMonitorCache(f.input)).rejects.toThrow(/source/u);
  } finally {
    await NodeFSP.rm(f.root, { recursive: true, force: true });
  }
});

it("captures a reusable artifact outside the shipped stage and preserves preexisting capture output", async () => {
  const f = await fixture();
  try {
    const outputRoot = NodePath.join(f.root, "build");
    await NodeFSP.mkdir(outputRoot);
    const input = {
      sourceRoot: f.sourceRoot,
      outputRoot,
      binaryPath: f.binaryPath,
      recipeSha256: recipe(),
      toolchainManifestSha256: "a".repeat(64),
    };
    const descriptor = await writeResourceMonitorCache(input);
    expect(descriptor.root).toBe(NodePath.join(outputRoot, "artifacts/resource-monitor-cache"));
    expect(await readResourceMonitorCache({ ...input, descriptor })).toEqual(f.bytes);
    await expect(writeResourceMonitorCache(input)).rejects.toThrow();
    expect(
      await NodeFSP.readFile(NodePath.join(descriptor.root, "t3-resource-monitor.exe")),
    ).toEqual(f.bytes);
  } finally {
    await NodeFSP.rm(f.root, { recursive: true, force: true });
  }
});

it("refuses unpinned Cargo configuration above the isolated source", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.root, ".cargo"));
    await NodeFSP.writeFile(NodePath.join(f.root, ".cargo/config.toml"), "[build]\nrustflags = []");
    await expect(readResourceMonitorCache(f.input)).rejects.toThrow(/ancestor Cargo/u);
  } finally {
    await NodeFSP.rm(f.root, { recursive: true, force: true });
  }
});
