import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";
import { resolveFleetEnvironmentId, resolveNativeWindowsPrimary } from "./lanFleetEnvironment";

const primary = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("primary-desktop"),
  label: "This computer",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const secondary = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("secondary-local"),
  label: "Other local backend",
  connectionId: "local:secondary",
});
const wsl = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("wsl"),
  label: "WSL",
  connectionId: "local:wsl:ubuntu",
});
const remote = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("remote"),
  label: "Remote machine",
  connectionId: "remote:paired",
});

describe("LAN fleet local environment selection", () => {
  it("uses the desktop-managed primary environment when it is the only local environment", () => {
    expect(resolveFleetEnvironmentId([primary, remote], primary, true)).toBe(primary.environmentId);
  });

  it("prefers the desktop-managed primary over other local backends", () => {
    expect(resolveFleetEnvironmentId([secondary, primary], primary, true)).toBe(
      primary.environmentId,
    );
  });

  it("does not treat a browser or configured remote primary as the desktop host", () => {
    expect(resolveFleetEnvironmentId([primary, remote], null, true)).toBeNull();
  });

  it("continues to support a native secondary local backend", () => {
    expect(resolveFleetEnvironmentId([remote, secondary], null, true)).toBe(
      secondary.environmentId,
    );
  });

  it("does not select a secondary desktop backend on a non-Windows client", () => {
    expect(resolveFleetEnvironmentId([secondary], null, false)).toBeNull();
  });

  it("never selects a WSL backend as the Windows fleet host", () => {
    expect(resolveFleetEnvironmentId([wsl, remote], null, true)).toBeNull();
  });
});

describe("native Windows primary guard", () => {
  const primaryTarget = {
    source: "desktop-managed" as const,
    target: { httpBaseUrl: "http://127.0.0.1:3773/", wsBaseUrl: "ws://127.0.0.1:3773/" },
  };
  const bridge = (platform: string, distro: string | null | undefined, port = 3773) => ({
    getClientPlatform: () => platform,
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "Primary",
        runningDistro: distro,
        httpBaseUrl: `http://127.0.0.1:${port}/`,
        wsBaseUrl: `ws://127.0.0.1:${port}/`,
      },
    ],
  });
  it("uses a matched native Windows bootstrap", () => {
    expect(resolveNativeWindowsPrimary(bridge("win32", null), primaryTarget)).toEqual(
      primaryTarget.target,
    );
  });
  it("refuses WSL, non-Windows, missing distro identity, and mismatched bootstrap endpoints", () => {
    expect(resolveNativeWindowsPrimary(bridge("win32", "Ubuntu"), primaryTarget)).toBeNull();
    expect(resolveNativeWindowsPrimary(bridge("linux", null), primaryTarget)).toBeNull();
    expect(resolveNativeWindowsPrimary(bridge("win32", undefined), primaryTarget)).toBeNull();
    expect(resolveNativeWindowsPrimary(bridge("win32", null, 3774), primaryTarget)).toBeNull();
    expect(resolveNativeWindowsPrimary(undefined, primaryTarget)).toBeNull();
  });
  it("refuses a stale primary catalog registration with different endpoints", () => {
    expect(
      resolveFleetEnvironmentId(
        [primary],
        {
          httpBaseUrl: "http://127.0.0.1:9999/",
          wsBaseUrl: "ws://127.0.0.1:9999/",
        },
        true,
      ),
    ).toBeNull();
  });
});
