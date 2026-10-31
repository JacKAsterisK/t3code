import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentEventsErrorCode,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import {
  allowed,
  layerAuthority,
  layerDatabase,
  layerMemorySecrets,
  testSecret,
} from "../../agentEvents/AgentEvents.testkit.ts";
import type * as AgentEventAuthority from "../../agentEvents/AgentEventAuthority.ts";
import { WebhookTransport } from "../../agentEvents/WebhookSender.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import * as McpEventsEndpoint from "./McpEventsEndpoint.ts";

const V2026 = "2026-07-28";
const V2025 = "2025-06-18";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const clientScope = (
  sessionId: string,
  client: Partial<McpInvocationContext.McpClientCaller> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:buildmachine"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: {
    sessionId,
    label: "Gecko Butler",
    access: "approval-required",
    sharesOutside: true,
    ...client,
  },
});

const scopes: Record<string, McpInvocationContext.McpInvocationScope> = {
  "token-dot": clientScope("session-dot"),
  "token-linked": clientScope("session-linked", { linked: true }),
  "token-task": clientScope("session-task", { taskOnly: true, grantId: "grant-1" }),
};

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Answers ok.",
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

const echoChallenge = WebhookTransport.of({
  post: ({ body }) =>
    Effect.succeed({
      _tag: "Response",
      status: 200,
      retryAfter: undefined,
      body: JSON.stringify({ challenge: (decodeJson(body) as { challenge?: string }).challenge }),
      remoteAddress: "203.0.113.1",
    } as const),
});

/** The real `/mcp` stack: effect's transport, T3's auth middleware and the events endpoint. */
const serve = (options: { readonly eventsEnabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const settingsContext = yield* Layer.build(
      ServerSettings.layerTest({
        agentEventsEnabled: options.eventsEnabled ?? true,
        linkedEnvironmentsEnabled: true,
      }),
    );
    const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
    const verdicts = yield* Ref.make<ReadonlyMap<string, AgentEventAuthority.AuthorityVerdict>>(
      new Map([["session-dot", allowed()]]),
    );
    const endpoint = McpEventsEndpoint.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerDatabase,
          layerMemorySecrets,
          layerAuthority(verdicts),
          Layer.succeed(WebhookTransport, echoChallenge),
        ),
      ),
    );
    const serverLayer = McpHttpServer.toolkitRegistration(
      ProbeToolkit,
      McpToolAccess.toLayer(ProbeToolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
      }),
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerMcpTransport.pipe(Layer.provide(endpoint))),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) =>
            Effect.succeed(
              token === "token-thread"
                ? ({
                    environmentId: EnvironmentId.make("environment:buildmachine"),
                    capabilities: new Set(["orchestration"]),
                    issuedAt: 1,
                    requestNamespace: "provider-session",
                    thread: {
                      threadId: ThreadId.make("thread-1"),
                      providerSessionId: "provider-session",
                      providerInstanceId: ProviderInstanceId.make("codex"),
                    },
                    client: undefined,
                  } as McpInvocationContext.McpThreadInvocationScope)
                : undefined,
            ),
        }),
      ),
      Layer.provide(
        Layer.succeed(McpHttpServer.McpClientAuthenticator, {
          authenticate: (request) =>
            Effect.succeed(scopes[request.headers.authorization?.slice("Bearer ".length) ?? ""]),
        }),
      ),
      Layer.provide(Layer.succeedContext(settingsContext)),
    );
    yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const httpClient = yield* HttpClient.HttpClient;
    const post = (input: {
      readonly body: string;
      readonly headers?: Record<string, string>;
      readonly contentType?: string;
      readonly token?: string;
    }) =>
      httpClient
        .post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${input.token ?? "token-dot"}`,
            ...input.headers,
          },
          body: HttpBody.text(input.body, input.contentType ?? "application/json"),
        })
        .pipe(
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.map((text) => ({ status: response.status, headers: response.headers, text })),
            ),
          ),
        );
    return { post, settings };
  });

const meta = (version = V2026) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "dot", version: "1.0.0" },
});

const statelessRequest = (method: string, params: Record<string, unknown> = {}, id: unknown = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta() } });

const statelessHeaders = (method: string) => ({
  "mcp-protocol-version": V2026,
  "mcp-method": method,
});

const resultOf = (text: string) =>
  (decodeJson(text) as { result?: Record<string, unknown> }).result;
const errorOf = (text: string) =>
  (decodeJson(text) as { error?: { code: number; data?: unknown } }).error;

describe("MCP Events endpoint", () => {
  it.effect("advertises events on 2026-07-28 discovery and answers events/list", () =>
    Effect.gen(function* () {
      const { post } = yield* serve();
      const discover = yield* post({
        body: statelessRequest("server/discover"),
        headers: statelessHeaders("server/discover"),
      });
      assert.strictEqual(discover.status, 200);
      const result = resultOf(discover.text)!;
      const capabilities = result.capabilities as Record<string, unknown>;
      assert.deepStrictEqual(capabilities.events, {});
      assert.isDefined(capabilities.tools);
      assert.deepStrictEqual(result.supportedVersions, [V2025, V2026]);

      const list = yield* post({
        body: statelessRequest("events/list"),
        headers: statelessHeaders("events/list"),
      });
      assert.strictEqual(list.status, 200);
      const events = resultOf(list.text)!;
      assert.strictEqual(events.resultType, "complete");
      assert.deepStrictEqual(
        (events.events as ReadonlyArray<{ name: string; delivery: ReadonlyArray<string> }>).map(
          (event) => [event.name, event.delivery],
        ),
        [
          "t3.task_activity",
          "t3.approval_needed",
          "t3.question_asked",
          "t3.task_blocked",
          "t3.run_finished",
          "t3.owner_changed",
        ].map((name) => [name, ["webhook"]]),
      );
      // 2026 tools keep working beside it.
      const tools = yield* post({
        body: statelessRequest("tools/list"),
        headers: statelessHeaders("tools/list"),
      });
      assert.deepStrictEqual(
        (resultOf(tools.text)!.tools as ReadonlyArray<{ name: string }>).map((tool) => tool.name),
        ["probe"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribes and unsubscribes on 2026-07-28", () =>
    Effect.gen(function* () {
      const { post } = yield* serve();
      const delivery = {
        mode: "webhook",
        url: "https://hooks.example.com/t3",
        secret: testSecret(),
      };
      const subscribed = yield* post({
        body: statelessRequest("events/subscribe", {
          name: "t3.task_activity",
          arguments: {},
          delivery,
          cursor: null,
        }),
        headers: statelessHeaders("events/subscribe"),
      });
      const result = resultOf(subscribed.text)!;
      assert.match(String(result.id), /^sub_/u);
      assert.match(String(result.refreshBefore), /^\d{4}-\d\d-\d\dT/u);
      assert.match(String(result.cursor), /^c1\./u);
      assert.strictEqual(result.truncated, false);
      const unsubscribed = yield* post({
        body: statelessRequest("events/unsubscribe", {
          name: "t3.task_activity",
          arguments: {},
          delivery: { mode: "webhook", url: delivery.url },
        }),
        headers: statelessHeaders("events/unsubscribe"),
      });
      assert.deepStrictEqual(resultOf(unsubscribed.text), {
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "T3 Code",
            version: (
              resultOf(subscribed.text)!._meta as {
                "io.modelcontextprotocol/serverInfo": { version: string };
              }
            )["io.modelcontextprotocol/serverInfo"].version,
          },
        },
        resultType: "complete",
      });
      const owner = yield* post({
        body: statelessRequest("events/subscribe", {
          name: "t3.task_activity",
          arguments: { owner: "dan" },
          delivery,
        }),
        headers: statelessHeaders("events/subscribe"),
      });
      assert.strictEqual(errorOf(owner.text)!.code, AgentEventsErrorCode.invalidParams);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("advertises events on a 2025-06-18 session and answers events/* in it", () =>
    Effect.gen(function* () {
      const { post } = yield* serve();
      const initialize = yield* post({
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: V2025,
            capabilities: {},
            clientInfo: { name: "dot", version: "1" },
          },
        }),
      });
      assert.strictEqual(initialize.status, 200);
      assert.deepStrictEqual(
        (resultOf(initialize.text)!.capabilities as Record<string, unknown>).events,
        {},
      );
      const sessionId = initialize.headers["mcp-session-id"]!;
      const session = { "mcp-session-id": sessionId, "mcp-protocol-version": V2025 };
      const list = yield* post({
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/list", params: {} }),
        headers: session,
      });
      assert.strictEqual(list.status, 200);
      assert.strictEqual((resultOf(list.text)!.events as ReadonlyArray<unknown>).length, 6);
      // The session's tools still work.
      const call = yield* post({
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "probe", arguments: {} },
        }),
        headers: session,
      });
      assert.strictEqual(call.status, 200);
      // Another credential cannot use this session's id for events: effect answers, as before.
      const borrowed = yield* post({
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "events/list", params: {} }),
        headers: session,
        token: "token-task",
      });
      assert.strictEqual(errorOf(borrowed.text)?.code, -32601);
      // A session effect never issued is effect's 404.
      const unknown = yield* post({
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "events/list", params: {} }),
        headers: { "mcp-session-id": "not-a-session", "mcp-protocol-version": V2025 },
      });
      assert.strictEqual(unknown.status, 404);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses thread callers, linked environments and task grants; auth comes first", () =>
    Effect.gen(function* () {
      const { post } = yield* serve();
      for (const token of ["token-thread", "token-linked", "token-task"]) {
        const response = yield* post({
          body: statelessRequest("events/list"),
          headers: statelessHeaders("events/list"),
          token,
        });
        assert.strictEqual(response.status, 200, token);
        assert.strictEqual(errorOf(response.text)?.code, AgentEventsErrorCode.forbidden, token);
      }
      const anonymous = yield* post({
        body: statelessRequest("events/list"),
        headers: statelessHeaders("events/list"),
        token: "nobody",
      });
      assert.strictEqual(anonymous.status, 401);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("admits exactly what effect admits, and leaves the rest to effect untouched", () =>
    Effect.gen(function* () {
      const { post } = yield* serve();
      type Variant = (method: string) => {
        readonly body: string;
        readonly headers?: Record<string, string>;
        readonly contentType?: string;
      };
      const base: Variant = (method) => ({
        body: statelessRequest(method),
        headers: statelessHeaders(method),
      });
      const variants: Record<string, Variant> = {
        base,
        "no protocol header": (method) => ({
          body: statelessRequest(method),
          headers: { "mcp-method": method },
        }),
        "no metadata claim": (method) => ({
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
          headers: statelessHeaders(method),
        }),
        "claim differs from header": (method) => ({
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { _meta: meta(V2025) } }),
          headers: statelessHeaders(method),
        }),
        "header differs from claim": (method) => ({
          body: statelessRequest(method),
          headers: { "mcp-protocol-version": V2025, "mcp-method": method },
        }),
        "unsupported version": (method) => ({
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: { _meta: meta("2099-01-01") },
          }),
          headers: { "mcp-protocol-version": "2099-01-01", "mcp-method": method },
        }),
        "no client capabilities": (method) => ({
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: { _meta: { "io.modelcontextprotocol/protocolVersion": V2026 } },
          }),
          headers: statelessHeaders(method),
        }),
        "malformed client info": (method) => ({
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: { _meta: { ...meta(), "io.modelcontextprotocol/clientInfo": 5 } },
          }),
          headers: statelessHeaders(method),
        }),
        "no Mcp-Method": (method) => ({
          body: statelessRequest(method),
          headers: { "mcp-protocol-version": V2026 },
        }),
        "wrong Mcp-Method": (method) => ({
          body: statelessRequest(method),
          headers: { "mcp-protocol-version": V2026, "mcp-method": "tools/call" },
        }),
        "browser Origin": (method) => ({
          body: statelessRequest(method),
          headers: { ...statelessHeaders(method), origin: "https://evil.example" },
        }),
        "text content type": (method) => ({ ...base(method), contentType: "text/plain" }),
        "no event-stream accept": (method) => ({
          body: statelessRequest(method),
          headers: { ...statelessHeaders(method), accept: "application/json" },
        }),
        "malformed JSON": (method) => ({
          body: `{"jsonrpc":"2.0","id":1,"method":"${method}"`,
          headers: statelessHeaders(method),
        }),
        batch: (method) => ({
          body: `[${statelessRequest(method)}]`,
          headers: statelessHeaders(method),
        }),
        notification: (method) => ({
          body: JSON.stringify({ jsonrpc: "2.0", method, params: { _meta: meta() } }),
          headers: statelessHeaders(method),
        }),
        "null id": (method) => ({
          body: statelessRequest(method, {}, null),
          headers: statelessHeaders(method),
        }),
        "object id": (method) => ({
          body: statelessRequest(method, {}, { a: 1 }),
          headers: statelessHeaders(method),
        }),
        "JSON-RPC 1.0": (method) => ({
          body: JSON.stringify({ jsonrpc: "1.0", id: 1, method, params: { _meta: meta() } }),
          headers: statelessHeaders(method),
        }),
      };
      const admitted = (response: { readonly status: number; readonly text: string }) => {
        if (response.status !== 200) return false;
        try {
          return resultOf(response.text) !== undefined;
        } catch {
          return false;
        }
      };
      for (const [name, variant] of Object.entries(variants)) {
        const tools = yield* post(variant("tools/list"));
        const events = yield* post(variant("events/list"));
        const unknown = yield* post(variant("t3/unknown"));
        // A notification is never an events request: it goes to effect like any other.
        if (name !== "notification")
          assert.strictEqual(admitted(events), admitted(tools), `${name}: admitted like effect`);
        if (!admitted(tools) || name === "notification") {
          // Passed through: effect answers exactly as it does for any method it lacks.
          assert.strictEqual(events.status, unknown.status, `${name}: status`);
          assert.strictEqual(
            events.text.replaceAll("events/list", "<method>"),
            unknown.text.replaceAll("t3/unknown", "<method>"),
            `${name}: body`,
          );
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("turning agent events off stops answering at once", () =>
    Effect.gen(function* () {
      const { post, settings } = yield* serve();
      yield* settings.updateSettings({ agentEventsEnabled: false });
      const discover = yield* post({
        body: statelessRequest("server/discover"),
        headers: statelessHeaders("server/discover"),
      });
      assert.isUndefined((resultOf(discover.text)!.capabilities as Record<string, unknown>).events);
      const list = yield* post({
        body: statelessRequest("events/list"),
        headers: statelessHeaders("events/list"),
      });
      assert.strictEqual(list.status, 404);
      assert.strictEqual(errorOf(list.text)?.code, -32601);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("off at startup, /mcp registers only 2025-06-18", () =>
    Effect.gen(function* () {
      const { post } = yield* serve({ eventsEnabled: false });
      const discover = yield* post({
        body: statelessRequest("server/discover"),
        headers: statelessHeaders("server/discover"),
      });
      assert.strictEqual(discover.status, 400);
      assert.strictEqual(
        errorOf(discover.text)?.code,
        AgentEventsErrorCode.unsupportedProtocolVersion,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("pins effect 4.0.5: it neither advertises nor routes events itself", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(
        McpServer.layerHttp({
          name: "pin",
          version: "1",
          path: "/mcp",
          protocols: [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28],
        }),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const call = (method: string) =>
        httpClient
          .post("/mcp", {
            headers: { accept: "application/json, text/event-stream", ...statelessHeaders(method) },
            body: HttpBody.text(statelessRequest(method), "application/json"),
          })
          .pipe(
            Effect.flatMap((response) =>
              response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
            ),
          );
      const discover = yield* call("server/discover");
      const capabilities = resultOf(discover.text)!.capabilities as Record<string, unknown>;
      assert.isUndefined(capabilities.events, "effect now advertises events: drop the patch");
      assert.deepStrictEqual(Object.keys(capabilities).toSorted(), ["completions", "logging"]);
      const list = yield* call("events/list");
      assert.strictEqual(list.status, 404, "effect now routes events/list: use its handler");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it("reports an unexpected result shape instead of dropping events silently", () => {
    assert.strictEqual(
      McpEventsEndpoint.addEventsCapability(
        `{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}}}}\n`,
      )._tag,
      "Patched",
    );
    for (const body of [
      "not json",
      "[]",
      `{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}`,
      `{"jsonrpc":"2.0","id":1,"result":{}}`,
      `{"jsonrpc":"2.0","id":1,"result":{"capabilities":[]}}`,
      `{"jsonrpc":"2.0","id":1,"result":null}`,
    ])
      assert.strictEqual(McpEventsEndpoint.addEventsCapability(body)._tag, "Unexpected", body);
  });
});
