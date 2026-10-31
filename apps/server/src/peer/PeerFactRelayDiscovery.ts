import { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Ports from "../agentEvents/AgentFactRelayAccess.ts";
import * as Links from "./PeerLinks.ts";
import * as Network from "./PeerNetworkDispatch.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeInitialize = Schema.decodeUnknownEffect(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(0),
    result: Schema.optionalKey(Schema.Struct({ protocolVersion: Schema.String })),
    error: Schema.optionalKey(Schema.Struct({ code: Schema.Number })),
  }),
);
const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    error: Schema.optionalKey(Schema.Struct({ code: Schema.Number })),
    result: Schema.optionalKey(
      Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(512)) }),
        ).check(Schema.isMaxLength(1000)),
        nextCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
      }),
    ),
  }),
);
export class PeerFactRelayDiscovery extends Context.Service<
  PeerFactRelayDiscovery,
  {
    readonly require: (
      authorization: Ports.RelayAuthorization,
    ) => Effect.Effect<void, Ports.RelayPeerError>;
  }
>()("t3/peer/PeerFactRelayDiscovery") {}
const isPeerError = Schema.is(Ports.RelayPeerError);
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
    : text;
const make = Effect.gen(function* () {
  const links = yield* Links.PeerLinks;
  const access = yield* Ports.AgentFactRelayAccess;
  const fresh = Effect.fn("PeerFactRelayDiscovery.fresh")(
    function* (authorization: Ports.RelayAuthorization) {
      const current = yield* access.outgoing(authorization.peerEnvironmentId);
      if (
        current.verdict !== "allowed" ||
        current.authorization.peerEnvironmentId !== authorization.peerEnvironmentId ||
        current.authorization.generation !== authorization.generation
      )
        return yield* new Ports.RelayPeerError({ reason: "refused" });
    },
    (effect) => access.withGate(effect),
  );
  const dispatch = yield* Network.capture;
  const cache = yield* Ref.make<
    ReadonlyMap<string, { readonly at: number; readonly supported: boolean }>
  >(new Map());
  const inspect = Effect.fn("PeerFactRelayDiscovery.inspect")(function* (
    authorization: Ports.RelayAuthorization,
  ) {
    const link = yield* links.resolve(EnvironmentId.make(authorization.peerEnvironmentId));
    const headers = {
      authorization: `Bearer ${link.token}`,
      accept: "application/json, text/event-stream",
      [Invocation.MODE_LIMIT_HEADER]: `${authorization.limits.runtimeMode}/${authorization.limits.interactionMode}`,
    };
    const post = (body: unknown, extra: Record<string, string> = {}) =>
      fresh(authorization).pipe(
        Effect.andThen(
          dispatch.execute(
            HttpClientRequest.post(`${link.url}/mcp`).pipe(
              HttpClientRequest.setHeaders({ ...headers, ...extra }),
              HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
            ),
            fresh(authorization),
          ),
        ),
      );
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const response = yield* post({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t3-fact-relay-discovery", version: "1" },
          },
        });
        if (response.status !== 200 || response.headers["mcp-session-id"] === undefined)
          return yield* new Ports.RelayPeerError({
            reason: response.status === 401 || response.status === 403 ? "refused" : "unreachable",
          });
        const sessionHeaders = {
          "mcp-session-id": response.headers["mcp-session-id"],
          "mcp-protocol-version": "2025-06-18",
        };
        return { sessionHeaders, response };
      }).pipe(Effect.interruptible),
      ({ sessionHeaders, response: initialization }) =>
        Effect.gen(function* () {
          const initializedText = yield* initialization.text;
          if (Buffer.byteLength(initializedText, "utf8") > 2 * 1024 * 1024)
            return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
          const initialized = yield* decodeInitialize(
            yield* decodeJson(
              responseJson(initialization.headers["content-type"], initializedText),
            ),
          );
          if (
            initialized.error !== undefined ||
            initialized.result?.protocolVersion !== "2025-06-18"
          )
            return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
          const notified = yield* post(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            sessionHeaders,
          );
          if (notified.status < 200 || notified.status >= 300)
            return yield* new Ports.RelayPeerError({
              reason:
                notified.status === 401 || notified.status === 403 ? "refused" : "unreachable",
            });
          let cursor: string | undefined;
          const seen = new Set<string>();
          const tools = new Set<string>();
          for (let page = 0; page < 32; page++) {
            const response = yield* post(
              {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: cursor === undefined ? {} : { cursor },
              },
              sessionHeaders,
            );
            if (response.status !== 200)
              return yield* new Ports.RelayPeerError({
                reason:
                  response.status === 401 || response.status === 403 ? "refused" : "unreachable",
              });
            const text = yield* response.text;
            if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
              return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
            const json =
              response.headers["content-type"]?.includes("text/event-stream") === true
                ? text
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trim())
                    .join("")
                : text;
            const catalog = yield* decodeCatalog(yield* decodeJson(json));
            if (catalog.error !== undefined && catalog.result !== undefined)
              return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
            if (catalog.error?.code === -32601) return false;
            if (catalog.error !== undefined || catalog.result === undefined)
              return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
            for (const tool of catalog.result.tools) tools.add(tool.name);
            if (tools.has("t3_link_agent_facts") && tools.has("t3_link_agent_fact_authority"))
              return true;
            cursor = catalog.result.nextCursor;
            if (cursor === undefined) return false;
            if (seen.has(cursor))
              return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
            seen.add(cursor);
          }
          return yield* new Ports.RelayPeerError({ reason: "invalid_response" });
        }),
      ({ sessionHeaders }) =>
        dispatch
          .execute(
            HttpClientRequest.delete(`${link.url}/mcp`).pipe(
              HttpClientRequest.setHeaders({ ...headers, ...sessionHeaders }),
            ),
            fresh(authorization),
          )
          .pipe(Effect.interruptible, Effect.timeoutOption("1 second"), Effect.ignoreCause),
    ).pipe(Effect.timeout("15 seconds"));
  });
  const require = Effect.fn("PeerFactRelayDiscovery.require")(
    function* (authorization: Ports.RelayAuthorization) {
      yield* fresh(authorization);
      const key = `${authorization.peerEnvironmentId}:${authorization.generation}`;
      const now = yield* Clock.currentTimeMillis;
      const saved = (yield* Ref.get(cache)).get(key);
      const supported =
        saved !== undefined && now - saved.at < (saved.supported ? 5 * 60_000 : 60 * 60_000)
          ? saved.supported
          : yield* inspect(authorization).pipe(
              Effect.tap(() => fresh(authorization)),
              Effect.tap((supported) =>
                Ref.update(cache, (current) => {
                  const next = new Map(
                    [...current].filter(
                      ([entry]) => !entry.startsWith(`${authorization.peerEnvironmentId}:`),
                    ),
                  );
                  next.set(key, { at: now, supported });
                  return next;
                }),
              ),
            );
      if (!supported) return yield* new Ports.RelayPeerError({ reason: "unsupported" });
    },
    Effect.mapError((cause) =>
      isPeerError(cause) ? cause : new Ports.RelayPeerError({ reason: "unreachable", cause }),
    ),
  );
  return PeerFactRelayDiscovery.of({ require });
});
export const layer = Layer.effect(PeerFactRelayDiscovery, make);
