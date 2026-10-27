// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Offline release classification and changed-test selection.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface ReleaseProfileIdentity {
  sourceCommit: string;
  upstreamCommit: string;
  toolchainManifestSha256: string;
  toolsSha256: string;
}
export interface ReleaseProfileInput {
  qualified?: ReleaseProfileIdentity | undefined;
  candidate?: ReleaseProfileIdentity | undefined;
  qualifiedIsAncestor: boolean;
  changedFiles: readonly string[];
  nativeBuildTransformUnchanged?: boolean | undefined;
}
export interface ReleaseProfileResult {
  profile: "routine" | "qualification";
  reasons: string[];
}

export const ROUTINE_RELEASE_TESTS = [
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
const hash = /^[a-f0-9]{64}$/u;
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

const dependencyOrTransform = (file: string) =>
  /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|Cargo\.toml|\.pnpmfile\.cjs|\.npmrc)$/u.test(
    file,
  ) ||
  /(^|\/)(vite|tsup|electron-builder|tsconfig)(?:\.[^/]*)?\.(?:[cm]?[jt]s|json|ya?ml)$/u.test(
    file,
  ) ||
  file.startsWith("patches/") ||
  file.startsWith("native/") ||
  file.startsWith("scripts/lan/locks/") ||
  file.startsWith(".github/actions/setup-ci-deps/") ||
  file.startsWith(".github/workflows/release") ||
  [
    "scripts/build-desktop-artifact.ts",
    "scripts/update-release-package-versions.ts",
    "scripts/lib/production-stage.ts",
    "scripts/lib/resolve-catalog.ts",
    "scripts/lib/cli-external-packages.ts",
    "scripts/lib/desktop-external-packages.ts",
    "scripts/lib/lan-build-policy.ts",
    "scripts/lan/stage-locks.ts",
    "scripts/lan/prepare-stage-locks.ts",
    "scripts/lan/accept-stage-locks.ts",
    "scripts/lan/windows-build-execution.ts",
    "scripts/lan/windows-build-preparation.ts",
    "scripts/lan/native-maintenance.pack.ts",
    "scripts/lan/windows-native-build.pack.ts",
  ].includes(file);

// Enforcement and credential/transport changes need qualification. Tests and
// delivery/validation plumbing remain eligible for the focused profile.
const enforcement = (file: string) =>
  !testFile.test(file) &&
  (file.startsWith("apps/server/src/auth/") ||
    file.startsWith("apps/server/src/lan/FleetTransport") ||
    file.startsWith("apps/server/src/lan/FleetDelivery") ||
    file.startsWith("apps/server/src/lan/FleetAuthority") ||
    file.startsWith("apps/server/src/lan/FleetVault") ||
    file.startsWith("apps/server/src/lan/Gateway") ||
    file.startsWith("apps/desktop/src/lan/DesktopFleetGateway") ||
    file.startsWith("packages/shared/src/fleetTls") ||
    file.startsWith("packages/shared/src/distribution") ||
    file === "packages/contracts/src/clientRpcPermissions.ts" ||
    file === "apps/server/src/mcp/McpToolAccess.ts" ||
    file === "apps/desktop/src/app/DesktopDistribution.ts" ||
    file === "apps/server/src/lan/NativeDistribution.ts");

function validIdentity(value: ReleaseProfileIdentity | undefined): value is ReleaseProfileIdentity {
  return (
    value !== undefined &&
    commit.test(value.sourceCommit) &&
    commit.test(value.upstreamCommit) &&
    hash.test(value.toolchainManifestSha256) &&
    hash.test(value.toolsSha256)
  );
}

export function classifyRelease(input: ReleaseProfileInput): ReleaseProfileResult {
  const reasons: string[] = [];
  if (!validIdentity(input.qualified) || !validIdentity(input.candidate))
    reasons.push("missing-or-invalid-qualified-inputs");
  else {
    if (!input.qualifiedIsAncestor) reasons.push("qualified-source-not-ancestor");
    if (input.qualified.upstreamCommit !== input.candidate.upstreamCommit)
      reasons.push("upstream-changed");
    if (
      input.qualified.toolchainManifestSha256 !== input.candidate.toolchainManifestSha256 ||
      input.qualified.toolsSha256 !== input.candidate.toolsSha256
    )
      reasons.push("toolchain-changed");
  }
  for (const raw of input.changedFiles) {
    const file = raw.replaceAll("\\", "/");
    if (!safePath.test(file) || file.split("/").includes("..")) reasons.push("invalid-path");
    else if (dependencyOrTransform(file)) reasons.push(`dependency-or-build:${file}`);
    else if (
      file === "scripts/lan/windows-native-build.ts" &&
      input.nativeBuildTransformUnchanged !== true
    )
      reasons.push(`native-build-transform:${file}`);
    else if (enforcement(file)) reasons.push(`policy-enforcement:${file}`);
  }
  return { profile: reasons.length === 0 ? "routine" : "qualification", reasons };
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

/** Extract only qualification jobs that run their listed files without a test-name filter. */
export function qualificationCoveredTests(workflow: string): string[] {
  const fullGroups = new Set([
    "Verify client version and encrypted setup UI",
    "Verify build reuse, native bootstrap and both MCP access paths",
    "Verify synthetic enrollment, delivery, polling, and retained-home behavior",
  ]);
  const covered = new Set<string>();
  for (const section of workflow.split(/(?=^ {6}- name: )/mu)) {
    const name = /^ {6}- name: (.+)$/mu.exec(section)?.[1];
    if (!name || !fullGroups.has(name)) continue;
    for (const found of section.matchAll(
      /(?:apps|packages|scripts)\/[a-zA-Z0-9_.\x2f-]+\.test\.[cm]?[jt]sx?/gu,
    ))
      covered.add(found[0]);
  }
  return [...covered].sort();
}

/** Order-independent digest of all six versioned BuildLock tool pins. */
export function toolsFingerprint(
  tools: Record<string, { version: string; sha256: string }>,
): string {
  const names = ["msvc", "node", "nsis", "pnpm", "rust", "windowsSdk"];
  if (
    Object.keys(tools).length !== names.length ||
    names.some((name) => !tools[name]?.version || !hash.test(tools[name]!.sha256))
  )
    throw new Error("Invalid BuildLock tool pins");
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(names.map((name) => [name, tools[name]!.version, tools[name]!.sha256])))
    .digest("hex");
}

export function identityFromBuildLock(
  lock: {
    forkCommit: string;
    upstreamCommit: string;
    tools: Record<string, { version: string; sha256: string }>;
  },
  toolchainManifestSha256: string,
): ReleaseProfileIdentity {
  const result = {
    sourceCommit: lock.forkCommit,
    upstreamCommit: lock.upstreamCommit,
    toolchainManifestSha256,
    toolsSha256: toolsFingerprint(lock.tools),
  };
  if (!validIdentity(result)) throw new Error("Invalid release BuildLock identity");
  return result;
}

/** Treat missing or ambiguous compiler-scope markers as changed. */
export function sameCriticalNativeBuildSpans(previous: string, current: string): boolean {
  const ranges = [
    [
      "export async function runWorkingNativeWindowsBuild(",
      "export async function runWindowsNativeBuild(",
    ],
    ["const factoryInput = {", 'await verifyInventories("after-install");'],
    [
      'console.log("[native-build] Building the application from the frozen working snapshot.");',
      'await verifyInventories("after-build");',
    ],
  ] as const;
  return ranges.every(([start, end]) => {
    const slice = (source: string) => {
      const a = source.indexOf(start),
        b = source.indexOf(end, a + start.length);
      if (
        a < 0 ||
        b < 0 ||
        source.indexOf(start, a + start.length) >= 0 ||
        source.indexOf(end, b + end.length) >= 0
      )
        return null;
      return source.slice(a, b + end.length);
    };
    const before = slice(previous),
      after = slice(current);
    return before !== null && before === after;
  });
}

function main() {
  const [baselinePath, outputPath] = process.argv.slice(2);
  if (!baselinePath || !outputPath)
    throw new Error("Usage: release-profile.ts QUALIFICATION_BASELINE_JSON OUTPUT_JSON");
  let qualified: ReleaseProfileIdentity | undefined;
  let candidate: ReleaseProfileIdentity | undefined;
  let qualifiedIsAncestor = false;
  let changedFiles: string[] = [];
  let existingFiles: string[] = [];
  let candidatePinsCompared = false;
  let nativeBuildTransformUnchanged: boolean | undefined;
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
  const head = git("rev-parse", "HEAD").trim();
  existingFiles = git("ls-files", "-z").split("\0").filter(Boolean);
  try {
    const baseline = JSON.parse(NodeFS.readFileSync(baselinePath, "utf8"));
    const proof = baseline.qualification;
    if (
      baseline.schemaVersion !== 1 ||
      proof?.mode !== "independent-rebuild" ||
      ![
        proof.artifactSha256,
        proof.manifestSha256,
        proof.activationPolicySha256,
        proof.buildLockSha256,
        proof.runtimePolicyEvidenceSha256,
      ].every((value) => typeof value === "string" && hash.test(value)) ||
      !baseline.sourceInputs ||
      typeof baseline.sourceInputs !== "object" ||
      Object.keys(baseline.sourceInputs).length === 0
    )
      throw new Error("Invalid qualification evidence");
    qualified = identityFromBuildLock(
      {
        forkCommit: baseline.sourceCommit,
        upstreamCommit: baseline.upstreamCommit,
        tools: baseline.tools,
      },
      baseline.toolchainManifestSha256,
    );
    qualifiedIsAncestor =
      NodeChildProcess.spawnSync("git", [
        "merge-base",
        "--is-ancestor",
        qualified.sourceCommit,
        head,
      ]).status === 0;
    if (
      !qualifiedIsAncestor ||
      NodeChildProcess.spawnSync("git", [
        "merge-base",
        "--is-ancestor",
        qualified.upstreamCommit,
        qualified.sourceCommit,
      ]).status !== 0
    )
      throw new Error("Qualification ancestry is unavailable");
    for (const [file, expected] of Object.entries(baseline.sourceInputs)) {
      if (!safePath.test(file) || typeof expected !== "string" || !hash.test(expected))
        throw new Error("Invalid source pin");
      const bytes = NodeChildProcess.execFileSync(
        "git",
        ["show", `${qualified.sourceCommit}:${file}`],
        { maxBuffer: 32 * 1024 ** 2 },
      );
      const windowsBytes = Buffer.from(bytes.toString("utf8").replace(/\r?\n/gu, "\r\n"));
      if (
        ![bytes, windowsBytes].some(
          (value) => NodeCrypto.createHash("sha256").update(value).digest("hex") === expected,
        )
      )
        throw new Error("Qualified source pin mismatch");
    }
    changedFiles = git("diff", "--name-only", "--no-renames", "-z", qualified.sourceCommit, head)
      .split("\0")
      .filter(Boolean);
    if (changedFiles.includes("scripts/lan/windows-native-build.ts")) {
      const oldSource = git(
        "show",
        `${qualified.sourceCommit}:scripts/lan/windows-native-build.ts`,
      );
      const newSource = git("show", `${head}:scripts/lan/windows-native-build.ts`);
      nativeBuildTransformUnchanged = sameCriticalNativeBuildSpans(oldSource, newSource);
    }
    // Any merge after qualification requires review; it may include a newer upstream.
    if (git("rev-list", "--merges", `${qualified.sourceCommit}..${head}`).trim())
      changedFiles.push("native/upstream-merge");
    const lockPath = process.env.LAN_CANDIDATE_BUILD_LOCK;
    const toolchainSha = process.env.LAN_CANDIDATE_TOOLCHAIN_MANIFEST_SHA256;
    if (lockPath && toolchainSha) {
      candidate = identityFromBuildLock(
        JSON.parse(NodeFS.readFileSync(lockPath, "utf8")),
        toolchainSha,
      );
      if (candidate.sourceCommit !== head) throw new Error("Candidate source differs from HEAD");
      candidatePinsCompared = true;
    } else {
      // CI checks source scope against declared pins. The native release gate must
      // classify again with the actual BuildLock and verified toolchain inventory.
      candidate = { ...qualified, sourceCommit: head };
    }
  } catch {
    qualified = undefined;
    candidate = undefined;
    const eventBefore = process.env.GITHUB_EVENT_BEFORE;
    const previous = eventBefore && commit.test(eventBefore) ? eventBefore : "HEAD^";
    try {
      changedFiles = git("diff", "--name-only", "--no-renames", "-z", previous, head)
        .split("\0")
        .filter(Boolean);
    } catch {
      /* Full qualification remains required. */
    }
  }
  const result = classifyRelease({
    qualified,
    candidate,
    qualifiedIsAncestor,
    changedFiles,
    nativeBuildTransformUnchanged,
  });
  let covered: string[] = [...ROUTINE_RELEASE_TESTS];
  if (result.profile === "qualification") {
    try {
      covered = [
        ...covered,
        ...qualificationCoveredTests(
          NodeFS.readFileSync(".github/workflows/lan-fleet-checks.yml", "utf8"),
        ),
      ];
    } catch {
      /* The extra changed tests will still run. */
    }
  }
  const changedTests = selectReleaseTests(changedFiles, existingFiles, covered);
  const tests = [...new Set([...ROUTINE_RELEASE_TESTS, ...changedTests])];
  const report = {
    ...result,
    qualifiedSource: qualified?.sourceCommit ?? null,
    candidateSource: candidate?.sourceCommit ?? head,
    candidatePinsCompared,
    nativeBuildTransformUnchanged: nativeBuildTransformUnchanged ?? null,
    nativeToolchainVerified: false,
    changedFiles,
    tests,
    needsBrowser:
      result.profile === "qualification" || tests.some((file) => file.includes(".browser.test.")),
  };
  NodeFS.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
