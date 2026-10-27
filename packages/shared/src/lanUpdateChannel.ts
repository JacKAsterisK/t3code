import { NativeActivationBuildIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  LAN_PORTABLE_ZIP_MAX_BYTES,
  LAN_UPDATE_REPOSITORY,
  parseLanBuildIdentity,
} from "./distribution.ts";
import { strictJson } from "./strictJson.ts";

export const FORK_UPDATE_CHANNEL_ASSET = "t3code-lan-channel.json";
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const LanUpdateChannel = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repository: Schema.Literal("JacKAsterisK/t3code"),
  releaseTag: Schema.String,
  distributionVersion: Version,
  applicationVersion: Version,
  identity: NativeActivationBuildIdentity,
  artifact: Schema.Struct({ name: Schema.String, sha256: Hash, byteLength: Schema.Int }),
});
export type LanUpdateChannel = typeof LanUpdateChannel.Type;
const decodeChannel = Schema.decodeUnknownSync(LanUpdateChannel, { onExcessProperty: "error" });
const Asset = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  size: Schema.Int,
  browser_download_url: Schema.String,
  digest: Schema.optional(Schema.NullOr(Schema.String)),
});
const Release = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(Asset),
});
const decodeRelease = Schema.decodeUnknownSync(Release);

export function parseLanUpdateChannel(
  value: unknown,
  expectedIdentity?: NativeActivationBuildIdentity,
): Readonly<LanUpdateChannel> {
  const channel = decodeChannel(value),
    identity = parseLanBuildIdentity(channel.identity);
  if (
    channel.releaseTag !== `lan-v${channel.distributionVersion}` ||
    channel.applicationVersion !== identity.applicationVersion ||
    channel.artifact.byteLength <= 0 ||
    channel.artifact.byteLength > LAN_PORTABLE_ZIP_MAX_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.zip$/u.test(channel.artifact.name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(channel.artifact.name)
  )
    throw new Error("Invalid fork update channel binding.");
  if (
    expectedIdentity &&
    [
      "appId",
      "productName",
      "protocolScheme",
      "homeDirectoryName",
      "telemetry",
      "cloudConfiguration",
      "nativeUpdater",
      "protocolVersion",
    ].some(
      (key) =>
        identity[key as keyof NativeActivationBuildIdentity] !==
        expectedIdentity[key as keyof NativeActivationBuildIdentity],
    )
  )
    throw new Error("Fork update belongs to a different distribution identity.");
  return Object.freeze({ ...channel, identity, artifact: Object.freeze({ ...channel.artifact }) });
}

export class LanUpdateDiscoveryError extends Schema.TaggedError<LanUpdateDiscoveryError>()(
  "LanUpdateDiscoveryError",
  { message: Schema.String },
) {}
export interface LanUpdateDiscovery {
  readonly status: "available" | "unchanged" | "unavailable";
  readonly channel: Readonly<LanUpdateChannel> | null;
  readonly releaseUrl: string | null;
  readonly message: string;
}
const unavailable = (message: string): LanUpdateDiscovery => ({
  status: "unavailable",
  channel: null,
  releaseUrl: null,
  message,
});
const fail = (message: string) => new LanUpdateDiscoveryError({ message });
const releaseRoot = `https://github.com/${LAN_UPDATE_REPOSITORY}/releases`;
const apiRoot = `https://api.github.com/repos/${LAN_UPDATE_REPOSITORY}`;

export const discoverLanUpdateChannel = Effect.fn("LanUpdateChannel.discover")(
  function* (expectedIdentity: NativeActivationBuildIdentity) {
    const client = yield* HttpClient.HttpClient;
    const read = Effect.fn("LanUpdateChannel.readMetadata")(function* (
      url: string,
      maximum: number,
      assetContent = false,
    ) {
      let current = url;
      for (let redirects = 0; redirects <= 2; redirects++) {
        const response = yield* client
          .get(current, {
            headers: {
              Accept: assetContent ? "application/octet-stream" : "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "T3CodeLAN-update-check",
            },
          })
          .pipe(Effect.mapError(() => fail("The fork update metadata request failed.")));
        if (response.status === 404) return null;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!assetContent || redirects === 2)
            return yield* fail("Fork metadata redirected unexpectedly.");
          const next = yield* Effect.try({
            try: () => new URL(response.headers.location ?? "", current),
            catch: () => fail("Fork metadata redirect is invalid."),
          });
          if (
            next.protocol !== "https:" ||
            next.hostname !== "release-assets.githubusercontent.com" ||
            next.port ||
            next.username ||
            next.password ||
            next.hash
          )
            return yield* fail("Fork metadata redirected outside the approved public asset host.");
          current = next.href;
          continue;
        }
        if (response.status !== 200) return yield* fail("The fork update metadata is unavailable.");
        const length = response.headers["content-length"];
        if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum))
          return yield* fail("Fork metadata exceeds its size bound.");
        const body = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ parts: [] as Uint8Array[], size: 0 }),
            (state, chunk) => {
              const size = state.size + chunk.length;
              if (size > maximum) return Effect.fail(fail("Fork metadata exceeds its size bound."));
              state.parts.push(chunk);
              state.size = size;
              return Effect.succeed(state);
            },
          ),
          Effect.mapError(() => fail("Fork metadata is unreadable or exceeds its size bound.")),
        );
        const bytes = new Uint8Array(body.size);
        let offset = 0;
        for (const part of body.parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        return bytes;
      }
      return yield* fail("Fork metadata redirect limit exceeded.");
    });
    const releaseBytes = yield* read(`${apiRoot}/releases/latest`, 256 * 1024);
    if (releaseBytes === null) return unavailable("No published LAN fork update is available.");
    const release = yield* Effect.try({
      try: () => decodeRelease(strictJson(releaseBytes)),
      catch: () => fail("The fork release metadata is invalid."),
    });
    if (
      release.draft ||
      release.prerelease ||
      release.assets.length > 100 ||
      !/^lan-v\d+\.\d+\.\d+$/u.test(release.tag_name)
    )
      return unavailable("The latest fork release is not a published LAN channel release.");
    const releaseUrl = `${releaseRoot}/tag/${encodeURIComponent(release.tag_name)}`;
    if (release.html_url !== releaseUrl)
      return yield* fail("The release URL does not belong to the pinned fork channel.");
    const names = release.assets.map((asset) => asset.name.toLowerCase());
    if (new Set(names).size !== names.length)
      return yield* fail("Fork release asset names are ambiguous.");
    const descriptor = release.assets.find((asset) => asset.name === FORK_UPDATE_CHANNEL_ASSET);
    if (!descriptor)
      return unavailable(
        "The fork release has no verified LAN channel descriptor. Use Reprint Hub to inspect it.",
      );
    if (
      descriptor.id <= 0 ||
      descriptor.size <= 0 ||
      descriptor.size > 65536 ||
      descriptor.browser_download_url !==
        `${releaseRoot}/download/${encodeURIComponent(release.tag_name)}/${FORK_UPDATE_CHANNEL_ASSET}`
    )
      return yield* fail("The fork channel asset metadata is invalid.");
    const channelBytes = yield* read(`${apiRoot}/releases/assets/${descriptor.id}`, 65536, true);
    if (!channelBytes || channelBytes.length !== descriptor.size)
      return yield* fail("The fork channel descriptor length differs from its release asset.");
    const channelDigest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", new Uint8Array(channelBytes)),
      catch: () => fail("The fork descriptor digest could not be checked."),
    });
    const channelSha256 = [...new Uint8Array(channelDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (descriptor.digest !== `sha256:${channelSha256}`)
      return yield* fail("The fork descriptor differs from its release digest.");
    const channel = yield* Effect.try({
      try: () => parseLanUpdateChannel(strictJson(channelBytes), expectedIdentity),
      catch: () => fail("The fork channel descriptor has an invalid identity or artifact binding."),
    });
    const artifact = release.assets.find((asset) => asset.name === channel.artifact.name);
    if (
      channel.releaseTag !== release.tag_name ||
      !artifact ||
      artifact.size !== channel.artifact.byteLength ||
      artifact.digest !== `sha256:${channel.artifact.sha256}` ||
      artifact.browser_download_url !==
        `${releaseRoot}/download/${encodeURIComponent(channel.releaseTag)}/${encodeURIComponent(channel.artifact.name)}`
    )
      return yield* fail("The fork ZIP metadata differs from the channel descriptor.");
    return {
      status:
        channel.identity.sourceCommit === expectedIdentity.sourceCommit &&
        channel.applicationVersion === expectedIdentity.applicationVersion
          ? "unchanged"
          : "available",
      channel,
      releaseUrl,
      message:
        "Fork release metadata checked. The installed distribution revision is not known here; Reprint Hub must verify the package against its installed revision, then activate it while T3 Code is stopped.",
    } satisfies LanUpdateDiscovery;
  },
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  // Fetch otherwise follows redirects before the pinned-host checks above can see them.
  Effect.provideService(FetchHttpClient.RequestInit, {
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }),
  Effect.timeout("20 seconds"),
  Effect.mapError(() =>
    fail("The fork update check failed; no package was downloaded or installed."),
  ),
);
