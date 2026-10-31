// @effect-diagnostics nodeBuiltinImport:off -- Isolated production fleet TLS and streaming loopback fixtures.
import * as NodeHttp from "node:http";
import type * as NodeTls from "node:tls";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type OrchestratorMcpFailure } from "@t3tools/contracts";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Fleet from "../lan/FleetPeerHttpClient.ts";
import * as Access from "../agentEvents/AgentFactRelayAccess.ts";
import * as Discovery from "./PeerFactRelayDiscovery.ts";
import * as Links from "./PeerLinks.ts";
import * as Peer from "./PeerMcpClient.ts";
import * as Network from "./PeerNetworkDispatch.ts";
import * as Fixture from "./PeerNetworkDispatch.testkit.ts";

it.live(
  "production fleet trust admits guarded discovery and MCP initialization, reuse and 404 renewal",
  () =>
    Effect.gen(function* () {
      const receiver = yield* Fixture.fleetReceiver;
      const dns = yield* Fixture.pausedDns;
      const trust = yield* Fleet.FleetPeerTrust.pipe(Effect.provide(Fleet.layerTrust));
      const identity = {
        origin: receiver.origin,
        ...receiver.certificate,
        connectHost: "localhost",
      };
      yield* trust.replace([identity]);
      const names: string[] = [];
      receiver.server.on("secureConnection", (socket: NodeTls.TLSSocket) =>
        names.push(String(socket.servername)),
      );
      const authorization = {
        peerEnvironmentId: "fleet-peer",
        generation: "generation",
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
      } as const;
      let activeAuthorization: Access.RelayAuthorization = authorization;
      const links = Layer.mock(Links.PeerLinks)({
        resolve: () =>
          Effect.succeed({
            url: receiver.origin,
            token: "isolated-token",
            link: {} as Links.ResolvedPeerLink["link"],
          }),
        recordOutcome: () => Effect.void,
      });
      const production = Layer.mergeAll(Peer.layer, Discovery.layer).pipe(
        Layer.provide(links),
        Layer.provide(Peer.layerUnrestricted),
        Layer.provide(
          Layer.mock(Access.AgentFactRelayAccess)({
            withGate: (effect) => effect,
            outgoing: () =>
              Effect.sync(() => ({ verdict: "allowed", authorization: activeAuthorization })),
          }),
        ),
        Layer.provide(Fleet.layer),
        Layer.provide(Layer.succeed(Fleet.FleetPeerTrust, trust)),
        Layer.provide(FetchHttpClient.layer),
      );
      const context = yield* Layer.build(production);
      const discovery = Context.get(context, Discovery.PeerFactRelayDiscovery);
      const peer = Context.get(context, Peer.PeerMcpClient);
      // Calls run outside Layer.provide's trust context, as the production services do.
      yield* discovery
        .require(authorization)
        .pipe(Effect.provideService(Network.NetworkOptions, dns.options));
      const call = peer
        .call({
          environmentId: EnvironmentId.make("fleet-peer"),
          tool: "t3_link_agent_facts",
          arguments: {},
          limits: authorization.limits,
          writes: false,
          initiatingClientId: "approval-caller",
          beforeSend: Effect.void,
          success: Schema.Unknown,
        })
        .pipe(Effect.provideService(Network.NetworkOptions, dns.options));
      yield* call;
      yield* call;
      receiver.answer.failNextCall = true;
      yield* call;
      assert.deepEqual(
        receiver.received.map((row) => row.method),
        [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "DELETE",
          "initialize",
          "notifications/initialized",
          "tools/call",
          "tools/call",
          "tools/call",
          "initialize",
          "notifications/initialized",
          "tools/call",
        ],
      );
      for (const row of receiver.received) {
        assert.equal(row.headers.host, new URL(receiver.origin).host);
        assert.equal(row.headers.authorization, "Bearer isolated-token");
        assert.equal(row.headers["t3-mode-limit"], "approval-required/plan");
      }
      for (const row of receiver.received.slice(4))
        assert.equal(row.headers["t3-initiating-client-id"], "approval-caller");
      assert.isTrue(names.every((name) => name === "false"));
      assert.equal(yield* Ref.get(dns.count), receiver.received.length);
      const rotated = createFleetTlsCertificate({
        address: "127.0.0.1",
        now: yield* Clock.currentTimeMillis,
      });
      for (const operation of ["discovery", "call"] as const) {
        for (const next of [
          [],
          [
            {
              ...identity,
              certificate: rotated.certificate,
              publicKeySha256: rotated.publicKeySha256,
            },
          ],
        ]) {
          yield* trust.replace([identity]);
          activeAuthorization = {
            ...authorization,
            generation: "renewed-" + (yield* Ref.get(dns.count)),
          };
          yield* Ref.set(dns.pauseAt, (yield* Ref.get(dns.count)) + 1);
          const attempt: Effect.Effect<unknown, Access.RelayPeerError | OrchestratorMcpFailure> =
            operation === "discovery"
              ? discovery
                  .require(activeAuthorization)
                  .pipe(Effect.provideService(Network.NetworkOptions, dns.options))
              : call;
          const pending = yield* attempt.pipe(Effect.result, Effect.forkChild);
          yield* Queue.take(dns.entered);
          const before = { ...receiver.traffic };
          yield* trust.replace(next);
          yield* dns.release;
          assert.equal((yield* Fiber.join(pending))._tag, "Failure");
          assert.deepEqual(receiver.traffic, before);
        }
      }
    }).pipe(Effect.scoped),
);

it.live(
  "fleet trust refuses untrusted, changed key, signed IP mismatch and post-DNS removal or rotation",
  () =>
    Effect.gen(function* () {
      const receiver = yield* Fixture.fleetReceiver;
      const dns = yield* Fixture.pausedDns;
      const trust = yield* Fleet.FleetPeerTrust;
      const dispatch = yield* Network.PeerNetworkDispatch;
      const identity = {
        origin: receiver.origin,
        ...receiver.certificate,
        connectHost: "localhost",
      };
      const send = dispatch
        .execute(
          HttpClientRequest.post(receiver.origin).pipe(
            HttpClientRequest.setBody(
              HttpBody.text(JSON.stringify({ method: "initialize" }), "application/json"),
            ),
          ),
          Effect.void,
        )
        .pipe(Effect.provideService(Network.NetworkOptions, dns.options));
      assert.equal((yield* send.pipe(Effect.result))._tag, "Failure");
      const wrong = createFleetTlsCertificate({
        address: "127.0.0.1",
        now: yield* Clock.currentTimeMillis,
      });
      yield* trust.replace([
        { ...identity, certificate: wrong.certificate, publicKeySha256: wrong.publicKeySha256 },
      ]);
      assert.equal((yield* send.pipe(Effect.result))._tag, "Failure");
      yield* trust.replace([
        { ...identity, origin: receiver.origin.replace("127.0.0.1", "127.0.0.2") },
      ]);
      assert.equal(
        (yield* dispatch
          .execute(
            HttpClientRequest.get(receiver.origin.replace("127.0.0.1", "127.0.0.2")),
            Effect.void,
          )
          .pipe(Effect.provideService(Network.NetworkOptions, dns.options), Effect.result))._tag,
        "Failure",
      );
      for (const next of [
        [],
        [{ ...identity, certificate: wrong.certificate, publicKeySha256: wrong.publicKeySha256 }],
      ]) {
        yield* trust.replace([identity]);
        yield* Ref.set(dns.pauseAt, (yield* Ref.get(dns.count)) + 1);
        const fiber = yield* send.pipe(Effect.result, Effect.forkChild);
        yield* Queue.take(dns.entered);
        const before = { ...receiver.traffic };
        yield* trust.replace(next);
        yield* dns.release;
        assert.equal((yield* Fiber.join(fiber))._tag, "Failure");
        assert.deepEqual(receiver.traffic, before);
      }
      assert.equal(receiver.received.length, 0);
    }).pipe(Effect.provide(Fleet.layerTrust), Effect.scoped),
);

it.live(
  "chunked oversized responses stop reading and close the owned socket before the producer finishes",
  () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024);
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const server = NodeHttp.createServer((_request, response) => {
            response.writeHead(200, { "transfer-encoding": "chunked" });
            const write = () => {
              while (!response.destroyed && sent < 64 * 1024 * 1024) {
                sent += chunk.length;
                if (!response.write(chunk)) {
                  response.once("drain", write);
                  return;
                }
              }
              if (!response.destroyed) response.end();
            };
            response.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
            write();
          });
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.closeAllConnections();
            server.close(() => resume(Effect.void));
          }),
      );
      const address = server.address();
      assert.isTrue(address !== null && typeof address !== "string");
      if (address === null || typeof address === "string") return;
      const dispatch = yield* Network.PeerNetworkDispatch;
      const result = yield* dispatch
        .execute(HttpClientRequest.get("http://127.0.0.1:" + address.port), Effect.void)
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      yield* Deferred.await(closed);
      assert.isBelow(sent, 64 * 1024 * 1024);
    }).pipe(Effect.scoped),
);

it.live("an HTTP 101 upgrade is refused and its socket is closed deterministically", () =>
  Effect.gen(function* () {
    const receiver = yield* Fixture.receiver;
    receiver.server.removeAllListeners("request");
    receiver.server.on("request", (_request, response) => {
      response.writeHead(101, { connection: "Upgrade", upgrade: "websocket" });
      response.end();
    });
    const dispatch = yield* Network.PeerNetworkDispatch;
    const result = yield* dispatch
      .execute(HttpClientRequest.get(receiver.url.replace("localhost", "127.0.0.1")), Effect.void)
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.match(String(result.failure.cause), /upgrades are refused/u);
  }).pipe(Effect.scoped),
);
