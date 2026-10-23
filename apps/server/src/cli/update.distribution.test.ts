// @effect-diagnostics nodeBuiltinImport:off -- Synthetic public catalog bytes need the same digest as the release fixture.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Command } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { vi } from "vite-plus/test";

vi.mock("@t3tools/shared/distribution", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/distribution")>()),
  isLanDistribution: true,
  nativeUpdatesEnabled: false,
  distributionUpdateGuidance:
    "Updates come from JacKAsterisK/t3code. Use Reprint Hub to verify, stage and activate them while T3 Code is stopped.",
  resolveDistributionUpdateRepository: () => "JacKAsterisK/t3code",
  lanBuildIdentity: {
    appId: "com.example.lanfixture",
    productName: "LAN Fixture",
    protocolScheme: "lan-fixture",
    homeDirectoryName: "T3CodeLAN",
    telemetry: "disabled",
    cloudConfiguration: "disabled",
    nativeUpdater: "disabled",
    protocolVersion: 2,
    applicationVersion: "0.1.2",
    sourceCommit: "a".repeat(40),
  },
}));

import { lanBuildIdentity } from "@t3tools/shared/distribution";
import * as ForkUpdateDiscovery from "../lan/ForkUpdateDiscovery.ts";
import { resolveNewestVersion, repointLauncher, updateCommand } from "./update.ts";

const check = ForkUpdateDiscovery.ForkUpdateDiscovery.pipe(
  Effect.flatMap((discovery) => discovery.check),
  Effect.provide(ForkUpdateDiscovery.layer),
);

function catalog() {
  return {
    schemaVersion: 1,
    repository: "JacKAsterisK/t3code",
    releaseTag: "lan-v1.0.0",
    distributionVersion: "1.0.0",
    applicationVersion: "0.1.3",
    identity: { ...lanBuildIdentity!, applicationVersion: "0.1.3", sourceCommit: "b".repeat(40) },
    artifact: { name: "t3code-lan-1.0.0-win32-x64.zip", sha256: "f".repeat(64), byteLength: 65536 },
  };
}

function release(withCatalog: boolean, channel = catalog()) {
  const json = JSON.stringify(channel);
  const jsonBytes = new TextEncoder().encode(json).length;
  return {
    tag_name: "lan-v1.0.0",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/JacKAsterisK/t3code/releases/tag/lan-v1.0.0",
    assets: [
      ...(withCatalog
        ? [
            {
              id: 1,
              name: "t3code-lan-channel.json",
              browser_download_url:
                "https://github.com/JacKAsterisK/t3code/releases/download/lan-v1.0.0/t3code-lan-channel.json",
              size: jsonBytes,
              digest: "sha256:" + NodeCrypto.createHash("sha256").update(json).digest("hex"),
            },
          ]
        : []),
      {
        id: 2,
        name: channel.artifact.name,
        size: channel.artifact.byteLength,
        digest: "sha256:" + channel.artifact.sha256,
        browser_download_url:
          "https://github.com/JacKAsterisK/t3code/releases/download/lan-v1.0.0/" +
          channel.artifact.name,
      },
    ],
  };
}

it.effect(
  "LAN checks use only the public fork catalog despite ambient official overrides and credentials",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        assert.isUndefined(request.headers.authorization);
        requests.push(url.pathname);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(url.pathname.endsWith("/releases/latest") ? release(true) : catalog()),
          ),
        );
      });
      const result = yield* check.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Environment, {
          GH_TOKEN: "fixture",
          GITHUB_TOKEN: "fixture",
          T3CODE_RELEASE_BASE_URL: "https://github.com/pingdotgg/t3code/releases/download",
          T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
        }),
      );
      assert.equal(result.status, "available");
      assert.equal(result.channel?.distributionVersion, "1.0.0");
      assert.equal(result.channel?.applicationVersion, "0.1.3");
      assert.deepEqual(requests, [
        "/repos/JacKAsterisK/t3code/releases/latest",
        "/repos/JacKAsterisK/t3code/releases/assets/1",
      ]);
    }),
);

it.effect(
  "CLI checks print fork candidates through a credential-free metadata transport without runtime dependencies",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const output: string[] = [];
      const currentConsole = yield* Console.Console;
      const command = Command.runWith(updateCommand, { version: "0.1.2" })(["--check"]);
      yield* command.pipe(
        Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
          const url = new URL(String(input));
          assert.equal(url.origin, "https://api.github.com");
          assert.equal(init?.redirect, "manual");
          assert.equal(init?.credentials, "omit");
          assert.equal(init?.referrerPolicy, "no-referrer");
          assert.isFalse(new Headers(init?.headers).has("authorization"));
          requests.push(url.pathname);
          return Response.json(
            url.pathname.endsWith("/releases/latest") ? release(true) : catalog(),
          );
        }),
        Effect.provideService(Console.Console, {
          ...currentConsole,
          log: (...values) => void output.push(values.join(" ")),
        }),
        Effect.provide(Context.empty() as Context.Context<Effect.Services<typeof command>>),
      );
      assert.deepEqual(requests, [
        "/repos/JacKAsterisK/t3code/releases/latest",
        "/repos/JacKAsterisK/t3code/releases/assets/1",
      ]);
      assert.include(output.join("\n"), "Distribution: 1.0.0; application: 0.1.3");
      assert.include(output.join("\n"), "JacKAsterisK/t3code");
      assert.include(output.join("\n"), "Reprint Hub");
    }),
);

it.effect(
  "a missing fork catalog stays unavailable without official fallback or an artifact download",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests++;
        assert.equal(new URL(request.url).pathname, "/repos/JacKAsterisK/t3code/releases/latest");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(release(false))));
      });
      const result = yield* check.pipe(Effect.provideService(HttpClient.HttpClient, client));
      assert.equal(result.status, "unavailable");
      assert.isNull(result.channel);
      assert.equal(requests, 1);
    }),
);

it.effect(
  "a catalog for an official application identity cannot become a fork update candidate",
  () =>
    Effect.gen(function* () {
      const invalidChannel = {
        ...catalog(),
        identity: { ...catalog().identity, appId: "com.t3tools.t3code" },
      };
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/releases/latest")
                ? release(true, invalidChannel)
                : invalidChannel,
            ),
          ),
        ),
      );
      const result = yield* check.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(result));
    }),
);

it.effect(
  "LAN activation and native version resolution refuse before acquiring runtime dependencies",
  () =>
    Effect.gen(function* () {
      const command = Command.runWith(updateCommand, { version: "0.1.2" })([]);
      const commandError = yield* command.pipe(
        Effect.flip,
        Effect.provide(Context.empty() as Context.Context<Effect.Services<typeof command>>),
      );
      assert.equal(commandError._tag, "CliUpdateError");
      assert.include(commandError.message, "Hub");
      assert.include(commandError.message, "JacKAsterisK/t3code");
      const repoint = repointLauncher({
        launchedAs: "unused",
        versionsDir: "unused",
        targetEntryPath: "unused",
      });
      const repointError = yield* repoint.pipe(
        Effect.flip,
        Effect.provide(Context.empty() as Context.Context<Effect.Services<typeof repoint>>),
      );
      assert.include(repointError.message, "Hub");
      const version = resolveNewestVersion("stable");
      const versionError = yield* version.pipe(
        Effect.flip,
        Effect.provide(Context.empty() as Context.Context<Effect.Services<typeof version>>),
      );
      assert.include(versionError.message, "Hub");
    }),
);

it.effect(
  "CLI read-only checks reject unsupported catalog selection before any network or local state access",
  () =>
    Effect.gen(function* () {
      for (const arguments_ of [
        ["--check", "9.9.9"],
        ["--check", "--channel", "nightly"],
      ]) {
        const command = Command.runWith(updateCommand, { version: "0.1.2" })(arguments_);
        const error = yield* command.pipe(
          Effect.flip,
          Effect.provide(Context.empty() as Context.Context<Effect.Services<typeof command>>),
        );
        assert.equal(error._tag, "CliUpdateError");
      }
    }),
);
