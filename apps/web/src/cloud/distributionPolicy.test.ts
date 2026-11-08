// @effect-diagnostics nodeBuiltinImport:off - pins the reviewed callers by scanning real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { EnvironmentId } from "@t3tools/contracts";

vi.mock("@t3tools/shared/distribution", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/distribution")>()),
  cloudEnabled: false,
  telemetryEnabled: false,
  nativeUpdatesEnabled: false,
  isLanDistribution: true,
  lanBuildIdentity: {
    appId: "example.t3code.lan",
    productName: "T3 Code LAN",
    protocolScheme: "t3code-lan",
    homeDirectoryName: "T3CodeLAN",
    telemetry: "disabled",
    cloudConfiguration: "disabled",
    nativeUpdater: "disabled",
    protocolVersion: 2,
    applicationVersion: "0.1.2",
    sourceCommit: "a".repeat(40),
  },
}));

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayTracingConfig,
} from "./publicConfig";
import { connectCliAuthRoutesEnabled } from "./connectCliAuth";
import * as ManagedRelayLayer from "./managedRelayLayer";
import { configureClientTracing } from "../observability/clientTracing";
import { hasDelegate } from "../observability/clientTracer";
import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { manualServerUpdateCommand, resolveServerSelfUpdateCapability } from "../versionSkew";
import {
  buildHostedPairingUrl,
  buildHostedChannelSelectionUrl,
  configuredHostedAppUrl,
  isHostedStaticApp,
  threadLinkHostedAppUrl,
} from "../hostedPairing";
import {
  linkEnvironmentToCloud,
  unlinkEnvironmentFromCloud,
  updateCloudPreferences,
  readCloudLinkState,
} from "./linkEnvironment";

// Disabled paths must not acquire HTTP, crypto, registry or credential services.
const withoutDependencies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Context.empty() as Context.Context<R>));

it("disabled cloud ignores ambient hosted authentication and exporter configuration", () => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_fixture");
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "fixture");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://collector.example.test");
  try {
    expect(hasCloudPublicConfig()).toBe(false);
    expect(connectCliAuthRoutesEnabled()).toBe(false);
    expect(resolveCloudPublicConfig()).toEqual({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
      relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    expect(resolveRelayTracingConfig()).toBe(null);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.effect("disabled managed relay refuses without initializing HTTP or browser key storage", () =>
  Effect.gen(function* () {
    const client = yield* ManagedRelay.ManagedRelayClient;
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    expect((yield* Effect.flip(client.listEnvironments({ clerkToken: "fixture" })))._tag).toBe(
      "ManagedRelayUrlInvalidError",
    );
    expect((yield* Effect.flip(signer.thumbprint))._tag).toBe("ManagedRelayDpopKeyLoadError");
  }).pipe(
    Effect.provide(ManagedRelayLayer.layer("https://relay.example.test")),
    withoutDependencies,
  ),
);

it("disabled telemetry never creates a web tracing delegate", async () => {
  await configureClientTracing();
  expect(hasDelegate()).toBe(false);
});

it("LAN renderer identity and manual update guidance come from the compiled distribution", () => {
  expect(APP_BASE_NAME).toBe("T3 Code LAN");
  expect(APP_DISPLAY_NAME).toBe("T3 Code LAN");
  expect(APP_VERSION).toBe("0.1.2");
  expect(manualServerUpdateCommand("9.9.9")).toBe("Use the Hub update workflow for T3 Code LAN.");
  expect(resolveServerSelfUpdateCapability(null)).toBe(null);
});

it("LAN pairing stays on the native server and refuses hosted cloud routes", () => {
  expect(
    new URL(buildHostedPairingUrl({ host: "http://192.0.2.10:3773", token: "fixture" })).origin,
  ).toBe("http://192.0.2.10:3773");
  expect(buildHostedPairingUrl({ host: "http://192.0.2.10:3773", token: "fixture" })).toBe(
    "http://192.0.2.10:3773/pair#token=fixture",
  );
  expect(() => buildHostedPairingUrl({ host: "https://app.t3.codes", token: "fixture" })).toThrow(
    "direct native",
  );
  expect(() => buildHostedPairingUrl({ host: "https://app.t3.codes.", token: "fixture" })).toThrow(
    "direct native",
  );
  expect(() => configuredHostedAppUrl()).toThrow("disabled");
  // Copied thread links fall back to native t3-thread:// links instead of throwing mid-render.
  expect(threadLinkHostedAppUrl()).toBeNull();
  expect(() => buildHostedChannelSelectionUrl({ channel: "nightly" })).toThrow("Hub");
  expect(isHostedStaticApp(new URL("https://app.t3.codes"))).toBe(false);
});

it("LAN-throwing hosted helpers keep only their reviewed callers", () => {
  // Upstream merges add hosted-link callers; in LAN builds these helpers throw. The 1.0.35 merge
  // crashed the thread view that way. Route new callers through threadLinkHostedAppUrl() or gate
  // them on isLanDistribution, then add them here.
  const root = NodePath.resolve(import.meta.dirname, "..");
  const callers = NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) =>
      /\b(?:configuredHostedAppUrl|buildHostedChannelSelectionUrl)\(/.test(
        NodeFS.readFileSync(NodePath.join(root, file), "utf8"),
      ),
    )
    .map((file) => file.replaceAll("\\", "/"))
    .toSorted();
  expect(callers).toEqual([
    "components/promptLinks/copyPromptLink.ts",
    "components/settings/SettingsPanels.tsx",
    "hostedPairing.ts",
  ]);
});

it.effect(
  "disabled cloud mutations refuse before constructing HTTP clients or reading credentials",
  () => {
    const target = {
      environmentId: EnvironmentId.make("fixture"),
      label: "fixture",
      httpBaseUrl: "http://192.0.2.10:3773",
      wsBaseUrl: "ws://192.0.2.10:3773",
    };
    return Effect.gen(function* () {
      expect(yield* readCloudLinkState({ target }).pipe(withoutDependencies)).toBe(null);
      for (const result of yield* Effect.all([
        linkEnvironmentToCloud({ target, clerkToken: "fixture" }).pipe(
          Effect.flip,
          withoutDependencies,
        ),
        unlinkEnvironmentFromCloud({ target, clerkToken: "fixture" }).pipe(
          Effect.flip,
          withoutDependencies,
        ),
        updateCloudPreferences({ target, publishAgentActivity: true }).pipe(
          Effect.flip,
          withoutDependencies,
        ),
      ]))
        expect(result.message).toBe("T3 Connect is disabled in this LAN distribution.");
    });
  },
);
