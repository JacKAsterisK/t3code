import { it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { UserConfigExport } from "vite-plus";
import * as NodeAssert from "node:assert/strict";

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
  NodeAssert.equal(resolved.envDir, false);
  NodeAssert.deepEqual(resolved.envPrefix, []);
  NodeAssert.equal(resolved.define?.["import.meta.env.VITE_T3CODE_RELAY_URL"], '""');
  NodeAssert.equal(resolved.define?.["import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY"], '""');
});
