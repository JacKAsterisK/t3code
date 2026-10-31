// @effect-diagnostics nodeBuiltinImport:off -- Real loopback transport and TLS identity checks.
import * as NodeDns from "node:dns";
import type * as NodeTls from "node:tls";
import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { startReceiver } from "../agentEvents/AgentEvents.testkit.ts";
import * as Network from "./PeerNetworkDispatch.ts";
import * as NetworkTest from "./PeerNetworkDispatch.testkit.ts";

it.live("numeric peer addresses still require admission before connecting", () =>
  Effect.gen(function* () {
    const receiver = yield* NetworkTest.receiver;
    const dispatch = yield* Network.PeerNetworkDispatch;
    let checks = 0;
    const refused = new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Link revoked",
    });
    const result = yield* dispatch
      .execute(
        HttpClientRequest.post(receiver.url.replace("localhost", "127.0.0.1")),
        Effect.suspend(() => {
          checks++;
          return Effect.fail(refused);
        }),
      )
      .pipe(Effect.result);
    assert.equal(checks, 1);
    assert.equal(receiver.received.length, 0);
    assert.deepEqual(receiver.traffic, { connections: 0, bytes: 0 });
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure, refused);
  }).pipe(Effect.scoped),
);

it.live(
  "pinned HTTPS verifies the original hostname and SNI, preserves Host, and refuses redirects",
  () =>
    Effect.gen(function* () {
      const receiver = yield* startReceiver();
      const target = yield* NetworkTest.receiver;
      const dispatch = yield* Network.PeerNetworkDispatch;
      const names: string[] = [];
      receiver.server.on("secureConnection", (socket: NodeTls.TLSSocket) =>
        names.push(String(socket.servername)),
      );
      let resolutions = 0;
      const lookup = () =>
        Effect.callback<NodeDns.LookupAddress, NodeJS.ErrnoException>((done) => {
          resolutions++;
          NodeDns.lookup("localhost", { family: 4 }, (error, address, family) =>
            done(error === null ? Effect.succeed({ address, family }) : Effect.fail(error)),
          );
        });
      const send = (hostname: string, path = "/mcp") =>
        dispatch
          .execute(
            HttpClientRequest.post(`https://${hostname}:${receiver.port}${path}`).pipe(
              HttpClientRequest.setHeaders({ authorization: "Bearer isolated-token" }),
              HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
            ),
            Effect.void,
          )
          .pipe(Effect.provideService(Network.NetworkOptions, { lookup, ca: receiver.ca }));
      const response = yield* send("callback.test");
      assert.equal(response.status, 200);
      assert.equal(receiver.received[0]?.headers.host, `callback.test:${receiver.port}`);
      assert.equal(receiver.received[0]?.headers.authorization, "Bearer isolated-token");
      assert.deepEqual(names, ["callback.test"]);
      assert.equal(resolutions, 1);
      const mismatch = yield* send("wrong.test").pipe(Effect.result);
      assert.equal(mismatch._tag, "Failure");
      if (mismatch._tag === "Failure")
        assert.match(
          String(mismatch.failure.cause),
          /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/u,
        );
      assert.equal(receiver.received.length, 1);
      receiver.respond.current = () => ({
        status: 307,
        headers: { location: `${target.url}/mcp` },
      });
      const redirected = yield* send("callback.test", "/redirect").pipe(Effect.result);
      assert.equal(redirected._tag, "Failure");
      assert.equal(receiver.received.length, 2);
      assert.equal(target.received.length, 0);
      assert.equal(resolutions, 3);
    }).pipe(Effect.scoped),
);
