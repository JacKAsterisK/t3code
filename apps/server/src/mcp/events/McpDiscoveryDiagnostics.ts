// @effect-diagnostics nodeBuiltinImport:off -- Correlation IDs are generated locally and never copied from client headers or RPC ids.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { HttpServerResponse } from "effect/http";
import { mcpMediaTypes, type AdmissionReason } from "./McpEventsAdmission.ts";

const MAX_INSPECT_BYTES = 65_536;
const methods = ["initialize", "server/discover", "events/list"] as const;
type DiscoveryMethod = (typeof methods)[number];
const method = (value: unknown): DiscoveryMethod | null =>
  methods.includes(value as DiscoveryMethod) ? (value as DiscoveryMethod) : null;
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const version = (value: unknown): string | null =>
  value === undefined
    ? null
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? value
      : "invalid";
const contentType = (value: string | undefined) => {
  if (value === undefined) return null;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return ["application/json", "text/event-stream", "text/plain"].includes(type ?? "")
    ? type
    : "other";
};
const parse = (text: string) => {
  if (text.length > MAX_INSPECT_BYTES) return undefined;
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
};

export interface Observation {
  relevant: boolean;
  rpcMethod: DiscoveryMethod | "unknown";
  rpcMethodSource: "header" | "body" | "unavailable";
  protocolVersion: string | null;
  protocolHeaderVersion: string | null;
  protocolClaimVersion: string | null;
  originPresent: boolean;
  sessionIdPresent: boolean;
  admission:
    | AdmissionReason
    | "not_classified"
    | "authentication_rejected"
    | "invalid_mode_limit"
    | "linked_environments_disabled"
    | "events_disabled_at_startup"
    | "events_disabled_now"
    | "endpoint_unavailable";
  capabilityInjection:
    | "not_attempted"
    | "injected"
    | "skipped_http_status"
    | "skipped_non_materialized"
    | "skipped_content_type"
    | "skipped_shape";
  errorCategory:
    | "authentication_required"
    | "authentication_rejected"
    | "invalid_mode_limit"
    | "linked_environments_disabled"
    | null;
  emitted: boolean;
}

/** Values are allowlisted scalars only. This object never retains a body, URL, credential or session id. */
export const begin = (headers: Readonly<Record<string, string | undefined>>): Observation => ({
  relevant: method(headers["mcp-method"]) !== null,
  rpcMethod: method(headers["mcp-method"]) ?? "unknown",
  rpcMethodSource: method(headers["mcp-method"]) === null ? "unavailable" : "header",
  protocolVersion: version(headers["mcp-protocol-version"]),
  protocolHeaderVersion: version(headers["mcp-protocol-version"]),
  protocolClaimVersion: null,
  originPresent: headers.origin !== undefined,
  sessionIdPresent: headers["mcp-session-id"] !== undefined,
  admission: "not_classified",
  capabilityInjection: "not_attempted",
  errorCategory: null,
  emitted: false,
});

/** Avoid buffering a body that the transport would reject from its headers alone. */
export const mayInspectRequestBody = (headers: Readonly<Record<string, string | undefined>>) => {
  const accepted = mcpMediaTypes(headers.accept);
  return (
    headers.origin === undefined &&
    mcpMediaTypes(headers["content-type"])[0] === "application/json" &&
    accepted.includes("application/json") &&
    accepted.includes("text/event-stream")
  );
};

/** Only called after authentication. Parse bounded metadata; discard every other request field. */
export const inspectRequest = (observation: Observation, text: string) => {
  const message = parse(text);
  const rpcMethod = method(message?.method);
  if (rpcMethod !== null) {
    observation.rpcMethod = rpcMethod;
    observation.rpcMethodSource = "body";
    observation.relevant = true;
  }
  const params = record(message?.params);
  const meta = record(params?._meta);
  observation.protocolClaimVersion = version(meta?.["io.modelcontextprotocol/protocolVersion"]);
  observation.protocolVersion ??=
    version(params?.protocolVersion) ?? observation.protocolClaimVersion;
};

const rpcErrorCategory = (code: unknown): string | null => {
  if (code === undefined) return null;
  switch (code) {
    case -32700:
      return "parse_error";
    case -32600:
      return "invalid_request";
    case -32601:
      return "method_not_found";
    case -32602:
      return "invalid_params";
    case -32603:
      return "internal_error";
    case -32024:
      return "forbidden";
    default:
      return "rpc_error";
  }
};

/** One bounded record for discovery/list, or an early auth rejection. Never consume a response stream. */
export const logResponse = Effect.fn("McpDiscoveryDiagnostics.logResponse")(function* (
  observation: Observation,
  response?: HttpServerResponse.HttpServerResponse,
) {
  if (!observation.relevant || observation.emitted) return;
  observation.emitted = true;
  const type =
    response?.headers["content-type"] ??
    (response?.body._tag === "Uint8Array" ? response.body.contentType : undefined);
  const inspected =
    response?.body._tag === "Uint8Array" &&
    response.body.body.length <= MAX_INSPECT_BYTES &&
    contentType(type) === "application/json";
  const message = inspected ? parse(new TextDecoder().decode(response.body.body)) : undefined;
  const result = record(message?.result);
  const capabilities = record(result?.capabilities);
  const errorCategory =
    observation.errorCategory ??
    rpcErrorCategory(record(message?.error)?.code) ??
    (response === undefined ? "request_failed" : response.status >= 400 ? "http_rejected" : null);
  const metadata = {
    timestamp: DateTime.formatIso(yield* DateTime.now),
    correlationId: NodeCrypto.randomUUID(),
    phase: response === undefined ? "request_failed" : "pre_response",
    rpcMethod: observation.rpcMethod,
    rpcMethodSource: observation.rpcMethodSource,
    protocolVersion: observation.protocolVersion,
    protocolHeaderVersion: observation.protocolHeaderVersion,
    protocolClaimVersion: observation.protocolClaimVersion,
    negotiatedProtocolVersion:
      version(response?.headers["mcp-protocol-version"]) ?? version(result?.protocolVersion),
    httpStatus: response?.status ?? null,
    contentType: contentType(type),
    responseBodyKind: response?.body._tag ?? null,
    // null means uninspected, not absent. In particular, streams are never drained for logging.
    eventsCapabilityPresent:
      message === undefined
        ? null
        : capabilities !== undefined && Object.hasOwn(capabilities, "events"),
    eventsCount: Array.isArray(result?.events) ? result.events.length : null,
    admission: observation.admission,
    capabilityInjection: observation.capabilityInjection,
    errorCategory,
    originPresent: observation.originPresent,
    sessionIdPresent: observation.sessionIdPresent,
  };
  yield* errorCategory === "authentication_required" || errorCategory === "authentication_rejected"
    ? Effect.logWarning("MCP discovery metadata", metadata)
    : Effect.logInfo("MCP discovery metadata", metadata);
});
