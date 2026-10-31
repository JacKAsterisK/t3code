import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Network from "../peer/PeerNetworkDispatch.ts";
import * as NetworkTest from "../peer/PeerNetworkDispatch.testkit.ts";
import * as Links from "../peer/PeerLinks.ts";
import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Peer from "../peer/PeerMcpClient.ts";
import * as Discovery from "../peer/PeerFactRelayDiscovery.ts";
import * as Ports from "./AgentFactRelayAccess.ts";
import * as Transport from "./AgentFactRelayTransport.ts";

const authorization: Ports.RelayAuthorization = {
  peerEnvironmentId: "peer",
  generation: "pointer-1",
  limits: { runtimeMode: "approval-required", interactionMode: "plan" },
};
const method = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const raw = { epoch: "epoch", futureField: { mustSurviveUntilStrictDomainDecoder: true } };
const fixture = Effect.gen(function* () {
  const grant = yield* Ref.make<Ports.RelayAccess>({ verdict: "allowed", authorization });
  const paused = yield* Ref.make(false);
  const entered = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  const failure = yield* Ref.make<OrchestratorMcpFailure | undefined>(undefined);
  const calls = yield* Ref.make(0);
  const call: Peer.PeerMcpClient["Service"]["call"] = Effect.fn("fixture.peerCall")(
    function* (input) {
      assert.isFalse(input.writes);
      assert.deepEqual(input.limits, authorization.limits);
      assert.equal(input.environmentId, "peer");
      assert.isTrue(
        input.tool === "t3_link_agent_facts" || input.tool === "t3_link_agent_fact_authority",
      );
      assert.isTrue(Object.is(input.success, Schema.Unknown));
      yield* Ref.update(calls, (count) => count + 1);
      if (yield* Ref.get(paused)) {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(resume);
      }
      const error = yield* Ref.get(failure);
      if (error !== undefined) return yield* error;
      return raw;
    },
  );
  const peer = Layer.succeed(Peer.PeerMcpClient, { call });
  const services = yield* Transport.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        peer,
        Layer.succeed(Discovery.PeerFactRelayDiscovery, { require: () => Effect.void }),
        Layer.succeed(Ports.AgentFactRelayAccess, {
          withGate: (effect) => effect,
          outgoing: () => Ref.get(grant),
          incoming: () => Effect.succeed({ verdict: "unavailable" }),
          requester: () => Effect.succeed({ verdict: "unavailable" }),
          originFact: () => Effect.succeed({ verdict: "unavailable" }),
        }),
      ),
    ),
    Layer.build,
  );
  return {
    grant,
    paused,
    entered,
    resume,
    failure,
    calls,
    transport: Context.get(services, Ports.AgentFactRelayTransport),
  };
});

it.effect(
  "retains raw response fields for domain validation and never turns generic invalid_request into unsupported",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      assert.strictEqual(yield* f.transport.read({ authorization, request: { after: null } }), raw);
      assert.strictEqual(
        yield* f.transport.validate({
          authorization,
          request: {
            references: [{ eventId: "event", originGeneration: "source", threadId: null }],
            authorizationGeneration: null,
          },
        }),
        raw,
      );
      yield* Ref.set(
        f.failure,
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Generic remote invalid request.",
        }),
      );
      const invalid = yield* f.transport
        .read({ authorization, request: { after: null } })
        .pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "unreachable");
    }).pipe(Effect.scoped),
);

it.effect(
  "withholds a response when the outgoing pointer generation changes during the network call",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.set(f.paused, true);
      const call = yield* f.transport
        .read({ authorization, request: { after: null } })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(f.entered);
      yield* Ref.set(f.grant, {
        verdict: "allowed",
        authorization: { ...authorization, generation: "pointer-2" },
      });
      yield* Deferred.succeed(f.resume, undefined);
      const result = yield* Fiber.join(call);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "refused");
    }).pipe(Effect.scoped),
);

it.live.each(["read", "validate"] as const)(
  "%s revalidates captured link authority after actual DNS before sending credentials",
  (operation) =>
    Effect.gen(function* () {
      for (const change of ["removed", "disabled", "expired", "revision"] as const) {
        const receiver = yield* NetworkTest.receiver;
        const dns = yield* NetworkTest.pausedDns;
        const gate = yield* Semaphore.make(1);
        const held = yield* Ref.make(false);
        const grant = yield* Ref.make<Ports.RelayAccess>({ verdict: "allowed", authorization });
        const access = Layer.mock(Ports.AgentFactRelayAccess)({
          withGate: (effect) =>
            gate.withPermit(
              Effect.acquireUseRelease(
                Ref.set(held, true),
                () => effect,
                () => Ref.set(held, false),
              ),
            ),
          outgoing: () => Ref.get(grant),
        });
        const peer = Peer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              dns.http,
              Peer.layerUnrestricted,
              Layer.mock(Links.PeerLinks)({
                resolve: () =>
                  Effect.succeed({
                    url: receiver.url,
                    token: "isolated-token",
                    link: {} as Links.ResolvedPeerLink["link"],
                  }),
                recordOutcome: () => Effect.void,
              }),
            ),
          ),
        );
        const transport = yield* Ports.AgentFactRelayTransport.pipe(
          Effect.provide(
            Transport.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  peer,
                  access,
                  Layer.succeed(Discovery.PeerFactRelayDiscovery, { require: () => Effect.void }),
                ),
              ),
            ),
          ),
        );
        const call = () =>
          (operation === "read"
            ? transport.read({ authorization, request: { after: null } })
            : transport.validate({
                authorization,
                request: {
                  references: [{ eventId: "event", originGeneration: "source", threadId: null }],
                  authorizationGeneration: null,
                },
              })
          ).pipe(
            Effect.provideService(Network.NetworkOptions, {
              lookup: (host) =>
                Effect.gen(function* () {
                  assert.isFalse(yield* Ref.get(held));
                  return yield* dns.options.lookup(host);
                }),
            }),
          );
        assert.deepEqual(yield* call(), { untouched: { future: true } });
        yield* Ref.set(dns.pauseAt, (yield* Ref.get(dns.count)) + 1);
        const pending = yield* call().pipe(Effect.result, Effect.forkChild);
        yield* Queue.take(dns.entered);
        assert.isFalse(yield* Ref.get(held));
        yield* Ref.set(
          grant,
          change === "revision"
            ? {
                verdict: "allowed",
                authorization: { ...authorization, generation: "changed-revision" },
              }
            : {
                verdict: "refused",
                reason:
                  change === "removed"
                    ? "source_changed"
                    : change === "disabled"
                      ? "links_disabled"
                      : "credential_changed",
              },
        );
        const sentBefore = receiver.received.length;
        const trafficBefore = { ...receiver.traffic };
        yield* dns.release;
        const result = yield* Fiber.join(pending);
        assert.deepEqual(receiver.traffic, trafficBefore);
        assert.equal(receiver.received.length, sentBefore);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "refused");
        assert.equal(receiver.received.filter((r) => r.method === "initialize").length, 1);
      }
    }).pipe(Effect.scoped),
);

it.live("relay deadlines and interruption discard late DNS and close in-flight peer sockets", () =>
  Effect.gen(function* () {
    for (const operation of ["read", "validate"] as const) {
      for (const phase of ["dns", "socket", "tls"] as const) {
        for (const end of ["deadline", "interrupt"] as const) {
          const receiver = yield* NetworkTest.receiver;
          const dns = yield* NetworkTest.pausedDns;
          const tls = phase === "tls" ? yield* NetworkTest.tlsBlackhole : undefined;
          const peer = Peer.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                dns.http,
                Peer.layerUnrestricted,
                Layer.mock(Links.PeerLinks)({
                  resolve: () =>
                    Effect.succeed({
                      url: tls?.url ?? receiver.url,
                      token: "isolated-token",
                      link: {} as Links.ResolvedPeerLink["link"],
                    }),
                  recordOutcome: () => Effect.void,
                }),
              ),
            ),
          );
          const transport = yield* Ports.AgentFactRelayTransport.pipe(
            Effect.provide(
              Transport.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    peer,
                    Layer.succeed(Discovery.PeerFactRelayDiscovery, { require: () => Effect.void }),
                    Layer.mock(Ports.AgentFactRelayAccess)({
                      withGate: (effect) => effect,
                      outgoing: () => Effect.succeed({ verdict: "allowed", authorization }),
                    }),
                  ),
                ),
              ),
            ),
          );
          const call = () =>
            (operation === "read"
              ? transport.read({ authorization, request: { after: null } })
              : transport.validate({
                  authorization,
                  request: { references: [], authorizationGeneration: null },
                })
            ).pipe(Effect.provideService(Network.NetworkOptions, dns.options));
          if (tls === undefined) {
            yield* call();
            for (let sent = 0; sent < 3; sent++) yield* Queue.take(receiver.requests);
          }
          yield* Ref.set(dns.pauseAt, phase === "dns" ? (yield* Ref.get(dns.count)) + 1 : 0);
          receiver.answer.hang = phase === "socket";
          const pending = yield* call().pipe(Effect.result, Effect.forkChild);
          const socket =
            tls !== undefined
              ? yield* Queue.take(tls.connections)
              : phase === "socket"
                ? (yield* Queue.take(receiver.requests)).socket
                : undefined;
          if (phase === "dns") yield* Queue.take(dns.entered);
          const sentBefore = receiver.received.length;
          if (end === "deadline") {
            yield* TestClock.adjust("15 seconds");
            const result = yield* Fiber.join(pending);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.equal(result.failure.reason, "unreachable");
          } else yield* Fiber.interrupt(pending);
          if (socket !== undefined)
            yield* Effect.callback<void>((done) => {
              if (socket.destroyed) done(Effect.void);
              else socket.once("close", () => done(Effect.void));
            });
          if (phase === "dns") yield* dns.release;
          receiver.answer.hang = false;
          if (tls === undefined) {
            yield* call();
            assert.equal(receiver.received.length, sentBefore + 1);
          } else assert.equal(receiver.received.length, 0);
        }
      }
    }
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("discovery and dead-first URL setup do not consume a valid long-poll budget", () =>
  Effect.gen(function* () {
    const discovering = yield* Deferred.make<void>();
    const discovered = yield* Deferred.make<void>();
    const resolving = yield* Deferred.make<void>();
    const resolved = yield* Deferred.make<void>();
    const polling = yield* Deferred.make<void>();
    const response = yield* Deferred.make<void>();

    const peer = Peer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Peer.layerUnrestricted,
          Layer.mock(Links.PeerLinks)({
            resolve: () =>
              Deferred.succeed(resolving, undefined).pipe(
                Effect.andThen(Deferred.await(resolved)),
                Effect.as({
                  url: "https://isolated.test",
                  token: "isolated",
                  link: {} as Links.ResolvedPeerLink["link"],
                }),
              ),
            recordOutcome: () => Effect.void,
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Guarded requests must use the pinned adapter")),
          ),
        ),
      ),
    );
    const dispatch: Context.Service.Shape<typeof Network.PeerNetworkDispatch> = {
      execute: (request, beforeSend) =>
        Effect.gen(function* () {
          yield* beforeSend;
          const body =
            request.body._tag === "Uint8Array"
              ? method(new TextDecoder().decode(request.body.body))
              : { method: "" };
          if (body.method === "initialize")
            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", { headers: { "mcp-session-id": "session" } }),
            );
          if (body.method === "notifications/initialized")
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
          yield* Deferred.succeed(polling, undefined);
          yield* Deferred.await(response);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              result: {
                content: [
                  {
                    type: "text",
                    text: encodeUnknown(raw),
                  },
                ],
              },
            }),
          );
        }),
    };
    const transport = yield* Ports.AgentFactRelayTransport.pipe(
      Effect.provide(
        Transport.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              peer,
              Layer.mock(Ports.AgentFactRelayAccess)({
                withGate: (effect) => effect,
                outgoing: () => Effect.succeed({ verdict: "allowed", authorization }),
              }),
              Layer.succeed(Discovery.PeerFactRelayDiscovery, {
                require: () =>
                  Deferred.succeed(discovering, undefined).pipe(
                    Effect.andThen(Deferred.await(discovered)),
                  ),
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(Network.PeerNetworkDispatch, dispatch),
    );
    const fiber = yield* transport
      .read({ authorization, request: { after: { epoch: "epoch", seq: 1 }, waitMs: 45_000 } })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(discovering);
    yield* TestClock.adjust(14_000);
    yield* Deferred.succeed(discovered, undefined);
    yield* Deferred.await(resolving);
    yield* TestClock.adjust(10_000);
    yield* Deferred.succeed(resolved, undefined);
    yield* Deferred.await(polling);
    yield* TestClock.adjust(44_000);
    yield* Deferred.succeed(response, undefined);
    const result = yield* Fiber.join(fiber);
    assert.equal(result._tag, "Success");
    if (result._tag === "Success") assert.deepEqual(result.success, raw);
  }).pipe(Effect.scoped),
);
