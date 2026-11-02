// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { cacheKey, releaseLinkedEntries, seedPreparedCache } from "./server-compile-cache.ts";

// Reprint Hub rejects shipped files with more than one filesystem link, so seeding must never add one.
const expectSingleLink = (path: string) => {
  const entry = NodeFS.lstatSync(path);
  expect(entry.isFile(), path).toBe(true);
  expect(entry.nlink, path).toBe(1);
};

// Seeds are per-file symlinks or independent single-link copies, never shared inodes.
const expectIndependentSeed = (path: string) => {
  if (!NodeFS.lstatSync(path).isSymbolicLink()) expectSingleLink(path);
};

it.each(["x64", "arm64"])("skips prepared bytecode generation on Linux %s", async (arch) => {
  const { spawnSync } = await import("node:child_process");
  const hook = NodeURL.fileURLToPath(
    new URL("../prepare-server-compile-cache.cjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `Object.defineProperty(process, "platform", { value: "linux" });
       Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });
       require(${JSON.stringify(hook)})({ electronPlatformName: "linux", arch: ${arch === "x64" ? 1 : 3} }).catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Skipping unsupported target linux");
});

it("seeds relocated cache entries without allowing writes into shipped resources", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-prepared-test-")),
  );
  try {
    const prepared = NodePath.join(root, "resources", "server-compile-cache");
    const active = NodePath.join(root, "user", "different-uid-tag");
    NodeFS.mkdirSync(prepared, { recursive: true });
    NodeFS.mkdirSync(active, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prepared, "12345678"), "prepared bytes");
    const manifest = {
      format: 1,
      runtime: "matching",
      entries: [{ module: "app.asar/apps/server/dist/chunk.mjs", file: "12345678" }],
    };
    NodeFS.writeFileSync(NodePath.join(prepared, "manifest.json"), JSON.stringify(manifest));
    expect(seedPreparedCache(prepared, active, "wrong-engine")).toBe(false);
    expect(seedPreparedCache(prepared, active, "matching")).toBe(true);
    const key = cacheKey(active, NodePath.join(root, "resources", manifest.entries[0]!.module));
    expect(NodeFS.readFileSync(NodePath.join(active, key), "utf8")).toBe("prepared bytes");
    expectSingleLink(NodePath.join(prepared, "12345678"));
    expectIndependentSeed(NodePath.join(active, key));
    // Node persists by replacing the directory entry, never by overwriting the linked inode.
    NodeFS.rmSync(NodePath.join(active, key));
    NodeFS.writeFileSync(NodePath.join(active, key), "runtime replacement");
    expect(NodeFS.readFileSync(NodePath.join(prepared, "12345678"), "utf8")).toBe("prepared bytes");
    expect(seedPreparedCache(prepared, active, "matching")).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(active, key), "utf8")).toBe("runtime replacement");
    const missing = { module: "app.asar/apps/server/dist/missing.mjs", file: "87654321" };
    for (const entries of [
      [...manifest.entries, missing],
      [missing, ...manifest.entries],
    ]) {
      NodeFS.writeFileSync(
        NodePath.join(prepared, "manifest.json"),
        JSON.stringify({ ...manifest, entries }),
      );
      expect(seedPreparedCache(prepared, active, "matching")).toBe(false);
    }
    NodeFS.writeFileSync(NodePath.join(prepared, "manifest.json"), "corrupt");
    expect(seedPreparedCache(prepared, active, "matching")).toBe(false);
    expect(seedPreparedCache(NodePath.join(root, "missing"), active, "matching")).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("replaces hard-linked entries from earlier seeding with independent copies", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-prepared-relink-")),
  );
  try {
    const prepared = NodePath.join(root, "resources", "server-compile-cache");
    const active = NodePath.join(root, "user", "runtime");
    NodeFS.mkdirSync(prepared, { recursive: true });
    NodeFS.mkdirSync(active, { recursive: true });
    const source = NodePath.join(prepared, "12345678");
    NodeFS.writeFileSync(source, "prepared bytes");
    const entry = { module: "app.asar/apps/server/dist/chunk.mjs", file: "12345678" };
    NodeFS.writeFileSync(
      NodePath.join(prepared, "manifest.json"),
      JSON.stringify({ format: 1, runtime: "matching", entries: [entry] }),
    );
    const destination = NodePath.join(
      active,
      cacheKey(active, NodePath.join(root, "resources", entry.module)),
    );
    NodeFS.linkSync(source, destination);
    expect(NodeFS.statSync(source).nlink).toBe(2);
    expect(seedPreparedCache(prepared, active, "matching")).toBe(true);
    expectSingleLink(source);
    expectSingleLink(destination);
    expect(NodeFS.readFileSync(destination, "utf8")).toBe("prepared bytes");
    // The copy is writable and independent: replacing or editing it never reaches shipped bytes.
    NodeFS.writeFileSync(destination, "runtime replacement");
    expect(NodeFS.readFileSync(source, "utf8")).toBe("prepared bytes");
    expect(NodeFS.readdirSync(active).filter((name) => name.endsWith(".seed"))).toEqual([]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("releases every hard link an earlier build left in the private cache", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-prepared-release-")),
  );
  try {
    const shipped = NodePath.join(root, "resources", "server-compile-cache");
    const directory = NodePath.join(root, "cache", "server", "identity");
    const current = NodePath.join(directory, "current-runtime");
    const previous = NodePath.join(directory, "previous-runtime");
    const deeper = NodePath.join(previous, "nested");
    for (const path of [shipped, current, deeper]) NodeFS.mkdirSync(path, { recursive: true });
    const shippedFiles = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((name) => {
      const path = NodePath.join(shipped, name);
      NodeFS.writeFileSync(path, `shipped ${name}`);
      return path;
    });
    NodeFS.linkSync(shippedFiles[0]!, NodePath.join(current, "11111111"));
    // An entry for a module the newer build no longer ships, and one under an older engine.
    NodeFS.linkSync(shippedFiles[1]!, NodePath.join(current, "22222222"));
    NodeFS.linkSync(shippedFiles[2]!, NodePath.join(previous, "33333333"));
    NodeFS.writeFileSync(NodePath.join(current, "44444444"), "runtime written");
    NodeFS.writeFileSync(NodePath.join(deeper, "keep"), "outside the cache layout");
    releaseLinkedEntries(directory);
    for (const path of shippedFiles) {
      expectSingleLink(path);
      expect(NodeFS.readFileSync(path, "utf8")).toBe(`shipped ${NodePath.basename(path)}`);
    }
    expect(NodeFS.readdirSync(current)).toEqual(["44444444"]);
    expect(NodeFS.readdirSync(previous)).toEqual(["nested"]);
    expect(NodeFS.readFileSync(NodePath.join(deeper, "keep"), "utf8")).toBe(
      "outside the cache layout",
    );
    releaseLinkedEntries(NodePath.join(root, "missing"));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["app", "server"])(
  "generates %s.asar cache with the consumer engine and falls back after damage",
  async (archive) => {
    const { spawnSync } = await import("node:child_process");
    const helper = new URL("./server-compile-cache.ts", import.meta.url).href;
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cache-engine-")),
    );
    const run = (code: string) => {
      const env = {
        ...process.env,
        NODE_DEBUG_NATIVE: "COMPILE_CACHE",
        NODE_COMPILE_CACHE: undefined,
        NODE_DISABLE_COMPILE_CACHE: undefined,
      };
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stderr;
    };
    try {
      const producer = NodePath.join(root, "producer", "resources");
      const consumer = NodePath.join(root, "relocated", "resources");
      const relative = `${archive}.asar/apps/server/dist/binCli-fixture.mjs`;
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(producer, relative)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(producer, relative), "export const answer = 42;");
      run(
        `import {generatePreparedServerCache} from ${JSON.stringify(helper)}; await generatePreparedServerCache(${JSON.stringify(producer)});`,
      );
      NodeFS.cpSync(producer, consumer, { recursive: true });
      const consume = (home: string, appImage = false) =>
        run(
          `if (${appImage}) process.env.APPIMAGE = "fixture"; import {enablePreparedServerCache} from ${JSON.stringify(helper)}; import {pathToFileURL} from 'node:url'; if(!enablePreparedServerCache(${JSON.stringify(NodePath.join(consumer, relative))},${JSON.stringify(NodePath.join(root, home))})) throw Error('cache disabled'); const m = await import(pathToFileURL(${JSON.stringify(NodePath.join(consumer, relative))}).href); if(m.answer!==42) throw Error('source fallback failed');`,
        );
      const prepared = NodePath.join(consumer, "server-compile-cache");
      const shipped = NodeFS.readdirSync(prepared).map((file) => NodePath.join(prepared, file));
      // A home upgraded from a build that hard-linked: its old links must not survive this launch.
      const legacy = NodePath.join(
        root,
        "first-user",
        "server",
        NodeZlib.crc32(NodeFS.realpathSync(consumer)).toString(16),
        "older-engine",
      );
      NodeFS.mkdirSync(legacy, { recursive: true });
      for (const file of shipped.filter((file) => !file.endsWith("manifest.json")))
        NodeFS.linkSync(file, NodePath.join(legacy, NodePath.basename(file)));
      NodeFS.chmodSync(prepared, 0o555);
      expect(consume("first-user")).toContain("was accepted");
      expect(NodeFS.readdirSync(legacy)).toEqual([]);
      for (const file of shipped) expectSingleLink(file);
      expect(consume("appimage-user", true)).toContain("was accepted");
      expect(NodeFS.readdirSync(NodePath.join(root, "appimage-user", "server"))).toEqual([]);
      for (const file of shipped) expectSingleLink(file);
      NodeFS.chmodSync(prepared, 0o755);
      for (const file of NodeFS.readdirSync(prepared).filter((file) => file !== "manifest.json")) {
        NodeFS.writeFileSync(NodePath.join(prepared, file), "broken");
      }
      expect(consume("second-user")).toContain("was not initialized");
      for (const file of NodeFS.readdirSync(prepared).filter((file) => file !== "manifest.json")) {
        expect(NodeFS.readFileSync(NodePath.join(prepared, file), "utf8")).toBe("broken");
      }
      NodeFS.rmSync(prepared, { recursive: true });
      expect(consume("third-user")).toContain("was not initialized");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
