import { describe, expect, it } from "vite-plus/test";
import { resolveClientBuildVersion } from "./clientBuildVersion";

describe("client fork build version", () => {
  it("uses the renderer's fork metadata even during development", () => {
    expect(resolveClientBuildVersion(" 7.8.9 ", false)).toBe("v7.8.9");
    expect(resolveClientBuildVersion("7.8.9-rc.2+fixture", true)).toBe("v7.8.9-rc.2+fixture");
  });

  it.each([undefined, "", "  ", "invalid", "v7.8.9"])(
    "uses truthful fallbacks for absent or invalid metadata: %s",
    (version) => {
      expect(resolveClientBuildVersion(version, true)).toBe("dev");
      expect(resolveClientBuildVersion(version, false)).toBe("unknown");
    },
  );
});
