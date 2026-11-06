// @effect-diagnostics nodeBuiltinImport:off - Compiles actual desktop entry recipes into disposable fixtures and evaluates them with restricted ports.
import { it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { UserConfigExport } from "vite-plus";
import { build, type PackUserConfig } from "vite-plus/pack";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

const fixture = vi.hoisted(() => ({
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
}));
vi.mock("../lib/lan-build-policy.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/lan-build-policy.ts")>(
    "../lib/lan-build-policy.ts",
  );
  return { ...actual, loadLanBuildPolicy: () => fixture };
});
vi.mock("../lib/public-config.ts", () => ({
  loadRepoEnv: () => {
    throw new Error("LAN config must not read repository environment files");
  },
}));

it("disables Vite automatic environment exposure on the actual LAN config, outside plugin options", async () => {
  // Its own composite project typechecks this config; load the real module at
  // runtime without pulling web's bundler-resolution files into scripts' NodeNext project.
  vi.stubEnv("T3CODE_FORK_BUILD_VERSION", "7.8.9");
  try {
    const configPath = "../../apps/web/vite.config.ts";
    const { default: config } = (await import(configPath)) as { default: UserConfigExport };
    if (typeof config !== "function")
      throw new Error("Expected the actual web configuration function.");
    const resolved = await config({
      command: "build",
      mode: "production",
      isSsrBuild: false,
      isPreview: false,
    });
    NodeAssert.equal(resolved.define?.["import.meta.env.FORK_BUILD_VERSION"], '"7.8.9"');
    NodeAssert.equal(resolved.define?.["import.meta.env.APP_VERSION"], '"0.1.2"');
    vi.stubEnv("T3CODE_FORK_BUILD_VERSION", "");
    const withoutReleaseMetadata = await config({
      command: "build",
      mode: "production",
      isSsrBuild: false,
      isPreview: false,
    });
    NodeAssert.equal(withoutReleaseMetadata.define?.["import.meta.env.FORK_BUILD_VERSION"], '""');
    NodeAssert.equal(resolved.envDir, false);
    NodeAssert.deepEqual(resolved.envPrefix, []);
    NodeAssert.equal(resolved.define?.["import.meta.env.VITE_T3CODE_RELAY_URL"], '""');
    NodeAssert.equal(resolved.define?.["import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY"], '""');
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  { name: "boot and compile cache", entry: "src/boot.ts" },
  { name: "preload", entry: "src/preload.ts" },
])("loads the actual LAN $name bundle without external workspace packages", async ({ entry }) => {
  const configPath = "../../apps/desktop/vite.config.ts";
  const { default: config } = (await import(configPath)) as {
    default: { pack: PackUserConfig[] };
  };
  const recipe = config.pack.find(
    (candidate) => Array.isArray(candidate.entry) && candidate.entry.includes(entry),
  );
  NodeAssert.ok(recipe, `Actual desktop pack recipe is missing ${entry}`);
  const temporaryParent = NodePath.resolve(NodeOS.tmpdir());
  const root = await NodeFSP.mkdtemp(NodePath.join(temporaryParent, "t3-lan-desktop-entry-"));
  try {
    await build({
      ...recipe,
      config: false,
      cwd: NodePath.resolve(import.meta.dirname, "../../apps/desktop"),
      outDir: root,
    });
    const cachePaths: string[] = [],
      events: string[] = [],
      denied: string[] = [];
    let desktopPlatform: (() => unknown) | undefined;
    const refuse = (name: string) => () => {
      denied.push(name);
      throw new Error(`Unexpected desktop entry port: ${name}`);
    };
    const sources = new Map<string, string>();
    for (const file of await NodeFSP.readdir(root, { withFileTypes: true }))
      if (file.isFile() && file.name.endsWith(".cjs"))
        sources.set(file.name, await NodeFSP.readFile(NodePath.join(root, file.name), "utf8"));
    const modules = new Map<string, { exports: unknown }>();
    const evaluate = (filename: string): unknown => {
      const cached = modules.get(filename);
      if (cached) return cached.exports;
      const code = sources.get(filename);
      NodeAssert.notEqual(code, undefined, `Missing generated module ${filename}`);
      const exports = {};
      const module = { exports: exports as unknown };
      modules.set(filename, module);
      new NodeVM.Script(
        `(function(require,module,exports,process,__filename,__dirname){\n${code}\n})`,
      ).runInNewContext({})(
        (id: string) => {
          if (id === "./main.cjs" && entry === "src/boot.ts") {
            events.push("main");
            return {};
          }
          if (/^\.\/[A-Za-z0-9_-]+\.cjs$/u.test(id) && sources.has(id.slice(2)))
            return evaluate(id.slice(2));
          if (id === "node:module")
            return {
              enableCompileCache: (location: string) => {
                cachePaths.push(location);
                events.push("cache");
              },
            };
          if (id === "node:os")
            return { tmpdir: () => NodePath.join(root, "temp"), homedir: () => root };
          if (id === "node:path") return NodePath;
          // The bundled prepared-cache helpers import these ports, but ordinary boot
          // must not call them. Empty ports fail if that contract changes.
          if (["node:fs", "node:v8", "node:zlib", "node:url"].includes(id)) return {};
          if (id === "electron")
            return {
              contextBridge: {
                exposeInMainWorld: (name: string, bridge: { getClientPlatform: () => unknown }) => {
                  events.push(name);
                  NodeAssert.equal(name, "desktopBridge");
                  desktopPlatform = bridge.getClientPlatform;
                },
              },
              ipcRenderer: {
                sendSync: refuse("legacy-storage IPC"),
                invoke: refuse("IPC invoke"),
                on: refuse("IPC subscribe"),
              },
              webFrame: {},
              webUtils: {},
            };
          return refuse(`external require ${id}`)();
        },
        module,
        exports,
        { platform: "win32", env: {} },
        NodePath.join(root, filename),
        root,
      );
      return module.exports;
    };
    const output = entry === "src/boot.ts" ? "boot.cjs" : "preload.cjs";
    evaluate(output);
    NodeAssert.deepEqual(denied, []);
    if (entry === "src/boot.ts") {
      NodeAssert.deepEqual(cachePaths, [NodePath.join(root, "temp", "T3CodeLAN", "compile-cache")]);
      NodeAssert.deepEqual(events, ["cache", "main"]);
    } else {
      NodeAssert.deepEqual(events, ["desktopBridge"]);
      NodeAssert.ok(desktopPlatform);
      NodeAssert.equal(desktopPlatform(), "win32");
    }
  } finally {
    NodeAssert.equal(NodePath.dirname(NodePath.resolve(root)), temporaryParent);
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
