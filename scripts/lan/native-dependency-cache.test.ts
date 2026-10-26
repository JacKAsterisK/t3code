// @effect-diagnostics nodeBuiltinImport:off - Disposable dependency fixtures; no real installation, provider or native build.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import {
  assertNativeDependencyCacheSeparation,
  captureNativeDependencyCache,
  nativeDependencyInputs,
  nativeDependencyRecipeSha256,
  restoreNativeDependencyCache,
} from "./native-dependency-cache.ts";

const bytes = (value: string) => Buffer.from(value);
const inputs = () =>
  new Map([
    ["package.json", bytes(JSON.stringify({ scripts: { prepare: "vp config --no-agent" } }))],
    ["pnpm-lock.yaml", bytes("exact lock")],
    ["scripts/lan/windows-build-execution.ts", bytes("reviewed execution implementation")],
    ["pnpm-workspace.yaml", bytes("packages: [apps/*, packages/*]")],
    ["packages/local/package.json", bytes('{"name":"@fixture/local"}')],
    ["patches/example.patch", bytes("reviewed patch")],
    ["apps/web/src/index.ts", bytes("source change does not reinstall dependencies")],
  ]);

it("binds reuse to install inputs and the complete native toolchain, while permitting ordinary source edits", () => {
  const original = inputs(),
    first = nativeDependencyInputs(original, "a".repeat(64), "e".repeat(64));
  const sourceEdit = new Map(original);
  sourceEdit.set("apps/web/src/index.ts", bytes("new application source"));
  expect(nativeDependencyInputs(sourceEdit, "a".repeat(64), "e".repeat(64))).toEqual(first);
  for (const name of ["pnpm-lock.yaml", "patches/example.patch", "pnpm-workspace.yaml"]) {
    const changed = new Map(original);
    changed.set(name, bytes("changed input"));
    expect(nativeDependencyInputs(changed, "a".repeat(64), "e".repeat(64)).keySha256).not.toBe(
      first.keySha256,
    );
  }
  expect(nativeDependencyInputs(original, "b".repeat(64), "e".repeat(64)).keySha256).not.toBe(
    first.keySha256,
  );
  const lifecycle = new Map(original);
  lifecycle.set(
    "packages/local/package.json",
    bytes('{"scripts":{"prepare":"node generated.js"}}'),
  );
  expect(() => nativeDependencyInputs(lifecycle, "a".repeat(64), "e".repeat(64))).toThrow(
    /lifecycle/u,
  );
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-dependency-reuse-"));
  const source = NodePath.join(root, "original"),
    cacheRoot = NodePath.join(root, "cache");
  await NodeFSP.mkdir(
    NodePath.join(source, "node_modules", ".pnpm", "fixture", "node_modules", "fixture"),
    {
      recursive: true,
    },
  );
  await NodeFSP.mkdir(NodePath.join(source, "node_modules", ".bin"));
  await NodeFSP.mkdir(NodePath.join(source, "packages", "local"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(source, "packages", "local", "index.js"),
    "original workspace source",
  );
  await NodeFSP.writeFile(
    NodePath.join(
      source,
      "node_modules",
      ".pnpm",
      "fixture",
      "node_modules",
      "fixture",
      "index.js",
    ),
    "approved dependency",
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "node_modules", ".bin", "fixture.cmd"),
    "@SET NODE_PATH=" + NodePath.join(source, "node_modules", ".pnpm") + "\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "node_modules", ".modules.yaml"),
    JSON.stringify({ virtualStoreDir: NodePath.join(source, "node_modules", ".pnpm") }),
  );
  await NodeFSP.symlink(
    NodePath.join(source, "node_modules", ".pnpm", "fixture", "node_modules", "fixture"),
    NodePath.join(source, "node_modules", "fixture"),
    "junction",
  );
  await NodeFSP.symlink(
    NodePath.join(source, "packages", "local"),
    NodePath.join(source, "node_modules", "local"),
    "junction",
  );
  const key = nativeDependencyInputs(inputs(), "a".repeat(64), "e".repeat(64));
  const cache = await captureNativeDependencyCache({
    sourceRoot: source,
    cacheRoot,
    sourceCommit: "b".repeat(40),
    inputs: key,
  });
  const destination = async (name: string) => {
    const output = NodePath.join(root, name);
    await NodeFSP.mkdir(NodePath.join(output, "packages", "local"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(output, "packages", "local", "index.js"),
      "new snapshot source",
    );
    return output;
  };
  return {
    root,
    source,
    key,
    cache,
    destination,
    cleanup: async () => {
      if (!NodePath.resolve(root).startsWith(NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep))
        throw new Error("Fixture cleanup escaped its captured temporary root.");
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("restores independent bytes, relocates generated shims and metadata, and binds workspace links to the new source", async () => {
  const f = await fixture();
  try {
    const output = await f.destination("fresh");
    expect(
      await restoreNativeDependencyCache({ sourceRoot: output, cache: f.cache, inputs: f.key }),
    ).toMatchObject({ independentlyCopied: true, links: 2 });
    expect(
      await NodeFSP.readFile(NodePath.join(output, "node_modules", "local", "index.js"), "utf8"),
    ).toBe("new snapshot source");
    expect(
      await NodeFSP.readFile(NodePath.join(output, "node_modules", ".bin", "fixture.cmd"), "utf8"),
    ).toContain(NodePath.join(output, "node_modules", ".pnpm"));
    expect(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(output, "node_modules", ".modules.yaml"), "utf8"),
      ).virtualStoreDir,
    ).toBe(NodePath.join(output, "node_modules", ".pnpm"));
    await NodeFSP.writeFile(
      NodePath.join(output, "node_modules", "fixture", "index.js"),
      "build-local mutation",
    );
    expect(
      await NodeFSP.readFile(
        NodePath.join(f.source, "node_modules", "fixture", "index.js"),
        "utf8",
      ),
    ).toBe("approved dependency");
    const second = await f.destination("independent-second");
    await restoreNativeDependencyCache({ sourceRoot: second, cache: f.cache, inputs: f.key });
    expect(
      await NodeFSP.readFile(NodePath.join(second, "node_modules", "fixture", "index.js"), "utf8"),
    ).toBe("approved dependency");
  } finally {
    await f.cleanup();
  }
});

it("refuses changed approved manifests, tampered cache bytes and mismatched installation keys", async () => {
  const f = await fixture();
  try {
    const output = await f.destination("fresh");
    await expect(
      restoreNativeDependencyCache({
        sourceRoot: output,
        cache: { ...f.cache, manifestSha256: "c".repeat(64) },
        inputs: f.key,
      }),
    ).rejects.toThrow(/manifest changed/u);
    await expect(
      restoreNativeDependencyCache({
        sourceRoot: output,
        cache: f.cache,
        inputs: { ...f.key, keySha256: "d".repeat(64) },
      }),
    ).rejects.toThrow(/incompatible/u);
    await NodeFSP.writeFile(
      NodePath.join(
        f.cache.root,
        "payload",
        "node_modules",
        ".pnpm",
        "fixture",
        "node_modules",
        "fixture",
        "index.js",
      ),
      "tampered dependency",
    );
    await expect(
      restoreNativeDependencyCache({ sourceRoot: output, cache: f.cache, inputs: f.key }),
    ).rejects.toThrow(/content changed/u);
  } finally {
    await f.cleanup();
  }
});

it("never restores over an existing node_modules tree", async () => {
  const f = await fixture();
  try {
    const output = await f.destination("fresh");
    await NodeFSP.mkdir(NodePath.join(output, "node_modules"));
    await expect(
      restoreNativeDependencyCache({ sourceRoot: output, cache: f.cache, inputs: f.key }),
    ).rejects.toThrow(/never overwrites/u);
  } finally {
    await f.cleanup();
  }
});

it("refuses a separately approved malformed receipt whose link leaves the current workspace", async () => {
  const f = await fixture();
  try {
    const manifestPath = NodePath.join(f.cache.root, "manifest.json"),
      manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    manifest.entries.find((entry: { kind: string }) => entry.kind === "link").target = "../foreign";
    const content = bytes(JSON.stringify(manifest));
    await NodeFSP.writeFile(manifestPath, content);
    await expect(
      restoreNativeDependencyCache({
        sourceRoot: await f.destination("fresh"),
        cache: { ...f.cache, manifestSha256: sha256(content) },
        inputs: f.key,
      }),
    ).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

it("refuses cache locations overlapping inputs or live T3 homes", () => {
  const root = NodePath.resolve(NodeOS.tmpdir(), "dependency-root");
  expect(() => assertNativeDependencyCacheSeparation(NodePath.join(root, "cache"), [root])).toThrow(
    /separate/u,
  );
  expect(() =>
    assertNativeDependencyCacheSeparation(NodePath.join(root, ".t3", "cache"), []),
  ).toThrow(/T3 homes/u);
});

it("keys the normalized exact install recipe and refuses varying lifecycle timestamps", () => {
  const source = NodePath.resolve(NodeOS.tmpdir(), "recipe-one"),
    tools = NodePath.resolve(NodeOS.tmpdir(), "recipe-tools");
  const command = {
    executable: NodePath.join(tools, "node.exe"),
    args: ["install", "--frozen-lockfile"],
    cwd: source,
    env: { SOURCE_DATE_EPOCH: "0", ABI: "node26", CACHE: NodePath.join(source, "cache") },
  };
  const first = nativeDependencyRecipeSha256(command, { SOURCE: source, TOOLS: tools });
  const secondSource = NodePath.resolve(NodeOS.tmpdir(), "recipe-two");
  expect(
    nativeDependencyRecipeSha256(
      {
        ...command,
        cwd: secondSource,
        env: { ...command.env, CACHE: NodePath.join(secondSource, "cache") },
      },
      { SOURCE: secondSource, TOOLS: tools },
    ),
  ).toBe(first);
  expect(
    nativeDependencyRecipeSha256(
      { ...command, args: ["install", "--prod"] },
      { SOURCE: source, TOOLS: tools },
    ),
  ).not.toBe(first);
  expect(
    nativeDependencyRecipeSha256(
      { ...command, env: { ...command.env, ABI: "electron44" } },
      { SOURCE: source, TOOLS: tools },
    ),
  ).not.toBe(first);
  expect(() =>
    nativeDependencyRecipeSha256(
      { ...command, env: { ...command.env, SOURCE_DATE_EPOCH: "123" } },
      { SOURCE: source, TOOLS: tools },
    ),
  ).toThrow(/epoch/u);
  expect(nativeDependencyInputs(inputs(), "a".repeat(64), "e".repeat(64)).keySha256).not.toBe(
    nativeDependencyInputs(inputs(), "a".repeat(64), "f".repeat(64)).keySha256,
  );
});

it("invalidates copied local file dependencies and the execution implementation", () => {
  const original = inputs();
  original.set(
    "package.json",
    bytes(
      JSON.stringify({
        scripts: { prepare: "vp config --no-agent" },
        dependencies: { fixture: "file:./local" },
      }),
    ),
  );
  original.set("local/index.js", bytes("original local package"));
  original.set("scripts/lan/windows-build-execution.ts", bytes("original install recipe"));
  const first = nativeDependencyInputs(original, "a".repeat(64), "e".repeat(64));
  for (const file of ["local/index.js", "scripts/lan/windows-build-execution.ts"]) {
    const changed = new Map(original);
    changed.set(file, bytes("new content"));
    expect(nativeDependencyInputs(changed, "a".repeat(64), "e".repeat(64)).keySha256).not.toBe(
      first.keySha256,
    );
  }
});

it("relocates the pinned pnpm store path outside the source root into the new build context", async () => {
  const f = await fixture();
  try {
    const oldOutput = NodePath.join(f.root, "old-build"),
      nextOutput = NodePath.join(f.root, "next-build");
    await NodeFSP.writeFile(
      NodePath.join(f.source, "node_modules", ".modules.yaml"),
      JSON.stringify({
        virtualStoreDir: NodePath.join(f.source, "node_modules", ".pnpm"),
        storeDir: NodePath.join(oldOutput, "caches", "pnpmStore"),
      }),
    );
    const cache = await captureNativeDependencyCache({
      sourceRoot: f.source,
      cacheRoot: NodePath.join(f.root, "relocatable-cache"),
      sourceCommit: "b".repeat(40),
      inputs: f.key,
      relocationRoots: { SOURCE: f.source, OUTPUT: oldOutput },
    });
    const output = await f.destination("fresh");
    await expect(
      restoreNativeDependencyCache({ sourceRoot: output, cache, inputs: f.key }),
    ).rejects.toThrow(/relocation roots changed/u);
    await restoreNativeDependencyCache({
      sourceRoot: output,
      cache,
      inputs: f.key,
      relocationRoots: { SOURCE: output, OUTPUT: nextOutput },
    });
    const metadata = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output, "node_modules", ".modules.yaml"), "utf8"),
    );
    expect(metadata.virtualStoreDir).toBe(NodePath.join(output, "node_modules", ".pnpm"));
    expect(metadata.storeDir).toBe(NodePath.join(nextOutput, "caches", "pnpmStore"));
  } finally {
    await f.cleanup();
  }
});
