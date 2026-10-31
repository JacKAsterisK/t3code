// @effect-diagnostics nodeBuiltinImport:off -- Disposable loopback MCP and real OS DNS fixtures.
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Clock from "effect/Clock";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Network from "./PeerNetworkDispatch.ts";

const makeReceiver = (tls?: { certificate: string; privateKey: string }) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<{
      method: string;
      tool: string | undefined;
      headers: NodeHttp.IncomingHttpHeaders;
      socket: NodeNet.Socket;
    }>();
    const received: Array<{
      method: string;
      tool: string | undefined;
      headers: NodeHttp.IncomingHttpHeaders;
    }> = [];
    const answer = { status: 200, hang: false, failNextCall: false };
    const traffic = { connections: 0, bytes: 0 };
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const handle: NodeHttp.RequestListener = (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body =
              request.method === "DELETE"
                ? { method: "DELETE" }
                : (JSON.parse(Buffer.concat(chunks).toString()) as {
                    method: string;
                    params?: { name?: string };
                  });
            const record = {
              method: body.method,
              tool: body.params?.name,
              headers: request.headers,
              socket: request.socket,
            };
            received.push(record);
            Queue.offerUnsafe(requests, record);
            if (body.method === "initialize") {
              response.writeHead(200, {
                "content-type": "application/json",
                "mcp-session-id": "session",
              });
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 0,
                  result: { protocolVersion: "2025-06-18" },
                }),
              );
            } else if (body.method === "tools/list") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    tools: [
                      { name: "t3_link_agent_facts" },
                      { name: "t3_link_agent_fact_authority" },
                    ],
                  },
                }),
              );
            } else if (body.method === "tools/call") {
              if (answer.hang) return;
              response.writeHead(answer.failNextCall ? 404 : answer.status, {
                "content-type": "application/json",
              });
              answer.failNextCall = false;
              response.end(
                JSON.stringify({
                  result: {
                    content: [
                      { type: "text", text: JSON.stringify({ untouched: { future: true } }) },
                    ],
                  },
                }),
              );
            } else {
              response.writeHead(202);
              response.end();
            }
          });
        };
        const server =
          tls === undefined
            ? NodeHttp.createServer(handle)
            : NodeHttps.createServer({ cert: tls.certificate, key: tls.privateKey }, handle);
        server.on("connection", (socket) => {
          traffic.connections++;
          socket.on("data", (chunk: Buffer) => {
            traffic.bytes += chunk.length;
          });
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );
    return {
      server,
      requests,
      received,
      answer,
      traffic,
      url: `${tls === undefined ? "http" : "https"}://localhost:${(server.address() as NodeNet.AddressInfo).port}`,
    };
  });

export const receiver = makeReceiver();
export const fleetReceiver = Effect.gen(function* () {
  const certificate = createFleetTlsCertificate({
    address: "127.0.0.1",
    now: yield* Clock.currentTimeMillis,
  });
  const receiver = yield* makeReceiver(certificate);
  return { ...receiver, certificate, origin: receiver.url.replace("localhost", "127.0.0.1") };
});

export const pausedDns = Effect.gen(function* () {
  const entered = yield* Queue.unbounded<number>();
  const completions = yield* Queue.unbounded<() => void>();
  const pauseAt = yield* Ref.make(0);
  const count = yield* Ref.make(0);
  const lookup = Effect.fn("fixture.lookup")(function* (hostname: string) {
    const index = yield* Ref.updateAndGet(count, (value) => value + 1);
    const paused = index === (yield* Ref.get(pauseAt));
    return yield* Effect.callback<NodeDns.LookupAddress, NodeJS.ErrnoException>((done) => {
      NodeDns.lookup(hostname, { family: 4 }, (error, address, family) => {
        const complete = () =>
          done(error === null ? Effect.succeed({ address, family }) : Effect.fail(error));
        if (paused) {
          Queue.offerUnsafe(completions, complete);
          Queue.offerUnsafe(entered, index);
        } else complete();
      });
    });
  });
  const dispatch = yield* Network.PeerNetworkDispatch;
  return {
    entered,
    release: Queue.take(completions).pipe(Effect.flatMap((complete) => Effect.sync(complete))),
    pauseAt,
    count,
    options: { lookup },
    // The pre-fix generic HTTP execution has DNS but no call-level admission.
    http: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => dispatch.execute(request, Effect.void)),
    ),
  };
});

export const tlsBlackhole = Effect.gen(function* () {
  const connections = yield* Queue.unbounded<NodeNet.Socket>();
  const sockets = new Set<NodeNet.Socket>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.resume();
        Queue.offerUnsafe(connections, socket);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  );
  return {
    connections,
    url: `https://localhost:${(server.address() as NodeNet.AddressInfo).port}`,
  };
});
