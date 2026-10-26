import { describe, expect, it } from "@effect/vitest";
import { supportsNativeUpdateControl } from "./NativeUpdateReadiness.ts";

const supported = {
  lan: true,
  platform: "win32",
  mode: "desktop",
  stdinShutdown: true,
  parentPid: 123,
  guardedParentPid: "123",
};
describe("native guarded update capability", () => {
  it("requires the guarded Windows LAN desktop parent", () => {
    expect(supportsNativeUpdateControl(supported)).toBe(true);
    for (const overrides of [
      { lan: false },
      { platform: "linux" },
      { mode: "web" },
      { stdinShutdown: false },
      { parentPid: 0 },
      { parentPid: 123.5 },
      { guardedParentPid: undefined },
      { guardedParentPid: "124" },
    ])
      expect(supportsNativeUpdateControl({ ...supported, ...overrides })).toBe(false);
  });
});
