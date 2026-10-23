// @effect-diagnostics nodeBuiltinImport:off - Public synthetic lock bytes only; no install or compiler invocation.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { parseLanBuildIdentity } from "@t3tools/shared/distribution";
import { BUILD_INPUT_FILES, sha256 } from "./hub-distribution.ts";
import { populateProductionStageFixture } from "./stage-locks.fixtures.ts";
import {
  assertLanPackagingTarget,
  LAN_STAGE_LOCK_FILES,
  readLanPackagingInputs,
} from "./lan-packaging.ts";

function fixture() {
  const identity = parseLanBuildIdentity({
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
  });
  const selection = { path: "C:\\Approved\\identity.json", sha256: "b".repeat(64), identity };
  const root = NodePath.resolve("synthetic-lan-source"),
    lockPath = NodePath.resolve("approved-fixture-lock.json");
  const files = Object.fromEntries(
    [...BUILD_INPUT_FILES, ...Object.values(LAN_STAGE_LOCK_FILES)].map((name) => [
      name,
      Buffer.from(`fixture:${name}`),
    ]),
  );
  for (const name of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ])
    files[name] = Buffer.from(JSON.stringify({ version: identity.applicationVersion }));
  files["package.json"] = Buffer.from(
    JSON.stringify({ engines: { node: "26.12.1" }, packageManager: "pnpm@12.14.0" }),
  );
  const stageFiles = new Map(Object.entries(files));
  populateProductionStageFixture(stageFiles);
  Object.assign(files, Object.fromEntries(stageFiles));
  const tool = { version: "1.0.0", sha256: "c".repeat(64) };
  const lock = {
    schemaVersion: 1,
    upstreamCommit: identity.sourceCommit,
    forkCommit: identity.sourceCommit,
    distributionVersion: "1.0.0",
    applicationVersion: identity.applicationVersion,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
    tools: { node: tool, pnpm: tool, rust: tool, msvc: tool, windowsSdk: tool, nsis: tool },
    wslRuntime: null,
    cloudConfiguration: "disabled",
    telemetry: "disabled",
    nativeUpdater: "disabled",
  };
  const read = (path: string) =>
    path === lockPath
      ? Buffer.from(JSON.stringify(lock))
      : (files[NodePath.relative(root, path).replaceAll("\\", "/")] ??
        (() => {
          throw new Error("missing fixture input");
        })());
  return { selection, root, lockPath, lock, files, read };
}

it("requires real approved production stage locks and checks their bytes before any install", () => {
  const input = fixture();
  const result = readLanPackagingInputs(input.selection, input.lockPath, input.root, input.read);
  NodeAssert.deepEqual(result.stageLocks.desktop, input.files[LAN_STAGE_LOCK_FILES.desktop]);
  delete input.lock.files[LAN_STAGE_LOCK_FILES.server];
  NodeAssert.throws(
    () => readLanPackagingInputs(input.selection, input.lockPath, input.root, input.read),
    /missing from build lock/u,
  );
  const changed = fixture();
  changed.files[LAN_STAGE_LOCK_FILES.desktop] = Buffer.from("changed frozen resolution");
  NodeAssert.throws(
    () => readLanPackagingInputs(changed.selection, changed.lockPath, changed.root, changed.read),
    /bytes differ/u,
  );
});

it("refuses source/version drift and unsafe or non-isolated packaging modes", () => {
  const input = fixture();
  input.lock.forkCommit = "d".repeat(40);
  NodeAssert.throws(
    () => readLanPackagingInputs(input.selection, input.lockPath, input.root, input.read),
    /source\/version/u,
  );
  const valid = {
    platform: "win",
    arch: "x64",
    target: "zip",
    skipBuild: false,
    signed: false,
    mockUpdates: false,
    wslRuntime: undefined,
  };
  assertLanPackagingTarget(valid, input.selection);
  for (const change of [
    { platform: "linux" },
    { arch: "arm64" },
    { target: "nsis" },
    { skipBuild: true },
    { signed: true },
    { mockUpdates: true },
    { wslRuntime: "fixture.tar.gz" },
  ])
    NodeAssert.throws(() => assertLanPackagingTarget({ ...valid, ...change }, input.selection));
});

it("requires version preparation before the approved source/input lock instead of rewriting tracked manifests", () => {
  const input = fixture();
  const path = "apps/web/package.json";
  input.files[path] = Buffer.from('{"version":"9.9.9"}');
  input.lock.files[path] = sha256(input.files[path]);
  NodeAssert.throws(
    () => readLanPackagingInputs(input.selection, input.lockPath, input.root, input.read),
    /before final source commit/u,
  );
});

it("validates the same captured stage bytes that packaging returns instead of a later replacement", () => {
  const input = fixture(),
    name = LAN_STAGE_LOCK_FILES.desktop;
  const correct = input.files[name]!;
  const changed = Buffer.concat([correct, Buffer.from("\nunsafeIgnoredField: true\n")]);
  input.files[name] = changed;
  input.lock.files[name] = sha256(changed);
  const pinnedReadCount = [...BUILD_INPUT_FILES, ...Object.values(LAN_STAGE_LOCK_FILES)].filter(
    (path) => path === name,
  ).length;
  let reads = 0;
  NodeAssert.throws(
    () =>
      readLanPackagingInputs(input.selection, input.lockPath, input.root, (path) =>
        path === NodePath.join(input.root, name)
          ? ++reads <= pinnedReadCount
            ? changed
            : correct
          : input.read(path),
      ),
    /exact root projection/u,
  );
});
