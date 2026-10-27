// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Local filesystem qualification receipts own their administrative timestamp.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { sha256 } from "./hub-distribution.ts";
import { parseToolchainManifest, relativeWindowsPath, strictJson } from "./windows-artifact.ts";
import {
  assertValidationRoot,
  inspectValidationTree,
  readValidationFile,
} from "./validate-windows-artifact.ts";
import { buildInventoryCounts, measureBuildStage } from "./build-metrics.ts";

export const NativeToolchainQualificationRequest = Schema.Struct({
  path: Schema.String,
  refresh: Schema.optionalKey(Schema.Boolean),
});
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Qualification = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("local-native-toolchain-qualification"),
  root: Schema.String,
  rootIdentity: Hash,
  manifestSha256: Hash,
  primaryPinsSha256: Hash,
  fileCount: Schema.Int,
  byteLength: Schema.Int,
  qualifiedAt: Schema.String,
});
const decode = Schema.decodeUnknownSync(Qualification, { onExcessProperty: "error" });
const contains = (root: string, file: string) => {
  const relative = NodePath.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};

export async function captureQualifiedToolchain(input: {
  readonly root: string;
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly primaryFiles: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly version: string;
  }>;
  readonly qualification?: { readonly path: string; readonly refresh?: boolean };
  readonly expectedQualificationSha256?: string;
}) {
  if (sha256(input.manifestBytes) !== input.manifestSha256)
    throw new Error("Toolchain manifest changed.");
  await assertValidationRoot(input.root);
  const inventory = parseToolchainManifest(input.manifestBytes);
  const files = new Map(
    inventory.files.map((pin) => [
      pin.path,
      { length: pin.length, sha256: pin.sha256, bytes: new Uint8Array() },
    ]),
  );
  if (
    files.size !== inventory.files.length ||
    new Set(inventory.files.map((pin) => pin.path.toLowerCase())).size !== files.size
  )
    throw new Error("Toolchain inventory has duplicate files.");
  for (const pin of inventory.files) relativeWindowsPath(pin.path);
  const counts = buildInventoryCounts(files.values());
  const rootIdentity = async () => {
    await assertValidationRoot(input.root);
    const stat = await NodeFSP.lstat(input.root, { bigint: true });
    return sha256(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
  };
  const binding = {
    schemaVersion: 1 as const,
    kind: "local-native-toolchain-qualification" as const,
    root: NodePath.resolve(input.root),
    rootIdentity: await rootIdentity(),
    manifestSha256: input.manifestSha256,
    primaryPinsSha256: sha256(
      JSON.stringify(input.primaryFiles.toSorted((a, b) => a.path.localeCompare(b.path))),
    ),
    fileCount: files.size,
    byteLength: counts.bytes,
  };
  const primaryPins = input.primaryFiles.map((tool) => {
    const name = relativeWindowsPath(tool.path),
      pin = files.get(name);
    if (
      !pin ||
      pin.sha256 !== tool.sha256 ||
      !/^\d+\.\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?$/iu.test(tool.version)
    )
      throw new Error("Primary tool differs from its qualified inventory.");
    return { name, pin };
  });
  const primaryCounts = buildInventoryCounts(primaryPins.map(({ pin }) => pin));
  const verifyPrimary = async () => {
    if ((await rootIdentity()) !== binding.rootIdentity)
      throw new Error("Qualified toolchain root changed.");
    for (const { name, pin } of primaryPins) {
      const bytes = await readValidationFile(NodePath.join(input.root, name), 256 * 1024 ** 2);
      if (bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
        throw new Error("A qualified primary tool changed; restore it or refresh qualification.");
    }
  };
  let qualificationBytes: Uint8Array | undefined;
  let fullInventoryVerifiedDuringBuild = false;
  let previousQualification = false;
  if (input.qualification !== undefined && !NodePath.isAbsolute(input.qualification.path))
    throw new Error("Qualification requires an absolute local receipt path.");
  const qualification =
    input.qualification === undefined
      ? undefined
      : {
          ...input.qualification,
          path: NodePath.resolve(input.qualification.path),
        };
  if (qualification !== undefined) {
    if (!NodePath.isAbsolute(qualification.path) || contains(input.root, qualification.path))
      throw new Error("Qualification must be an absolute local receipt outside the toolchain.");
    await assertValidationRoot(NodePath.dirname(qualification.path));
    try {
      const bytes = await readValidationFile(qualification.path, 16 * 1024);
      const previous = decode(strictJson(bytes));
      previousQualification = true;
      if (
        !qualification.refresh &&
        Object.entries(binding).every(
          ([name, value]) => previous[name as keyof typeof previous] === value,
        )
      )
        qualificationBytes = bytes;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (
    input.expectedQualificationSha256 !== undefined &&
    (qualificationBytes === undefined ||
      sha256(qualificationBytes) !== input.expectedQualificationSha256)
  )
    throw new Error("The approved toolchain qualification is absent, stale or changed.");
  if (qualificationBytes === undefined) {
    if (qualification !== undefined && previousQualification)
      await NodeFSP.unlink(qualification.path);
    const actual = await measureBuildStage(
      "preparation.toolchain-scan",
      () => inspectValidationTree(input.root, true),
      (found) => buildInventoryCounts(found.values()),
    );
    if (
      actual.size !== files.size ||
      [...files].some(
        ([name, pin]) =>
          actual.get(name)?.length !== pin.length || actual.get(name)?.sha256 !== pin.sha256,
      )
    )
      throw new Error("Toolchain bytes differ from the qualification manifest.");
    fullInventoryVerifiedDuringBuild = true;
    if (qualification !== undefined) {
      if ((await rootIdentity()) !== binding.rootIdentity)
        throw new Error("Toolchain root changed during qualification.");
      qualificationBytes = Buffer.from(
        JSON.stringify({ ...binding, qualifiedAt: new Date().toISOString() }, null, 2) + "\n",
      );
      const temp = `${qualification.path}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temp, qualificationBytes, { flag: "wx", mode: 0o600 });
        await NodeFSP.rename(temp, qualification.path);
      } finally {
        await NodeFSP.rm(temp, { force: true });
      }
    }
  } else
    await measureBuildStage(
      "preparation.toolchain-primary-pins",
      verifyPrimary,
      () => primaryCounts,
    );
  const qualificationSha256 = qualificationBytes === undefined ? null : sha256(qualificationBytes);
  const recheck = async () => {
    if (qualification !== undefined) {
      const bytes = await readValidationFile(qualification.path, 16 * 1024);
      if (sha256(bytes) !== qualificationSha256)
        throw new Error("Toolchain qualification changed during the build.");
    }
    await verifyPrimary();
  };
  return {
    files,
    qualificationBytes,
    verification: {
      mode:
        qualification === undefined
          ? ("full-inventory" as const)
          : ("qualified-primary-pins" as const),
      fullInventoryVerifiedDuringBuild,
      primaryFileCount: primaryPins.length,
      qualificationSha256,
    },
    recheck,
  };
}
