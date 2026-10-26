import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";
import { resolveFleetEnvironmentId } from "./lanFleetEnvironment";

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
    expect(resolveFleetEnvironmentId([primary, remote], true)).toBe(primary.environmentId);
  });

  it("prefers the desktop-managed primary over other local backends", () => {
    expect(resolveFleetEnvironmentId([secondary, primary], true)).toBe(primary.environmentId);
  });

  it("does not treat a browser or configured remote primary as the desktop host", () => {
    expect(resolveFleetEnvironmentId([primary, remote], false)).toBeNull();
  });

  it("continues to support a native secondary local backend", () => {
    expect(resolveFleetEnvironmentId([remote, secondary], false)).toBe(secondary.environmentId);
  });

  it("never selects a WSL backend as the Windows fleet host", () => {
    expect(resolveFleetEnvironmentId([wsl, remote], true)).toBeNull();
  });
});
