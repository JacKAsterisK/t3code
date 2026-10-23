// @effect-diagnostics nodeBuiltinImport:off - Synthetic archives and signature port only; no native process or provider is run.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import { readPortableZip, strictJson, validateWindowsArtifact } from "./windows-artifact.ts";
import { fixture, zip, asar, pe, json, commit } from "./windows-artifact.fixtures.ts";
function patchHeader(
  bytes: Uint8Array,
  edit: (header: { files: Record<string, Record<string, unknown>> }) => void,
) {
  const old = Buffer.from(bytes),
    oldSize = old.readUInt32LE(4);
  const header = JSON.parse(old.subarray(16, 16 + old.readUInt32LE(12)).toString("utf8"));
  edit(header);
  const encoded = json(header),
    size = 8 + Math.ceil(encoded.length / 4) * 4,
    prefix = Buffer.alloc(8 + size);
  prefix.writeUInt32LE(4);
  prefix.writeUInt32LE(size, 4);
  prefix.writeUInt32LE(size - 4, 8);
  prefix.writeUInt32LE(encoded.length, 12);
  encoded.copy(prefix, 16);
  return Buffer.concat([prefix, old.subarray(8 + oldSize)]);
}

it("rejects ASAR flag types that disagree with Electron's truthy unpacked interpretation", async () => {
  for (const field of ["unpacked", "executable", "integrity"]) {
    const input = fixture((files) =>
      files.set(
        "resources/app.asar",
        patchHeader(files.get("resources/app.asar")!, (header) => {
          header.files["package.json"]![field] = "false";
        }),
      ),
    );
    await NodeAssert.rejects(() => validateWindowsArtifact(input), /ASAR/u);
  }
});

it("refuses duplicate or failed receipt checks accepted by a partial some-true predicate", async () => {
  for (const check of [
    { name: "focused-tests", passed: true },
    { name: "additional-native-check", passed: false },
  ]) {
    const input = fixture((files) => {
      const receipt = JSON.parse(
        Buffer.from(files.get("t3code-lan-test-receipt.json")!).toString("utf8"),
      );
      receipt.checks.push(check);
      files.set("t3code-lan-test-receipt.json", json(receipt));
    });
    await NodeAssert.rejects(
      () => validateWindowsArtifact(input),
      /test evidence|receipt|checks/iu,
    );
  }
});

it("requires Hub-compatible build time and sorted manifest file order", async () => {
  for (const invalid of ["time", "sort"] as const) {
    const input = fixture(),
      files = new Map(input.files);
    const manifest = JSON.parse(
      Buffer.from(files.get("t3code-lan-package.json")!).toString("utf8"),
    );
    if (invalid === "time") delete manifest.builtUtc;
    else manifest.files.reverse();
    files.set("t3code-lan-package.json", json(manifest));
    input.runs = [
      { ...input.runs[0], artifact: zip(files), extractedFiles: files },
      { ...input.runs[1], artifact: zip(files), extractedFiles: files },
    ];
    await NodeAssert.rejects(() => validateWindowsArtifact(input), /time|sorted|provenance/iu);
  }
});

it("refuses reserved installation receipts and oversized Hub evidence", async () => {
  const reserved = fixture((files) =>
    files.set("t3code-lan-install.json", json({ installed: true })),
  );
  await NodeAssert.rejects(() => validateWindowsArtifact(reserved), /reserved/u);
  const oversized = fixture((files) => {
    const receipt = JSON.parse(
      Buffer.from(files.get("t3code-lan-test-receipt.json")!).toString("utf8"),
    );
    receipt.padding = "x".repeat(1024 * 1024);
    files.set("t3code-lan-test-receipt.json", json(receipt));
  });
  await NodeAssert.rejects(() => validateWindowsArtifact(oversized), /size bounds/u);
});

it("checks actual ZIP, ASAR, toolchain, compiled component and signature bytes from two supplied builds", async () => {
  const input = fixture();
  const report = await validateWindowsArtifact(input);
  NodeAssert.equal(report.passed, true);
  NodeAssert.equal(report.byteReproducibilityVerified, true);
  NodeAssert.equal(report.distributionAuthorized, false);
  NodeAssert.equal(report.toolVersionCommandsExecuted, false);
  NodeAssert.equal(input.calls.length, 6);
  NodeAssert.equal(report.runs[0]?.native.length, 3);
});

it("validates deflated artifact bytes without relying on an external extractor", async () => {
  const input = fixture();
  input.runs = [
    { ...input.runs[0], artifact: zip(input.files, 0, true) },
    { ...input.runs[1], artifact: zip(input.files, 0, true) },
  ];
  NodeAssert.equal((await validateWindowsArtifact(input)).passed, true);
});

it("accepts explicitly approved Portal-pinned native bytes without asserting trusted Windows signatures", async () => {
  const input = fixture();
  const inspectNative = input.inspectNative;
  const result = await validateWindowsArtifact({
    ...input,
    policy: { ...input.policy, nativeTrust: "portal-pinned", certificateSha256: [] },
    inspectNative: async (run, path) => ({
      ...(await inspectNative(run, path)),
      trustStatus: -2146762496,
      certificateSha256: null,
    }),
  });
  NodeAssert.equal(result.nativeTrust, "portal-pinned");
  NodeAssert.equal(result.runs[0]!.native[0]!.certificateSha256, null);
  NodeAssert.equal(result.passed, true);
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...input,
        policy: { ...input.policy, certificateSha256: [] },
      }),
    /explicit Portal-pinned/u,
  );
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...input,
        policy: { ...input.policy, nativeTrust: "portal-pinned" },
      }),
    /explicit Portal-pinned/u,
  );
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...input,
        policy: { ...input.policy, nativeTrust: "portal-pinned", certificateSha256: [] },
        inspectNative: async (run, path) => ({
          ...(await inspectNative(run, path)),
          sha256: "0".repeat(64),
        }),
      }),
    /Native evidence differs/u,
  );
});

it("refuses operating-system and web schemes as a supposedly independent package protocol", async () => {
  for (const protocolScheme of ["https", "file", "ms-settings"]) {
    const input = fixture(undefined, protocolScheme);
    await NodeAssert.rejects(() => validateWindowsArtifact(input), /Independent identity/u);
    NodeAssert.equal(input.calls.length, 0);
  }
});

it("reads compiled ASAR identity instead of trusting independent identity in the outer manifest", async () => {
  const input = fixture((files) =>
    files.set(
      "resources/app.asar",
      asar(
        new Map([
          [
            "package.json",
            json({
              version: "0.1.2",
              buildVersion: "0.1.2",
              t3codeCommitHash: commit,
              t3codeLanIdentity: {
                schemaVersion: 1,
                sourceCommit: commit,
                applicationVersion: "0.1.2",
                appId: "com.t3tools.t3code",
                productName: "T3 Code",
                protocolScheme: "t3code",
              },
            }),
          ],
          [
            "apps/desktop/dist-electron/main.cjs",
            Buffer.from("audited fixture desktop policy enforcement"),
          ],
        ]),
      ),
    ),
  );
  await NodeAssert.rejects(
    () => validateWindowsArtifact(input),
    /Extracted desktop package identity/u,
  );
  NodeAssert.equal(input.calls.length, 0);
});

it("rejects corrupted ASAR offsets even when the outer manifest hashes those archive bytes", async () => {
  const input = fixture((files) => {
    const server = Buffer.from(files.get("resources/server.asar")!);
    server.writeUInt32LE(0xffffffff, 4);
    files.set("resources/server.asar", server);
  });
  await NodeAssert.rejects(() => validateWindowsArtifact(input), /ASAR header bounds/u);
});

it("rejects dirty or mismatched source and changed actual tool bytes before native inspection", async () => {
  for (const change of ["dirty", "commit", "input", "tool", "extra"] as const) {
    const input = fixture(),
      first = input.runs[0];
    if (change === "dirty") input.runs[0] = { ...first, source: { ...first.source, clean: false } };
    if (change === "commit")
      input.runs[0] = { ...first, source: { ...first.source, commit: "c".repeat(40) } };
    if (change === "input")
      input.runs[0] = {
        ...first,
        source: {
          ...first.source,
          files: new Map(first.source.files).set("pnpm-lock.yaml", Buffer.from("changed")),
        },
      };
    if (change === "tool")
      input.runs[0] = {
        ...first,
        toolchainFiles: new Map(first.toolchainFiles).set("bin/rust", {
          length: 1,
          sha256: "c".repeat(64),
        }),
      };
    if (change === "extra")
      input.runs[0] = {
        ...first,
        toolchainFiles: new Map(first.toolchainFiles).set("ambient.dll", {
          length: 1,
          sha256: "c".repeat(64),
        }),
      };
    await NodeAssert.rejects(() => validateWindowsArtifact(input));
    NodeAssert.equal(input.calls.length, 0);
  }
});

it("refuses unbound or unaudited compiled policy even when package metadata says disabled", async () => {
  const input = fixture((files) =>
    files.set("resources/native-maintenance.mjs", Buffer.from("unreviewed policy assertion")),
  );
  await NodeAssert.rejects(
    () => validateWindowsArtifact(input),
    /Audited compiled policy component differs/u,
  );
  NodeAssert.equal(input.calls.length, 0);
  const missing = fixture();
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...missing,
        policy: {
          ...missing.policy,
          reviewedComponents: missing.policy.reviewedComponents.filter(
            (item) => item.role !== "web-policy",
          ),
        },
      }),
    /incomplete/u,
  );
});

it("binds the extracted tree to archive bytes and refuses unlisted files", async () => {
  const input = fixture();
  input.runs[0] = {
    ...input.runs[0],
    extractedFiles: new Map(input.runs[0].extractedFiles).set(
      "resources/native-maintenance.mjs",
      Buffer.from("changed after extraction"),
    ),
  };
  await NodeAssert.rejects(() => validateWindowsArtifact(input), /File bytes differ/u);
  const extra = fixture();
  extra.runs[0] = {
    ...extra.runs[0],
    extractedFiles: new Map(extra.runs[0].extractedFiles).set("unlisted.exe", pe()),
  };
  await NodeAssert.rejects(() => validateWindowsArtifact(extra), /unlisted/u);
});

it("requires trusted signatures for every native addon and detects inspection-time replacement", async () => {
  for (const kind of ["unsigned", "certificate", "replacement"] as const) {
    const input = fixture();
    await NodeAssert.rejects(
      () =>
        validateWindowsArtifact({
          ...input,
          inspectNative: async (run, name) => ({
            ...(await input.inspectNative(run, name)),
            ...(name.endsWith(".node")
              ? kind === "unsigned"
                ? { trustStatus: -1, certificateSha256: null }
                : kind === "certificate"
                  ? { certificateSha256: "d".repeat(64) }
                  : { sha256: "e".repeat(64) }
              : {}),
          }),
        }),
      /signature/u,
    );
  }
  const version = fixture();
  await NodeAssert.rejects(
    () =>
      validateWindowsArtifact({
        ...version,
        inspectNative: async (run, name) => ({
          ...(await version.inspectNative(run, name)),
          fileVersion: "99.0.0",
        }),
      }),
    /native desktop product or file version/iu,
  );
});

it("rejects non-reproducible archive bytes even when the extracted payload is identical", async () => {
  const input = fixture();
  input.runs[1] = { ...input.runs[1], artifact: zip(input.files, 1) };
  await NodeAssert.rejects(() => validateWindowsArtifact(input), /not reproducible/u);
});

it("refuses reused build bindings and absent approved signer or lock pins", async () => {
  const input = fixture();
  input.runs[1] = { ...input.runs[1], sourceId: input.runs[0].sourceId };
  await NodeAssert.rejects(() => validateWindowsArtifact(input), /distinct/u);
  const pins = fixture();
  await NodeAssert.rejects(
    () => validateWindowsArtifact({ ...pins, policy: { ...pins.policy, certificateSha256: [] } }),
    /allowlist/u,
  );
  await NodeAssert.rejects(
    () => validateWindowsArtifact({ ...pins, buildLockBytes: Buffer.from("{}") }),
    /lock bytes/u,
  );
});

it("rejects native updater feeds, unsafe ZIP names, case duplicates, CRC corruption and duplicate JSON keys", async () => {
  const updater = fixture((files) =>
    files.set("resources/app-update.yml", Buffer.from("provider: github")),
  );
  await NodeAssert.rejects(() => validateWindowsArtifact(updater), /native update/u);
  for (const names of [
    ["../escape", "a", "b"],
    ["A", "a", "b"],
    ["file:stream", "a", "b"],
  ])
    NodeAssert.throws(() =>
      readPortableZip(zip(new Map(names.map((name) => [name, Buffer.from("x")])))),
    );
  const broken = Buffer.from(fixture().runs[0].artifact);
  const content = 30 + broken.readUInt16LE(26) + broken.readUInt16LE(28);
  broken[content + 5] = (broken[content + 5] ?? 0) ^ 1;
  NodeAssert.throws(() => readPortableZip(broken), /CRC/u);
  NodeAssert.throws(
    () => strictJson(Buffer.from('{"nativeUpdater":"disabled","NativeUpdater":"enabled"}')),
    /Duplicate/u,
  );
});
