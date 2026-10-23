// @effect-diagnostics nodeBuiltinImport:off -- Native path fixtures exercise Windows isolation without opening a home.
import { describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";
import {
  parseLanBuildIdentity,
  resolveDistributionHome,
  assertDistributionHome,
  getDistributionProtocolScheme,
  cloudEnabled,
  telemetryEnabled,
  nativeUpdatesEnabled,
} from "./distribution.ts";

const identity = {
  appId: "com.spiderpunch.t3code.lan",
  productName: "T3 Code LAN",
  protocolScheme: "t3code-lan",
  homeDirectoryName: "T3CodeLAN",
  telemetry: "disabled",
  cloudConfiguration: "disabled",
  nativeUpdater: "disabled",
  protocolVersion: 2,
  applicationVersion: "0.1.2",
  sourceCommit: "a".repeat(40),
};

describe("compiled distribution identity", () => {
  it("freezes a separate identity without retaining the input object", () => {
    const input = { ...identity };
    const parsed = parseLanBuildIdentity(input);
    input.productName = "changed";
    expect(parsed.productName).toBe("T3 Code LAN");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { appId: "com.t3tools.other" },
    { productName: "T3 Code (Beta)" },
    { productName: "../T3 Code LAN" },
    { protocolScheme: "t3code" },
    { homeDirectoryName: ".t3" },
    { telemetry: "enabled" },
    { cloudConfiguration: "enabled" },
    { nativeUpdater: "enabled" },
    { protocolVersion: 3 },
    { applicationVersion: "2147483648.0.0" },
    { sourceCommit: "not-a-source-commit" },
    { extra: "unexpected" },
  ])("refuses conflicting or incomplete policy %j", (change) => {
    expect(() => parseLanBuildIdentity({ ...identity, ...change })).toThrow();
  });

  it.each([
    "https",
    "http",
    "file",
    "ws",
    "wss",
    "data",
    "javascript",
    "mailto",
    "ms-settings",
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "lpt1",
  ])("refuses a system or web protocol handler: %s", (protocolScheme) => {
    expect(() => parseLanBuildIdentity({ ...identity, protocolScheme })).toThrow();
  });

  it("retains upstream defaults when no LAN policy was compiled", () => {
    expect([cloudEnabled, telemetryEnabled, nativeUpdatesEnabled]).toEqual([true, true, true]);
    expect(getDistributionProtocolScheme(false)).toBe("t3code");
    expect(getDistributionProtocolScheme(true)).toBe("t3code-dev");
    expect(
      resolveDistributionHome({
        homeDirectory: "C:\\Users\\fixture",
        platform: "win32",
        localAppData: "C:\\Users\\fixture\\AppData\\Local",
        joinPath: NodePath.win32.join,
      }),
    ).toBe("C:\\Users\\fixture\\.t3");
    expect(assertDistributionHome("C:\\explicit", "C:\\default")).toBe("C:\\explicit");
  });
});
