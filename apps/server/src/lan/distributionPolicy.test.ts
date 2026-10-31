import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

vi.mock("@t3tools/shared/distribution", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/distribution")>()),
  cloudEnabled: false,
  telemetryEnabled: false,
  nativeUpdatesEnabled: false,
  distributionUpdateGuidance:
    "Updates come from JacKAsterisK/t3code. Use Reprint Hub to verify, stage and activate them while T3 Code is stopped.",
}));

import * as Analytics from "../telemetry/AnalyticsService.ts";
import * as Identify from "../telemetry/Identify.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as Tokens from "../cloud/CliTokenManager.ts";
import * as ManagedEndpoint from "../cloud/ManagedEndpointRuntime.ts";
import * as Reachability from "../cloud/ConnectReachability.ts";
import * as CloudConfig from "../cloud/config.ts";
import * as PublicConfig from "../cloud/publicConfig.ts";
import * as Awareness from "../relay/AgentAwarenessRelay.ts";
import * as HeldHooks from "../relay/HeldHooksWaker.ts";
import * as SelfUpdate from "../cloud/selfUpdate.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as DesktopUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as LauncherClient from "../cloud/serviceLauncherClient.ts";
import * as BootService from "../cloud/bootService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { resolveServerConfig } from "../cli/config.ts";
import * as RelayProof from "../scheduledTasks/RelayDeliveryProof.ts";

// Deliberately omit platform, HTTP, secret, provider and subprocess services:
// a disabled build must finish these paths before acquiring any of them.
const withoutRuntimeDependencies = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(program).pipe(
    Effect.provide(Context.empty() as Context.Context<Exclude<R, Scope.Scope>>),
  );

it.effect("disabled analytics neither reads provider identities nor initializes exporters", () =>
  Effect.gen(function* () {
    const analytics = yield* Analytics.make;
    yield* analytics.record("fixture");
    yield* analytics.recordOwners([{ source: "device", ownerId: "fixture" }], "client");
    yield* analytics.flush;
    assert.deepEqual(yield* Identify.getTelemetryIdentityForHome("unused-home"), {
      distinctId: null,
      installId: null,
    });
    assert.deepEqual(yield* Identify.getServerOwnersForHome("unused-home"), []);
  }).pipe(withoutRuntimeDependencies),
);

it.effect(
  "disabled cloud ignores stored state and refuses credential or configuration mutations",
  () =>
    Effect.gen(function* () {
      const cloud = yield* CloudLink.CloudLink.pipe(Effect.provide(CloudLink.layer));
      assert.deepInclude(yield* cloud.linkState(), {
        linked: false,
        managedTunnelActive: false,
        relayUrl: null,
        publishAgentActivity: false,
      });
      assert.equal((yield* Effect.flip(cloud.unlink())).operation, "distribution-disabled");
      assert.isFalse(yield* cloud.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773"));
      assert.isFalse(yield* cloud.releaseManagedTunnelOnShutdown());
      const tokens = yield* Tokens.make;
      assert.isTrue(Option.isNone(yield* tokens.getExisting));
      assert.isFalse(yield* tokens.hasCredential);
      assert.equal((yield* Effect.flip(tokens.get))._tag, "CloudCliAuthorizationError");
      assert.equal((yield* Effect.flip(tokens.clear))._tag, "CloudCliAuthorizationError");
      assert.isNull(yield* CloudConfig.readRelayConnection);
      assert.isFalse(yield* CloudConfig.readHoldWebhooksWhileOffline);
      assert.isFalse(PublicConfig.hasCloudPublicConfig);
      assert.isNull(
        PublicConfig.resolveRelayClientTracingConfig({
          T3CODE_TELEMETRY_ENABLED: "true",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://collector.example.test",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "fixture",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "fixture",
        }),
      );
    }).pipe(withoutRuntimeDependencies),
);

it.effect(
  "disabled cloud starts no connector, publisher, reachability probe or held-hook worker",
  () =>
    Effect.gen(function* () {
      const runtime = yield* ManagedEndpoint.make;
      assert.deepEqual(yield* runtime.applyConfig(null), { status: "disabled" });
      assert.isNull(yield* runtime.inspectConnector);
      const reachability = yield* Reachability.ConnectReachability.pipe(
        Effect.provide(Reachability.layer),
      );
      assert.equal((yield* reachability.check).status, "unreachable");
      assert.isTrue(Option.isNone(yield* reachability.latest));
      const awareness = yield* Awareness.make;
      yield* awareness.start();
      yield* awareness.drain;
      yield* awareness.requestCatchUp();
      yield* Effect.void.pipe(Effect.provide(HeldHooks.layer));
      const proof = yield* RelayProof.RelayDeliveryProof.pipe(Effect.provide(RelayProof.layer));
      assert.isTrue(
        Option.isNone(
          yield* proof.verify({
            hookId: "fixture",
            headers: {
              "x-t3-relay-delivery-proof": "fixture",
              "x-t3-relay-delivery-id": "fixture",
              "x-t3-relay-received-at": "fixture",
            },
          }),
        ),
      );
    }).pipe(withoutRuntimeDependencies),
);

it.effect("disabled telemetry ignores malformed ambient exporter settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lan-policy-" });
    const config = yield* resolveServerConfig(
      {
        mode: Option.some("web"),
        lan: Option.none(),
        port: Option.some(3773),
        host: Option.none(),
        baseDir: Option.some(baseDir),
        cwd: Option.some(baseDir),
        devUrl: Option.some(new URL("http://localhost:8000")),
        noBrowser: Option.some(true),
        bootstrapFd: Option.none(),
        autoBootstrapProjectFromCwd: Option.some(false),
        logWebSocketEvents: Option.none(),
        tailscaleServeEnabled: Option.none(),
        tailscaleServePort: Option.none(),
      },
      Option.none(),
    );
    assert.isUndefined(config.otlpTracesUrl);
    assert.isUndefined(config.otlpMetricsUrl);
    assert.isUndefined(config.otlpLogsUrl);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_OTLP_PROTOCOL: "invalid",
              T3CODE_OTLP_HEADERS: "malformed-header",
              T3CODE_OTLP_EXPORT_INTERVAL_MS: "not-a-number",
              T3CODE_OTLP_TRACES_URL: "malformed-url",
              OTEL_EXPORTER_OTLP_HEADERS: "malformed-header",
              OTEL_EXPORTER_OTLP_PROTOCOL: "invalid",
            },
          }),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("disabled native updates cannot commit or acquire update dependencies", () =>
  Effect.gen(function* () {
    const updates = yield* SelfUpdate.make();
    assert.equal(
      (yield* Effect.flip(updates.commitDesktopUpdate("fixture")))._tag,
      "ServerSelfUpdateError",
    );
    assert.isNull(
      SelfUpdate.resolveServerSelfUpdateCapability({
        desktopManaged: true,
        launcherManaged: true,
      }),
    );
    const npmRelease = yield* NpmRelease.make();
    assert.isNull(yield* npmRelease.get({ spec: "latest" }));
    const desktop = yield* DesktopUpdate.make();
    assert.isFalse(desktop.available);
    assert.equal((yield* Effect.flip(desktop.commit("fixture")))._tag, "ServerSelfUpdateError");
    const launcher = yield* LauncherClient.make();
    assert.isFalse(launcher.managed);
    assert.equal(
      (yield* Effect.flip(launcher.requestUpdate({ targetVersion: "9.9.9", dbPath: "unused" })))
        ._tag,
      "ServiceLauncherRejectedError",
    );
    const service = yield* BootService.make({
      baseDir: "unused",
      logsDir: "unused",
      cliVersion: "0.1.2",
    });
    assert.isFalse((yield* service.status).supported);
    assert.equal((yield* Effect.flip(service.install()))._tag, "BootServiceCommandError");
    assert.equal((yield* Effect.flip(service.uninstall))._tag, "BootServiceCommandError");
  }).pipe(withoutRuntimeDependencies),
);
