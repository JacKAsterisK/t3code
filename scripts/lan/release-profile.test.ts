import { describe, expect, it } from "vite-plus/test";
import {
  RELEASE_TESTS,
  releaseTestMetadata,
  selectReleaseTests,
  workflowCoveredTests,
} from "./release-profile.ts";

const sourceCommit = "a".repeat(40);

describe("LAN release tests", () => {
  it("binds a successful test report to hashed workspace files and rejects invalid evidence", () => {
    const files = ["scripts/lan/release-profile.test.ts"];
    const report = { success: true, numTotalTests: 17 };
    const metadata = releaseTestMetadata(process.cwd(), sourceCommit, files, report);
    expect(metadata).toMatchObject({
      sourceCommit,
      workspaceRoot: process.cwd(),
      reportFile: "vitest.json",
      success: true,
      testTotal: 17,
    });
    expect(metadata.testFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      releaseTestMetadata(process.cwd(), sourceCommit, files, { ...report, success: false }),
    ).toThrow();
    expect(() =>
      releaseTestMetadata(process.cwd(), sourceCommit, ["../escape.test.ts"], report),
    ).toThrow();
    expect(() =>
      releaseTestMetadata(process.cwd(), sourceCommit, [...files, ...files], report),
    ).toThrow();
  });

  it("keeps the updater, stopped-state, projection and home-preservation tests mandatory", () => {
    for (const file of [
      "apps/server/src/lan/NativeMaintenance.test.ts",
      "apps/server/src/lan/NativeUpdateGate.test.ts",
      "apps/server/src/orchestration-v2/ProjectionRecovery.test.ts",
      "scripts/lan/home-repair.test.ts",
      "scripts/lan/validate-windows-artifact.test.ts",
    ])
      expect(RELEASE_TESTS).toContain(file);
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

  it("ignores unsafe changed paths", () => {
    expect(
      selectReleaseTests(
        ["../scripts/lan/native.ts", "/abs/native.ts"],
        ["scripts/lan/native.test.ts"],
      ),
    ).toEqual([]);
  });

  it("does not consider test-name-filtered workflow steps fully covered", () => {
    const workflow = `
      - name: Verify native Windows packaging and manifest restoration
        run: vp test run scripts/build-desktop-artifact.test.ts -t native
      - name: Verify build reuse, native bootstrap and both MCP access paths
        run: vp test run scripts/lan/source-git.test.ts
      - name: Verify execution intake is fenced before persistence
        run: >-
          vp test run apps/server/src/orchestration-v2/runtimeLayer.test.ts
          -t 'native update admission'
`;
    expect(workflowCoveredTests(workflow)).toEqual(["scripts/lan/source-git.test.ts"]);
  });
});
