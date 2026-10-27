// @effect-diagnostics nodeBuiltinImport:off -- Disposable local tool files; no compiler or application is started.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import { captureQualifiedToolchain } from "./native-toolchain-qualification.ts";

async function fixture() {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-toolchain-qualification-"));
  const root = NodePath.join(base, "tools");
  await NodeFSP.mkdir(root);
  const files = [
    { path: "node.exe", bytes: Buffer.from("synthetic primary") },
    { path: "dependency.bin", bytes: Buffer.from("synthetic dependency") },
  ];
  for (const file of files) await NodeFSP.writeFile(NodePath.join(root, file.path), file.bytes);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      files: files.map((file) => ({
        path: file.path,
        length: file.bytes.length,
        sha256: sha256(file.bytes),
      })),
    }),
  );
  const input = {
    root,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    primaryFiles: [{ path: "node.exe", sha256: sha256(files[0]!.bytes), version: "1.0.0" }],
    qualification: { path: NodePath.join(base, "qualified.json") },
  };
  return { base, input, cleanup: () => NodeFSP.rm(base, { recursive: true, force: true }) };
}

it("qualifies once and reuses without enumerating or reading the complete dependency tree", async () => {
  const f = await fixture();
  try {
    await captureQualifiedToolchain(f.input);
    await NodeFSP.unlink(NodePath.join(f.input.root, "dependency.bin"));
    const reused = await captureQualifiedToolchain(f.input);
    await reused.recheck();
    expect(reused.verification.mode).toBe("qualified-primary-pins");
    expect(reused.verification.fullInventoryVerifiedDuringBuild).toBe(false);
    expect(reused.files.size).toBe(2);
  } finally {
    await f.cleanup();
  }
});

it("rehashes primary tools and refuses changed qualification evidence during a build", async () => {
  const f = await fixture();
  try {
    const first = await captureQualifiedToolchain(f.input);
    await NodeFSP.writeFile(NodePath.join(f.input.root, "node.exe"), "changed primary");
    await expect(captureQualifiedToolchain(f.input)).rejects.toThrow(/primary tool changed/u);
    await expect(first.recheck()).rejects.toThrow(/primary tool changed/u);
  } finally {
    await f.cleanup();
  }
});

it("refreshes ancillary bytes only explicitly and requalifies changed tool versions", async () => {
  const f = await fixture();
  try {
    await captureQualifiedToolchain(f.input);
    const updated = {
      ...f.input,
      primaryFiles: f.input.primaryFiles.map((pin) => ({ ...pin, version: "2.0.0" })),
    };
    expect(
      (await captureQualifiedToolchain(updated)).verification.fullInventoryVerifiedDuringBuild,
    ).toBe(true);
    expect(
      (await captureQualifiedToolchain(updated)).verification.fullInventoryVerifiedDuringBuild,
    ).toBe(false);
    await NodeFSP.writeFile(NodePath.join(f.input.root, "dependency.bin"), "changed ancillary");
    expect(
      (await captureQualifiedToolchain(updated)).verification.fullInventoryVerifiedDuringBuild,
    ).toBe(false);
    await expect(
      captureQualifiedToolchain({
        ...updated,
        qualification: { ...updated.qualification, refresh: true },
      }),
    ).rejects.toThrow(/bytes differ/u);
  } finally {
    await f.cleanup();
  }
});

it("requires exact existing qualification for canonical sealing and never silently rescans", async () => {
  const f = await fixture();
  try {
    await expect(
      captureQualifiedToolchain({ ...f.input, expectedQualificationSha256: "a".repeat(64) }),
    ).rejects.toThrow(/absent, stale or changed/u);
    expect(await NodeFSP.readdir(f.base)).toEqual(["tools"]);
    const first = await captureQualifiedToolchain(f.input);
    const approved = first.verification.qualificationSha256!;
    await NodeFSP.unlink(NodePath.join(f.input.root, "dependency.bin"));
    const sealed = await captureQualifiedToolchain({
      ...f.input,
      expectedQualificationSha256: approved,
    });
    expect(sealed.verification.fullInventoryVerifiedDuringBuild).toBe(false);
    await NodeFSP.appendFile(f.input.qualification.path, " ");
    await expect(
      captureQualifiedToolchain({ ...f.input, expectedQualificationSha256: approved }),
    ).rejects.toThrow(/absent, stale or changed/u);
    await expect(first.recheck()).rejects.toThrow(/qualification changed/u);
  } finally {
    await f.cleanup();
  }
});

it("binds the manifest and physical root generation, and refuses linked receipts", async () => {
  const f = await fixture();
  try {
    await captureQualifiedToolchain(f.input);
    const manifest = JSON.parse(f.input.manifestBytes.toString());
    manifest.files = manifest.files.filter(
      (pin: { path: string }) => pin.path !== "dependency.bin",
    );
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await expect(
      captureQualifiedToolchain({
        ...f.input,
        manifestBytes,
        manifestSha256: sha256(manifestBytes),
      }),
    ).rejects.toThrow(/bytes differ/u);
    const moved = NodePath.join(f.base, "old-tools");
    await NodeFSP.rename(f.input.root, moved);
    await NodeFSP.mkdir(f.input.root);
    for (const name of ["node.exe", "dependency.bin"])
      await NodeFSP.copyFile(NodePath.join(moved, name), NodePath.join(f.input.root, name));
    expect(
      (await captureQualifiedToolchain(f.input)).verification.fullInventoryVerifiedDuringBuild,
    ).toBe(true);
    await NodeFSP.rename(f.input.qualification.path, f.input.qualification.path + ".original");
    await NodeFSP.link(f.input.qualification.path + ".original", f.input.qualification.path);
    await expect(captureQualifiedToolchain(f.input)).rejects.toThrow(/linked/u);
  } finally {
    await f.cleanup();
  }
});
