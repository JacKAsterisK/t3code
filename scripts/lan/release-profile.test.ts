import { describe, expect, it } from "vite-plus/test";
import {
  classifyRelease,
  qualificationCoveredTests,
  releaseTestMetadata,
  sameCriticalNativeBuildSpans,
  selectReleaseTests,
  toolsFingerprint,
  type ReleaseProfileIdentity,
} from "./release-profile.ts";

const base: ReleaseProfileIdentity = {
  sourceCommit: "a".repeat(40),
  upstreamCommit: "b".repeat(40),
  toolchainManifestSha256: "c".repeat(64),
  toolsSha256: "d".repeat(64),
};
const candidate: ReleaseProfileIdentity = { ...base, sourceCommit: "e".repeat(40) };
const evaluate = (changedFiles: string[], extra = {}) =>
  classifyRelease({
    qualified: base,
    candidate,
    qualifiedIsAncestor: true,
    changedFiles,
    ...extra,
  });

describe("LAN release profile", () => {
  it("binds a successful test report to hashed workspace files and rejects invalid evidence", () => {
    const files = ["scripts/lan/release-profile.test.ts"];
    const report = { success: true, numTotalTests: 17 };
    const metadata = releaseTestMetadata(process.cwd(), base.sourceCommit, files, report);
    expect(metadata).toMatchObject({
      sourceCommit: base.sourceCommit,
      workspaceRoot: process.cwd(),
      reportFile: "vitest.json",
      success: true,
      testTotal: 17,
    });
    expect(metadata.testFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      releaseTestMetadata(process.cwd(), base.sourceCommit, files, { ...report, success: false }),
    ).toThrow();
    expect(() =>
      releaseTestMetadata(process.cwd(), base.sourceCommit, ["../escape.test.ts"], report),
    ).toThrow();
    expect(() =>
      releaseTestMetadata(process.cwd(), base.sourceCommit, [...files, ...files], report),
    ).toThrow();
  });
  it("permits focused validation for application and release receipt plumbing", () => {
    expect(
      evaluate([
        "apps/web/src/connection/lanFleet.ts",
        "scripts/lan/release-profile.ts",
        "scripts/lan/validate-windows-artifact.ts",
        "docs/operations/lan-windows-validation.md",
      ]).profile,
    ).toBe("routine");
  });
  it("fails closed when qualified baseline or ancestry is unknown", () => {
    expect(evaluate([], { qualified: undefined }).profile).toBe("qualification");
    expect(evaluate([], { qualifiedIsAncestor: false }).profile).toBe("qualification");
  });
  it("qualifies native build changes unless both compiler and workspace-install spans match", () => {
    const source = `export async function runWorkingNativeWindowsBuild() { compile(); }
export async function runWindowsNativeBuild() { const factoryInput = {}; install(); await verifyInventories("after-install"); console.log("[native-build] Building the application from the frozen working snapshot."); build(); await verifyInventories("after-build"); }
`;
    const receiptOnly = source + "// receipt outside compiler spans\n";
    expect(sameCriticalNativeBuildSpans(source, receiptOnly)).toBe(true);
    expect(
      sameCriticalNativeBuildSpans(source, source.replace("install()", "otherInstall()")),
    ).toBe(false);
    expect(
      sameCriticalNativeBuildSpans(source, source.replace("compile()", "otherCompile()")),
    ).toBe(false);
    expect(sameCriticalNativeBuildSpans(source, source.replace("build()", "otherBuild()"))).toBe(
      false,
    );
    expect(sameCriticalNativeBuildSpans(source, "missing markers")).toBe(false);
    expect(evaluate(["scripts/lan/windows-native-build.ts"]).profile).toBe("qualification");
    expect(
      evaluate(["scripts/lan/windows-native-build.ts"], { nativeBuildTransformUnchanged: true })
        .profile,
    ).toBe("routine");
  });
  it("qualifies changed upstream and both kinds of toolchain pin", () => {
    for (const change of [
      { upstreamCommit: "f".repeat(40) },
      { toolsSha256: "f".repeat(64) },
      { toolchainManifestSha256: "f".repeat(64) },
    ])
      expect(evaluate([], { candidate: { ...candidate, ...change } }).profile).toBe(
        "qualification",
      );
  });
  it.each([
    "pnpm-lock.yaml",
    "apps/server/package.json",
    "patches/example.patch",
    "scripts/lan/locks/server.pnpm-lock.yaml",
    "scripts/build-desktop-artifact.ts",
    "scripts/lib/production-stage.ts",
    "native/resource-monitor/src/main.rs",
    "apps/web/vite.config.ts",
    "apps/server/src/auth/RpcAuthorization.ts",
    "apps/server/src/lan/FleetTransport.ts",
  ])("qualifies sensitive change %s", (file) => {
    expect(evaluate([file]).profile).toBe("qualification");
  });
  it("selects changed and adjacent tests once, excluding mandatory coverage", () => {
    const files = [
      "scripts/lan/native.test.ts",
      "scripts/lan/native.browser.test.tsx",
      "scripts/lan/other.test.ts",
    ];
    expect(
      selectReleaseTests(["scripts/lan/native.ts", "scripts/lan/other.test.ts"], files, [
        "scripts/lan/native.test.ts",
      ]),
    ).toEqual(["scripts/lan/native.browser.test.tsx", "scripts/lan/other.test.ts"]);
  });

  it("does not consider test-name-filtered qualification cases fully covered", () => {
    const workflow = `
      - name: Verify native Windows packaging and manifest restoration
        run: vp test run scripts/build-desktop-artifact.test.ts -t native
      - name: Verify build reuse, native bootstrap and both MCP access paths
        run: vp test run scripts/lan/source-git.test.ts
      - name: Verify execution intake is fenced before persistence
        run: vp test run apps/server/src/orchestration-v2/runtimeLayer.test.ts -t admission
`;
    expect(qualificationCoveredTests(workflow)).toEqual(["scripts/lan/source-git.test.ts"]);
  });
  it("binds all six compiler tool pins independent of key order", () => {
    const p = { version: "1", sha256: "a".repeat(64) };
    const tools = { msvc: p, node: p, nsis: p, pnpm: p, rust: p, windowsSdk: p };
    expect(toolsFingerprint(tools)).toBe(
      toolsFingerprint({ rust: p, windowsSdk: p, pnpm: p, nsis: p, node: p, msvc: p }),
    );
    expect(() => toolsFingerprint({ node: p })).toThrow();
  });
});
