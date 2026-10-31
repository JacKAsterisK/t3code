import * as Queue from "effect/Queue";
import * as NetworkTest from "./PeerNetworkDispatch.testkit.ts";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Ports from "../agentEvents/AgentFactRelayAccess.ts";
import * as Links from "./PeerLinks.ts";
import * as Discovery from "./PeerFactRelayDiscovery.ts";
import * as Network from "./PeerNetworkDispatch.ts";

const authorization: Ports.RelayAuthorization = {
  peerEnvironmentId: "peer",
  generation: "generation-1",
  limits: { runtimeMode: "approval-required", interactionMode: "plan" },
};
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);
const fixture = Effect.fn("fixture.discovery")(function* (
  catalog: Record<string, unknown>,
  options: {
    readonly initializeError?: boolean;
    readonly notificationError?: boolean;
    readonly hangInitialize?: boolean;
    readonly hangDelete?: boolean;
  } = {},
) {
  const trace = yield* Ref.make<string[]>([]);
  const started = yield* Deferred.make<void>();
  const cleanupStarted = yield* Deferred.make<void>();
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      assert.equal(request.headers.authorization, "Bearer isolated-token");
      assert.equal(request.headers["t3-mode-limit"], "approval-required/plan");
      const method =
        request.method === "DELETE"
          ? "DELETE"
          : request.body._tag === "Uint8Array"
            ? decode(new TextDecoder().decode(request.body.body)).method
            : "missing";
      yield* Ref.update(trace, (entries) => [...entries, method]);
      if (method === "initialize" && options.hangInitialize) {
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }
      if (method === "DELETE" && options.hangDelete) {
        yield* Deferred.succeed(cleanupStarted, undefined);
        return yield* Effect.never;
      }
      const response =
        method === "initialize"
          ? Response.json(
              options.initializeError
                ? { jsonrpc: "2.0", id: 0, error: { code: -32600 } }
                : {
                    jsonrpc: "2.0",
                    id: 0,
                    result: {
                      protocolVersion: "2025-06-18",
                      capabilities: {},
                      serverInfo: { name: "free-mock", version: "1" },
                    },
                  },
              { headers: { "mcp-session-id": "owned-session" } },
            )
          : method === "notifications/initialized" || method === "DELETE"
            ? new Response(null, {
                status: options.notificationError && method !== "DELETE" ? 500 : 202,
              })
            : Response.json({ jsonrpc: "2.0", id: 1, ...catalog });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const access = Layer.mock(Ports.AgentFactRelayAccess)({
    withGate: (effect) => effect,
    outgoing: () => Effect.succeed({ verdict: "allowed", authorization }),
  });
  const services = yield* Discovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Network.PeerNetworkDispatch, {
          execute: (request, beforeSend) => beforeSend.pipe(Effect.andThen(http.execute(request))),
        }),
        access,
        Layer.mock(Links.PeerLinks)({
          resolve: () =>
            Effect.succeed({
              url: "http://127.0.0.1:12345",
              token: "isolated-token",
              link: {
                environmentId: EnvironmentId.make("peer"),
                label: "Peer",
                urls: ["http://127.0.0.1:12345"],
                access: "read-only",
                linkedAt: DateTime.makeUnsafe(0),
                expiresAt: DateTime.makeUnsafe(100_000),
                lastReachedAt: null,
                lastError: null,
              },
            }),
        }),
      ),
    ),
    Layer.build,
  );
  return {
    discovery: Context.get(services, Discovery.PeerFactRelayDiscovery),
    trace,
    started,
    cleanupStarted,
  };
});

it.effect("caches only verified unsupported catalogs and retries them hourly", () =>
  Effect.gen(function* () {
    for (const catalog of [{ result: { tools: [] } }, { error: { code: -32601 } }]) {
      const f = yield* fixture(catalog);
      assert.equal(
        (yield* f.discovery.require(authorization).pipe(Effect.flip)).reason,
        "unsupported",
      );
      assert.equal(
        (yield* f.discovery.require(authorization).pipe(Effect.flip)).reason,
        "unsupported",
      );
      assert.equal((yield* Ref.get(f.trace)).filter((method) => method === "tools/list").length, 1);
      yield* TestClock.adjust("1 hour");
      assert.equal(
        (yield* f.discovery.require(authorization).pipe(Effect.flip)).reason,
        "unsupported",
      );
      assert.equal((yield* Ref.get(f.trace)).filter((method) => method === "tools/list").length, 2);
      assert.equal((yield* Ref.get(f.trace)).filter((method) => method === "DELETE").length, 2);
    }
  }).pipe(Effect.scoped),
);

it.effect("generic invalid requests remain retryable and do not poison discovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ error: { code: -32600 } });
    assert.equal(
      (yield* f.discovery.require(authorization).pipe(Effect.flip)).reason,
      "invalid_response",
    );
    assert.equal(
      (yield* f.discovery.require(authorization).pipe(Effect.flip)).reason,
      "invalid_response",
    );
    assert.equal((yield* Ref.get(f.trace)).filter((method) => method === "tools/list").length, 2);
  }).pipe(Effect.scoped),
);

it.effect(
  "an unsuccessful initialization never verifies missing tools and always cleans up its owned session",
  () =>
    Effect.gen(function* () {
      for (const options of [{ initializeError: true }, { notificationError: true }]) {
        const f = yield* fixture({ result: { tools: [] } }, options);
        assert.notEqual(
          (yield* f.discovery.require(authorization).pipe(Effect.flip)).reason,
          "unsupported",
        );
        const trace = yield* Ref.get(f.trace);
        assert.isFalse(trace.includes("tools/list"));
        assert.equal(trace.filter((method) => method === "DELETE").length, 1);
      }
    }).pipe(Effect.scoped),
);

it.effect("bounds an initialization that never returns a session", () =>
  Effect.gen(function* () {
    const f = yield* fixture({}, { hangInitialize: true });
    const call = yield* f.discovery.require(authorization).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(f.started);
    yield* TestClock.adjust("15 seconds");
    const result = yield* Fiber.join(call);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "unreachable");
  }).pipe(Effect.scoped),
);

it.effect("bounds cleanup of the session it owns when the peer stops answering DELETE", () =>
  Effect.gen(function* () {
    const f = yield* fixture(
      {
        result: {
          tools: [{ name: "t3_link_agent_facts" }, { name: "t3_link_agent_fact_authority" }],
        },
      },
      { hangDelete: true },
    );
    const call = yield* f.discovery.require(authorization).pipe(Effect.forkChild);
    yield* Deferred.await(f.cleanupStarted);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(call);
    assert.equal((yield* Ref.get(f.trace)).filter((method) => method === "DELETE").length, 1);
  }).pipe(Effect.scoped),
);

it.live("discovery guards every send and skips stale cleanup without caching unsupported", () =>
  Effect.gen(function* () {
    for (const pauseAt of [1, 2, 3, 4]) {
      const receiver = yield* NetworkTest.receiver;
      const dns = yield* NetworkTest.pausedDns;
      const grant = yield* Ref.make<Ports.RelayAccess>({ verdict: "allowed", authorization });
      const discovery = yield* Discovery.PeerFactRelayDiscovery.pipe(
        Effect.provide(
          Discovery.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Ports.AgentFactRelayAccess)({
                  withGate: (effect) => effect,
                  outgoing: () => Ref.get(grant),
                }),
                Layer.mock(Links.PeerLinks)({
                  resolve: () =>
                    Effect.succeed({
                      url: receiver.url,
                      token: "isolated-token",
                      link: {} as Links.ResolvedPeerLink["link"],
                    }),
                }),
              ),
            ),
          ),
        ),
      );
      yield* Ref.set(dns.pauseAt, pauseAt);
      const pending = yield* discovery
        .require(authorization)
        .pipe(
          Effect.provideService(Network.NetworkOptions, dns.options),
          Effect.result,
          Effect.forkChild,
        );
      yield* Queue.take(dns.entered);
      const sentBefore = receiver.received.length;
      const trafficBefore = { ...receiver.traffic };
      yield* Ref.set(grant, {
        verdict: "allowed",
        authorization: { ...authorization, generation: "replacement" },
      });
      yield* dns.release;
      const result = yield* Fiber.join(pending);
      assert.equal(receiver.received.length, sentBefore);
      assert.deepEqual(receiver.traffic, trafficBefore);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "refused");
      assert.isFalse(receiver.received.some((r) => r.method === "DELETE"));
      yield* Ref.set(grant, { verdict: "allowed", authorization });
      yield* discovery
        .require(authorization)
        .pipe(Effect.provideService(Network.NetworkOptions, dns.options));
      assert.equal(receiver.received.filter((r) => r.method === "DELETE").length, 1);
    }
  }).pipe(Effect.scoped),
);
