// @effect-diagnostics nodeBuiltinImport:off - Local disposable file fixtures; no executable or installer is launched.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import {
  inspectValidationTree,
  nativeInputSnapshotSha256,
  verifyNativeBuildReceipt,
} from "./validate-windows-artifact.ts";
import { fixture, json, commit } from "./windows-artifact.fixtures.ts";

it("hashes several batches of empty, binary and streamed tool files and rejects hardlinks", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lan-tool-inventory-"));
  try {
    const small = Buffer.from("public package contents");
    const large = Buffer.alloc(256 * 1024 + 1, 42);
    await NodeFSP.writeFile(NodePath.join(root, "small"), small);
    await NodeFSP.writeFile(NodePath.join(root, "large"), large);
    const nested = NodePath.join(root, "nested");
    await NodeFSP.mkdir(nested);
    for (let index = 0; index < 70; index++)
      await NodeFSP.writeFile(
        NodePath.join(nested, `tiny-${index.toString().padStart(2, "0")}`),
        index % 2 === 0 ? new Uint8Array() : new Uint8Array([index, 0, 255, 13, 10]),
      );
    const files = await inspectValidationTree(root, true);
    expect(files.size).toBe(72);
    for (const [name, bytes] of [
      ["small", small],
      ["large", large],
    ] as const)
      expect(files.get(name)).toEqual({
        bytes: new Uint8Array(),
        length: bytes.length,
        sha256: sha256(bytes),
      });
    const payload = await inspectValidationTree(root);
    expect([...files.keys()]).toEqual([...payload.keys()]);
    for (const [name, pin] of files) {
      const original = payload.get(name)!;
      expect(pin).toEqual({
        bytes: new Uint8Array(),
        length: original.bytes.length,
        sha256: sha256(original.bytes),
      });
    }
    await NodeFSP.link(NodePath.join(root, "small"), NodePath.join(root, "alias"));
    await expect(inspectValidationTree(root, true)).rejects.toThrow(/changed while opening/u);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

function nativeReceiptFixture() {
  const base = fixture();
  const runnerBytes = Buffer.from("approved native producer fixture");
  const identityBytes = json({
    ...base.policy.identity,
    sourceCommit: commit,
    applicationVersion: "0.1.2",
    protocolVersion: 2,
  });
  const bindings = {
    schemaVersion: 1,
    buildLockSha256: sha256(base.buildLockBytes),
    identitySha256: sha256(identityBytes),
    toolchainManifestSha256: sha256(base.toolchainManifestBytes),
  };
  const preparationBytes = json(bindings),
    executionBytes = json(bindings);
  const nativeBytes = json({
    schemaVersion: 1,
    runnerSha256: sha256(runnerBytes),
    preparationRequestSha256: sha256(preparationBytes),
    executionRequestSha256: sha256(executionBytes),
  });
  const snapshotBytes = json({ schemaVersion: 1, sourceCommit: commit, files: [] });
  const inputs = new Map([
    ["native-request.json", nativeBytes],
    ["preparation-request.json", preparationBytes],
    ["execution-request.json", executionBytes],
    ["snapshot.json", snapshotBytes],
    ["identity.json", identityBytes],
    ["build-lock.json", base.buildLockBytes],
    ["toolchain-manifest.json", base.toolchainManifestBytes],
  ]);
  const selectedTools = new Map(
    [...base.runs[0].toolchainFiles].map(([name]) => [
      name,
      Buffer.from(`synthetic tool:${name.split("/").at(-1)}`),
    ]),
  );
  const receipt = {
    schemaVersion: 1,
    kind: "windows-native-build-receipt",
    sourceCommit: commit,
    buildLockSha256: sha256(base.buildLockBytes),
    toolchainManifestSha256: sha256(base.toolchainManifestBytes),
    runnerSha256: sha256(runnerBytes),
    nativeRequestSha256: sha256(nativeBytes),
    preparationRequestSha256: sha256(preparationBytes),
    executionRequestSha256: sha256(executionBytes),
    sourceSnapshotSha256: sha256(snapshotBytes),
    inputsSnapshotSha256: nativeInputSnapshotSha256(inputs),
    identitySha256: sha256(identityBytes),
    rawArtifactSha256: sha256(base.runs[0].artifact),
    rawArtifactByteLength: base.runs[0].artifact.length,
    toolchainFileCount: base.runs[0].toolchainFiles.size,
    toolchainByteLength: [...base.runs[0].toolchainFiles.values()].reduce(
      (n, pin) => n + pin.length,
      0,
    ),
    verifiedBoundaries: ["before-execution", "after-execution"],
  };
  const receiptBytes = json(receipt);
  const input = {
    policy: {
      ...base.policy,
      validationMode: "candidate" as const,
      nativeBuildEvidence: {
        receiptSha256: sha256(receiptBytes),
        runnerSha256: sha256(runnerBytes),
      },
    },
    receiptBytes,
    runnerBytes,
    rawArtifactBytes: base.runs[0].artifact,
    rawExtractedFiles: base.runs[0].extractedFiles,
    inputs,
    selectedTools,
    buildLockBytes: base.buildLockBytes,
    toolchainManifestBytes: base.toolchainManifestBytes,
    sourceCommit: commit,
  };
  const approvedReceipt = (value: unknown) => {
    const receiptBytes = json(value);
    return {
      receiptBytes,
      policy: {
        ...input.policy,
        nativeBuildEvidence: {
          ...input.policy.nativeBuildEvidence,
          receiptSha256: sha256(receiptBytes),
        },
      },
    };
  };
  return { base, receipt, input, approvedReceipt };
}

it("accepts externally pinned native scans only with fresh runner, input, ZIP, payload and selected-tool bindings", () => {
  const { base, input } = nativeReceiptFixture();
  expect(verifyNativeBuildReceipt(input)).toEqual(base.runs[0].toolchainFiles);
  expect(nativeInputSnapshotSha256(new Map([...input.inputs].toReversed()))).toBe(
    nativeInputSnapshotSha256(input.inputs),
  );
  expect(() =>
    verifyNativeBuildReceipt({
      ...input,
      policy: { ...input.policy, validationMode: "independent-rebuild" },
    }),
  ).toThrow(/candidate policy/u);
  expect(() => verifyNativeBuildReceipt({ ...input, policy: base.policy })).toThrow(
    /separately approve/u,
  );
});

it("refuses malformed, unapproved and source-mismatched native build receipts", () => {
  const { receipt, input, approvedReceipt } = nativeReceiptFixture();
  expect(() =>
    verifyNativeBuildReceipt({
      ...input,
      receiptBytes: json({ ...receipt, sourceCommit: "b".repeat(40) }),
    }),
  ).toThrow(/separately approved bytes/u);
  for (const changed of [
    { ...receipt, verifiedBoundaries: ["before-execution"] },
    { ...receipt, claimed: "passed" },
    { ...receipt, sourceCommit: "b".repeat(40) },
    { ...receipt, toolchainFileCount: receipt.toolchainFileCount + 1 },
    { ...receipt, toolchainByteLength: receipt.toolchainByteLength + 1 },
  ])
    expect(() => verifyNativeBuildReceipt({ ...input, ...approvedReceipt(changed) })).toThrow();
  expect(() => verifyNativeBuildReceipt({ ...input, sourceCommit: "b".repeat(40) })).toThrow(
    /source, runner or request/u,
  );
});

it("refuses replaced native producer artifacts and a different extracted payload", () => {
  const { input } = nativeReceiptFixture();
  expect(() =>
    verifyNativeBuildReceipt({ ...input, rawArtifactBytes: Buffer.from("replaced") }),
  ).toThrow(/artifact differs/u);
  const changed = new Map(input.rawExtractedFiles).set(
    "resources/native-maintenance.mjs",
    Buffer.from("changed after extraction"),
  );
  expect(() => verifyNativeBuildReceipt({ ...input, rawExtractedFiles: changed })).toThrow(
    /payload differs/u,
  );
  expect(() =>
    verifyNativeBuildReceipt({
      ...input,
      rawExtractedFiles: new Map(input.rawExtractedFiles).set("unlisted", Buffer.from("extra")),
    }),
  ).toThrow(/payload differs/u);
});

it("refuses changed runner, selected tools and native input snapshots", () => {
  const { input } = nativeReceiptFixture();
  expect(() =>
    verifyNativeBuildReceipt({ ...input, runnerBytes: Buffer.from("changed runner") }),
  ).toThrow(/runner or request/u);
  expect(() =>
    verifyNativeBuildReceipt({
      ...input,
      selectedTools: new Map(input.selectedTools).set("bin/rust", Buffer.from("changed tool")),
    }),
  ).toThrow(/selected tool/u);
  expect(() =>
    verifyNativeBuildReceipt({
      ...input,
      inputs: new Map(input.inputs).set("identity.json", json({ changed: true })),
    }),
  ).toThrow(/input snapshot differs/u);
  const missing = new Map(input.inputs);
  missing.delete("snapshot.json");
  expect(() => verifyNativeBuildReceipt({ ...input, inputs: missing })).toThrow(
    /input snapshot differs/u,
  );
});

it("checks producer request relationships even when a malformed receipt is separately pinned", () => {
  const { input, receipt, approvedReceipt } = nativeReceiptFixture();
  const badNative = json({
    schemaVersion: 1,
    runnerSha256: receipt.runnerSha256,
    preparationRequestSha256: "0".repeat(64),
    executionRequestSha256: receipt.executionRequestSha256,
  });
  const inputs = new Map(input.inputs).set("native-request.json", badNative);
  const changed = {
    ...receipt,
    nativeRequestSha256: sha256(badNative),
    inputsSnapshotSha256: nativeInputSnapshotSha256(inputs),
  };
  expect(() => verifyNativeBuildReceipt({ ...input, inputs, ...approvedReceipt(changed) })).toThrow(
    /source, runner or request/u,
  );
});
