import { AGENT_EVENTS_PROTOCOL_VERSION, AgentEventsErrorCode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Types from "effect/Types";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as AgentEventAuthority from "../../agentEvents/AgentEventAuthority.ts";
import * as AgentEventDelivery from "../../agentEvents/AgentEventDelivery.ts";
import * as AgentFactAuthority from "../../agentEvents/AgentFactAuthority.ts";
import * as AgentFactRuntime from "../../agentEvents/AgentFactRuntime.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Subscriptions from "../../agentEvents/AgentEventSubscriptions.ts";
import { layerTransport, WebhookTransport } from "../../agentEvents/WebhookSender.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type * as McpInvocationContext from "../McpInvocationContext.ts";
import { classify, type Classified, type RequestId } from "./McpEventsAdmission.ts";

/** The MCP protocol versions `/mcp` registers, decided once at startup. */
const SESSION_PROTOCOL_VERSION = "2025-06-18";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const MAX_TRACKED_SESSIONS = 1_000;

type InnerEffect = Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>;
type HandledEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

/**
 * T3 Code LAN: MCP Events on `/mcp`, after its auth middleware. Answers `events/*` that
 * `McpEventsAdmission` admits and adds `capabilities.events` to effect's `server/discover` and
 * session `initialize`. All else, and everything while `agentEventsEnabled` is off, is untouched.
 */
export class McpEventsEndpoint extends Context.Service<
  McpEventsEndpoint,
  {
    /** Whether `2026-07-28` should be registered on `/mcp`, read once at startup. */
    readonly statelessEnabled: boolean;
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
      scope: McpInvocationContext.McpInvocationScope,
      inner: InnerEffect,
    ) => HandledEffect;
  }
>()("t3/mcp/events/McpEventsEndpoint") {}

const jsonRpc = (body: unknown, status = 200) =>
  HttpServerResponse.text(encodeJson(body), {
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
  });

const resultMeta = {
  "io.modelcontextprotocol/serverInfo": { name: "T3 Code", version: packageJson.version },
};

export type CapabilityPatch =
  | { readonly _tag: "Patched"; readonly body: string }
  | { readonly _tag: "Unexpected"; readonly detail: string };

/** Adds `events: {}` to a single JSON-RPC result's capabilities, or says why it cannot. */
export const addEventsCapability = (text: string): CapabilityPatch => {
  const parsed = Option.getOrUndefined(decodeJson(text.trimEnd()));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { _tag: "Unexpected", detail: "not a single JSON-RPC message" };
  const message = parsed as Record<string, unknown>;
  if ("error" in message) return { _tag: "Unexpected", detail: "an error response" };
  const result = message.result;
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return { _tag: "Unexpected", detail: "no result object" };
  const capabilities = (result as Record<string, unknown>).capabilities;
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities))
    return { _tag: "Unexpected", detail: "no result.capabilities object" };
  return {
    _tag: "Patched",
    body: `${encodeJson({ ...message, result: { ...result, capabilities: { ...capabilities, events: {} } } })}\n`,
  };
};

const patchCapabilities = Effect.fn("McpEventsEndpoint.patchCapabilities")(function* (
  method: string,
  response: HttpServerResponse.HttpServerResponse,
) {
  if (response.status !== 200) return response;
  const contentType =
    response.headers["content-type"] ??
    (response.body._tag === "Uint8Array" ? response.body.contentType : undefined);
  const diagnostic = (detail: string) =>
    Effect.logWarning(
      "MCP Events: effect's result has an unexpected shape, so this response does not advertise events.",
      { method, detail, contentType },
    ).pipe(Effect.as(response));
  if (response.body._tag !== "Uint8Array") return yield* diagnostic(`a ${response.body._tag} body`);
  if (!String(contentType ?? "").startsWith("application/json"))
    return yield* diagnostic("not application/json");
  const patched = addEventsCapability(new TextDecoder().decode(response.body.body));
  if (patched._tag === "Unexpected") return yield* diagnostic(patched.detail);
  return HttpServerResponse.text(patched.body, {
    status: response.status,
    headers: response.headers,
    contentType: "application/json",
  });
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const enabledNow = settings.getSettings.pipe(
    Effect.map((current) => current.agentEventsEnabled),
    Effect.orElseSucceed(() => false),
  );
  const statelessEnabled = yield* enabledNow;
  const services = yield* Effect.context<
    | SqlClient.SqlClient
    | ServerSecretStore.ServerSecretStore
    | AgentEventAuthority.AgentEventAuthority
    | WebhookTransport
  >();
  const delivery = yield* Effect.serviceOption(AgentEventDelivery.AgentEventDelivery);
  const supportedVersions = statelessEnabled
    ? [SESSION_PROTOCOL_VERSION, AGENT_EVENTS_PROTOCOL_VERSION]
    : [SESSION_PROTOCOL_VERSION];
  // Session ids this endpoint saw `initialize` create, per signed-in session. effect keeps its
  // sessions in memory too, so after a restart neither knows them.
  const sessions = new Map<string, { readonly owner: string; readonly version: string }>();
  const track = (sessionId: string, owner: string, version: string) => {
    sessions.delete(sessionId);
    sessions.set(sessionId, { owner, version });
    if (sessions.size > MAX_TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value!);
  };

  const dispatch = (
    classified: Extract<Classified, { readonly _tag: "Events" }>,
    scope: McpInvocationContext.McpInvocationScope,
  ) => {
    const run: Effect.Effect<
      object,
      Subscriptions.EventsRpcError,
      | SqlClient.SqlClient
      | ServerSecretStore.ServerSecretStore
      | AgentEventAuthority.AgentEventAuthority
      | WebhookTransport
    > =
      classified.method === "events/list"
        ? Subscriptions.listEvents(scope)
        : classified.method === "events/subscribe"
          ? Subscriptions.subscribe(scope, classified.params)
          : Subscriptions.unsubscribe(scope, classified.params);
    const id: RequestId = classified.id;
    return run.pipe(
      Effect.tap(() =>
        classified.method === "events/subscribe" && Option.isSome(delivery)
          ? delivery.value.wake
          : Effect.void,
      ),
      Effect.map((result) =>
        jsonRpc({
          jsonrpc: "2.0",
          id,
          result:
            classified.profile === "stateless"
              ? { ...result, _meta: resultMeta, resultType: "complete" }
              : result,
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          jsonRpc({
            jsonrpc: "2.0",
            id,
            error: {
              code: error.code,
              message: error.detail,
              ...(error.data === undefined ? {} : { data: error.data }),
            },
          }),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("MCP Events request failed.", { cause }).pipe(
          Effect.as(
            jsonRpc({
              jsonrpc: "2.0",
              id,
              error: { code: AgentEventsErrorCode.internal, message: "Internal error" },
            }),
          ),
        ),
      ),
      Effect.provide(services),
    );
  };

  const handle: McpEventsEndpoint["Service"]["handle"] = Effect.fn("McpEventsEndpoint.handle")(
    function* (request, scope, inner) {
      if (!statelessEnabled || !(yield* enabledNow)) return yield* inner;
      const owner = scope.client?.sessionId ?? scope.requestNamespace;
      const sessionHeader = request.headers["mcp-session-id"];
      if (request.method === "DELETE") {
        const response = yield* inner;
        if (response.status === 204 && sessionHeader !== undefined) sessions.delete(sessionHeader);
        return response;
      }
      if (request.method !== "POST") return yield* inner;
      const body = yield* request.text.pipe(Effect.option);
      if (Option.isNone(body)) return yield* inner;
      const classified = yield* classify({
        method: request.method,
        headers: request.headers,
        body: body.value,
        statelessEnabled,
        supportedVersions,
        sessionVersion: (sessionId) => {
          const known = sessions.get(sessionId);
          return known?.owner === owner ? known.version : undefined;
        },
      });
      switch (classified._tag) {
        case "Other":
          return yield* inner;
        case "Events":
          return yield* dispatch(classified, scope);
        case "Discover":
          return yield* inner.pipe(
            Effect.flatMap((response) => patchCapabilities("server/discover", response)),
          );
        case "Initialize": {
          const response = yield* inner;
          // effect adds the session headers in a pre-response handler; this one runs after it.
          yield* HttpEffect.appendPreResponseHandler((_request, written) =>
            Effect.sync(() => {
              const created = written.headers["mcp-session-id"];
              const version = written.headers["mcp-protocol-version"];
              if (created !== undefined && version !== undefined) track(created, owner, version);
              return written;
            }),
          );
          return yield* patchCapabilities("initialize", response);
        }
      }
    },
  );

  return McpEventsEndpoint.of({ statelessEnabled, handle });
});

export const layer = Layer.effect(McpEventsEndpoint, make);

/** The endpoint with its delivery worker, authority checks and webhook transport. */
export const layerLive = layer.pipe(
  Layer.provideMerge(AgentFactRuntime.layer),
  Layer.provideMerge(AgentEventDelivery.layer),
  Layer.provideMerge(AgentFactAuthority.layer),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(AgentEventAuthority.layer),
  Layer.provideMerge(layerTransport),
);
