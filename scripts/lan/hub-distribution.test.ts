import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  BUILD_INPUT_FILES,
  BuildLock,
  CandidateManifest,
  planActivation,
  planRollback,
  prepareWindowsBuild,
  proposeManualUpdate,
  sha256,
  verifyArtifact,
  verifyInstallPaths,
  type CheckoutEvidence,
  type MachineInventory,
  type StoppedStateEvidence,
} from "./hub-distribution.ts";

const decodeBuildLock = Schema.decodeUnknownSync(BuildLock);
const decodeCandidate = Schema.decodeUnknownSync(CandidateManifest);

const bytes = new TextEncoder().encode("verified candidate bytes");
const artifactId = sha256(bytes);
const previousArtifactId = "b".repeat(64);
const commit = "a".repeat(40);
const now = 100_000;
const candidate = (): CandidateManifest => ({
  schemaVersion: 1,
  artifactId,
  sha256: artifactId,
  byteLength: bytes.byteLength,
  distributionVersion: "1.0.0",
  desktopVersion: "0.1.2",
  backendVersion: "0.1.2",
  protocolVersion: 2,
  architecture: "x64",
  upstreamCommit: commit,
  forkCommit: commit,
  sourceDirty: false,
  builtUtc: "2026-10-23T00:00:00Z",
  buildLockSha256: "c".repeat(64),
  testReceiptSha256: "d".repeat(64),
  appId: "com.spiderpunch.t3code.lan",
  productName: "T3 Code LAN",
  protocolScheme: "t3code-lan",
  homeDirectoryName: "T3CodeLAN",
  nativeUpdater: "disabled",
  signature: { status: "unsigned-developer-candidate" },
});
const checkout = (): CheckoutEvidence => ({
  commit,
  clean: true,
  node: "26.12.1",
  packageManager: "pnpm@12.14.0",
  electron: "44.9.3",
  electronBuilder: "26.16.1",
  files: Object.fromEntries(BUILD_INPUT_FILES.map((path) => [path, artifactId])),
  officialAppId: false,
  officialHomeDefault: false,
  officialProtocols: false,
  officialBranding: false,
});
const buildLock = (): BuildLock => ({
  schemaVersion: 1,
  upstreamCommit: commit,
  forkCommit: commit,
  distributionVersion: "1.0.0",
  applicationVersion: "0.1.2",
  files: checkout().files,
  tools: {
    node: { version: "26.12.1", sha256: artifactId },
    pnpm: { version: "12.14.0", sha256: artifactId },
    rust: { version: "1.0.0", sha256: artifactId },
    msvc: { version: "1.0.0", sha256: artifactId },
    windowsSdk: { version: "1.0.0", sha256: artifactId },
    nsis: { version: "1.0.0", sha256: artifactId },
  },
  wslRuntime: null,
  cloudConfiguration: "disabled",
  telemetry: "disabled",
  nativeUpdater: "disabled",
});
const inventory = (): MachineInventory => ({
  environmentId: "environment-one",
  machineId: "machine-one",
  desiredArtifactId: artifactId,
  installedArtifactId: previousArtifactId,
  runningArtifactId: null,
  observedAt: now,
  provenance: "native-user",
  desktopVersion: "0.1.2",
  backendVersion: "0.1.2",
  protocolVersion: 2,
  executablePath:
    "C:\\Users\\Owner\\AppData\\Local\\Programs\\T3CodeLAN\\versions\\1.0.0\\T3CodeLAN.exe",
});
const state = (): StoppedStateEvidence => ({
  environmentId: "environment-one",
  installedArtifactId: previousArtifactId,
  observedAt: now,
  lockHeld: true,
  serverStopped: true,
  activeRuns: 0,
  queuedRuns: 0,
  pendingRequests: 0,
  backgroundAgents: 0,
  scheduledWork: 0,
  restartContinuations: 0,
});
const activation = () => ({
  inventory: inventory(),
  state: state(),
  candidateArtifactId: artifactId,
  now,
  artifactVerified: true,
  snapshotVerified: true,
});

it("blocks unlocked builds and official identity collisions without inventing tool pins", () => {
  const report = prepareWindowsBuild({
    ...checkout(),
    officialAppId: true,
    officialHomeDefault: true,
    officialProtocols: true,
    officialBranding: true,
  });
  assert.isFalse(report.ready);
  assert.equal(report.blockers.length, 5);
  assert.equal(report.source.node, "26.12.1");
  assert.equal(report.mode, "dry-run");
});

it("requires exact source, frozen input hashes and exact tool versions", () => {
  assert.isTrue(prepareWindowsBuild(checkout(), buildLock()).ready);
  assert.isFalse(prepareWindowsBuild({ ...checkout(), clean: false }, buildLock()).ready);
  assert.isFalse(prepareWindowsBuild({ ...checkout(), commit: "b".repeat(40) }, buildLock()).ready);
  assert.isFalse(prepareWindowsBuild({ ...checkout(), files: {} }, buildLock()).ready);
  const lock = buildLock();
  assert.isFalse(
    prepareWindowsBuild(checkout(), {
      ...lock,
      tools: { ...lock.tools, rust: { version: "stable", sha256: artifactId } },
    }).ready,
  );
  assert.isFalse(
    prepareWindowsBuild(checkout(), {
      ...lock,
      tools: { ...lock.tools, pnpm: { version: "11.10.0", sha256: artifactId } },
    }).ready,
  );
  assert.throws(() => decodeBuildLock({ ...lock, tools: {} }));
});

it("verifies artifact bytes, identity and version alignment before staging", () => {
  assert.deepEqual(verifyArtifact(candidate(), bytes), {
    artifactId,
    bytesVerified: true,
    nativeSignatureVerificationRequired: true,
  });
  assert.throws(() => verifyArtifact(candidate(), new TextEncoder().encode("wrong")), /SHA-256/u);
  assert.throws(
    () => verifyArtifact({ ...candidate(), byteLength: bytes.byteLength + 1 }, bytes),
    /length/u,
  );
  for (const identity of [
    { appId: "com.t3tools.t3code" },
    { productName: "T3 Code (Beta)" },
    { protocolScheme: "t3code" },
    { protocolScheme: "https" },
    { protocolScheme: "file" },
    { protocolScheme: "ms-settings" },
    { homeDirectoryName: ".t3" },
  ])
    assert.throws(() => verifyArtifact({ ...candidate(), ...identity }, bytes), /collides/u);
  assert.throws(
    () => verifyArtifact({ ...candidate(), backendVersion: "0.1.1" }, bytes),
    /versions/u,
  );
  assert.throws(
    () =>
      verifyArtifact(
        { ...candidate(), signature: { status: "verified", publisher: "T3 Tools Inc" } },
        bytes,
      ),
    /publisher/u,
  );
  assert.throws(() => decodeCandidate({ ...candidate(), byteLength: -1 }));
});

it("keeps channel versions immutable and manual updates stage-only", () => {
  assert.equal(proposeManualUpdate(undefined, candidate()).action, "stage-only");
  assert.isTrue(proposeManualUpdate(candidate(), candidate()).publicationRequiresApproval);
  assert.throws(
    () => proposeManualUpdate(candidate(), { ...candidate(), distributionVersion: "0.9.0" }),
    /downgrade/u,
  );
  assert.throws(
    () => proposeManualUpdate(candidate(), { ...candidate(), testReceiptSha256: artifactId }),
    /immutable/u,
  );
});

it("rejects virtualized, official, traversing and overlapping installation paths", () => {
  const paths = {
    localAppData: "C:\\Users\\Owner\\AppData\\Local",
    installRoot: "C:\\Users\\Owner\\AppData\\Local\\Programs\\T3CodeLAN\\versions\\1.0.0",
    t3Home: "C:\\Users\\Owner\\AppData\\Local\\T3CodeLAN\\data",
  };
  assert.deepEqual(verifyInstallPaths(paths), {
    installRoot: paths.installRoot,
    t3Home: paths.t3Home,
  });
  for (const installRoot of [
    "relative\\T3CodeLAN",
    "C:\\Users\\Owner\\.codex\\cache\\T3CodeLAN",
    "C:\\Users\\Owner\\AppData\\Local\\Programs\\t3code",
    "C:\\Users\\Owner\\AppData\\Local\\Programs\\T3CodeLAN\\..\\t3code",
  ])
    assert.throws(() => verifyInstallPaths({ ...paths, installRoot }));
  assert.throws(() => verifyInstallPaths({ ...paths, t3Home: "C:\\Users\\Owner\\.t3" }));
  assert.throws(() =>
    verifyInstallPaths({
      localAppData: "C:\\OpenAI\\Codex\\cache",
      installRoot: "C:\\OpenAI\\Codex\\cache\\Programs\\T3CodeLAN\\versions\\1.0.0",
      t3Home: "C:\\OpenAI\\Codex\\cache\\T3CodeLAN\\data",
    }),
  );
  const virtualLocal =
    "C:\\Users\\Owner\\AppData\\Local\\Packages\\sandbox.fixture\\LocalCache\\Local";
  assert.throws(() =>
    verifyInstallPaths({
      localAppData: virtualLocal,
      installRoot: `${virtualLocal}\\Programs\\T3CodeLAN\\versions\\1.0.0`,
      t3Home: `${virtualLocal}\\T3CodeLAN\\data`,
    }),
  );
});

it("defers every busy or unknown work class including questions and restart continuations", () => {
  assert.equal(planActivation(activation()).action, "manual-activation-eligible");
  for (const key of [
    "activeRuns",
    "queuedRuns",
    "pendingRequests",
    "backgroundAgents",
    "scheduledWork",
    "restartContinuations",
  ] as const) {
    for (const count of [1, null])
      assert.equal(
        planActivation({ ...activation(), state: { ...state(), [key]: count } }).action,
        "defer",
      );
  }
  for (const patch of [
    { lockHeld: false },
    { serverStopped: false },
    { environmentId: "other" },
    { observedAt: now - 30_001 },
  ]) {
    assert.equal(
      planActivation({ ...activation(), state: { ...state(), ...patch } }).action,
      "defer",
    );
  }
  assert.equal(planActivation({ ...activation(), artifactVerified: false }).action, "defer");
  assert.equal(planActivation({ ...activation(), snapshotVerified: false }).action, "defer");
  assert.equal(planActivation({ ...activation(), now: Number.NaN }).action, "defer");
  assert.equal(
    planActivation({ ...activation(), inventory: { ...inventory(), desiredArtifactId: null } })
      .action,
    "defer",
  );
  assert.equal(
    planActivation({ ...activation(), inventory: { ...inventory(), provenance: "unknown" } })
      .action,
    "defer",
  );
  assert.equal(
    planActivation({
      ...activation(),
      inventory: { ...inventory(), runningArtifactId: previousArtifactId },
    }).action,
    "defer",
  );
});

it("restores a matched stopped-state snapshot only before new work is accepted", () => {
  const rollback = {
    admission: planActivation(activation()),
    previousArtifactVerified: true,
    coherentSnapshotVerified: true,
    snapshotArtifactId: previousArtifactId,
    previousArtifactId,
    newWorkAccepted: false,
  };
  assert.equal(planRollback(rollback).action, "restore-stopped-snapshot-and-previous-binary");
  assert.equal(
    planRollback({ ...rollback, newWorkAccepted: true }).action,
    "manual-recovery-required",
  );
  assert.equal(
    planRollback({ ...rollback, snapshotArtifactId: artifactId }).action,
    "manual-recovery-required",
  );
  assert.equal(
    planRollback({
      ...rollback,
      admission: planActivation({ ...activation(), snapshotVerified: false }),
    }).action,
    "manual-recovery-required",
  );
});
