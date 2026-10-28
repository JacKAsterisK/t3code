// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Offline release test selection.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Every LAN release is one fresh build followed by these checks, whatever changed.
export const RELEASE_TESTS = [
  "apps/desktop/src/snapShot/DesktopSnapShot.test.ts",
  "apps/web/src/lib/nativePromptReadiness.test.ts",
  "apps/web/src/lib/backgroundActivityReporter.test.ts",
  "apps/web/src/lib/nativePromptReadiness.browser.test.tsx",
  "apps/web/src/components/desktop/SnapShotCoordinator.browser.test.ts",
  "scripts/lan/home-repair.test.ts",
  "scripts/lan/home-repair-executor.test.ts",
  "scripts/lan/home-repair-migrations.test.ts",
  "scripts/lan/home-repair-cancel.test.ts",
  "scripts/lan/home-repair-scheduled.test.ts",
  "scripts/lan/home-repair-work-states.test.ts",
  "scripts/lan/native-helper-output.test.ts",
  "scripts/lan/windows-artifact.test.ts",
  "scripts/lan/validate-windows-artifact.test.ts",
  "apps/server/src/lan/NativeMaintenance.test.ts",
  "apps/server/src/lan/NativeUpdateGate.test.ts",
  "apps/server/src/lan/NativeUpdateControl.test.ts",
  "apps/server/src/lan/NativeUpdateReadiness.test.ts",
  "apps/server/src/orchestration-v2/ProjectionRecovery.test.ts",
  "apps/server/src/orchestration-v2/EffectWorker.test.ts",
  "apps/server/src/orchestration-v2/ThreadLaunchService.test.ts",
  "apps/server/src/persistence/reconcileV2PreviewMigration.test.ts",
  "apps/server/src/persistence/Migrations/073_ThreadMessageSearch.test.ts",
  "apps/server/src/background/NativePromptReadiness.test.ts",
  "apps/server/src/background/BackgroundPolicy.test.ts",
  "apps/desktop/src/updates/DesktopNativeUpdateClose.test.ts",
  "packages/shared/src/nativeUpdateControl.test.ts",
] as const;

const commit = /^[a-f0-9]{40}$/u;
const testFile = /\.test\.[cm]?[jt]sx?$/u;
const codeFile = /\.[cm]?[jt]sx?$/u;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_.@+/-]+$/u;

/** Bind a successful Vitest report to the exact source files run on the CI host. */
export function releaseTestMetadata(
  workspaceRoot: string,
  sourceCommit: string,
  files: readonly string[],
  report: { success?: boolean; numTotalTests?: number },
) {
  if (
    !NodePath.isAbsolute(workspaceRoot) ||
    !commit.test(sourceCommit) ||
    report.success !== true ||
    !Number.isInteger(report.numTotalTests) ||
    report.numTotalTests! < 1 ||
    files.length === 0 ||
    new Set(files).size !== files.length
  )
    throw new Error("Invalid release test report");
  const testFiles = files.map((file) => {
    if (!safePath.test(file) || !testFile.test(file)) throw new Error("Invalid release test path");
    return {
      path: file,
      sha256: NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.join(workspaceRoot, file)))
        .digest("hex"),
    };
  });
  return {
    sourceCommit,
    workspaceRoot,
    testFiles,
    reportFile: "vitest.json",
    success: true,
    testTotal: report.numTotalTests,
  };
}

/** Test files adjacent to changed source, matching the repository's changed-check convention. */
export function selectReleaseTests(
  changedFiles: readonly string[],
  existingFiles: readonly string[],
  alreadyRequired: readonly string[] = [],
): string[] {
  const existing = new Set(existingFiles.map((file) => file.replaceAll("\\", "/")));
  const required = new Set(alreadyRequired.map((file) => file.replaceAll("\\", "/")));
  const selected = new Set<string>();
  for (const raw of changedFiles) {
    const file = raw.replaceAll("\\", "/");
    if (!safePath.test(file) || file.split("/").includes("..")) continue;
    if (testFile.test(file) && existing.has(file)) selected.add(file);
    if (!codeFile.test(file) || testFile.test(file)) continue;
    const prefix = file.replace(codeFile, ".");
    for (const candidate of existing)
      if (candidate.startsWith(prefix) && testFile.test(candidate)) selected.add(candidate);
  }
  return [...selected].filter((file) => !required.has(file)).sort();
}

/** Test files the workflow already runs in full, without a test-name filter. */
export function workflowCoveredTests(workflow: string): string[] {
  const covered = new Set<string>();
  for (const section of workflow.split(/(?=^ {6}- name: )/mu)) {
    if (/(?:^|\s)-t\s/u.test(section)) continue;
    for (const found of section.matchAll(
      /(?:apps|packages|scripts)\/[a-zA-Z0-9_.\x2f-]+\.test\.[cm]?[jt]sx?/gu,
    ))
      covered.add(found[0]);
  }
  return [...covered].sort();
}

function main() {
  const [outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error("Usage: release-profile.ts OUTPUT_JSON");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
  const head = git("rev-parse", "HEAD").trim();
  const existingFiles = git("ls-files", "-z").split("\0").filter(Boolean);
  const eventBefore = process.env.GITHUB_EVENT_BEFORE;
  const previous = eventBefore && commit.test(eventBefore) ? eventBefore : "HEAD^";
  let changedFiles: string[] = [];
  try {
    changedFiles = git("diff", "--name-only", "--no-renames", "-z", previous, head)
      .split("\0")
      .filter(Boolean);
  } catch {
    /* The release tests still run. */
  }
  let covered: string[] = [...RELEASE_TESTS];
  try {
    covered = [
      ...covered,
      ...workflowCoveredTests(
        NodeFS.readFileSync(".github/workflows/lan-fleet-checks.yml", "utf8"),
      ),
    ];
  } catch {
    /* The extra changed tests will still run. */
  }
  const tests = [
    ...new Set([...RELEASE_TESTS, ...selectReleaseTests(changedFiles, existingFiles, covered)]),
  ];
  const report = { sourceCommit: head, changedFiles, tests };
  NodeFS.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
