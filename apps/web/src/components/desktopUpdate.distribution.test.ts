import type { DesktopUpdateState } from "@t3tools/contracts";
import { afterAll, expect, it, vi } from "vite-plus/test";

vi.hoisted(() =>
  vi.stubGlobal("__T3_LAN_BUILD_IDENTITY__", {
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
  }),
);

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateIdleTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

afterAll(() => vi.unstubAllGlobals());

const state: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.2",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

it("permits advisory checks while every update state keeps download and install unavailable", () => {
  expect(canCheckForUpdate(state)).toBe(true);
  expect(canCheckForUpdate({ ...state, status: "checking" })).toBe(false);
  for (const status of ["available", "downloaded", "error"] as const) {
    const candidate = { ...state, status, availableVersion: "0.1.3", downloadedVersion: "0.1.3" };
    expect(resolveDesktopUpdateButtonAction(candidate)).toBe("none");
    expect(getDesktopUpdateButtonTooltip(candidate)).toContain("Reprint Hub");
  }
  expect(getDesktopUpdateIdleTooltip(state).title).toBe("Check fork updates");
});

it("never uses ambient official links or infers a fork distribution tag from an app version", () => {
  for (const repository of [undefined, "pingdotgg/t3code", "attacker/repository"]) {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/JacKAsterisK/t3code/releases",
    );
    expect(getDesktopUpdateReleaseUrl("0.1.3", repository)).toBeNull();
  }
});
