import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Network from "./PeerNetworkDispatch.ts";
import * as NetworkTest from "./PeerNetworkDispatch.testkit.ts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const peer = EnvironmentId.make("peer-environment");
const Answer = Schema.Struct({ ok: Schema.Boolean });

/**
 * A linked environment that answers every MCP request, and this machine's own list, which may
 * narrow at any step of a call: `narrowAt` names the step after which it does.
 */
const makeClient = (narrowAt: "resolve" | "initialize" | "first-call") =>
  Effect.gen(function* () {
    const writable = yield* Ref.make(true);
    const sent: Array<string> = [];
    const clients: Array<string | undefined> = [];
    let calls = 0;
    const narrow = Ref.set(writable, false);
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const method = (JSON.parse(body) as { readonly method: string }).method;
        sent.push(method);
        if (method === "tools/call") clients.push(request.headers["t3-initiating-client-id"]);
        if (method === "initialize") {
          if (narrowAt === "initialize") yield* narrow;
          return HttpClientResponse.fromWeb(
            request,
            new Response("{}", { status: 200, headers: { "mcp-session-id": "session" } }),
          );
        }
        if (method !== "tools/call") return HttpClientResponse.fromWeb(request, new Response(null));
        calls += 1;
        // The peer restarted and lost the session: the client starts a new one and retries.
        if (narrowAt === "first-call" && calls === 1) {
          yield* narrow;
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
          }),
        );
      }),
    );
    const client = yield* PeerMcpClient.PeerMcpClient.pipe(
      Effect.provide(
        PeerMcpClient.layer.pipe(
          Layer.provide(
            Layer.mock(PeerLinks.PeerLinks)({
              resolve: () =>
                (narrowAt === "resolve" ? narrow : Effect.void).pipe(
                  Effect.as({
                    link: {} as PeerLinks.ResolvedPeerLink["link"],
                    url: "https://peer.test",
                    token: "standard-token",
                  }),
                ),
              recordOutcome: () => Effect.void,
            }),
          ),
          Layer.provide(
            Layer.succeed(PeerMcpClient.PeerWriteCeiling, { writable: () => Ref.get(writable) }),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
        ),
      ),
    );
    const call = (writes: boolean, initiatingClientId?: string) =>
      client
        .call({
          environmentId: peer,
          tool: "anything",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          writes,
          ...(initiatingClientId === undefined ? {} : { initiatingClientId }),
          success: Answer,
        })
        .pipe(
          Effect.map(() => "answered"),
          Effect.catchTags({ OrchestratorMcpFailure: (failure) => Effect.succeed(failure.code) }),
        );
    return { call, sent, clients };
  });

const toolCalls = (sent: ReadonlyArray<string>) =>
  sent.filter((method) => method === "tools/call").length;

it.effect("never sends a write once this machine's list narrows while the link resolves", () =>
  Effect.gen(function* () {
    const { call, sent } = yield* makeClient("resolve");
    expect(yield* call(true)).toBe("capability_denied");
    expect(toolCalls(sent)).toBe(0);
    // The link keeps reading.
    expect(yield* call(false)).toBe("answered");
  }),
);

it.effect("never sends a write once this machine's list narrows while a session starts", () =>
  Effect.gen(function* () {
    const { call, sent } = yield* makeClient("initialize");
    expect(yield* call(true)).toBe("capability_denied");
    expect(sent).toContain("initialize");
    expect(toolCalls(sent)).toBe(0);
    expect(yield* call(false)).toBe("answered");
  }),
);

it.effect("never retries a write once this machine's list narrows before the retry", () =>
  Effect.gen(function* () {
    const { call, sent } = yield* makeClient("first-call");
    expect(yield* call(true)).toBe("capability_denied");
    // The first send was allowed; the session it found was gone, and the retry is refused.
    expect(toolCalls(sent)).toBe(1);
    expect(sent.filter((method) => method === "initialize")).toHaveLength(2);
    expect(yield* call(false)).toBe("answered");
  }),
);

it.effect("reused MCP sessions carry each server-built initiating client on the request", () =>
  Effect.gen(function* () {
    const { call, sent, clients } = yield* makeClient("resolve");
    expect(yield* call(false, "opaque-client-one")).toBe("answered");
    expect(yield* call(false, "opaque-client-two")).toBe("answered");
    expect(yield* call(false)).toBe("answered");
    expect(sent.filter((method) => method === "initialize")).toHaveLength(1);
    expect(clients).toEqual(["opaque-client-one", "opaque-client-two", undefined]);
  }),
);

it.live("guarded calls stop after paused DNS across setup, session reuse, and 404 renewal", () =>
  Effect.gen(function* () {
    for (const pauseAt of [1, 2, 3, 4, 5, 6, 7]) {
      const receiver = yield* NetworkTest.receiver;
      const dns = yield* NetworkTest.pausedDns;
      let allowed = true;
      const outcomes: Array<string | null> = [];
      const client = yield* PeerMcpClient.PeerMcpClient.pipe(
        Effect.provide(
          PeerMcpClient.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                dns.http,
                PeerMcpClient.layerUnrestricted,
                Layer.mock(PeerLinks.PeerLinks)({
                  resolve: () =>
                    Effect.succeed({
                      url: receiver.url,
                      token: "isolated-token",
                      link: {} as PeerLinks.ResolvedPeerLink["link"],
                    }),
                  recordOutcome: (_id, outcome) =>
                    Effect.sync(() => {
                      outcomes.push(outcome.error);
                    }),
                }),
              ),
            ),
          ),
        ),
      );
      const call = () =>
        client
          .call({
            environmentId: peer,
            tool: "t3_link_agent_facts",
            arguments: {},
            limits: { runtimeMode: "approval-required", interactionMode: "plan" },
            writes: false,
            initiatingClientId: "isolated-client",
            success: Schema.Unknown,
            beforeSend: Effect.suspend(() =>
              allowed
                ? Effect.void
                : Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message: "Captured link changed",
                    }),
                  ),
            ),
          })
          .pipe(Effect.provideService(Network.NetworkOptions, dns.options));
      if (pauseAt >= 4) yield* call();
      if (pauseAt >= 5) receiver.answer.status = 404;
      yield* Ref.set(dns.pauseAt, pauseAt);
      const pending = yield* call().pipe(Effect.result, Effect.forkChild);
      yield* Queue.take(dns.entered);
      const sentBefore = receiver.received.length;
      const trafficBefore = { ...receiver.traffic };
      const outcomeCount = outcomes.length;
      allowed = false;
      yield* dns.release;
      const result = yield* Fiber.join(pending);
      expect(receiver.received).toHaveLength(sentBefore);
      expect(receiver.traffic).toEqual(trafficBefore);
      expect(outcomes).toHaveLength(outcomeCount);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
      for (const request of receiver.received) {
        expect(request.headers["t3-mode-limit"]).toBe("approval-required/plan");
        expect(request.headers["t3-initiating-client-id"]).toBe("isolated-client");
      }
    }
  }).pipe(Effect.scoped),
);

const Result = Schema.Struct({ modes: Schema.String });
const toolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Returns this request's mode limits.",
    success: Result,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("hold", {
    description: "Holds a tool request open.",
    success: Result,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

it.effect.each([false, true])(
  "reuses an initialized session before its first call finishes (cancelled: %s)",
  (cancelFirst) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const modes = McpInvocationContext.McpInvocationContext.pipe(
          Effect.map((scope) => {
            const ceiling = McpInvocationContext.clientModeCeiling(scope.client);
            return { modes: `${ceiling.runtimeMode}/${ceiling.interactionMode}` };
          }),
        );
        const handlers = McpToolAccess.toLayer(toolkit, {
          probe: McpToolAccess.reads(() => modes),
          hold: McpToolAccess.reads(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(modes),
            ),
          ),
        });
        const box = descriptorOf("environment-box", "Box");
        const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
        const context = yield* Layer.build(
          layerLinkingEnvironment(descriptorOf("environment-a", "A")),
        );
        const links = Context.get(context, PeerLinks.PeerLinks);
        const client = Context.get(context, PeerMcpClient.PeerMcpClient);
        yield* linkTo(links, b);
        const held = yield* client
          .call({
            environmentId: box.environmentId,
            tool: "hold",
            arguments: {},
            writes: false,
            limits: { runtimeMode: "full-access", interactionMode: "default" },
            success: Result,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        if (cancelFirst) yield* Fiber.interrupt(held);
        const before = (yield* Ref.get(b.bearers)).length;
        expect(
          yield* client.call({
            environmentId: box.environmentId,
            tool: "probe",
            arguments: {},
            writes: false,
            limits: { runtimeMode: "approval-required", interactionMode: "plan" },
            success: Result,
          }),
        ).toEqual({ modes: "approval-required/plan" });
        // One tool POST; no second initialize or initialized notification.
        expect((yield* Ref.get(b.bearers)).length - before).toBe(1);
        yield* Deferred.succeed(release, undefined);
        if (!cancelFirst) expect(yield* Fiber.join(held)).toEqual({ modes: "auto/default" });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("renews a missing peer session once and reuses its replacement", () =>
  Effect.gen(function* () {
    const sessionHeaders: Array<string | undefined> = [];
    const statuses = [200, 202, 404, 200, 202, 200, 200];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const index = sessionHeaders.length;
        sessionHeaders.push(request.headers["mcp-session-id"]);
        const status = statuses[index];
        if (status === undefined) throw new Error("Unexpected retry");
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            index >= 5
              ? JSON.stringify({
                  result: {
                    content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }],
                  },
                })
              : "",
            {
              status,
              headers:
                index === 0
                  ? { "mcp-session-id": "old" }
                  : index === 3
                    ? { "mcp-session-id": "renewed" }
                    : {},
            },
          ),
        );
      }),
    );
    const box = descriptorOf("environment-box", "Box");
    const context = yield* Layer.build(
      PeerMcpClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PeerMcpClient.layerUnrestricted,
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.mock(PeerLinks.PeerLinks)({
              resolve: () =>
                Effect.succeed({
                  link: {
                    environmentId: box.environmentId,
                    label: box.label,
                    urls: ["https://peer.example"],
                    access: "auto",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(1),
                    lastReachedAt: null,
                    lastError: null,
                  },
                  url: "https://peer.example",
                  token: "fixture",
                }),
              recordOutcome: () => Effect.void,
            }),
          ),
        ),
      ),
    );
    const client = Context.get(context, PeerMcpClient.PeerMcpClient);
    for (let call = 0; call < 2; call++) {
      expect(
        yield* client.call({
          environmentId: box.environmentId,
          tool: "probe",
          arguments: {},
          writes: false,
          limits: { runtimeMode: "approval-required", interactionMode: "plan" },
          success: Result,
        }),
      ).toEqual({ modes: "approval-required/plan" });
    }
    expect(sessionHeaders).toEqual([
      undefined,
      "old",
      "old",
      undefined,
      "renewed",
      "renewed",
      "renewed",
    ]);
  }).pipe(Effect.scoped),
);
