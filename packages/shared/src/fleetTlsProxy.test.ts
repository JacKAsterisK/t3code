// @effect-diagnostics nodeBuiltinImport:off -- Transient loopback fixtures exercise real Node TLS validation and streaming sockets.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { createFleetTlsCertificate } from "./fleetTlsCertificate.ts";
import {
  FLEET_TLS_FORWARD_HEADER,
  fleetTlsRequestOptions,
  startFleetProxy,
} from "./fleetTlsProxy.ts";

vi.mock("./distribution.ts", () => ({ desktopProtocolSchemes: ["t3code-lan"] }));

const listen = (server: NodeHttp.Server | NodeHttps.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No test port"));
        return;
      }
      resolve(address.port);
    });
  });
const close = (server: NodeHttp.Server | NodeHttps.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
const get = (
  url: string,
  authorization = "Bearer synthetic-only",
  extraHeaders: Record<string, string> = {},
) =>
  new Promise<{ status: number; body: string; cookie?: string[] }>((resolve, reject) => {
    const request = NodeHttp.get(
      url,
      { headers: { authorization, ...extraHeaders }, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body,
            ...(response.headers["set-cookie"] === undefined
              ? {}
              : { cookie: response.headers["set-cookie"] }),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  });

it.live(
  "uses the configured native runtime to trust the exact saved leaf and reject replacements",
  () =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* Effect.promise(async () => {
        const code = `
        import assert from "node:assert/strict";
        import http from "node:http";
        import https from "node:https";
        import { startFleetProxy, fleetTlsRequestOptions } from ${JSON.stringify(new URL("./fleetTlsProxy.ts", import.meta.url).href)};
        import { createFleetTlsCertificate } from ${JSON.stringify(new URL("./fleetTlsCertificate.ts", import.meta.url).href)};
        const now = ${now};
        const listen = server => new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server.address().port));
        });
        const close = server => new Promise(resolve => server.close(resolve));
        const get = url => new Promise((resolve, reject) => {
          const request = http.get(url, { headers: { authorization: "Bearer synthetic-only" }, agent: false }, response => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", data => body += data);
            response.once("end", () => resolve({ status: response.statusCode, body }));
            response.once("error", reject);
          });
          request.once("error", reject);
        });
        let requests = 0, impostorRequests = 0;
        const backend = http.createServer((request, response) => {
          requests++;
          assert.equal(request.headers.authorization, "Bearer synthetic-only");
          response.end("saved identity reached");
        });
        const backendPort = await listen(backend);
        const approved = createFleetTlsCertificate({ address: "127.0.0.1", now });
        const impostor = createFleetTlsCertificate({ address: "127.0.0.1", now });
        const impostorServer = https.createServer({ key: impostor.privateKey, cert: impostor.certificate }, (_request, response) => {
          impostorRequests++;
          response.end("wrong peer");
        });
        const impostorPort = await listen(impostorServer);
        let endpoint, gateway, wrongGateway;
        try {
          endpoint = await startFleetProxy({
            listen: { address: "127.0.0.1", port: 0 },
            target: "http://127.0.0.1:" + backendPort + "/",
            serverTls: approved,
          });
          const identity = {
            origin: new URL(endpoint.httpBaseUrl).origin,
            certificate: approved.certificate,
            publicKeySha256: approved.publicKeySha256,
            connectHost: "localhost",
          };
          gateway = await startFleetProxy({
            listen: { address: "127.0.0.1", port: 0 },
            target: endpoint.httpBaseUrl, peerTls: { identity, now },
          });
          assert.deepEqual(await get(gateway.httpBaseUrl), { status: 200, body: "saved identity reached" });
          assert.throws(() => fleetTlsRequestOptions({ ...identity, origin: "https://127.0.0.2:4443" }, now));
          assert.throws(() => fleetTlsRequestOptions({ ...identity, publicKeySha256: impostor.publicKeySha256 }, now));
          const wrongIdentity = { ...identity, origin: "https://127.0.0.1:" + impostorPort };
          wrongGateway = await startFleetProxy({
            listen: { address: "127.0.0.1", port: 0 },
            target: wrongIdentity.origin + "/", peerTls: { identity: wrongIdentity, now },
          });
          assert.equal((await get(wrongGateway.httpBaseUrl)).status, 502);
          assert.equal(impostorRequests, 0);
          assert.equal(requests, 1);
        } finally {
          await wrongGateway?.close(); await gateway?.close(); await endpoint?.close();
          await close(impostorServer); await close(backend);
        }
        console.log(JSON.stringify({ passed: true, node: process.versions.node, requests, impostorRequests }));
      `;
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = NodeChildProcess.spawn(
              process.env.T3_LAN_TEST_NODE ?? process.execPath,
              ["--input-type=module", "--eval", code],
              {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "",
              stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (data) => {
              stdout += data;
            });
            child.stderr.on("data", (data) => {
              stderr += data;
            });
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, stdout, stderr }));
          },
        );
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          passed: true,
          requests: 1,
          impostorRequests: 0,
        });
      });
    }),
);

it.live("reaches the pinned IPv4 identity over a DNS IPv6 route without changing its Host", () =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.promise(async () => {
      const backend = NodeHttp.createServer((request, response) => {
        response.end(request.headers.authorization);
      });
      const port = await listen(backend);
      const key = createFleetTlsCertificate({ address: "127.0.0.1", now });
      let endpoint: Awaited<ReturnType<typeof startFleetProxy>> | undefined;
      let gateway: Awaited<ReturnType<typeof startFleetProxy>> | undefined;
      try {
        endpoint = await startFleetProxy({
          listen: { address: "::1", port: 0 },
          target: `http://127.0.0.1:${port}/`,
          serverTls: { ...key, origin: "https://127.0.0.1:0" },
        });
        const identity = {
          origin: new URL(endpoint.httpBaseUrl).origin,
          certificate: key.certificate,
          publicKeySha256: key.publicKeySha256,
          connectHost: "localhost",
        };
        gateway = await startFleetProxy({
          listen: { address: "127.0.0.1", port: 0 },
          target: endpoint.httpBaseUrl,
          peerTls: { identity, now },
        });
        expect(
          await get(gateway.httpBaseUrl, "Bearer synthetic-only", { origin: "t3code-lan://app" }),
        ).toEqual({
          status: 200,
          body: "Bearer synthetic-only",
        });
        expect(() =>
          fleetTlsRequestOptions({ ...identity, connectHost: "untrusted.test/path" }, now),
        ).toThrow();
      } finally {
        await gateway?.close();
        await endpoint?.close();
        await close(backend);
      }
    });
  }),
);

it.live("streams an authenticated request through the encrypted endpoint and local gateway", () =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.promise(async () => {
      const received: string[] = [];
      const cookies: Array<string | undefined> = [];
      const marks: Array<string | string[] | undefined> = [];
      const backend = NodeHttp.createServer((request, response) => {
        received.push(request.headers.authorization ?? "");
        cookies.push(request.headers.cookie);
        marks.push(request.headers[FLEET_TLS_FORWARD_HEADER]);
        response.setHeader("set-cookie", "synthetic=must-not-escape");
        response.end("synthetic task data");
      });
      const port = await listen(backend);
      const key = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const endpoint = await startFleetProxy({
        listen: { address: "127.0.0.1", port: 0 },
        target: `http://127.0.0.1:${port}/`,
        serverTls: key,
        forwardedMark: "synthetic-mark",
      });
      const identity = {
        origin: new URL(endpoint.httpBaseUrl).origin,
        certificate: key.certificate,
        publicKeySha256: key.publicKeySha256,
      };
      const gateway = await startFleetProxy({
        listen: { address: "127.0.0.1", port: 0 },
        target: endpoint.httpBaseUrl,
        peerTls: { identity, now },
      });
      try {
        expect(
          await get(`${gateway.httpBaseUrl}api/synthetic`, "Bearer synthetic-only", {
            cookie: "synthetic-local-session=private",
            [FLEET_TLS_FORWARD_HEADER]: "forged-by-client",
          }),
        ).toEqual({ status: 200, body: "synthetic task data" });
        expect(received).toEqual(["Bearer synthetic-only"]);
        expect(cookies).toEqual([undefined]);
        // Only the encrypted endpoint's own mark reaches the backend, never a client's.
        expect(marks).toEqual(["synthetic-mark"]);
        expect(
          (
            await get(gateway.httpBaseUrl, "Bearer synthetic-only", {
              host: "untrusted.example.test",
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await get(gateway.httpBaseUrl, "Bearer synthetic-only", {
              origin: "https://untrusted.example.test",
            })
          ).status,
        ).toBe(400);
        expect(received.length).toBe(1);
      } finally {
        await gateway.close();
        await endpoint.close();
        await close(backend);
      }
    });
  }),
);

it.live("forwards WebSocket upgrade bytes through the verified TLS gateway", () =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.promise(async () => {
      const backend = NodeHttp.createServer();
      backend.on("upgrade", (incoming, socket) => {
        const accept = NodeCrypto.createHash("sha1")
          .update(`${incoming.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.on("error", () => socket.destroy());
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.on("data", (chunk) => socket.write(chunk));
        socket.on("end", () => socket.end());
      });
      const port = await listen(backend);
      const key = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const endpoint = await startFleetProxy({
        listen: { address: "::1", port: 0 },
        target: `http://127.0.0.1:${port}/`,
        serverTls: { ...key, origin: "https://127.0.0.1:0" },
      });
      const identity = {
        origin: new URL(endpoint.httpBaseUrl).origin,
        certificate: key.certificate,
        publicKeySha256: key.publicKeySha256,
        connectHost: "localhost",
      };
      const gateway = await startFleetProxy({
        listen: { address: "127.0.0.1", port: 0 },
        target: endpoint.httpBaseUrl,
        peerTls: { identity, now },
      });
      try {
        const bytes = await new Promise<string>((resolve, reject) => {
          const request = NodeHttp.request(`${gateway.httpBaseUrl}ws?wsTicket=synthetic-only`, {
            headers: {
              connection: "Upgrade",
              upgrade: "websocket",
              origin: "t3code-lan://app",
              "sec-websocket-version": "13",
              "sec-websocket-key": Buffer.from("synthetic-key-16").toString("base64"),
            },
          });
          request.on("error", reject);
          request.on("response", (response) => {
            response.destroy();
            reject(new Error("Upgrade rejected"));
          });
          request.on("upgrade", (_response, socket) => {
            socket.once("error", reject);
            socket.once("data", (chunk) => {
              socket.destroy();
              resolve(chunk.toString());
            });
            socket.write("synthetic-websocket-stream");
          });
          request.end();
        });
        expect(bytes).toBe("synthetic-websocket-stream");
      } finally {
        await gateway.close();
        await endpoint.close();
        await close(backend);
      }
    });
  }),
);

it.live("normal TLS rejects a substituted peer before any bearer request reaches its handler", () =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.promise(async () => {
      const approved = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const impostor = createFleetTlsCertificate({ address: "127.0.0.1", now });
      let requests = 0;
      const server = NodeHttps.createServer(
        { key: impostor.privateKey, cert: impostor.certificate },
        (_request, response) => {
          requests++;
          response.end("wrong peer");
        },
      );
      const port = await listen(server);
      const origin = `https://127.0.0.1:${port}`;
      const gateway = await startFleetProxy({
        listen: { address: "127.0.0.1", port: 0 },
        target: `${origin}/`,
        peerTls: {
          now,
          identity: {
            origin,
            certificate: approved.certificate,
            publicKeySha256: approved.publicKeySha256,
          },
        },
      });
      try {
        expect((await get(gateway.httpBaseUrl)).status).toBe(502);
        expect(requests).toBe(0);
      } finally {
        await gateway.close();
        await close(server);
      }
    });
  }),
);

it.live("does not follow redirects or allow plaintext/nonlocal gateway fallback", () =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.promise(async () => {
      const key = createFleetTlsCertificate({ address: "127.0.0.1", now });
      expect(() =>
        fleetTlsRequestOptions(
          {
            origin: "http://127.0.0.1:4443",
            certificate: key.certificate,
            publicKeySha256: key.publicKeySha256,
          },
          now,
        ),
      ).toThrow();
      await expect(
        startFleetProxy({
          listen: { address: "127.0.0.1", port: 0 },
          target: "http://192.168.40.10:4000/",
        }),
      ).rejects.toThrow();
      const backend = NodeHttp.createServer((_request, response) => {
        response.writeHead(302, { location: "http://192.168.40.10:4000/" });
        response.end();
      });
      const port = await listen(backend);
      const proxy = await startFleetProxy({
        listen: { address: "127.0.0.1", port: 0 },
        target: `http://127.0.0.1:${port}/`,
      });
      try {
        expect((await get(proxy.httpBaseUrl)).status).toBe(502);
      } finally {
        await proxy.close();
        await close(backend);
      }
    });
  }),
);
