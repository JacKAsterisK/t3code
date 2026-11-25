import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  type FleetTlsIdentity,
  type FleetTlsGatewayInput,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "../platform/storageDocument.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  PrimaryConnectionRegistration,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  type NetworkStatus,
} from "./model.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Onboarding from "./onboarding.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly failExchange?: boolean;
    readonly renewalToken?: string;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly exchangeGate?: { readonly reached: () => void; readonly release: Promise<void> };
    readonly accessTokenRenewal?: boolean;
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/t3/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
            ...(options?.accessTokenRenewal === true ? { accessTokenRenewal: true } : {}),
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      if (options?.failExchange === true) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-pairing-test",
            },
            { status: 401 },
          ),
        );
      }
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const params = new URLSearchParams(body);
      const requestedScope = params.get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      const dpop = new Headers(init.headers).has("dpop");
      const granted = Response.json({
        access_token: dpop
          ? "dpop-token"
          : params.get("subject_token") === "rotated-fixture-grant"
            ? (options?.renewalToken ?? "bearer-token")
            : "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: dpop ? "DPoP" : "Bearer",
        expires_in: 3600,
        scope: sessionScopes.join(" "),
      });
      const gate = options?.exchangeGate;
      if (gate === undefined) return Promise.resolve(granted);
      gate.reached();
      return gate.release.then(() => granted);
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

function layerPairingOnboarding(
  options?: Parameters<typeof layerPairingHttp>[1],
  calls: Array<{ readonly url: string; readonly init: RequestInit }> = [],
  provision?: ClientCapabilities.SshEnvironmentGateway["Service"]["provision"],
  registered: unknown[] = [],
  fleetGateway?: Parameters<typeof ClientCapabilities.FleetTlsGateway.of>[0],
) {
  let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
  const dependencies = Layer.mergeAll(
    layerClientPresentation,
    layerPairingHttp(calls, options),
    fleetGateway === undefined
      ? Layer.empty
      : Layer.succeed(ClientCapabilities.FleetTlsGateway, fleetGateway),
    Layer.mock(Persistence.ConnectionTargetStore)({
      list: Effect.succeed([]),
      listDisabled: Effect.succeed([]),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      register: (registration, routes, enable) =>
        Effect.sync(() => {
          registered.push(registration);
          document = registerConnectionInCatalog(document, registration, routes, enable);
        }),
      setRoutes: () => Effect.void,
      setEnabled: () => Effect.void,
    }),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({}),
    Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({
      get: (connectionId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            document.credentials.find((item) => item.connectionId === connectionId)?.credential,
          ),
        ),
      put: () => Effect.void,
    }),
    Layer.mock(ClientCapabilities.SshEnvironmentGateway)(provision ? { provision } : {}),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.mock(ConnectionDriver.ConnectionDriver)({ connect: () => Effect.never }),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
  );
  return Onboarding.layer.pipe(
    Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
  );
}

// Pairing with an expected environment never consults the registry: its
// methods die if called, and its refs stay empty.
const layerUnusedRegistry = Layer.unwrap(
  Effect.gen(function* () {
    return Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map(),
      ),
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("unknown"),
    });
  }),
);

const PAIRED_ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const PAIRING_INPUT = { host: "remote.example.test", pairingCode: "pairing-token" };
const PAIRED_PROFILE = new BearerConnectionProfile({
  connectionId: "bearer:environment-paired:https://remote.example.test",
  environmentId: PAIRED_ENVIRONMENT_ID,
  label: "Paired environment",
  httpBaseUrl: "https://remote.example.test/",
  wsBaseUrl: "wss://remote.example.test/",
});
const UNSUPPORTED_ERROR = new ConnectionBlockedError({
  reason: "unsupported",
  detail: "The saved server used an incompatible orchestration protocol.",
});

const registerSavedEnvironment = (
  fleetTls?: FleetTlsIdentity,
  fleetId?: string,
  fleetReplacementDeliveryId?: string,
) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const registration = new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: PAIRED_ENVIRONMENT_ID,
        connectionId: PAIRED_PROFILE.connectionId,
        label: "Old label",
      }),
      profile: new BearerConnectionProfile({
        ...PAIRED_PROFILE,
        label: "Old label",
        ...(fleetTls === undefined ? {} : { fleetTls }),
        ...(fleetId === undefined ? {} : { fleetId }),
        ...(fleetReplacementDeliveryId === undefined ? {} : { fleetReplacementDeliveryId }),
      }),
      credential: new BearerConnectionCredential({ token: "old-token" }),
    });
    yield* registry.register(registration);
    yield* registry.setEnabled(PAIRED_ENVIRONMENT_ID, false);
    yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
    const entries = yield* SubscriptionRef.get(registry.entries);
    expect(entries.get(PAIRED_ENVIRONMENT_ID)).toEqual({
      target: registration.target,
      profile: Option.some(registration.profile),
      enabled: false,
      unsupportedReason: UNSUPPORTED_ERROR.message,
    });
    return entries;
  });
const registerSwitchedOffEnvironment = registerSavedEnvironment();

describe("connection onboarding", () => {
  it.effect(
    "keeps fleet pairing material behind the native pinned gateway and persists its original identity",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const tls = {
          origin: "https://192.168.40.10:4443",
          certificate: "synthetic-public-certificate",
          publicKeySha256: "a".repeat(64),
        };
        const prepared: unknown[] = [];
        const registration = yield* preparePairingRegistration({
          host: tls.origin,
          pairingCode: "synthetic-pairing-code",
          expectedEnvironmentId: EnvironmentId.make("environment-paired"),
          tls,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls), layerUnusedRegistry),
          ),
          Effect.provideService(ClientCapabilities.FleetTlsGateway, {
            prepare: (input) =>
              Effect.sync(() => {
                prepared.push(input);
                return {
                  httpBaseUrl: "http://127.0.0.1:41001/",
                  wsBaseUrl: "ws://127.0.0.1:41001/",
                };
              }),
          }),
        );
        expect(prepared).toEqual([{ environmentId: "environment-paired", identity: tls }]);
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.every((call) => call.url.startsWith("http://127.0.0.1:41001/"))).toBe(true);
        expect(registration.profile.fleetTls).toEqual(tls);
        expect(registration.profile.httpBaseUrl).toBe(`${tls.origin}/`);
        expect(registration.target.connectionId).toBe(`bearer:environment-paired:${tls.origin}`);
      }),
  );

  it.effect(
    "does not attempt fleet discovery or redeem a code without the protected native gateway",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const tls = {
          origin: "https://192.168.40.10:4443",
          certificate: "synthetic-public-certificate",
          publicKeySha256: "a".repeat(64),
        };
        const error = yield* preparePairingRegistration({
          host: tls.origin,
          pairingCode: "synthetic-pairing-code",
          expectedEnvironmentId: EnvironmentId.make("environment-paired"),
          tls,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls), layerUnusedRegistry),
          ),
          Effect.flip,
        );
        expect(error).toMatchObject({ reason: "unsupported" });
        expect(calls).toEqual([]);
      }),
  );
  it.effect(
    "skips a known fleet identity before discovery or spending a code and preserves its disabled state",
    () => {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const before = yield* registerSwitchedOffEnvironment;
        const result = yield* onboarding.registerPairing({
          ...PAIRING_INPUT,
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          skipExisting: true,
        });
        expect(result).toBe(PAIRED_ENVIRONMENT_ID);
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
        expect(calls).toEqual([]);
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
    },
  );
  it.effect(
    "keeps a manual desktop connection when the replacement fleet offers a credential",
    () => {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const before = yield* registerSwitchedOffEnvironment;
        const result = yield* onboarding.registerPairing({
          ...PAIRING_INPUT,
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          preserveManualConnection: true,
        });
        expect(result).toBe(PAIRED_ENVIRONMENT_ID);
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
        expect(calls).toEqual([]);
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
    },
  );

  it.effect("refuses to replace a verified route with an unpinned offer", () => {
    const registered: unknown[] = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSavedEnvironment({
        origin: "https://remote.example.test",
        certificate: "synthetic-public-certificate",
        publicKeySha256: "a".repeat(64),
      });
      const before = yield* SubscriptionRef.get(registry.entries);
      const failure = yield* onboarding
        .registerPairing({
          ...PAIRING_INPUT,
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          preserveManualConnection: true,
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "configuration" });
      expect(registered).toHaveLength(1);
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, [], undefined, registered)));
  });
  const switchCases = [
    "ordinary",
    "replacement",
    "legacy preservation",
    "failed pairing",
    "failed promotion",
    "unpinned switch",
  ] as const;
  it.effect.each(switchCases)(
    "reconciles proven old fleet routes and protects retained credentials on %s",
    (mode) => {
      let prepares = 0;
      let disconnects = 0;
      const oldTls = {
        origin: "https://remote.example.test",
        certificate: "old-public-certificate",
        publicKeySha256: "a".repeat(64),
      };
      const tls = {
        origin: "https://new-fleet.example.test",
        certificate: "new-public-certificate",
        publicKeySha256: "b".repeat(64),
      };
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSavedEnvironment(oldTls, "old-fleet");
        const legacyTls =
          mode === "legacy preservation"
            ? {
                ...tls,
                origin: "https://ambiguous.example.test",
              }
            : tls;
        const ordinary = mode === "ordinary" || mode === "unpinned switch";
        if (!ordinary) {
          for (const [origin, pin] of [
            ["https://manual.example.test", undefined],
            [legacyTls.origin, legacyTls],
          ] as const) {
            const connectionId = `bearer:${PAIRED_ENVIRONMENT_ID}:${origin}`;
            yield* registry.register(
              new BearerConnectionRegistration({
                target: new BearerConnectionTarget({
                  environmentId: PAIRED_ENVIRONMENT_ID,
                  connectionId,
                  label: origin,
                }),
                profile: new BearerConnectionProfile({
                  ...PAIRED_PROFILE,
                  connectionId,
                  httpBaseUrl: `${origin}/`,
                  wsBaseUrl: origin.replace("https:", "wss:") + "/",
                  ...(pin === undefined ? {} : { fleetTls: pin }),
                }),
                credential: new BearerConnectionCredential({ token: "saved-token" }),
              }),
            );
          }
        }
        const before = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
        const delivery = {
          host: tls.origin,
          pairingCode: "synthetic-switch",
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          fleetId: "new-fleet",
          skipExisting: ordinary || mode === "legacy preservation",
          ...(mode === "replacement" || mode === "failed pairing"
            ? { replacementDeliveryId: "synthetic-delivery" }
            : {}),
          ...(mode === "unpinned switch" ? {} : { tls }),
        };
        const pairing = onboarding.registerPairing(delivery);
        if (mode === "failed pairing" || mode === "failed promotion") {
          yield* Effect.flip(pairing);
          const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
          expect(
            Option.getOrUndefined(yield* credentials.get(PAIRED_PROFILE.connectionId)),
          ).toMatchObject({
            token: "old-token",
          });
          expect((yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID)).toEqual(
            before,
          );
        } else {
          expect(yield* pairing).toBe(PAIRED_ENVIRONMENT_ID);
          const saved = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID)!;
          expect(connectionRoutes(saved).map(routeHttpBaseUrl).sort()).toEqual(
            [
              `${tls.origin}/`,
              ...(ordinary ? [] : ["https://manual.example.test/"]),
              ...(mode === "legacy preservation" ? [`${legacyTls.origin}/`] : []),
            ].sort(),
          );
          expect(
            connectionRoutes(saved).map(({ profile }) => Option.getOrUndefined(profile)),
          ).toContainEqual(
            expect.objectContaining({
              fleetId: "new-fleet",
              ...(mode === "unpinned switch" ? {} : { fleetTls: tls }),
            }),
          );
          expect(disconnects).toBe(mode === "unpinned switch" ? 1 : 0);
          if (mode === "legacy preservation") {
            yield* onboarding.registerPairing({
              ...delivery,
              pairingCode: "rotated-fixture-grant",
              skipExisting: false,
              replacementDeliveryId: "synthetic-renewal",
            });
            const renewed = (yield* SubscriptionRef.get(registry.entries)).get(
              PAIRED_ENVIRONMENT_ID,
            )!;
            const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
            const routes = connectionRoutes(renewed);
            const bearer = routes.find((route) => routeHttpBaseUrl(route) === tls.origin + "/");
            expect(bearer?.target._tag).toBe("BearerConnectionTarget");
            if (bearer?.target._tag === "BearerConnectionTarget")
              expect(
                Option.getOrUndefined(yield* credentials.get(bearer.target.connectionId)),
              ).toMatchObject({
                token: "renewed-token",
              });
            expect(
              connectionRoutes(renewed).map(({ profile }) => Option.getOrUndefined(profile)),
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  fleetReplacementDeliveryId: "synthetic-renewal",
                  fleetTls: tls,
                }),
                expect.objectContaining({ fleetTls: legacyTls }),
              ]),
            );
          }
        }
        expect(calls.some(({ url }) => url.endsWith("/oauth/token"))).toBe(true);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(
            { failExchange: mode === "failed pairing", renewalToken: "renewed-token" },
            calls,
            undefined,
            [],
            {
              prepare: () =>
                Effect.suspend(() =>
                  ++prepares === 2 && mode === "failed promotion"
                    ? Effect.fail(
                        new ConnectionBlockedError({
                          reason: "configuration",
                          detail: "Synthetic promotion failure",
                        }),
                      )
                    : Effect.succeed({
                        httpBaseUrl: "http://127.0.0.1:41001/",
                        wsBaseUrl: "ws://127.0.0.1:41001/",
                      }),
                ),
              disconnect: () => Effect.sync(() => void disconnects++),
            },
          ),
        ),
      );
    },
  );

  it.effect.each([false, true])(
    "reconciles a verified replacement and keeps manual routes (pairing failure: %s)",
    (failExchange) => {
      const previousIdentity = {
        origin: "https://remote.example.test",
        certificate: "old-public-certificate",
        publicKeySha256: "a".repeat(64),
      };
      const tls = {
        origin: "https://new-fleet.example.test",
        certificate: "new-public-certificate",
        publicKeySha256: "b".repeat(64),
      };
      const manualProfile = new BearerConnectionProfile({
        ...PAIRED_PROFILE,
        connectionId: "bearer:environment-paired:https://manual.example.test",
        httpBaseUrl: "https://manual.example.test/",
        wsBaseUrl: "wss://manual.example.test/",
      });
      const prepared: FleetTlsGatewayInput[] = [];
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSavedEnvironment(previousIdentity);
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: PAIRED_ENVIRONMENT_ID,
              connectionId: manualProfile.connectionId,
              label: "Manual",
            }),
            profile: manualProfile,
            credential: new BearerConnectionCredential({ token: "manual-token" }),
          }),
        );
        const pair = onboarding.registerPairing({
          host: tls.origin,
          pairingCode: "synthetic-replacement",
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          replacementDeliveryId: "same-fleet-replacement",
          tls,
        });
        if (failExchange) yield* Effect.flip(pair);
        else expect(yield* pair).toBe(PAIRED_ENVIRONMENT_ID);

        expect(prepared).toEqual([
          { environmentId: PAIRED_ENVIRONMENT_ID, identity: tls, previousIdentity },
          ...(failExchange
            ? []
            : [{ environmentId: PAIRED_ENVIRONMENT_ID, identity: tls, savedRoute: true }]),
        ]);
        const saved = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID)!;
        expect(connectionRoutes(saved).map(routeHttpBaseUrl)).toEqual(
          expect.arrayContaining([
            manualProfile.httpBaseUrl,
            failExchange ? PAIRED_PROFILE.httpBaseUrl : `${tls.origin}/`,
          ]),
        );
        expect(connectionRoutes(saved)).toHaveLength(2);
        expect(
          connectionRoutes(saved).some(
            ({ profile }) =>
              Option.isSome(profile) &&
              profile.value._tag === "BearerConnectionProfile" &&
              profile.value.fleetReplacementDeliveryId === "same-fleet-replacement",
          ),
        ).toBe(!failExchange);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ failExchange }, [], undefined, [], {
            prepare: (input) =>
              Effect.sync(() => {
                prepared.push(input);
                return {
                  httpBaseUrl: "http://127.0.0.1:41001/",
                  wsBaseUrl: "ws://127.0.0.1:41001/",
                };
              }),
          }),
        ),
      );
    },
  );

  it.effect("renews an unpinned connection from an original fleet", () => {
    const registered: unknown[] = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSavedEnvironment(undefined, undefined, "prior-renewal");
      yield* onboarding.registerPairing({
        host: "manual.example.test",
        pairingCode: "manual-fixture",
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
      });
      expect(
        yield* onboarding.registerPairing({
          ...PAIRING_INPUT,
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          replacementDeliveryId: "synthetic-renewal",
          requireSavedConnection: true,
          fleetId: "original-fleet",
        }),
      ).toBe(PAIRED_ENVIRONMENT_ID);
      expect(registered.at(-1)).toMatchObject({
        target: { connectionId: PAIRED_PROFILE.connectionId },
        profile: { fleetReplacementDeliveryId: "synthetic-renewal" },
        credential: { token: "bearer-token" },
      });
      const saved = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID)!;
      expect(connectionRoutes(saved).map(routeHttpBaseUrl)).toContain(
        "https://manual.example.test/",
      );
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, [], undefined, registered)));
  });

  it.effect("keeps a hand-edited unpinned address and its credential on a fleet switch", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
      yield* registerSavedEnvironment(undefined, "old-fleet");
      yield* onboarding.updateBearer({
        environmentId: PAIRED_ENVIRONMENT_ID,
        label: "Hand-edited route",
        httpBaseUrl: "https://manual.example.test/",
      });
      yield* onboarding.registerPairing({
        host: "new-fleet.example.test",
        pairingCode: "synthetic-switch",
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
        fleetId: "new-fleet",
      });
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID)!;
      expect(connectionRoutes(entry).map(routeHttpBaseUrl)).toContain(
        "https://new-fleet.example.test/",
      );
      const edited = connectionRoutes(entry).find(
        (route) => routeHttpBaseUrl(route) === "https://manual.example.test/",
      );
      expect(edited).toBeDefined();
      expect(Option.getOrUndefined(edited!.profile)).not.toHaveProperty("fleetId");
      expect(
        Option.getOrUndefined(yield* credentials.get(PAIRED_PROFILE.connectionId)),
      ).toMatchObject({
        token: "old-token",
      });
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("keeps the saved fleet ID when an exact-pin renewal omits it", () => {
    const registered: unknown[] = [];
    const tls = {
      origin: "https://remote.example.test",
      certificate: "synthetic-pin",
      publicKeySha256: "c".repeat(64),
    };
    return Effect.gen(function* () {
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSavedEnvironment(tls, "original-fleet");
      yield* onboarding.registerPairing({
        ...PAIRING_INPUT,
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
        replacementDeliveryId: "synthetic-renewal",
        tls,
      });
      expect(registered.at(-1)).toMatchObject({
        profile: { fleetId: "original-fleet", fleetReplacementDeliveryId: "synthetic-renewal" },
        credential: { token: "bearer-token" },
      });
    }).pipe(
      Effect.provide(
        layerPairingOnboarding(undefined, [], undefined, registered, {
          prepare: () =>
            Effect.succeed({
              httpBaseUrl: "http://127.0.0.1:41001/",
              wsBaseUrl: "ws://127.0.0.1:41001/",
            }),
        }),
      ),
    );
  });

  it.effect("keeps a newer fleet pin installed during an unpinned renewal", () => {
    let reached!: () => void;
    let release!: () => void;
    const exchangeReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const exchangeGate = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const registered: unknown[] = [];
    const newerPin = {
      origin: "https://remote.example.test",
      certificate: "newer-synthetic-pin",
      publicKeySha256: "c".repeat(64),
    };
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSavedEnvironment();
      const renewal = yield* onboarding
        .registerPairing({
          ...PAIRING_INPUT,
          expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          replacementDeliveryId: "synthetic-renewal",
          requireSavedConnection: true,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => exchangeReached);
      const newer = yield* registerSavedEnvironment(newerPin);
      release();

      expect(yield* Fiber.join(renewal)).toMatchObject({ reason: "configuration" });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(newer);
      expect(registered).toHaveLength(2);
      expect(registered.at(-1)).toMatchObject({
        profile: { fleetTls: newerPin },
        credential: { token: "old-token" },
      });
    }).pipe(Effect.provide(layerPairingOnboarding({ exchangeGate }, [], undefined, registered)));
  });

  it.effect("leaves an unspent automatic renewal when the environment was forgotten", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      expect(
        yield* onboarding
          .registerPairing({
            ...PAIRING_INPUT,
            expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
            replacementDeliveryId: "synthetic-renewal",
            requireSavedConnection: true,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual([]);
      expect((yield* SubscriptionRef.get(registry.entries)).has(PAIRED_ENVIRONMENT_ID)).toBe(false);
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
  });

  it.effect.each(["ambiguous", "manual-collision", "predecessor-removed"] as const)(
    "keeps existing routes on a fleet replacement conflict (%s)",
    (conflict) => {
      const previousIdentity = {
        origin: "https://remote.example.test",
        certificate: "prior-synthetic-pin",
        publicKeySha256: "a".repeat(64),
      };
      const tls = {
        origin: "https://next-fleet.example.test",
        certificate: "next-synthetic-pin",
        publicKeySha256: "b".repeat(64),
      };
      const alternateOrigin =
        conflict === "manual-collision" ? tls.origin : "https://alternate.example.test";
      const alternateId = `bearer:environment-paired:${alternateOrigin}`;
      const alternateProfile = new BearerConnectionProfile({
        ...PAIRED_PROFILE,
        connectionId: alternateId,
        httpBaseUrl: `${alternateOrigin}/`,
        wsBaseUrl: `${alternateOrigin.replace("https:", "wss:")}/`,
        ...(conflict === "ambiguous"
          ? {
              fleetTls: {
                origin: alternateOrigin,
                certificate: "other-synthetic-pin",
                publicKeySha256: "c".repeat(64),
              },
            }
          : {}),
      });
      let reached!: () => void;
      let release!: () => void;
      const exchangeReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const exchangeGate = {
        reached,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registered: unknown[] = [];
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSavedEnvironment(previousIdentity);
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: PAIRED_ENVIRONMENT_ID,
              connectionId: alternateId,
              label: "Alternate",
            }),
            profile: alternateProfile,
            credential: new BearerConnectionCredential({ token: "alternate-token" }),
          }),
        );
        const replace = onboarding
          .registerPairing({
            host: tls.origin,
            pairingCode: "synthetic-replacement",
            expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
            replacementDeliveryId: "synthetic-delivery",
            tls,
          })
          .pipe(Effect.flip);
        if (conflict === "predecessor-removed") {
          const pending = yield* Effect.forkChild(replace);
          yield* Effect.promise(() => exchangeReached);
          yield* registry.removeRoute(PAIRED_ENVIRONMENT_ID, PAIRED_PROFILE.connectionId);
          release();
          expect(yield* Fiber.join(pending)).toMatchObject({ reason: "configuration" });
          expect(calls.some(({ url }) => url.endsWith("/oauth/token"))).toBe(true);
        } else {
          expect(yield* replace).toMatchObject({ reason: "configuration" });
          expect(calls).toEqual([]);
        }
        expect(registered).toHaveLength(2);
        const saved = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID)!;
        const origins = connectionRoutes(saved).map(routeHttpBaseUrl).sort();
        expect(origins).toEqual(
          conflict === "predecessor-removed"
            ? [alternateProfile.httpBaseUrl]
            : [PAIRED_PROFILE.httpBaseUrl, alternateProfile.httpBaseUrl].sort(),
        );
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(
            conflict === "predecessor-removed" ? { exchangeGate } : {},
            calls,
            undefined,
            registered,
            {
              prepare: () =>
                Effect.succeed({
                  httpBaseUrl: "http://127.0.0.1:41001/",
                  wsBaseUrl: "ws://127.0.0.1:41001/",
                }),
            },
          ),
        ),
      );
    },
  );

  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  it.effect("turns a switched-off environment back on when it is paired again", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      const entries = yield* SubscriptionRef.get(registry.entries);
      const entry = entries.get(environmentId);
      expect(entries.size).toBe(1);
      expect(entry?.enabled).toBe(true);
      expect(entry?.unsupportedReason).toBeUndefined();
      expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      expect(entry?.target).toEqual(
        new BearerConnectionTarget({
          environmentId,
          connectionId: PAIRED_PROFILE.connectionId,
          label: PAIRED_PROFILE.label,
        }),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("refuses a pairing link that claims a saved environment from a new address", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      expect(calls.map((call) => call.url)).toEqual([
        "https://attacker.example.test/.well-known/t3/environment",
      ]);
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
  });

  it.effect(
    "refuses to add an SSH route to a saved environment during untargeted onboarding",
    () => {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const before = yield* registerSwitchedOffEnvironment;

        const result = yield* onboarding.registerSsh({ target }).pipe(Effect.result);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
        });
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(undefined, [], () =>
            Effect.succeed({
              environmentId: PAIRED_ENVIRONMENT_ID,
              label: "Remote development box",
              bootstrap: {
                target,
                httpBaseUrl: "http://127.0.0.1:3201",
                wsBaseUrl: "ws://127.0.0.1:3201",
                pairingToken: "pairing-token",
              },
              bearerToken: "bearer-token",
            }),
          ),
        ),
      );
    },
  );

  it.effect("refuses a new address when the environment is saved during the exchange", () => {
    let reached!: () => void;
    let release!: () => void;
    const exchangeReached = new Promise<void>((resolve) => (reached = resolve));
    const exchangeGate = {
      reached: () => reached(),
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const pairing = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => exchangeReached);
      const before = yield* registerSwitchedOffEnvironment;
      release();

      const outcome = yield* Fiber.join(pairing);

      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
    }).pipe(Effect.provide(layerPairingOnboarding({ exchangeGate })));
  });

  it.effect("adds a new address as a route when pairing targets that environment", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      yield* onboarding.registerPairing({
        host: "lan.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
      });

      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      expect(entry === undefined ? [] : connectionRoutes(entry).map(routeHttpBaseUrl)).toEqual(
        expect.arrayContaining(["https://remote.example.test/", "https://lan.example.test/"]),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect(
    "re-pairs an outdated self-updatable environment so its connection can be rechecked",
    () =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSwitchedOffEnvironment;
        yield* registry.setCompatibility(
          PAIRED_ENVIRONMENT_ID,
          new ConnectionBlockedError({
            reason: "unsupported",
            detail: "The saved server needs an update.",
            serverUpdateRequired: true,
          }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID),
        ).toMatchObject({
          enabled: false,
          serverUpdateRequired: true,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(entry?.enabled).toBe(true);
        expect(entry?.unsupportedReason).toBeUndefined();
        expect(entry?.serverUpdateRequired).toBeUndefined();
        expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({
            protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
            selfUpdate: true,
          }),
        ),
      ),
  );

  it.effect.each([
    {
      kind: "primary",
      registration: new PrimaryConnectionRegistration({
        target: new PrimaryConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Host environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      }),
    },
    {
      kind: "bearer",
      registration: new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          connectionId: "platform:wsl",
          label: "WSL",
        }),
        profile: new BearerConnectionProfile({
          ...PAIRED_PROFILE,
          connectionId: "platform:wsl",
          label: "WSL",
          httpBaseUrl: "http://127.0.0.1:4000",
          wsBaseUrl: "ws://127.0.0.1:4000",
        }),
        credential: new BearerConnectionCredential({ token: "platform-token" }),
      }),
    },
  ] as const)(
    "leaves a platform-managed $kind environment untouched when its id is paired",
    ({ registration }) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.reconcilePlatform([registration]);
        yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
        const before = yield* SubscriptionRef.get(registry.entries);
        expect(before.get(PAIRED_ENVIRONMENT_ID)).toMatchObject({
          enabled: true,
          unsupportedReason: UNSUPPORTED_ERROR.message,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("leaves a switched-off environment unchanged when the pairing exchange fails", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding.registerPairing(PAIRING_INPUT).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        traceId: "trace-pairing-test",
      });
      const after = yield* SubscriptionRef.get(registry.entries);
      expect(after).toEqual(before);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.enabled).toBe(false);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.unsupportedReason).toBe(UNSUPPORTED_ERROR.message);
    }).pipe(Effect.provide(layerPairingOnboarding({ failExchange: true }))),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );
  it.effect.each([
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "default", scopes: AuthStandardClientScopes },
  ] as const)("preserves the $label grant when pairing a remote environment", ({ scopes }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });

      assert(registration.credential._tag === "BearerConnectionCredential");
      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: registration.profile.httpBaseUrl,
        bearerToken: registration.credential.token,
      });

      expect(session.authenticated).toBe(true);
      expect(session.scopes).toEqual(scopes);
    }).pipe(Effect.provide(layerPairingOnboarding({ grantScopes: scopes }))),
  );

  it.effect.each([
    { name: "a host that renews, with a device key", renews: true, signer: true, dpop: true },
    { name: "a host that renews, without a device key", renews: true, signer: false, dpop: false },
    { name: "an older host, with a device key", renews: false, signer: true, dpop: false },
  ])("pairs with $name as DPoP: $dpop", ({ renews, signer, dpop }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });
      expect(registration.credential).toMatchObject(
        dpop
          ? { _tag: "DpopConnectionCredential", accessToken: "dpop-token" }
          : { _tag: "BearerConnectionCredential", token: "bearer-token" },
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingOnboarding({ accessTokenRenewal: renews }),
          signer
            ? Layer.succeed(
                ManagedRelay.ManagedRelayDpopSigner,
                ManagedRelay.ManagedRelayDpopSigner.of({
                  thumbprint: Effect.succeed("device-key"),
                  createProof: (proof) => Effect.succeed(`proof:${proof.url}`),
                }),
              )
            : Layer.empty,
        ),
      ),
    ),
  );

  it.effect("refuses to add a route that reaches a different machine, keeping the code", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)), Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("different machine");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding({ failDescriptor: true }, calls)), Effect.flip);

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
        // Saved so the first connect reuses this pairing instead of adding another.
        credential: { token: "bearer-token" },
      });
    }),
  );
});
