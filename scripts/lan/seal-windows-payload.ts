// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Offline sealing of supplied trees/evidence; no build, install, signature creation or publication.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import {
  crc32,
  relativeWindowsPath,
  strictJson,
  WindowsArtifactPolicy,
  type WindowsArtifactPolicy as ArtifactPolicy,
} from "./windows-artifact.ts";
import {
  assertValidationRoot,
  readValidationFile,
  validateRequest,
  WindowsValidationRequest,
} from "./validate-windows-artifact.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const decodeBuildLock = Schema.decodeUnknownSync(BuildLock);
const decodePolicy = Schema.decodeUnknownSync(WindowsArtifactPolicy);
const decodeValidationRequest = Schema.decodeUnknownSync(WindowsValidationRequest);
const SealRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  validationRequestPath: Schema.String,
  testReceiptPath: Schema.String,
  runtimePolicyEvidencePath: Schema.String,
  builtUtc: Schema.String,
  executablePath: Schema.String,
});
const decodeSealRequest = Schema.decodeUnknownSync(SealRequest);

const outputPort = {
  assertRoot: assertValidationRoot,
  stat: (path: string) => NodeFSP.lstat(path),
  create: (path: string) => NodeFSP.open(path, "wx", 0o600),
  read: readValidationFile,
  remove: (path: string) => NodeFSP.unlink(path),
};

export async function writeNewValidatedArtifacts(
  outputs: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
  port: typeof outputPort = outputPort,
) {
  const created: Array<{ path: string; dev: number; ino: number }> = [];
  const parents = async (path: string) => {
    const result: Array<{ path: string; dev: number; ino: number }> = [];
    let current = NodePath.dirname(path);
    await port.assertRoot(current);
    for (;;) {
      const stat = await port.stat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Sealing output parent is unsafe.");
      result.push({ path: current, dev: stat.dev, ino: stat.ino });
      const next = NodePath.dirname(current);
      if (next === current) return result;
      current = next;
    }
  };
  try {
    for (const output of outputs) {
      const directories = await parents(output.path);
      const handle = await port.create(output.path);
      const identity = await handle.stat();
      created.push({ path: output.path, dev: identity.dev, ino: identity.ino });
      try {
        if (!identity.isFile() || identity.nlink !== 1)
          throw new Error("New sealing output is not an exclusive regular file.");
        await handle.writeFile(output.bytes);
        await handle.sync();
        const written = await handle.stat();
        if (
          written.dev !== identity.dev ||
          written.ino !== identity.ino ||
          written.nlink !== 1 ||
          written.size !== output.bytes.length
        )
          throw new Error("Sealing output changed while writing.");
      } finally {
        await handle.close();
      }
      // Validate the path that will be handed to the owner, including its parent
      // chain, rather than reporting only the bytes written through our handle.
      const bytes = await port.read(output.path, 512 * 1024 ** 2);
      const current = await port.stat(output.path);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.size !== output.bytes.length ||
        sha256(bytes) !== sha256(output.bytes)
      )
        throw new Error("Sealed output differs from its validated bytes or file identity.");
      const after = await parents(output.path);
      if (
        after.length !== directories.length ||
        after.some(
          (directory, index) =>
            directory.path !== directories[index]?.path ||
            directory.dev !== directories[index]?.dev ||
            directory.ino !== directories[index]?.ino,
        )
      )
        throw new Error("Sealing output parent changed.");
    }
  } catch (error) {
    for (const file of created) {
      const current = await port.stat(file.path);
      if (current.dev !== file.dev || current.ino !== file.ino)
        throw new Error("Failed sealing output changed; owner recovery is required.", {
          cause: error,
        });
      await port.remove(file.path);
    }
    throw error;
  }
  return created.length;
}

export function deterministicPortableZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  if (files.size < 3 || files.size > 20001) throw new Error("Portable ZIP file count is invalid.");
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : 1,
  )) {
    relativeWindowsPath(path);
    const name = Buffer.from(path),
      header = Buffer.alloc(30),
      directory = Buffer.alloc(46),
      crc = crc32(bytes);
    if (bytes.length > 256 * 1024 ** 2) throw new Error("Portable ZIP entry exceeds bounds.");
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, Buffer.from(bytes));
    central.push(directory, name);
    offset += 30 + name.length + bytes.length;
    if (offset > 512 * 1024 ** 2)
      throw new Error("Portable ZIP exceeds the validator's local bound.");
  }
  const end = Buffer.alloc(22),
    directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, directory, end]);
  if (result.length > 512 * 1024 ** 2)
    throw new Error("Portable ZIP exceeds the validator's local bound.");
  return result;
}

export function materializeWindowsCandidate(input: {
  readonly payload: ReadonlyMap<string, Uint8Array>;
  readonly policy: ArtifactPolicy;
  readonly buildLockBytes: Uint8Array;
  readonly testReceiptBytes: Uint8Array;
  readonly runtimeEvidenceBytes: Uint8Array;
  readonly builtUtc: string;
  readonly executablePath: string;
}) {
  const lock = decodeBuildLock(strictJson(input.buildLockBytes), { onExcessProperty: "error" });
  if (
    sha256(input.buildLockBytes) !== input.policy.buildLockSha256 ||
    sha256(input.runtimeEvidenceBytes) !== input.policy.runtimePolicyEvidenceSha256
  )
    throw new Error(
      "Sealing requires the exact approved build lock and runtime enforcement evidence.",
    );
  relativeWindowsPath(input.executablePath);
  if (!input.payload.has(input.executablePath))
    throw new Error("Sealing executable is absent from supplied payload.");
  const files = new Map(input.payload);
  for (const name of files.keys())
    if (
      /^t3code-lan-(?:package|install|build-lock|test-receipt|runtime-policy-evidence)\.json$/iu.test(
        name,
      )
    )
      throw new Error("Supplied raw payload already contains reserved sealing evidence.");
  files.set("t3code-lan-build-lock.json", input.buildLockBytes);
  files.set("t3code-lan-test-receipt.json", input.testReceiptBytes);
  files.set("t3code-lan-runtime-policy-evidence.json", input.runtimeEvidenceBytes);
  const manifest = {
    schemaVersion: 1,
    packageId: `t3code-lan-${lock.distributionVersion}`,
    version: lock.distributionVersion,
    platform: "Win64",
    architecture: "x64",
    desktopVersion: lock.applicationVersion,
    backendVersion: lock.applicationVersion,
    protocolVersion: 2,
    sourceCommit: lock.forkCommit,
    upstreamCommit: lock.upstreamCommit,
    sourceDirty: false,
    builtUtc: input.builtUtc,
    buildLockSha256: sha256(input.buildLockBytes),
    testReceiptSha256: sha256(input.testReceiptBytes),
    ...input.policy.identity,
    executablePath: input.executablePath,
    files: [...files]
      .sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
      .map(([path, bytes]) => ({ path, length: bytes.length, sha256: sha256(bytes) })),
  };
  files.set("t3code-lan-package.json", encode(manifest));
  return {
    artifact: deterministicPortableZip(files),
    extractedFiles: files,
    manifest,
    validationRequired: true as const,
  };
}

export async function sealWindowsPayloads(requestPath: string, approvedPolicySha256: string) {
  const seal = decodeSealRequest(strictJson(await readValidationFile(requestPath, 1024 * 1024)), {
    onExcessProperty: "error",
  });
  const requestBytes = await readValidationFile(seal.validationRequestPath, 1024 * 1024);
  const validation = decodeValidationRequest(strictJson(requestBytes), {
    onExcessProperty: "error",
  });
  const policyBytes = await readValidationFile(validation.policyPath, 1024 * 1024);
  if (sha256(policyBytes) !== approvedPolicySha256)
    throw new Error("Sealing policy differs from separately approved bytes.");
  const policy = decodePolicy(strictJson(policyBytes), { onExcessProperty: "error" });
  const buildLockBytes = await readValidationFile(validation.buildLockPath, 1024 * 1024),
    testReceiptBytes = await readValidationFile(seal.testReceiptPath, 1024 * 1024),
    runtimeEvidenceBytes = await readValidationFile(seal.runtimePolicyEvidencePath, 1024 * 1024);
  const candidates = new Map<string, ReturnType<typeof materializeWindowsCandidate>>();
  for (const run of validation.runs) {
    if (!NodePath.isAbsolute(run.artifactPath) || !run.artifactPath.endsWith(".zip"))
      throw new Error("Sealed outputs require explicit absolute new ZIP paths.");
    relativeWindowsPath(NodePath.basename(run.artifactPath));
    await assertValidationRoot(NodePath.dirname(run.artifactPath));
    try {
      await NodeFSP.lstat(run.artifactPath);
      throw new Error("Sealing never overwrites an existing output.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const report = await validateRequest(seal.validationRequestPath, approvedPolicySha256, {
    requestBytes,
    artifactForRun: async (run, payload) => {
      const candidate = materializeWindowsCandidate({
        payload,
        policy,
        buildLockBytes,
        testReceiptBytes,
        runtimeEvidenceBytes,
        builtUtc: seal.builtUtc,
        executablePath: seal.executablePath,
      });
      candidates.set(run.sourceId, candidate);
      return candidate;
    },
  });
  const outputsCreated = await writeNewValidatedArtifacts(
    validation.runs.map((run) => {
      const candidate = candidates.get(run.sourceId);
      if (!candidate) throw new Error("Sealing lost its validated build binding.");
      return { path: run.artifactPath, bytes: candidate.artifact };
    }),
  );
  return {
    ...report,
    outputsCreated,
    release: false,
    publicationAuthorized: false,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--request" ||
    args[2] !== "--approved-policy-sha256" ||
    !args[1] ||
    !args[3]
  )
    throw new Error(
      "Supply --request ABSOLUTE_SEAL_REQUEST --approved-policy-sha256 APPROVED_SHA256; no evidence is generated.",
    );
  console.log(JSON.stringify(await sealWindowsPayloads(args[1], args[3]), null, 2));
}
