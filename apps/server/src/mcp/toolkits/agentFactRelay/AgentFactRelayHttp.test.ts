import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as Facts from "../../../agentEvents/AgentFactStore.ts";
import * as RelayTransport from "../../../agentEvents/AgentFactRelayTransport.ts";
import * as Discovery from "../../../peer/PeerFactRelayDiscovery.ts";
import * as PeerClient from "../../../peer/PeerMcpClient.ts";
import * as Links from "../../../peer/PeerLinks.ts";
import * as Relay from "../../../agentEvents/AgentFactRelay.ts";
import * as Access from "../../../agentEvents/AgentFactRelayAccess.ts";
import { layerDatabase } from "../../../agentEvents/AgentEvents.testkit.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttp from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Registry from "../../McpSessionRegistry.ts";
import * as Endpoint from "../../events/McpEventsEndpoint.ts";
import { AgentFactRelayToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const resultOf = (text: string) =>
  decode(
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("")
      : text,
  ) as {
    readonly result?: {
      readonly tools?: readonly {
        readonly name: string;
        readonly inputSchema: {
          readonly type?: string;
          readonly anyOf?: unknown;
          readonly oneOf?: unknown;
        };
      }[];
      readonly content?: readonly { readonly text?: string }[];
      readonly isError?: boolean;
      readonly structuredContent?: unknown;
    };
    readonly error?: unknown;
  };
const base: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("here"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "peer",
  thread: undefined,
  client: { sessionId: "peer", label: "Peer", linked: true, access: "read-only" },
};
const scopes: Readonly<Record<string, Invocation.McpInvocationScope>> = {
  peer: base,
  outside: { ...base, client: { sessionId: "outside", label: "Outside", access: "read-only" } },
  task: { ...base, client: { ...base.client!, taskOnly: true, grantId: "task-grant" } },
  thread: {
    ...base,
    thread: {
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
};
const serve = Effect.fn("fixture.relayHttp")(function* (enabled = true) {
  const settingsContext = yield* Layer.build(
    Settings.layerTest({ agentEventsEnabled: enabled, linkedEnvironmentsEnabled: true }),
  );
  const settings = Context.get(settingsContext, Settings.ServerSettingsService);
  const incomingUnavailable = { current: false };
  const relay = Relay.layer({ id: "here", label: "Here" }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Access.AgentFactRelayAccess)({
          withGate: (effect) => effect,
          originFact: () => Effect.succeed({ verdict: "allowed" }),
          incoming: () =>
            Effect.succeed(
              incomingUnavailable.current
                ? { verdict: "unavailable" }
                : {
                    verdict: "allowed",
                    authorization: {
                      peerEnvironmentId: "peer",
                      generation: "peer-1",
                      limits: { runtimeMode: "approval-required", interactionMode: "default" },
                    },
                  },
            ),
        }),
        Layer.mock(Access.AgentFactRelayTransport)({}),
        Layer.succeed(Access.AgentFactRelayWake, { wait: () => Effect.void }),
      ),
    ),
  );
  const relayContext = yield* Layer.build(relay.pipe(Layer.provideMerge(layerDatabase)));
  const routes = McpHttp.toolkitRegistration(AgentFactRelayToolkit, Handlers.layer).pipe(
    Layer.provide(Layer.succeedContext(relayContext)),
    Layer.provideMerge(
      McpHttp.layerMcpTransport.pipe(
        Layer.provide(
          Layer.mock(Endpoint.McpEventsEndpoint)({
            statelessEnabled: enabled,
            handle: (_request, _scope, inner) => inner,
          }),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(Registry.McpSessionRegistry)({
        resolve: (token) => {
          const scope = scopes[token];
          return Effect.succeed(
            scope?.thread === undefined ? undefined : { ...scope, thread: scope.thread },
          );
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(McpHttp.McpClientAuthenticator, {
        authenticate: (request) =>
          Effect.succeed(scopes[request.headers.authorization?.slice(7) ?? ""]),
      }),
    ),
    Layer.provide(Layer.succeedContext(settingsContext)),
  );
  yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  const http = yield* HttpClient.HttpClient;
  const post = Effect.fn("fixture.relayPost")(function* (
    method: string,
    params: Record<string, unknown> = {},
    options: {
      readonly token?: string;
      readonly session?: string | undefined;
      readonly stateless?: boolean;
    } = {},
  ) {
    const response = yield* http.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${options.token ?? "peer"}`,
        ...(options.session === undefined
          ? {}
          : { "mcp-session-id": options.session, "mcp-protocol-version": "2025-06-18" }),
        ...(options.stateless
          ? {
              "mcp-protocol-version": "2026-07-28",
              "mcp-method": method,
              ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
            }
          : {}),
      },
      body: HttpBody.text(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            ...(options.stateless
              ? {
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/clientInfo": { name: "free-fixture", version: "1" },
                  },
                }
              : {}),
          },
        }),
        "application/json",
      ),
    });
    return { status: response.status, headers: response.headers, text: yield* response.text };
  });
  const address = (yield* HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected loopback TCP fixture");
  return {
    settings,
    incomingUnavailable,
    post,
    sql: Context.get(relayContext, SqlClient.SqlClient),
    url: `http://127.0.0.1:${address.port}`,
  };
});

it.live(
  "both MCP protocols expose object-root relay schemas only to enabled non-task linked peers and refuse excess identity fields",
  () =>
    Effect.gen(function* () {
      const f = yield* serve();
      const initialized = yield* f.post("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "free-fixture", version: "1" },
      });
      const session = initialized.headers["mcp-session-id"];
      assert.isDefined(session);
      for (const options of [{ session }, { stateless: true }]) {
        const response = yield* f.post("tools/list", {}, options);
        const tools = resultOf(response.text).result?.tools;
        assert.deepEqual(tools?.map((tool) => tool.name).toSorted(), [
          "t3_link_agent_fact_authority",
          "t3_link_agent_facts",
        ]);
        for (const tool of tools ?? []) {
          assert.equal(tool.inputSchema.type, "object");
          assert.isUndefined(tool.inputSchema.anyOf);
          assert.isUndefined(tool.inputSchema.oneOf);
        }
        const read = resultOf(
          (yield* f.post(
            "tools/call",
            { name: "t3_link_agent_facts", arguments: { after: null, waitMs: 0 } },
            options,
          )).text,
        );
        assert.isUndefined(read.error);
        assert.notEqual(read.result?.isError, true);
        f.incomingUnavailable.current = true;
        const unavailable = resultOf(
          (yield* f.post(
            "tools/call",
            { name: "t3_link_agent_facts", arguments: { after: null, waitMs: 0 } },
            options,
          )).text,
        );
        assert.isTrue(unavailable.result?.isError);
        assert.equal(
          (decode(unavailable.result?.content?.[0]?.text ?? "null") as { code: string }).code,
          "orchestration_error",
        );
        f.incomingUnavailable.current = false;

        const invalid = resultOf(
          (yield* f.post(
            "tools/call",
            { name: "t3_link_agent_facts", arguments: { after: null, environmentId: "forged" } },
            options,
          )).text,
        );
        assert.isTrue(invalid.error !== undefined || invalid.result?.isError === true);
      }
      for (const token of ["outside", "task", "thread"]) {
        assert.deepEqual(
          resultOf((yield* f.post("tools/list", {}, { token, stateless: true })).text).result
            ?.tools,
          [],
        );
      }
      yield* f.settings.updateSettings({ agentEventsEnabled: false });
      for (const options of [{ session }, { stateless: true }]) {
        assert.deepEqual(
          resultOf((yield* f.post("tools/list", {}, options)).text).result?.tools,
          [],
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("an events startup disable keeps relay tools hidden after a live enable", () =>
  Effect.gen(function* () {
    const f = yield* serve(false);
    yield* f.settings.updateSettings({ agentEventsEnabled: true });
    const initialized = yield* f.post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "free-fixture", version: "1" },
    });
    assert.deepEqual(
      resultOf(
        (yield* f.post("tools/list", {}, { session: initialized.headers["mcp-session-id"] })).text,
      ).result?.tools,
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live(
  "real peer discovery and transport import canonical origin facts once over authenticated loopback MCP",
  () =>
    Effect.gen(function* () {
      const source = yield* serve();
      yield* source.sql`INSERT INTO agent_event_source_state(id, generation, origin_environment_id) VALUES (1, 'source-1', 'here')`;
      const data: Facts.FactData = {
        schema: "t3.agent-event/1",
        kind: "approval",
        factKey: "pending",
        summary: "Approval needed",
        textIsUntrusted: true,
        environment: { id: "here", label: "Origin" },
        thread: null,
        run: null,
        owner: null,
        origin: {
          environmentId: "here",
          sourceGeneration: "source-1",
          sourceKind: "orchestration",
          sourceSequence: 1,
          transitionOrdinal: 0,
          threadSequence: null,
          occurredAt: "1970-01-01T00:00:00.000Z",
        },
        relay: null,
        detail: { requestId: "request" },
      };
      const original = yield* Facts.appendFact({ data, recordedAt: 0 }).pipe(
        Effect.provideService(SqlClient.SqlClient, source.sql),
      );
      const authorization: Access.RelayAuthorization = {
        peerEnvironmentId: "here",
        generation: "outgoing-1",
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
      };
      const current = Layer.mock(Access.AgentFactRelayAccess)({
        withGate: (effect) => effect,
        outgoing: () => Effect.succeed({ verdict: "allowed", authorization }),
      });
      const receiverContext = yield* Relay.layer({ id: "receiver", label: "Receiver" }).pipe(
        Layer.provideMerge(RelayTransport.layer.pipe(Layer.provide(Discovery.layer))),
        Layer.provide(PeerClient.layer.pipe(Layer.provide(PeerClient.layerUnrestricted))),
        Layer.provide(
          Layer.mock(Links.PeerLinks)({
            resolve: () =>
              Effect.succeed({
                url: source.url,
                token: "peer",
                link: {
                  environmentId: EnvironmentId.make("here"),
                  label: "Origin",
                  urls: [source.url],
                  access: "read-only",
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(100_000),
                  lastReachedAt: null,
                  lastError: null,
                },
              }),
            recordOutcome: () => Effect.void,
          }),
        ),
        Layer.provide(current),
        Layer.provide(Layer.succeed(Access.AgentFactRelayWake, { wait: () => Effect.void })),
        Layer.provideMerge(layerDatabase),
        Layer.provide(Layer.fresh(FetchHttpClient.layer)),
        Layer.build,
      );
      const receiver = Context.get(receiverContext, Relay.AgentFactRelay);
      const initial = yield* receiver.followOnce("here", 0);
      assert.equal(initial.imported, 0);
      assert.equal(initial.cursor.peerSeq, original.logSeq);
      const emitted = yield* Facts.appendFact({
        data: { ...data, factKey: "new-pending", origin: { ...data.origin, sourceSequence: 2 } },
        recordedAt: 0,
      }).pipe(Effect.provideService(SqlClient.SqlClient, source.sql));
      const pulled = yield* receiver.followOnce("here", 0);
      assert.equal(pulled.imported, 1, JSON.stringify(pulled.cursor));
      assert.equal((yield* receiver.followOnce("here", 0)).imported, 0);
      const received = yield* Facts.readFacts(0).pipe(
        Effect.provideService(
          SqlClient.SqlClient,
          Context.get(receiverContext, SqlClient.SqlClient),
        ),
      );
      const imported = received.filter((row) => row.relayedFrom === "here");
      assert.equal(imported.length, 1);
      assert.equal(imported[0]?.eventId, emitted.eventId);
      assert.equal(imported[0]?.originEnvironmentId, "here");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
