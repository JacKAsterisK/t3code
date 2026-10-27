import { describe, expect, it } from "@effect/vitest";
import {
  FLEET_ROSTER_ENV,
  resolveFleetBootstrap,
  trustedFleetShareRoot,
  WINDOWS_FLEET_SHARE_ROOT,
} from "./FleetBootstrap.ts";

describe("Hub fleet metadata bootstrap", () => {
  it("recognizes only canonical paths beneath the exact Windows SMB share", () => {
    expect(trustedFleetShareRoot("\\\\BuildMachine\\BuildShare\\T3\\roster.json")).toBe(
      WINDOWS_FLEET_SHARE_ROOT,
    );
    expect(trustedFleetShareRoot("\\\\buildmachine\\buildshare\\roster.json")).toBe(
      WINDOWS_FLEET_SHARE_ROOT,
    );
    for (const value of [
      "C:\\BuildMachine\\BuildShare\\roster.json",
      "\\\\OtherMachine\\BuildShare\\roster.json",
      "\\\\BuildMachine\\BuildShareEvil\\roster.json",
      "//BuildMachine/BuildShare/roster.json",
      "\\\\BuildMachine\\BuildShare\\..\\roster.json",
      "\\\\BuildMachine\\BuildShare\\T3\\..\\roster.json",
      "\\\\BuildMachine\\BuildShare\\T3.\\roster.json",
      "\\\\BuildMachine\\BuildShare\\roster.json:stream",
      "\\\\?\\UNC\\BuildMachine\\BuildShare\\roster.json",
    ])
      expect(trustedFleetShareRoot(value)).toBeUndefined();
  });
  it("honors the explicit child-process path before a local fallback and derives sibling delivery storage", () => {
    const result = resolveFleetBootstrap(
      { [FLEET_ROSTER_ENV]: "C:\\SyntheticFleet\\roster.json" },
      "C:\\OtherFleet\\roster.json",
    );
    expect(result).toEqual({
      rosterPath: "C:\\SyntheticFleet\\roster.json",
      deliveryDirectory: "C:\\SyntheticFleet\\fleet-deliveries",
    });
    expect(
      resolveFleetBootstrap({}, "C:\\SyntheticFleet\\roster.json", "C:\\SyntheticDeliveries"),
    ).toEqual({
      rosterPath: "C:\\SyntheticFleet\\roster.json",
      deliveryDirectory: "C:\\SyntheticDeliveries",
    });
  });

  it("does not invent a default, mutate the caller environment, or fall back from an invalid explicit value", () => {
    const env = Object.freeze({});
    expect(resolveFleetBootstrap(env)).toBeUndefined();
    expect(
      resolveFleetBootstrap({ [FLEET_ROSTER_ENV]: "" }, "C:\\OtherFleet\\roster.json"),
    ).toBeUndefined();
    expect(env).toEqual({});
    for (const value of [" ", "relative.json", " C:\\SyntheticFleet\\roster.json"])
      expect(() =>
        resolveFleetBootstrap({ [FLEET_ROSTER_ENV]: value }, "C:\\OtherFleet\\roster.json"),
      ).toThrow();
  });
});
