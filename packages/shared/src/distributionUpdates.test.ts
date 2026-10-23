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
  LAN_UPDATE_REPOSITORY,
  distributionUpdateMode,
  resolveDistributionUpdateRepository,
  getDistributionUpdateReleaseUrl,
  nativeUpdatesEnabled,
} from "./distribution.ts";
import {
  CLI_RELEASES_PAGE_URL,
  cliReleaseIndexPageUrl,
  cliReleaseDownloadBaseUrl,
} from "./cliRelease.ts";

afterAll(() => vi.unstubAllGlobals());

it("pins every LAN release route to the fork and keeps Hub activation mandatory", () => {
  for (const configured of [
    undefined,
    "",
    "pingdotgg/t3code",
    "attacker/repo",
    "invalid/path/extra",
  ])
    expect(resolveDistributionUpdateRepository(configured)).toBe(LAN_UPDATE_REPOSITORY);
  expect(distributionUpdateMode).toBe("hub");
  expect(nativeUpdatesEnabled).toBe(false);
  expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/JacKAsterisK/t3code/releases");
  expect(cliReleaseIndexPageUrl(1)).toBe(
    "https://api.github.com/repos/JacKAsterisK/t3code/releases?per_page=100&page=1",
  );
  expect(getDistributionUpdateReleaseUrl("0.1.3")).toBe(
    "https://github.com/JacKAsterisK/t3code/releases/tag/lan-v0.1.3",
  );
});

it("refuses a direct LAN archive installation even with an explicitly supplied official or alternate base", () => {
  for (const base of [
    undefined,
    "https://github.com/pingdotgg/t3code/releases/download",
    "https://example.test/files",
  ])
    expect(() => cliReleaseDownloadBaseUrl("0.1.3", base)).toThrow("Reprint Hub");
  for (const page of [0, -1, 101, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => cliReleaseIndexPageUrl(page)).toThrow("page");
});
