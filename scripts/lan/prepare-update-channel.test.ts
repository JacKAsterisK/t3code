import { describe, expect, it } from "vite-plus/test";
import { createForkUpdateChannel, createHubDelivery } from "./prepare-update-channel.ts";
import { fixture } from "./windows-artifact.fixtures.ts";
import { validateWindowsArtifact } from "./windows-artifact.ts";
import { sha256 } from "./hub-distribution.ts";

async function accepted() {
  const input = fixture();
  return {
    artifact: input.runs[0].artifact,
    artifactName: "t3code-lan-1.0.0-windows-x64.zip",
    validation: await validateWindowsArtifact(input),
  };
}

describe("fork update channel preparation", () => {
  it("binds a separately delivered activation policy to the exact Portal artifact", async () => {
    const input = await accepted();
    const result = createHubDelivery(input);
    expect(result.metadata.activationPolicySha256).toBe(sha256(result.policyBytes));
    expect(result.metadata.artifactId).toBe(sha256(input.artifact));
    expect(result.activationPolicy.approvedArtifactIds).toEqual([result.metadata.artifactId]);
    expect(result.activationPolicy.nativeTrust).toBe("authenticode");
    expect(result.activationPolicy.nativeSigners).toHaveLength(3);
    expect(result.metadata.downloadPath).toBe(
      `/api/tools/t3code-lan/artifacts/${result.metadata.artifactId}/download`,
    );
    input.validation.runs[0]!.native[0]!.trustStatus = -1;
    expect(() => createHubDelivery(input)).toThrow(/trusted native signature/u);
  });

  it("retains explicitly validated Portal-pinned trust without manufacturing signer pins", async () => {
    const input = fixture();
    const validation = await validateWindowsArtifact({
      ...input,
      policy: { ...input.policy, nativeTrust: "portal-pinned", certificateSha256: [] },
    });
    const result = createHubDelivery({
      artifact: input.runs[0].artifact,
      artifactName: "t3code-lan-1.0.0-windows-x64.zip",
      validation,
    });
    expect(result.activationPolicy.nativeTrust).toBe("portal-pinned");
    expect(result.activationPolicy.nativeSigners).toEqual([]);
    expect(JSON.parse(result.policyBytes.toString()).nativeTrust).toBe("portal-pinned");
  });
  it("binds fork metadata to the verified archive, native identity and independent distribution version", async () => {
    const input = await accepted();
    expect(createForkUpdateChannel(input)).toMatchObject({
      repository: "JacKAsterisK/t3code",
      releaseTag: "lan-v1.0.0",
      distributionVersion: "1.0.0",
      applicationVersion: "0.1.2",
      identity: {
        sourceCommit: "a".repeat(40),
        nativeUpdater: "disabled",
        homeDirectoryName: "T3CodeLAN",
      },
      artifact: {
        name: input.artifactName,
        sha256: sha256(input.artifact),
        byteLength: input.artifact.length,
      },
    });
  });

  it("rejects an archive replaced after validation", async () => {
    const input = await accepted();
    input.artifact = Buffer.from("different artifact");
    expect(() => createForkUpdateChannel(input)).toThrow(/exact artifact/u);
  });

  it("requires both runs to bind the same archive", async () => {
    const input = await accepted();
    input.validation.runs[1]!.artifactSha256 = "0".repeat(64);
    expect(() => createForkUpdateChannel(input)).toThrow(/both local validation/u);
  });

  it("rejects a substituted build-lock receipt", async () => {
    const input = await accepted();
    input.validation.approvedBuildLockSha256 = "0".repeat(64);
    expect(() => createForkUpdateChannel(input)).toThrow(/build binding/u);
  });

  it.each(["../upstream.zip", "https://example.test/package.zip", "installer.exe"])(
    "rejects an invalid release asset name: %s",
    async (artifactName) => {
      const input = await accepted();
      expect(() => createForkUpdateChannel({ ...input, artifactName })).toThrow();
    },
  );
});
