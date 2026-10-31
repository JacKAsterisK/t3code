import { AGENT_EVENTS_PROTOCOL_VERSION } from "@t3tools/contracts";
import { McpProtocol } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * T3 Code LAN: the `/mcp` POSTs effect 4.0.5 would admit were `events/*` its own methods
 * (`addMcpHttpRoutes`, `mcpRuntime.ts` admission, its metadata decoder). Only ever stricter:
 * the rest reach effect unchanged and get its own errors. Pinned by McpEventsEndpoint.test.ts.
 */

const EVENTS_METHODS = ["events/list", "events/subscribe", "events/unsubscribe"] as const;
export type EventsMethod = (typeof EVENTS_METHODS)[number];

const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const SESSION_ID_HEADER = "mcp-session-id";
const METHOD_HEADER = "mcp-method";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

export type RequestId = string | number;

export type Classified =
  /** Not for the events endpoint: effect handles it as before. */
  | { readonly _tag: "Other" }
  | {
      readonly _tag: "Events";
      readonly id: RequestId;
      readonly method: EventsMethod;
      readonly params: unknown;
      readonly profile: "stateless" | "session";
    }
  /** `server/discover` effect will answer; the endpoint adds `capabilities.events`. */
  | { readonly _tag: "Discover" }
  /** A session `initialize` effect will answer; the endpoint adds `capabilities.events`. */
  | { readonly _tag: "Initialize" };

/** `McpServer.ts` `mcpMediaTypes`: media types in order, dropping `q=0` and malformed `q`. */
const mcpMediaTypes = (header: string | undefined): ReadonlyArray<string> =>
  header === undefined
    ? []
    : header.split(",").flatMap((part) => {
        const [mediaType = "", ...parameters] = part.split(";");
        const quality = parameters
          .map((parameter) => parameter.trim().toLowerCase())
          .find((parameter) => parameter.startsWith("q="));
        if (quality !== undefined) {
          const value = Number(quality.slice(2));
          if (!Number.isFinite(value) || value <= 0 || value > 1) return [];
        }
        return [mediaType.trim().toLowerCase()];
      });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isEventsMethod = (method: string): method is EventsMethod =>
  (EVENTS_METHODS as ReadonlyArray<string>).includes(method);

const statelessProfile = McpProtocol.v2026_07_28.runtime.profileFromRequestMetadata;

export interface ClassifyInput {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /** Whether `/mcp` registered `2026-07-28` at startup. */
  readonly statelessEnabled: boolean;
  /** The protocol version a session this endpoint saw initialize negotiated, if any. */
  readonly sessionVersion: (sessionId: string) => string | undefined;
  readonly supportedVersions: ReadonlyArray<string>;
}

export const classify = Effect.fn("McpEventsAdmission.classify")(function* (
  input: ClassifyInput,
): Effect.fn.Return<Classified> {
  const other: Classified = { _tag: "Other" };
  const { headers } = input;
  // addMcpHttpRoutes: no browser Origin (no allowed origins are configured), JSON in, JSON and
  // SSE accepted.
  if (input.method !== "POST" || headers.origin !== undefined) return other;
  if (mcpMediaTypes(headers["content-type"])[0] !== "application/json") return other;
  const accepted = mcpMediaTypes(headers.accept);
  if (!accepted.includes("application/json") || !accepted.includes("text/event-stream"))
    return other;
  // admitHttp: one JSON-RPC request with an id. Parse errors, batches and notifications are
  // effect's to answer.
  const message = asRecord(Option.getOrUndefined(decodeJson(input.body)));
  if (message === undefined || Array.isArray(message)) return other;
  const id = message.id;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return other;
  if (typeof id !== "string" && typeof id !== "number") return other;
  const method = message.method;
  const params = asRecord(message.params);
  const metadata = asRecord(params?._meta);
  const claimPresent = metadata !== undefined && PROTOCOL_VERSION_META in metadata;
  const version = headers[PROTOCOL_VERSION_HEADER];

  if (claimPresent || (input.statelessEnabled && version === AGENT_EVENTS_PROTOCOL_VERSION)) {
    // selectHttpProtocol's stateless branch, then prepareRequest's metadata decoding.
    if (!input.statelessEnabled || version !== AGENT_EVENTS_PROTOCOL_VERSION) return other;
    if (metadata === undefined || metadata[PROTOCOL_VERSION_META] !== version) return other;
    if (asRecord(metadata[CLIENT_CAPABILITIES_META]) === undefined) return other;
    if (headers[METHOD_HEADER] !== method) return other;
    // effect types the decoder failure as unknown; any failure means effect would refuse it.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const profile = yield* statelessProfile(metadata).pipe(Effect.option);
    if (Option.isNone(profile) || profile.value.protocolVersion !== version) return other;
    if (method === "server/discover") return { _tag: "Discover" } as const;
    return isEventsMethod(method)
      ? ({ _tag: "Events", id, method, params: message.params, profile: "stateless" } as const)
      : other;
  }

  // selectHttpSession: a session request. initialize must not carry a session id; anything else
  // needs one effect knows. This endpoint only knows the sessions it saw initialize, a subset.
  const sessionId = headers[SESSION_ID_HEADER];
  if (method === "initialize") return sessionId === undefined ? { _tag: "Initialize" } : other;
  if (!isEventsMethod(method) || sessionId === undefined) return other;
  const negotiated = input.sessionVersion(sessionId);
  if (negotiated === undefined) return other;
  if (
    version !== undefined &&
    (!input.supportedVersions.includes(version) || version !== negotiated)
  )
    return other;
  return { _tag: "Events", id, method, params: message.params, profile: "session" } as const;
});
