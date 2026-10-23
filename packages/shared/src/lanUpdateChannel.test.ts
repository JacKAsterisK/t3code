// @effect-diagnostics nodeBuiltinImport:off - Synthetic public release metadata and an in-memory HTTP client only.
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  discoverLanUpdateChannel,
  parseLanUpdateChannel,
  type LanUpdateChannel,
} from "./lanUpdateChannel.ts";

const api = "https://api.github.com/repos/JacKAsterisK/t3code";
const releases = "https://github.com/JacKAsterisK/t3code/releases";
const identity = {
  appId: "com.example.lanfixture",
  productName: "LAN Fixture",
  protocolScheme: "lan-fixture",
  homeDirectoryName: "T3CodeLAN" as const,
  telemetry: "disabled" as const,
  cloudConfiguration: "disabled" as const,
  nativeUpdater: "disabled" as const,
  protocolVersion: 2 as const,
  applicationVersion: "0.1.2",
  sourceCommit: "a".repeat(40),
};
function lanUpdateFixture(change?: (channel: LanUpdateChannel) => void) {
  const channel: LanUpdateChannel = {
    schemaVersion: 1,
    repository: "JacKAsterisK/t3code",
    releaseTag: "lan-v1.0.0",
    distributionVersion: "1.0.0",
    applicationVersion: "0.1.3",
    identity: { ...identity, applicationVersion: "0.1.3", sourceCommit: "b".repeat(40) },
    artifact: { name: "T3CodeLAN-1.0.0-windows-x64.zip", sha256: "c".repeat(64), byteLength: 123 },
  };
  change?.(channel);
  const bytes = Buffer.from(JSON.stringify(channel));
  const asset = (id: number, name: string, size: number, digest: string) => ({
    id,
    name,
    size,
    digest,
    browser_download_url: `${releases}/download/lan-v1.0.0/${name}`,
  });
  const release = {
    tag_name: "lan-v1.0.0",
    html_url: `${releases}/tag/lan-v1.0.0`,
    draft: false,
    prerelease: false,
    assets: [
      asset(
        1,
        "t3code-lan-channel.json",
        bytes.length,
        `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
      ),
      asset(
        2,
        channel.artifact.name,
        channel.artifact.byteLength,
        `sha256:${channel.artifact.sha256}`,
      ),
    ],
  };
  const requests: string[] = [];
  const client = (responses: Map<string, () => Response> = new Map()) =>
    HttpClient.make((request) => {
      requests.push(request.url);
      assert.equal(request.method, "GET");
      assert.isUndefined(request.headers.authorization);
      assert.isUndefined(request.headers.cookie);
      const response =
        responses.get(request.url)?.() ??
        (request.url === `${api}/releases/latest`
          ? new Response(JSON.stringify(release))
          : request.url === `${api}/releases/assets/1`
            ? new Response(bytes)
            : undefined);
      if (!response) return Effect.die(`Unexpected metadata request ${request.url}`);
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
  return { identity, channel, bytes, release, requests, client };
}

it.effect(
  "discovers a fork-bound advisory candidate without downloading its ZIP or granting activation",
  () => {
    const fixture = lanUpdateFixture();
    return Effect.gen(function* () {
      const result = yield* discoverLanUpdateChannel(identity);
      assert.equal(result.status, "available");
      assert.equal(result.channel?.distributionVersion, "1.0.0");
      assert.equal(result.releaseUrl, `${releases}/tag/lan-v1.0.0`);
      assert.include(result.message, "Hub must verify");
      assert.deepEqual(fixture.requests, [`${api}/releases/latest`, `${api}/releases/assets/1`]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.client()));
  },
);

it.effect(
  "returns the Hub candidate when source/app match without claiming the installed distribution revision",
  () => {
    const fixture = lanUpdateFixture((channel) => {
      Object.assign(channel, { applicationVersion: identity.applicationVersion, identity });
    });
    return Effect.gen(function* () {
      const result = yield* discoverLanUpdateChannel(identity);
      assert.equal(result.status, "unchanged");
      assert.equal(result.channel?.distributionVersion, "1.0.0");
      assert.equal(result.releaseUrl, `${releases}/tag/lan-v1.0.0`);
      assert.include(result.message, "installed distribution revision is not known");
    }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.client()));
  },
);

it.effect(
  "does not fall back to official releases when latest is missing or a legacy upstream tag",
  () =>
    Effect.gen(function* () {
      for (const response of [
        () => new Response(null, { status: 404 }),
        () => new Response(JSON.stringify({ ...lanUpdateFixture().release, tag_name: "v0.1.2" })),
      ]) {
        const fixture = lanUpdateFixture();
        const result = yield* discoverLanUpdateChannel(identity).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            fixture.client(new Map([[`${api}/releases/latest`, response]])),
          ),
        );
        assert.equal(result.status, "unavailable");
        assert.deepEqual(fixture.requests, [`${api}/releases/latest`]);
      }
    }),
);

it.effect(
  "refuses mismatched distribution identity, ZIP digest metadata and oversized responses",
  () =>
    Effect.gen(function* () {
      const mismatched = lanUpdateFixture((channel) => {
        Object.assign(channel.identity, { appId: "com.other.fixture" });
      });
      const badDigest = lanUpdateFixture();
      badDigest.release.assets[1]!.digest = `sha256:${"d".repeat(64)}`;
      const oversized = lanUpdateFixture();
      for (const client of [
        mismatched.client(),
        badDigest.client(),
        oversized.client(
          new Map([[`${api}/releases/latest`, () => new Response(new Uint8Array(256 * 1024 + 1))]]),
        ),
      ]) {
        const result = yield* Effect.result(
          discoverLanUpdateChannel(identity).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        );
        assert.equal(result._tag, "Failure");
      }
    }),
);

it.effect("refuses external redirects before sending another request", () => {
  const fixture = lanUpdateFixture();
  return Effect.gen(function* () {
    const result = yield* Effect.result(discoverLanUpdateChannel(identity));
    assert.equal(result._tag, "Failure");
    assert.deepEqual(fixture.requests, [`${api}/releases/latest`, `${api}/releases/assets/1`]);
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      fixture.client(
        new Map([
          [
            `${api}/releases/assets/1`,
            () =>
              new Response(null, {
                status: 302,
                headers: { location: "https://unapproved.example.test/channel.json" },
              }),
          ],
        ]),
      ),
    ),
  );
});

it("strictly binds descriptor identity, release tag and bounded portable ZIP metadata", () => {
  const fixture = lanUpdateFixture();
  assert.isTrue(Object.isFrozen(parseLanUpdateChannel(fixture.channel, identity)));
  for (const value of [
    { ...fixture.channel, releaseTag: "v1.0.0" },
    { ...fixture.channel, applicationVersion: "1.2.3" },
    { ...fixture.channel, unexpected: true },
    { ...fixture.channel, artifact: { ...fixture.channel.artifact, name: "../elsewhere.zip" } },
  ])
    assert.throws(() => parseLanUpdateChannel(value, identity));
});
