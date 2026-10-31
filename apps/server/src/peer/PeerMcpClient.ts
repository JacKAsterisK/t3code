import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as Network from "./PeerNetworkDispatch.ts";
import { INITIATING_CLIENT_HEADER } from "../approvals/ApprovalLaunchProvenance.ts";

/** The only MCP protocol version a T3 Code `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    /** Calls `tool` on the peer and decodes its structured result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(input: {
      readonly environmentId: EnvironmentId;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: PeerCallLimits;
      /**
       * Whether the call changes anything there, as the tool's declaration says
       * (`McpToolAccess.writesOf`): the rule the peer applies to a read-only link.
       */
      readonly writes: boolean;
      readonly initiatingClientId?: string;
      /** Internal live admission, after DNS and before every guarded send. */
      readonly beforeSend?: Effect.Effect<void, OrchestratorMcpFailure>;
      /** Guarded tools/call deadline, after link probing; setup sends retain their own bounds. */
      readonly requestTimeoutMs?: number;
      readonly success: S;
    }) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

/**
 * Whether this environment's own rules let it change anything in a linked
 * environment now, read on every call. The peer caps a link only once its own
 * view agrees, so a narrowing seen here first is enforced here: the link keeps
 * reading, and its writes stop at once.
 */
export class PeerWriteCeiling extends Context.Service<
  PeerWriteCeiling,
  { readonly writable: (environmentId: EnvironmentId) => Effect.Effect<boolean> }
>()("t3/peer/PeerMcpClient/PeerWriteCeiling") {}

/** No rule here narrows a link: the peer alone decides. */
export const layerUnrestricted = Layer.succeed(PeerWriteCeiling, {
  writable: Effect.fn("PeerWriteCeiling.unrestricted")(() => Effect.succeed(true)),
});

const writeRefused = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This tool changes the linked environment, and this machine's Machine access list makes it read-only there. Reading there still works.",
});

class BeforeSendRefused extends Schema.TaggedError<BeforeSendRefused>()(
  "PeerMcpBeforeSendRefused",
  { failure: OrchestratorMcpFailure },
) {}

const ToolCallResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeToolCallResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String }),
  ),
);

/** A peer link problem, as the agent that asked hears it. */
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

/** Not final, so a task already running there resumes once the beta is on there again. */
const linkedEnvironmentsOffThere = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message:
    "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.",
});

/** The body of an MCP response: JSON, or a single server-sent event carrying JSON. */
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const ceiling = yield* PeerWriteCeiling;
  const httpClient = yield* HttpClient.HttpClient;
  const dispatch = yield* Network.capture;
  // One MCP session per peer and address, reused across calls. The peer keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  // A write goes only while this machine's own list lets it write there.
  const writeAllowed = (input: {
    readonly environmentId: EnvironmentId;
    readonly writes: boolean;
  }) =>
    input.writes
      ? ceiling
          .writable(input.environmentId)
          .pipe(Effect.flatMap((writable) => (writable ? Effect.void : Effect.fail(writeRefused))))
      : Effect.void;

  const post = (
    url: string,
    token: string,
    body: unknown,
    headers: Record<string, string>,
    beforeSend?: Effect.Effect<void, OrchestratorMcpFailure>,
    timeoutMs = 15_000,
  ) => {
    const request = HttpClientRequest.post(`${url}/mcp`).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...headers,
      }),
      HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
    );
    return beforeSend === undefined
      ? httpClient.execute(request)
      : dispatch
          .execute(
            request,
            beforeSend.pipe(Effect.mapError((failure) => new BeforeSendRefused({ failure }))),
          )
          .pipe(Effect.timeout(timeoutMs));
  };

  const openSession = Effect.fn("PeerMcpClient.openSession")(function* (
    url: string,
    token: string,
    limitHeader: Record<string, string>,
    beforeSend?: Effect.Effect<void, OrchestratorMcpFailure>,
  ) {
    const initialized = yield* post(
      url,
      token,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3code-peer", version: "1" },
        },
      },
      limitHeader,
      beforeSend,
    );
    const sessionId = initialized.headers["mcp-session-id"];
    if (initialized.status === 403) return yield* linkedEnvironmentsOffThere;
    if (initialized.status !== 200 || sessionId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: initialized.status === 401 ? "capability_denied" : "orchestration_error",
        message:
          initialized.status === 401
            ? "The linked environment no longer accepts this link. It may have been revoked there; link it again."
            : `The linked environment refused to start an MCP session (HTTP ${initialized.status}).`,
      });
    }
    yield* post(
      url,
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
      beforeSend,
    );
    return sessionId;
  });

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(
    function* (input) {
      const resolved = yield* links
        .resolve(input.environmentId)
        .pipe(Effect.mapError(fromLinkError));
      const limitHeader = {
        ...(input.initiatingClientId === undefined
          ? {}
          : { [INITIATING_CLIENT_HEADER]: input.initiatingClientId }),
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
      };
      const sessionKey = `${input.environmentId} ${resolved.url}`;
      // Read again right before each send, the retry's included: the list may narrow while this
      // call resolves the link or starts a session, and a write then never leaves this machine.
      const callOnce = (sessionId: string) =>
        writeAllowed(input).pipe(
          Effect.andThen(
            post(
              resolved.url,
              resolved.token,
              {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: input.tool, arguments: input.arguments },
              },
              {
                ...limitHeader,
                "mcp-session-id": sessionId,
                "mcp-protocol-version": PROTOCOL_VERSION,
              },
              input.beforeSend,
              input.requestTimeoutMs,
            ),
          ),
        );
      const existing = (yield* Ref.get(sessions)).get(sessionKey);
      const sessionId =
        existing ??
        (yield* openSession(resolved.url, resolved.token, limitHeader, input.beforeSend));
      let response = yield* callOnce(sessionId);
      if (response.status === 404) {
        const renewed = yield* openSession(
          resolved.url,
          resolved.token,
          limitHeader,
          input.beforeSend,
        );
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, renewed));
        response = yield* callOnce(renewed);
      } else if (existing === undefined) {
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, sessionId));
      }
      if (response.status === 401) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
        });
      }
      if (response.status === 403) return yield* linkedEnvironmentsOffThere;
      if (response.status !== 200) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `The linked environment answered HTTP ${response.status}.`,
        });
      }
      const body = yield* decodeToolCallResponse(
        responseJson(response.headers["content-type"], yield* response.text),
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment answered in an unexpected shape.",
            }),
        ),
      );
      if (body.error !== undefined || body.result === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: body.error?.message ?? "The linked environment returned no result.",
        });
      }
      const text = body.result.content.map((part) => part.text ?? "").join("");
      if (body.result.isError === true) {
        // A refusal keeps the peer's own code, so the agent sees why it was refused.
        const refused = decodeFailure(text);
        return yield* refused._tag === "Some"
          ? new OrchestratorMcpFailure({ code: refused.value.code, message: refused.value.message })
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: text || "The linked environment refused the call.",
            });
      }
      const success = Schema.fromJsonString(input.success);
      return yield* Schema.decodeEffect(success)(text).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "The linked environment's answer did not match this version. Update both environments.",
            }),
        ),
      );
    },
    (effect, input) =>
      // Refused here, before the token goes anywhere; the link itself is fine, so not recorded.
      writeAllowed(input).pipe(
        Effect.andThen(
          effect.pipe(
            Effect.tapError((error) =>
              error === writeRefused || error._tag === "PeerMcpBeforeSendRefused"
                ? Effect.void
                : links.recordOutcome(input.environmentId, { error: error.message }),
            ),
            Effect.tap(() => links.recordOutcome(input.environmentId, { error: null })),
            // Recorded above with the transport's own message; the agent hears it plainly.
            Effect.catchTags({
              PeerMcpBeforeSendRefused: (error) => Effect.fail(error.failure),
              TimeoutError: () =>
                Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "The linked environment stopped answering.",
                  }),
                ),
              HttpClientError: () =>
                Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "The linked environment stopped answering.",
                  }),
                ),
            }),
          ),
        ),
      ),
  );

  return PeerMcpClient.of({ call });
});

export const layer = Layer.effect(PeerMcpClient, make);
