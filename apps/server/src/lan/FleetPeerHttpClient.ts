// @effect-diagnostics nodeBuiltinImport:off -- undici loads with require, as in outboundHttp.ts, so Node single executables find it on disk.
import * as NodeModule from "node:module";
import type * as NodeTls from "node:tls";
import { fleetTlsRequestOptions, type FleetTlsTrust } from "@t3tools/shared/fleetTlsProxy";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as Undici from "undici";

const requireUndici = NodeModule.createRequire(import.meta.url);

/** The encrypted endpoints of trusted fleet peers, as the fleet peer-link adapter last read them. */
export class FleetPeerTrust extends Context.Service<
  FleetPeerTrust,
  {
    readonly current: Effect.Effect<ReadonlyArray<FleetTlsTrust>>;
    readonly replace: (trust: ReadonlyArray<FleetTlsTrust>) => Effect.Effect<void>;
  }
>()("t3/lan/FleetPeerHttpClient/FleetPeerTrust") {}

export const layerTrust = Layer.effect(
  FleetPeerTrust,
  Effect.gen(function* () {
    const trust = yield* Ref.make<ReadonlyArray<FleetTlsTrust>>([]);
    return FleetPeerTrust.of({
      current: Ref.get(trust),
      replace: Effect.fn("FleetPeerTrust.replace")(function* (next) {
        yield* Ref.set(trust, next);
      }),
    });
  }),
);

const trustKey = (trust: FleetTlsTrust) =>
  JSON.stringify([trust.origin, trust.certificate, trust.publicKeySha256, trust.connectHost ?? ""]);

/**
 * Peer links reach a fleet peer at its encrypted endpoint, whose self-signed certificate the
 * system CAs never trust. A request to exactly a trusted peer's origin goes over a connection
 * pinned to that peer's certificate and key; every other request is left as it was.
 */
export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient;
    const trust = yield* FleetPeerTrust;
    const agents = new Map<string, Undici.Agent>();
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled([...agents.values()].map((agent) => agent.close()))),
    );

    const pinnedFetch = (peer: FleetTlsTrust, now: number): typeof globalThis.fetch => {
      const undici = requireUndici("undici") as typeof Undici;
      const key = trustKey(peer);
      let agent = agents.get(key);
      if (agent === undefined) {
        const { ca, allowPartialTrustChain, rejectUnauthorized, minVersion, checkServerIdentity } =
          fleetTlsRequestOptions(peer, now);
        const connect = undici.buildConnector({
          ca,
          allowPartialTrustChain,
          rejectUnauthorized,
          minVersion,
          checkServerIdentity: (hostname, certificate) =>
            checkServerIdentity?.(hostname, certificate as NodeTls.DetailedPeerCertificate),
        });
        const connectHost = peer.connectHost;
        agent = new undici.Agent({
          allowH2: false,
          // The route may go by hostname; the pinned check still names the signed origin.
          connect:
            connectHost === undefined
              ? connect
              : (options, callback) =>
                  connect({ ...options, hostname: connectHost, host: connectHost }, callback),
        });
        for (const [existing, replaced] of agents)
          if (existing.startsWith(`[${JSON.stringify(peer.origin)},`)) {
            agents.delete(existing);
            void replaced.close();
          }
        agents.set(key, agent);
      }
      const dispatcher = agent;
      return ((input: string | URL, init?: RequestInit) =>
        undici.fetch(input, {
          ...(init as unknown as Undici.RequestInit),
          dispatcher,
        })) as unknown as typeof globalThis.fetch;
    };

    return HttpClient.transform(base, (response, request) =>
      Effect.gen(function* () {
        const origin = URL.parse(request.url)?.origin;
        const peer = (yield* trust.current).find((candidate) => candidate.origin === origin);
        if (peer === undefined) return yield* response;
        const now = yield* Clock.currentTimeMillis;
        const fetch = yield* Effect.try({
          try: () => pinnedFetch(peer, now),
          catch: (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        });
        return yield* Effect.provideService(response, FetchHttpClient.Fetch, fetch);
      }),
    );
  }),
);
