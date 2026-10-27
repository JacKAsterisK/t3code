// @effect-diagnostics nodeBuiltinImport:off - Only the approved private build cache is read and seeded.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { sha256 } from "./hub-distribution.ts";
import { assertValidationRoot, readValidationFile } from "./validate-windows-artifact.ts";

function electronCacheArtifact(version: string) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version))
    throw new Error("An exact Electron version is required for the approved cache.");
  const name = `electron-v${version}-win32-x64.zip`;
  return {
    name,
    relativePath: `${sha256(`https://github.com/electron/electron/releases/download/v${version}`)}/${name}`,
    checksumName: `SHASUMS256.txt-${version}`,
  };
}

export async function preparePinnedElectronCache(
  root: string,
  pins: ReadonlyMap<string, { readonly length: number; readonly sha256: string }>,
  version: string,
) {
  await assertValidationRoot(root);
  const artifact = electronCacheArtifact(version),
    pin = pins.get(artifact.relativePath);
  if (!pin || pin.length <= 0 || !/^[a-f0-9]{64}$/u.test(pin.sha256))
    throw new Error("The requested Electron archive is absent from the approved cache.");
  const archive = await readValidationFile(
    NodePath.join(root, artifact.relativePath),
    256 * 1024 ** 2,
  );
  if (archive.length !== pin.length || sha256(archive) !== pin.sha256)
    throw new Error("The private Electron archive differs from its approved hash.");
  // The ZIP hash is already approved; inline checksums prevent @electron/get's forced network SHASUMS request.
  const checksums = Buffer.from(`${pin.sha256} *${artifact.name}\n`),
    file = NodePath.join(root, artifact.checksumName);
  try {
    await NodeFSP.writeFile(file, checksums, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const actual = await readValidationFile(file, 1024 * 1024);
  if (actual.length !== checksums.length || sha256(actual) !== sha256(checksums))
    throw new Error("The private Electron checksum seed differs from its approved archive.");
  return {
    files: 2,
    bytes: archive.length + actual.length,
    archiveSha256: pin.sha256,
    checksumSha256: sha256(actual),
  };
}
