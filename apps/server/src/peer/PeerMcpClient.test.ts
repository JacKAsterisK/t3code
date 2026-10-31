import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Network from "./PeerNetworkDispatch.ts";
import * as NetworkTest from "./PeerNetworkDispatch.testkit.ts";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "./PeerLinks.ts";
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
