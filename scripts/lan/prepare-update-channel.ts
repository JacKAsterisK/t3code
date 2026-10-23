// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Creates public fork discovery metadata only after local artifact validation; never publishes or installs.
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { LAN_UPDATE_REPOSITORY } from "@t3tools/shared/distribution";
import { FORK_UPDATE_CHANNEL_ASSET, parseLanUpdateChannel } from "@t3tools/shared/lanUpdateChannel";
import { sha256 } from "./hub-distribution.ts";
import { readPortableZip, strictJson, type validateWindowsArtifact } from "./windows-artifact.ts";
import {
  readValidationFile,
  validateRequest,
  WindowsValidationRequest,
} from "./validate-windows-artifact.ts";
import { writeNewValidatedArtifacts } from "./seal-windows-payload.ts";

const decodeRequest = Schema.decodeUnknownSync(WindowsValidationRequest);
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    version: Schema.String,
    desktopVersion: Schema.String,
    backendVersion: Schema.String,
    platform: Schema.Literal("Win64"),
    architecture: Schema.Literal("x64"),
    appId: Schema.String,
    productName: Schema.String,
    protocolScheme: Schema.String,
    homeDirectoryName: Schema.Literal("T3CodeLAN"),
    telemetry: Schema.Literal("disabled"),
    cloudConfiguration: Schema.Literal("disabled"),
    nativeUpdater: Schema.Literal("disabled"),
    protocolVersion: Schema.Literal(2),
    sourceCommit: Schema.String,
    upstreamCommit: Schema.String,
    sourceDirty: Schema.Literal(false),
    buildLockSha256: Schema.String,
  }),
);

export function createForkUpdateChannel(input: {
  readonly artifact: Uint8Array;
  readonly artifactName: string;
  readonly validation: Awaited<ReturnType<typeof validateWindowsArtifact>>;
}) {
  const digest = sha256(input.artifact);
  if (
    input.validation.passed !== true ||
    input.validation.byteReproducibilityVerified !== true ||
    input.validation.reviewedCompiledBindingsVerified !== true ||
    input.validation.runs.length !== 2 ||
    input.validation.runs.some((run) => run.artifactSha256 !== digest)
  )
    throw new Error(
      "Fork channel requires the exact artifact accepted by both local validation runs.",
    );
  const bytes = readPortableZip(input.artifact).get("t3code-lan-package.json");
  if (!bytes) throw new Error("The validated artifact has no LAN package manifest.");
  const manifest = decodeManifest(strictJson(bytes));
  if (
    manifest.desktopVersion !== manifest.backendVersion ||
    manifest.buildLockSha256 !== input.validation.approvedBuildLockSha256
  )
    throw new Error("The channel manifest differs from the validated build binding.");
  return parseLanUpdateChannel({
    schemaVersion: 1,
    repository: LAN_UPDATE_REPOSITORY,
    releaseTag: `lan-v${manifest.version}`,
    distributionVersion: manifest.version,
    applicationVersion: manifest.desktopVersion,
    identity: {
      appId: manifest.appId,
      productName: manifest.productName,
      protocolScheme: manifest.protocolScheme,
      homeDirectoryName: manifest.homeDirectoryName,
      telemetry: manifest.telemetry,
      cloudConfiguration: manifest.cloudConfiguration,
      nativeUpdater: manifest.nativeUpdater,
      protocolVersion: manifest.protocolVersion,
      applicationVersion: manifest.desktopVersion,
      sourceCommit: manifest.sourceCommit,
    },
    artifact: { name: input.artifactName, sha256: digest, byteLength: input.artifact.length },
  });
}

export function createHubDelivery(input: Parameters<typeof createForkUpdateChannel>[0]) {
  const channel = createForkUpdateChannel(input);
  const manifestBytes = readPortableZip(input.artifact).get("t3code-lan-package.json")!;
  const manifest = decodeManifest(strictJson(manifestBytes));
  const nativeTrust = input.validation.nativeTrust;
  if (nativeTrust !== "authenticode" && nativeTrust !== "portal-pinned")
    throw new Error("Hub delivery requires an explicit validated native trust mode.");
  const nativeSigners =
    nativeTrust === "portal-pinned"
      ? []
      : input.validation.runs[0]!.native.map((native) => {
          if (native.trustStatus !== 0 || native.certificateSha256 === null)
            throw new Error("Hub signer policy requires trusted native signature evidence.");
          return { path: native.path, certificateSha256: [native.certificateSha256] };
        });
  const activationPolicy = {
    schemaVersion: 1,
    approvedArtifactIds: [channel.artifact.sha256],
    appId: manifest.appId,
    productName: manifest.productName,
    protocolScheme: manifest.protocolScheme,
    homeDirectoryName: manifest.homeDirectoryName,
    telemetry: manifest.telemetry,
    cloudConfiguration: manifest.cloudConfiguration,
    nativeUpdater: manifest.nativeUpdater,
    nativeTrust,
    nativeSigners,
  };
  const policyBytes = Buffer.from(`${JSON.stringify(activationPolicy, null, 2)}\n`);
  if (policyBytes.length > 64 * 1024)
    throw new Error("Hub activation policy exceeds its size limit.");
  return {
    activationPolicy,
    policyBytes,
    metadata: {
      schemaVersion: 1,
      channel: "stable",
      artifactId: channel.artifact.sha256,
      packageId: `t3code-lan-${manifest.version}`,
      version: manifest.version,
      platform: "Win64",
      byteLength: input.artifact.length,
      sha256: channel.artifact.sha256,
      sourceCommit: manifest.sourceCommit,
      upstreamCommit: manifest.upstreamCommit,
      manifestSha256: sha256(manifestBytes),
      protocolVersion: 2,
      downloadPath: `/api/tools/t3code-lan/artifacts/${channel.artifact.sha256}/download`,
      activationPolicySha256: sha256(policyBytes),
    },
  };
}

export async function prepareForkUpdateChannel(
  requestPath: string,
  approvedPolicySha256: string,
  outputDirectory: string,
) {
  const requestBytes = await readValidationFile(requestPath, 1024 ** 2);
  const request = decodeRequest(strictJson(requestBytes), { onExcessProperty: "error" });
  const validation = await validateRequest(requestPath, approvedPolicySha256, { requestBytes });
  const artifactPath = request.runs[0].artifactPath;
  const artifact = await readValidationFile(artifactPath, 512 * 1024 ** 2);
  const input = {
    artifact,
    artifactName: NodePath.basename(artifactPath),
    validation,
  };
  const channel = createForkUpdateChannel(input);
  const delivery = createHubDelivery(input);
  const outputPath = NodePath.join(outputDirectory, FORK_UPDATE_CHANNEL_ASSET);
  const metadataPath = NodePath.join(outputDirectory, "t3code-lan-portal-metadata.json");
  const activationPolicyPath = NodePath.join(outputDirectory, "t3code-lan-activation-policy.json");
  const bytes = Buffer.from(`${JSON.stringify(channel, null, 2)}\n`);
  await writeNewValidatedArtifacts([
    { path: outputPath, bytes },
    { path: metadataPath, bytes: Buffer.from(`${JSON.stringify(delivery.metadata, null, 2)}\n`) },
    { path: activationPolicyPath, bytes: delivery.policyBytes },
  ]);
  return {
    schemaVersion: 1,
    outputPath,
    metadataPath,
    activationPolicyPath,
    nativeTrust: delivery.activationPolicy.nativeTrust,
    sha256: sha256(bytes),
    repository: channel.repository,
    releaseTag: channel.releaseTag,
    artifactSha256: channel.artifact.sha256,
    publicationAuthorized: false,
    activationAuthorized: false,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--request" ||
    args[2] !== "--approved-policy-sha256" ||
    args[4] !== "--output-directory" ||
    !args[1] ||
    !args[3] ||
    !args[5]
  )
    throw new Error(
      "Supply --request ABSOLUTE_VALIDATION_JSON --approved-policy-sha256 REVIEWED_SHA256 --output-directory ABSOLUTE_DIRECTORY.",
    );
  console.log(JSON.stringify(await prepareForkUpdateChannel(args[1], args[3], args[5]), null, 2));
}
