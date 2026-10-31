// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns DNS pinning and interruptible peer sockets.
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import { fleetTlsRequestOptions } from "@t3tools/shared/fleetTlsProxy";
import * as Fleet from "../lan/FleetPeerHttpClient.ts";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const lookup = (hostname: string) =>
  Effect.callback<NodeDns.LookupAddress, NodeJS.ErrnoException>((resume) => {
    let active = true;
    NodeDns.lookup(hostname, (error, address, family) => {
      if (!active) return;
      resume(error === null ? Effect.succeed({ address, family }) : Effect.fail(error));
    });
    // OS lookups cannot be cancelled; interruption discards their late callbacks.
    return Effect.sync(() => {
      active = false;
    });
  });

export const NetworkOptions = Context.Reference<{
  readonly lookup: (
    hostname: string,
  ) => Effect.Effect<NodeDns.LookupAddress, NodeJS.ErrnoException>;
  readonly ca?: string;
}>("t3/peer/PeerNetworkDispatch/NetworkOptions", { defaultValue: () => ({ lookup }) });

const execute = Effect.fn("PeerNetworkDispatch.execute")(function* <E>(
  request: HttpClientRequest.HttpClientRequest,
  beforeSend: Effect.Effect<void, E>,
) {
  const options = yield* NetworkOptions;
  const failed = (cause: unknown) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause }),
    });
  const url = yield* Effect.try({ try: () => new URL(request.url), catch: failed });
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return yield* failed("Unsupported peer protocol");
  const fleet = yield* Effect.serviceOption(Fleet.FleetPeerTrust);
  const currentPeer = Effect.gen(function* () {
    return Option.isSome(fleet)
      ? (yield* fleet.value.current).find((peer) => peer.origin === url.origin)
      : undefined;
  });
  const captured = yield* currentPeer;
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const route = captured?.connectHost ?? host;
  const family = NodeNet.isIP(route);
  const address =
    family === 0
      ? yield* options.lookup(route).pipe(Effect.mapError(failed))
      : { address: route, family };
  if (NodeNet.isIP(address.address) !== address.family || address.family === 0)
    return yield* failed("Invalid resolved peer address");
  if (request.body._tag !== "Empty" && request.body._tag !== "Uint8Array")
    return yield* failed("Unsupported peer request body");
  const body = request.body._tag === "Empty" ? undefined : request.body.body;
  // Admission releases its network-free gate before any socket is created. Admitted bytes cannot be recalled.
  yield* beforeSend;
  const current = yield* currentPeer;
  if (
    current?.origin !== captured?.origin ||
    current?.certificate !== captured?.certificate ||
    current?.publicKeySha256 !== captured?.publicKeySha256 ||
    current?.connectHost !== captured?.connectHost
  )
    return yield* failed("Fleet peer trust changed before admission");
  const now = yield* Clock.currentTimeMillis;
  const tls =
    current === undefined
      ? undefined
      : yield* Effect.try({
          try: () => fleetTlsRequestOptions(current, now),
          catch: failed,
        });
  return yield* Effect.callback<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >((resume) => {
    let outgoing: NodeHttp.ClientRequest | undefined;
    let incoming: NodeHttp.IncomingMessage | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    const destroy = () => {
      chunks.length = 0;
      incoming?.destroy();
      outgoing?.destroy();
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      destroy();
      resume(Effect.fail(failed(cause)));
    };
    try {
      outgoing = (url.protocol === "https:" ? NodeHttps.request : NodeHttp.request)({
        protocol: url.protocol,
        hostname: route,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: {
          ...request.headers,
          host: url.host,
          ...(body === undefined ? {} : { "content-length": String(body.byteLength) }),
        },
        agent: false,
        ...(NodeNet.isIP(host) === 0 ? { servername: host } : {}),
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        ...tls,
        lookup: (_hostname, lookupOptions, callback) =>
          lookupOptions.all
            ? (callback as (error: null, addresses: NodeDns.LookupAddress[]) => void)(null, [
                address,
              ])
            : callback(null, address.address, address.family),
      });
      outgoing.on("error", fail);
      outgoing.on("upgrade", (_response, socket) => {
        socket.destroy();
        fail("Peer upgrades are refused");
      });
      outgoing.on("response", (response) => {
        incoming = response;
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400)
          return fail("Peer redirects are refused");
        const maxBytes = 4 * 1024 * 1024;
        const length = response.headers["content-length"];
        if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBytes))
          return fail("Peer response exceeds the byte limit");
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > maxBytes) return fail("Peer response exceeds the byte limit");
          chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("aborted", () => fail("Peer response aborted"));
        response.on("end", () => {
          if (settled) return;
          try {
            const status = response.statusCode ?? 500;
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const part of value) headers.append(name, part);
              else if (value !== undefined) headers.set(name, value);
            }
            const result = HttpClientResponse.fromWeb(
              request,
              new Response(
                status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks),
                { status, headers },
              ),
            );
            settled = true;
            destroy();
            resume(Effect.succeed(result));
          } catch (cause) {
            fail(cause);
          }
        });
      });
      outgoing.end(body);
    } catch (cause) {
      fail(cause);
    }
    return Effect.sync(() => {
      settled = true;
      destroy();
    });
  });
});

/** Internal transport seam; the default always resolves, admits, pins, and refuses redirects. */
export const PeerNetworkDispatch = Context.Reference<{
  readonly execute: <E>(
    request: HttpClientRequest.HttpClientRequest,
    beforeSend: Effect.Effect<void, E>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, E | HttpClientError.HttpClientError>;
}>("t3/peer/PeerNetworkDispatch", { defaultValue: () => ({ execute }) });

/** Service constructors retain fleet trust even when their Layer.provide context is hidden from callers. */
export const capture = Effect.gen(function* () {
  const dispatch = yield* PeerNetworkDispatch;
  const fleet = yield* Effect.serviceOption(Fleet.FleetPeerTrust);
  if (Option.isNone(fleet)) return dispatch;
  const trust = fleet.value;
  return {
    execute: <E>(
      request: HttpClientRequest.HttpClientRequest,
      beforeSend: Effect.Effect<void, E>,
    ) =>
      dispatch
        .execute(request, beforeSend)
        .pipe(Effect.provideService(Fleet.FleetPeerTrust, trust)),
  };
});
