import { AsyncEntry } from "@napi-rs/keyring";
import {
  ExecutionEnvironmentDescriptor,
  type LanEnvironmentRoute,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GatewayOAuthState,
  makeGatewayT3OAuthClient,
  secureOrigin,
  type GatewayCredentialStore,
} from "./GatewayT3OAuthClient.ts";

export class RemoteTaskTransport extends Context.Service<
  RemoteTaskTransport,
  {
    readonly call: (
      route: LanEnvironmentRoute,
      tool: string,
      input: unknown,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/lan/RemoteTaskTransport") {}

export class RoutingFetch extends Context.Service<RoutingFetch, typeof fetch>()(
  "t3/lan/RemoteTaskTransport/RoutingFetch",
) {}
export class RoutingCredentials extends Context.Service<
  RoutingCredentials,
  {
    readonly forRoute: (environmentId: string, credentialRef: string) => GatewayCredentialStore;
  }
>()("t3/lan/RemoteTaskTransport/RoutingCredentials") {}

/** Optional: this machine's fleet identity, which signs each task grant refresh as itself. */
export class RoutingFleetIdentity extends Context.Service<
  RoutingFleetIdentity,
  {
    /** Signs `grantId` for the environment `audience`; undefined outside a fleet. */
    readonly sign: (audience: string, grantId: string) => Effect.Effect<string | undefined>;
  }
>()("t3/lan/RemoteTaskTransport/RoutingFleetIdentity") {}

// These Promise adapters let tryPromise or the OAuth client map parse failures at their boundary.
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeTaskArguments = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const credentialCodec = Schema.fromJsonString(GatewayOAuthState);
const decodeCredential = Schema.decodeSync(credentialCodec);
const encodeCredential = Schema.encodeSync(credentialCodec);
const accountKey = (...parts: ReadonlyArray<string>) => parts.map(encodeURIComponent).join(":");

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      "The destination did not confirm the operation. Keep the same request ID when reconciling; no local fallback was attempted.",
  });

const make = Effect.gen(function* () {
  const request = yield* RoutingFetch;
  const credentials = yield* RoutingCredentials;
  const identity = yield* Effect.serviceOption(RoutingFleetIdentity);
  const clients = new Map<string, ReturnType<typeof makeGatewayT3OAuthClient>>();
  const call = Effect.fn("RemoteTaskTransport.call")(function* (
    route: LanEnvironmentRoute,
    tool: string,
    input: unknown,
  ) {
    const services = yield* Effect.context<never>();
    return yield* Effect.tryPromise({
      try: async () => {
        if (route.origin === null || route.credentialRef === null)
          throw new Error("Route unavailable");
        const origin = secureOrigin(route.origin);
        // Identity and retry/replay capability are checked before credentials are loaded.
        const response = await request(`${origin}/.well-known/t3/environment`, {
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error("Discovery unavailable");
        const descriptor = decodeDescriptor(await response.json());
        if (
          descriptor.environmentId !== route.environmentId ||
          descriptor.orchestrationProtocolVersion !== 2 ||
          descriptor.capabilities.lanTaskRouting !== 1
        ) {
          throw new Error("Destination identity or routing protocol mismatch");
        }
        const key = accountKey(route.environmentId, origin, route.credentialRef);
        let client = clients.get(key);
        if (client === undefined) {
          client = makeGatewayT3OAuthClient({
            origin,
            redirectUri: "http://127.0.0.1/oauth/t3/callback",
            fetch: request,
            credentials: credentials.forRoute(route.environmentId, route.credentialRef),
            // A grant from before grants recorded their approver becomes this machine's.
            ...(Option.isNone(identity)
              ? {}
              : {
                  fleetAssertion: (grantId: string) =>
                    Effect.runPromiseWith(services)(
                      identity.value.sign(route.environmentId, grantId),
                    ),
                }),
          });
          clients.set(key, client);
        }
        return await client.callTaskTool(tool, decodeTaskArguments(input));
      },
      catch: unavailable,
    });
  });
  return RemoteTaskTransport.of({ call });
});

export const layerServices = Layer.effect(RemoteTaskTransport, make);

export const layer = layerServices.pipe(
  Layer.provide(Layer.succeed(RoutingFetch, fetch)),
  Layer.provide(
    Layer.succeed(RoutingCredentials, {
      forRoute: (environmentId, credentialRef) => {
        const entry = () =>
          new AsyncEntry("T3 Code LAN routing", accountKey(environmentId, credentialRef));
        return {
          load: async () => {
            const raw = await entry().getPassword();
            return raw === undefined ? undefined : decodeCredential(raw);
          },
          save: async (state) => {
            await entry().setPassword(encodeCredential(state));
          },
          clear: async () => {
            await entry().deleteCredential();
          },
        };
      },
    }),
  ),
);
