// @effect-diagnostics nodeBuiltinImport:off - Synthetic archives, disposable output fixtures and mock signature inspection only.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { fixture } from "./windows-artifact.fixtures.ts";
import { sha256 } from "./hub-distribution.ts";
import {
  PORTABLE_ZIP_MAX_BYTES,
  readPortableZip,
  validateWindowsArtifact,
} from "./windows-artifact.ts";
import { materializeWindowsCandidate, writeNewValidatedArtifacts } from "./seal-windows-payload.ts";
import { assertValidationRoot, readValidationFile } from "./validate-windows-artifact.ts";

function setup() {
  const input = fixture();
  const payload = new Map(input.files);
  for (const name of [
    "t3code-lan-package.json",
    "t3code-lan-build-lock.json",
    "t3code-lan-test-receipt.json",
    "t3code-lan-runtime-policy-evidence.json",
  ])
    payload.delete(name);
  const options = {
    payload,
    policy: input.policy,
    buildLockBytes: input.buildLockBytes,
    testReceiptBytes: input.files.get("t3code-lan-test-receipt.json")!,
    runtimeEvidenceBytes: input.files.get("t3code-lan-runtime-policy-evidence.json")!,
    builtUtc: "2026-10-23T00:00:00Z",
    executablePath: "T3CodeLAN.exe",
  };
  return { input, options };
}

it("seals supplied evidence deterministically and passes actual ZIP/ASAR validation before publication eligibility", async () => {
  const { input, options } = setup();
  const one = materializeWindowsCandidate(options),
    two = materializeWindowsCandidate({
      ...options,
      payload: new Map([...options.payload].toReversed()),
    });
  NodeAssert.equal(sha256(one.artifact), sha256(two.artifact));
  NodeAssert.deepEqual(
    readPortableZip(one.artifact).get("t3code-lan-test-receipt.json"),
    options.testReceiptBytes,
  );
  const runs = [
    { ...input.runs[0], ...one },
    { ...input.runs[1], ...two },
  ] as const;
  const report = await validateWindowsArtifact({ ...input, runs });
  NodeAssert.equal(report.passed, true);
  NodeAssert.equal(report.distributionAuthorized, false);
  NodeAssert.equal(one.validationRequired, true);
});

it("materializes and validates a single routine candidate with all supplied evidence", async () => {
  const { input, options } = setup();
  const policy = { ...input.policy, validationMode: "candidate" as const };
  const sealed = materializeWindowsCandidate({ ...options, policy });
  const report = await validateWindowsArtifact({
    ...input,
    policy,
    runs: [{ ...input.runs[0], ...sealed }],
  });
  NodeAssert.equal(report.passed, true);
  NodeAssert.equal(report.byteReproducibilityVerified, false);
  NodeAssert.equal(report.runs.length, 1);
  NodeAssert.deepEqual(
    readPortableZip(sealed.artifact).get("t3code-lan-test-receipt.json"),
    options.testReceiptBytes,
  );
});

it("cannot turn a failed supplied test receipt or unreviewed runtime evidence into a passed candidate", async () => {
  const { input, options } = setup();
  const receipt = JSON.parse(Buffer.from(options.testReceiptBytes).toString("utf8"));
  receipt.passed = false;
  const sealed = materializeWindowsCandidate({
    ...options,
    testReceiptBytes: Buffer.from(JSON.stringify(receipt)),
  });
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...input,
        runs: [
          { ...input.runs[0], ...sealed },
          { ...input.runs[1], ...sealed },
        ],
      }),
    /test evidence/u,
  );
  NodeAssert.throws(
    () =>
      materializeWindowsCandidate({
        ...options,
        runtimeEvidenceBytes: Buffer.from("invented passed assertion"),
      }),
    /exact approved/u,
  );
});

it("refuses preexisting reserved receipts and preserves changed payload bytes for validation refusal", async () => {
  const { input, options } = setup();
  NodeAssert.throws(
    () =>
      materializeWindowsCandidate({
        ...options,
        payload: new Map(options.payload).set("t3code-lan-install.json", Buffer.from("existing")),
      }),
    /reserved/u,
  );
  const changed = materializeWindowsCandidate({
    ...options,
    payload: new Map(options.payload).set(
      "resources/native-maintenance.mjs",
      Buffer.from("changed helper"),
    ),
  });
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...input,
        runs: [
          { ...input.runs[0], ...changed },
          { ...input.runs[1], ...changed },
        ],
      }),
    /compiled policy component/u,
  );
});

it.effect("verifies new output bytes on disk and preserves existing outputs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-seal-output-fixture-" });
      const file = path.join(root, "fixture.zip");
      const bytes = Buffer.from("synthetic validated fixture bytes");
      yield* Effect.promise(async () => {
        NodeAssert.equal(
          await writeNewValidatedArtifacts([{ path: file, bytes }], {
            assertRoot: assertValidationRoot,
            stat: (file) => NodeFSP.lstat(file),
            create: (file) => NodeFSP.open(file, "wx", 0o600),
            read: async (file, maximum) => {
              NodeAssert.equal(maximum, PORTABLE_ZIP_MAX_BYTES);
              return readValidationFile(file, maximum);
            },
            remove: (file) => NodeFSP.unlink(file),
          }),
          1,
        );
        NodeAssert.deepEqual(await NodeFSP.readFile(file), bytes);
        await NodeAssert.rejects(() => writeNewValidatedArtifacts([{ path: file, bytes }]));
        NodeAssert.deepEqual(await NodeFSP.readFile(file), bytes);
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a replaced sealed output and retains the replacement for owner recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-seal-replace-fixture-" });
      const file = path.join(root, "fixture.zip");
      yield* Effect.promise(async () => {
        await NodeAssert.rejects(
          () =>
            writeNewValidatedArtifacts(
              [{ path: file, bytes: Buffer.from("synthetic validated fixture bytes") }],
              {
                assertRoot: assertValidationRoot,
                stat: (file) => NodeFSP.lstat(file),
                create: (file) => NodeFSP.open(file, "wx", 0o600),
                read: async (file, maximum) => {
                  await NodeFSP.rename(file, path.join(root, "original.fixture"));
                  await NodeFSP.writeFile(file, "concurrent replacement");
                  return readValidationFile(file, maximum);
                },
                remove: (file) => NodeFSP.unlink(file),
              },
            ),
          /owner recovery/u,
        );
        NodeAssert.equal(await NodeFSP.readFile(file, "utf8"), "concurrent replacement");
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
