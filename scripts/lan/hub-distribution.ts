// @effect-diagnostics nodeBuiltinImport:off - Offline Windows distribution validation; this module never installs or starts a process.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { isIndependentDistributionScheme } from "@t3tools/shared/distribution";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u));
const Pin = Schema.Struct({ version: Schema.NonEmptyString, sha256: Sha256 });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const BuildLock = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  upstreamCommit: Commit,
  forkCommit: Commit,
  distributionVersion: Version,
  applicationVersion: Version,
  files: Schema.Record(Schema.String, Sha256),
  tools: Schema.Struct({
    node: Pin,
    pnpm: Pin,
    rust: Pin,
    msvc: Pin,
    windowsSdk: Pin,
    nsis: Pin,
  }),
  wslRuntime: Schema.NullOr(Schema.Struct({ sourceCommit: Commit, sha256: Sha256 })),
  cloudConfiguration: Schema.Literal("disabled"),
  telemetry: Schema.Literal("disabled"),
  nativeUpdater: Schema.Literal("disabled"),
});
export type BuildLock = typeof BuildLock.Type;

export const BUILD_INPUT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "patches/node-pty@1.2.0-beta.15.patch",
  "patches/@ff-labs__fff-node@0.11.0.patch",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "native/resource-monitor/Cargo.toml",
  "native/resource-monitor/Cargo.lock",
  "scripts/build-desktop-artifact.ts",
  "scripts/update-release-package-versions.ts",
  ".github/workflows/release.yml",
  ".github/workflows/release-desktop.yml",
  "apps/desktop/src/app/DesktopStatePaths.ts",
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "packages/shared/src/distribution.ts",
  "scripts/lib/lan-build-policy.ts",
  "scripts/lib/strict-json.ts",
  "scripts/lib/production-stage.ts",
  "scripts/lib/resolve-catalog.ts",
  "scripts/lib/cli-external-packages.ts",
  "scripts/lib/desktop-external-packages.ts",
  "scripts/lan/lan-packaging.ts",
  "scripts/lan/stage-locks.ts",
  "scripts/lan/prepare-stage-locks.ts",
  "scripts/lan/accept-stage-locks.ts",
  "scripts/lan/prepare-update-channel.ts",
  "packages/shared/src/lanUpdateChannel.ts",
  "packages/shared/src/strictJson.ts",
  "scripts/lan/locks/desktop.pnpm-lock.yaml",
  "scripts/lan/locks/server.pnpm-lock.yaml",
  "scripts/lan/locks/preparation.json",
  "scripts/lan/windows-build-preparation.ts",
  "scripts/lan/windows-build-execution.ts",
  "scripts/lan/windows-native-context.ts",
  "scripts/lan/windows-native-build.ts",
  "scripts/lan/build-metrics.ts",
  "scripts/lan/windows-native-build.pack.ts",
  "scripts/lan/prepare-windows-sandbox.ts",
  "scripts/lan/windows-sandbox-context.ts",
  "scripts/lan/windows-sandbox-guest.ts",
  "scripts/lan/windows-sandbox-guest.pack.ts",
  "scripts/lan/source-git.ts",
  "scripts/lan/native-maintenance.pack.ts",
  "packages/shared/src/nativeHomeSelection.ts",
  "packages/shared/src/nativeAdmission.ts",
  "apps/desktop/src/app/DesktopUserData.ts",
  "apps/server/src/os-jank.ts",
  "apps/server/src/lan/NativeMaintenance.ts",
  "scripts/lan/home-repair.ts",
  "scripts/lan/home-repair-executor.ts",
  "scripts/lan/home-repair-migrations.ts",
  "scripts/lan/home-repair-native.ts",
  "scripts/lan/home-repair.pack.ts",
  "scripts/lan/home-repair.schema.json",
  "scripts/lan/home-repair.contract.json",
  "scripts/lan/home-repair.fixture.json",
  "scripts/lan/native-helper-output.ts",
  "scripts/lan/seal-windows-payload.ts",
  "scripts/lan/windows-artifact.ts",
  "scripts/lan/validate-windows-artifact.ts",
  "apps/desktop/vite.config.ts",
  "apps/server/vite.config.ts",
  "apps/web/vite.config.ts",
  "apps/web/index.html",
  "apps/web/public/manifest.webmanifest",
] as const;

export interface CheckoutEvidence {
  readonly commit: string;
  readonly clean: boolean;
  readonly node: string;
  readonly packageManager: string;
  readonly electron: string;
  readonly electronBuilder: string;
  readonly files: Readonly<Record<string, string>>;
  readonly officialAppId: boolean;
  readonly officialHomeDefault: boolean;
  readonly officialProtocols: boolean;
  readonly officialBranding: boolean;
}

export const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export function prepareWindowsBuild(checkout: CheckoutEvidence, lock?: BuildLock) {
  const blockers: Array<string> = [];
  if (!checkout.clean) blockers.push("The source checkout contains uncommitted changes.");
  if (checkout.officialAppId)
    blockers.push("An independent package appId has not been established.");
  if (checkout.officialHomeDefault)
    blockers.push("An independent default T3 home has not been established.");
  if (checkout.officialProtocols)
    blockers.push("Independent protocol handlers have not been established.");
  if (checkout.officialBranding)
    blockers.push("Independent desktop product branding has not been established.");
  if (lock === undefined) {
    blockers.push(
      "Supply an approved build lock with exact tool versions and binary hashes; Rust, MSVC, Windows SDK and NSIS are not pinned by this checkout.",
    );
  } else {
    if (checkout.commit !== lock.forkCommit)
      blockers.push("The fork commit differs from the build lock.");
    if (checkout.node !== lock.tools.node.version)
      blockers.push("The Node pin differs from package.json.");
    if (checkout.packageManager !== `pnpm@${lock.tools.pnpm.version}`)
      blockers.push("The pnpm pin differs from package.json.");
    for (const path of BUILD_INPUT_FILES) {
      if (lock.files[path] === undefined || checkout.files[path] !== lock.files[path]) {
        blockers.push(`The build input hash differs or is absent: ${path}.`);
      }
    }
    for (const [name, pin] of Object.entries(lock.tools)) {
      if (!/^\d+\.\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?$/iu.test(pin.version)) {
        blockers.push(`The ${name} tool version is not an exact numeric pin.`);
      }
    }
  }
  return {
    schemaVersion: 1 as const,
    mode: "dry-run" as const,
    ready: blockers.length === 0,
    buildAuthorized: false as const,
    distributionAuthorized: false as const,
    source: checkout,
    blockers,
    requiredStages: [
      "Align all release package versions before freezing forkCommit and approved input hashes; use an isolated clean checkout and verify upstreamCommit ancestry.",
      "Verify every tool binary and all build input hashes against the approved lock, including the separately approved desktop and server staging locks; stage installs are offline and frozen.",
      "Compile server, web and desktop from the frozen source using the explicit independent LAN policy; packaging must not rewrite tracked source versions.",
      "Build the locked resource-monitor, stage the Windows server.asar payload and native maintenance helper, then package x64 ZIP using build-desktop-artifact.ts; no SEA conversion.",
      "The minimal LAN target omits WSL; preserve third-party notices.",
      "Inspect extracted package appId, uninstall identity, product, protocol, home, feed and native addon signatures.",
      "Verify cloud configuration, telemetry and every native update path are disabled in compiled/package inputs; launcher env vars alone are insufficient.",
      "Run Windows smoke verification outside Codex; produce immutable manifest and test receipts. No install or publication.",
    ],
  };
}

export const CandidateManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  artifactId: Sha256,
  sha256: Sha256,
  byteLength: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(2 * 1024 ** 3),
  ),
  distributionVersion: Version,
  desktopVersion: Version,
  backendVersion: Version,
  protocolVersion: Schema.Literal(2),
  architecture: Schema.Literal("x64"),
  upstreamCommit: Commit,
  forkCommit: Commit,
  sourceDirty: Schema.Literal(false),
  builtUtc: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  ),
  buildLockSha256: Sha256,
  testReceiptSha256: Sha256,
  appId: Schema.NonEmptyString,
  productName: Schema.NonEmptyString,
  protocolScheme: Schema.NonEmptyString,
  homeDirectoryName: Schema.NonEmptyString,
  nativeUpdater: Schema.Literal("disabled"),
  signature: Schema.Union([
    Schema.Struct({ status: Schema.Literal("unsigned-developer-candidate") }),
    Schema.Struct({ status: Schema.Literal("verified"), publisher: Schema.NonEmptyString }),
  ]),
});
export type CandidateManifest = typeof CandidateManifest.Type;

function assertIndependentIdentity(candidate: CandidateManifest) {
  if (
    candidate.appId.toLowerCase().startsWith("com.t3tools.") ||
    /^t3 code(?: \((?:beta|nightly)\))?$/iu.test(candidate.productName) ||
    !isIndependentDistributionScheme(candidate.protocolScheme) ||
    !/^[a-z0-9][a-z0-9._-]*$/iu.test(candidate.homeDirectoryName) ||
    candidate.homeDirectoryName.toLowerCase() === ".t3"
  ) {
    throw new Error("The candidate collides with the official application or data identity.");
  }
  if (candidate.desktopVersion !== candidate.backendVersion)
    throw new Error("Desktop and backend versions differ.");
  if (
    candidate.signature.status === "verified" &&
    candidate.signature.publisher === "T3 Tools Inc"
  ) {
    throw new Error("A fork cannot claim the official publisher.");
  }
}

export function verifyArtifact(candidate: CandidateManifest, bytes: Uint8Array) {
  assertIndependentIdentity(candidate);
  const digest = sha256(bytes);
  if (
    candidate.artifactId !== candidate.sha256 ||
    digest !== candidate.sha256 ||
    bytes.byteLength !== candidate.byteLength
  ) {
    throw new Error("Artifact length or SHA-256 does not match authenticated metadata.");
  }
  return {
    artifactId: digest,
    bytesVerified: true as const,
    nativeSignatureVerificationRequired: true as const,
  };
}

const compareVersion = (left: string, right: string) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${encodeJson(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : encodeJson(value);
};

export function proposeManualUpdate(
  current: CandidateManifest | undefined,
  candidate: CandidateManifest,
) {
  assertIndependentIdentity(candidate);
  if (current !== undefined) {
    const difference = compareVersion(candidate.distributionVersion, current.distributionVersion);
    if (difference < 0)
      throw new Error(
        "Channel promotion refuses a downgrade; rollback is a separate recovery operation.",
      );
    if (difference === 0 && canonicalJson(candidate) !== canonicalJson(current)) {
      throw new Error("An existing distribution version is immutable.");
    }
  }
  return {
    action: "stage-only" as const,
    artifactId: candidate.artifactId,
    publicationRequiresApproval: true as const,
  };
}

const isWithin = (root: string, path: string) => {
  const relative = NodePath.win32.relative(root, path);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.win32.isAbsolute(relative);
};

export function verifyInstallPaths(input: {
  readonly localAppData: string;
  readonly installRoot: string;
  readonly t3Home: string;
}) {
  const paths = [input.localAppData, input.installRoot, input.t3Home];
  if (
    paths.some(
      (path) =>
        !/^[a-z]:\\/iu.test(path) ||
        /(?:^|[\\/])(?:\.?codex|\.?cache|codex-runtimes|Packages)(?:[\\/]|$)/iu.test(path),
    )
  ) {
    throw new Error(
      "Installation requires absolute native-user paths outside Codex and its caches.",
    );
  }
  const allowedInstall = NodePath.win32.join(input.localAppData, "Programs", "T3CodeLAN");
  const allowedHome = NodePath.win32.join(input.localAppData, "T3CodeLAN");
  if (
    !isWithin(allowedInstall, input.installRoot) ||
    !isWithin(allowedHome, input.t3Home) ||
    isWithin(input.installRoot, input.t3Home) ||
    isWithin(input.t3Home, input.installRoot)
  ) {
    throw new Error(
      "Use separate versioned T3CodeLAN install and data directories under native LOCALAPPDATA.",
    );
  }
  return {
    installRoot: NodePath.win32.resolve(input.installRoot),
    t3Home: NodePath.win32.resolve(input.t3Home),
  };
}

export interface MachineInventory {
  readonly environmentId: string;
  readonly machineId: string;
  readonly desiredArtifactId: string | null;
  readonly installedArtifactId: string | null;
  readonly runningArtifactId: string | null;
  readonly observedAt: number;
  readonly provenance: "native-user" | "unknown";
  readonly desktopVersion: string | null;
  readonly backendVersion: string | null;
  readonly protocolVersion: number | null;
  readonly executablePath: string | null;
}

export interface StoppedStateEvidence {
  readonly environmentId: string;
  readonly installedArtifactId: string | null;
  readonly observedAt: number;
  readonly lockHeld: boolean;
  readonly serverStopped: boolean;
  readonly activeRuns: number | null;
  readonly queuedRuns: number | null;
  readonly pendingRequests: number | null;
  readonly backgroundAgents: number | null;
  readonly scheduledWork: number | null;
  readonly restartContinuations: number | null;
}

export function planActivation(input: {
  readonly inventory: MachineInventory;
  readonly state: StoppedStateEvidence;
  readonly candidateArtifactId: string;
  readonly now: number;
  readonly artifactVerified: boolean;
  readonly snapshotVerified: boolean;
}) {
  const reasons: Array<string> = [];
  if (!Number.isFinite(input.now)) reasons.push("The admission clock is invalid.");
  if (
    !/^[a-f0-9]{64}$/u.test(input.candidateArtifactId) ||
    input.inventory.desiredArtifactId !== input.candidateArtifactId
  )
    reasons.push("The candidate is not the machine's explicitly selected desired artifact.");
  if (
    input.state.environmentId !== input.inventory.environmentId ||
    input.state.installedArtifactId !== input.inventory.installedArtifactId
  )
    reasons.push(
      "Admission evidence does not match the selected environment and installed artifact.",
    );
  if (input.inventory.runningArtifactId !== null)
    reasons.push("The inventory still reports a running T3 instance.");
  if (!input.artifactVerified) reasons.push("The staged artifact is unverified.");
  if (!input.snapshotVerified)
    reasons.push("A coherent stopped-state recovery snapshot is required.");
  if (input.inventory.provenance !== "native-user")
    reasons.push("Machine identity and paths need native-user verification.");
  if (
    input.inventory.environmentId.length === 0 ||
    input.inventory.machineId.length === 0 ||
    input.inventory.executablePath === null ||
    input.inventory.protocolVersion !== 2 ||
    input.inventory.desktopVersion === null ||
    input.inventory.desktopVersion !== input.inventory.backendVersion
  )
    reasons.push("Machine/version inventory is incomplete or incompatible.");
  for (const timestamp of [input.inventory.observedAt, input.state.observedAt]) {
    if (!Number.isFinite(timestamp) || timestamp > input.now || input.now - timestamp > 30_000)
      reasons.push("Inventory or admission evidence is stale or invalid.");
  }
  if (!input.state.lockHeld || !input.state.serverStopped)
    reasons.push("Hold the exclusive activation lock and keep T3 stopped throughout activation.");
  for (const key of [
    "activeRuns",
    "queuedRuns",
    "pendingRequests",
    "backgroundAgents",
    "scheduledWork",
    "restartContinuations",
  ] as const) {
    if (input.state[key] !== 0) reasons.push(`Defer activation: ${key} is busy or unknown.`);
  }
  return {
    action: reasons.length === 0 ? ("manual-activation-eligible" as const) : ("defer" as const),
    reasons,
  };
}

export function planRollback(input: {
  readonly admission: ReturnType<typeof planActivation>;
  readonly previousArtifactVerified: boolean;
  readonly coherentSnapshotVerified: boolean;
  readonly snapshotArtifactId: string;
  readonly previousArtifactId: string;
  readonly newWorkAccepted: boolean;
}) {
  if (
    input.admission.action !== "manual-activation-eligible" ||
    !input.previousArtifactVerified ||
    !input.coherentSnapshotVerified ||
    input.snapshotArtifactId !== input.previousArtifactId ||
    input.newWorkAccepted
  ) {
    return { action: "manual-recovery-required" as const };
  }
  return { action: "restore-stopped-snapshot-and-previous-binary" as const };
}
