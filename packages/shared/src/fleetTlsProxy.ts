// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns fixed-destination native HTTP/TLS streams and socket disposal.
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import { fleetTlsPublicKeySha256, verifyFleetTlsCertificate } from "./fleetTlsCertificate.ts";
import * as NodeCrypto from "node:crypto";
import { FleetConnectHost } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { desktopProtocolSchemes } from "./distribution.ts";
const isConnectHost = Schema.is(FleetConnectHost);

export interface FleetTlsTrust {
  readonly origin: string;
  readonly certificate: string;
  readonly publicKeySha256: string;
  readonly connectHost?: string;
}
export interface FleetProxy {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly close: () => Promise<void>;
}

/** Only name-resolution errors permit a route fallback; socket/TLS failures never replay a request. */
export const isFleetDnsFailure = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  "code" in error &&
  ["ENOTFOUND", "EAI_FAIL", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME"].includes(String(error.code));

/** Preserve every successful DNS answer, including IPv6 and the caller's all-address lookup. */
export const fleetLookup =
  (trust: FleetTlsTrust, lookup: NodeNet.LookupFunction = NodeDns.lookup): NodeNet.LookupFunction =>
  (hostname, options, callback) => {
    lookup(hostname, options, (error, address, family) => {
      const target = new URL(trust.origin);
      if (
        isFleetDnsFailure(error) &&
        hostname === trust.connectHost &&
        target.protocol === "https:" &&
        target.origin === trust.origin &&
        NodeNet.isIPv4(target.hostname)
      ) {
        // This is a socket lookup result, before TCP/TLS or any HTTP bytes. The unchanged
        // TLS options still verify the signed origin's certificate and pinned public key.
        callback(
          null,
          options.all ? [{ address: target.hostname, family: 4 }] : target.hostname,
          4,
        );
      } else callback(error, address, family);
    });
  };

/** Bounded transport diagnostics, excluding request headers, bodies and credentials. */
export const peerConnectionFailure = (cause: unknown): string => {
  const details: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const error = value as {
      code?: unknown;
      syscall?: unknown;
      hostname?: unknown;
      address?: unknown;
      port?: unknown;
      cause?: unknown;
      reason?: unknown;
      errors?: unknown;
      name?: unknown;
    };
    if (typeof error.code === "string") {
      const phase =
        error.syscall === "getaddrinfo"
          ? "DNS"
          : error.code.includes("TIMEOUT") || error.code === "ETIMEDOUT"
            ? "timeout"
            : "connection/TLS";
      details.push(
        [phase, error.code, error.hostname, error.address, error.port]
          .filter((v) => typeof v === "string" || typeof v === "number")
          .join(" "),
      );
    } else if (
      error.name === "TimeoutError" ||
      error.name === "TimeoutException" ||
      (value as { _tag?: unknown })._tag === "TimeoutError"
    )
      details.push("connection/descriptor timeout");
    visit(error.cause, depth + 1);
    visit(error.reason, depth + 1);
    if (Array.isArray(error.errors))
      for (const child of error.errors.slice(0, 4)) visit(child, depth + 1);
  };
  visit(cause, 0);
  return (
    [...new Set(details)].join("; ").slice(0, 700) || "connection or descriptor request failed"
  );
};

export function fleetTlsRequestOptions(
  trust: FleetTlsTrust,
  now: number,
): NodeHttps.RequestOptions {
  const target = new URL(trust.origin);
  if (
    target.protocol !== "https:" ||
    target.origin !== trust.origin ||
    !NodeNet.isIPv4(target.hostname) ||
    (trust.connectHost !== undefined && !isConnectHost(trust.connectHost)) ||
    !verifyFleetTlsCertificate(trust.certificate, target.hostname, trust.publicKeySha256, now)
  )
    throw new Error("The approved fleet NodeTls identity is invalid.");
  return {
    ca: trust.certificate,
    lookup: fleetLookup(trust),
    // Electron's Node 24 requires partial-chain trust for the exact pinned, non-CA leaf.
    allowPartialTrustChain: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    servername: "",
    checkServerIdentity: (_hostname, certificate) => {
      // DNS selects the transport route; the signed origin and pinned key still name the peer.
      const mismatch = NodeTls.checkServerIdentity(target.hostname, certificate);
      if (mismatch !== undefined) return mismatch;
      const actual = new NodeCrypto.X509Certificate(certificate.raw);
      return fleetTlsPublicKeySha256(actual.publicKey) === trust.publicKeySha256
        ? undefined
        : new Error("The fleet peer key changed.");
    },
  };
}

/** Marks a request the encrypted fleet endpoint forwarded; only that endpoint can set it. */
export const FLEET_TLS_FORWARD_HEADER = "x-t3-fleet-tls";

/** No redirect or caller-supplied destination can escape this adapter's approved endpoint. */
export async function startFleetProxy(input: {
  readonly listen: { readonly address: string; readonly port: number };
  readonly target: string;
  readonly serverTls?: {
    readonly certificate: string;
    readonly privateKey: string;
    readonly origin?: string;
  };
  readonly peerTls?: { readonly identity: FleetTlsTrust; readonly now: number };
  /**
   * A secret the encrypted endpoint sets as `FLEET_TLS_FORWARD_HEADER` on what it forwards, so
   * the backend can tell a request that really arrived over TLS. A client's own copy is dropped.
   */
  readonly forwardedMark?: string;
}): Promise<FleetProxy> {
  const target = new URL(input.target);
  const advertised =
    input.serverTls?.origin === undefined ? undefined : new URL(input.serverTls.origin);
  if (
    advertised !== undefined &&
    (advertised.protocol !== "https:" ||
      advertised.origin !== input.serverTls!.origin ||
      !NodeNet.isIPv4(advertised.hostname) ||
      (input.listen.port !== 0 && Number(advertised.port || 443) !== input.listen.port))
  )
    throw new Error("Invalid advertised fleet endpoint.");
  const peerOptions =
    input.peerTls === undefined
      ? {}
      : fleetTlsRequestOptions(input.peerTls.identity, input.peerTls.now);
  if (input.peerTls === undefined) {
    const localBackend =
      ["127.0.0.1", "[::1]"].includes(target.hostname) ||
      (input.serverTls !== undefined &&
        NodeNet.isIPv4(target.hostname) &&
        Object.values(NodeOS.networkInterfaces()).some((entries) =>
          entries?.some((entry) => entry.address === target.hostname),
        ));
    if (target.protocol !== "http:" || !localBackend)
      throw new Error("The fleet endpoint must forward only to its local backend.");
  } else if (
    target.origin !== input.peerTls.identity.origin ||
    input.serverTls !== undefined ||
    input.listen.address !== "127.0.0.1"
  ) {
    throw new Error("A fleet client gateway must be local and bound to its approved peer.");
  }
  if (
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== "" ||
    target.username !== "" ||
    target.password !== ""
  )
    throw new Error("Invalid fleet endpoint.");
  const sockets = new Set<NodeNet.Socket>();
  const request = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
  const headers = (incoming: NodeHttp.IncomingMessage) => {
    const result: NodeHttp.IncomingHttpHeaders = {
      ...incoming.headers,
      host: input.serverTls === undefined ? target.host : incoming.headers.host,
    };
    // Local browser cookies belong to the local T3 instance, not its fleet peer.
    // The fleet transport uses only the explicitly selected bearer credential.
    for (const name of [
      "cookie",
      "proxy-authorization",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      FLEET_TLS_FORWARD_HEADER,
    ])
      delete result[name];
    if (input.serverTls !== undefined && input.forwardedMark !== undefined)
      result[FLEET_TLS_FORWARD_HEADER] = input.forwardedMark;
    return result;
  };
  const options = (incoming: NodeHttp.IncomingMessage): NodeHttps.RequestOptions => ({
    ...peerOptions,
    hostname: input.peerTls?.identity.connectHost ?? target.hostname.replace(/^\[|\]$/gu, ""),
    port: target.port,
    method: incoming.method,
    path: incoming.url,
    headers: headers(incoming),
    agent: false,
  });
  const validPath = (path: string | undefined) =>
    path !== undefined && path.startsWith("/") && !path.startsWith("//");
  const server =
    input.serverTls === undefined
      ? NodeHttp.createServer({ maxHeaderSize: 32_768 })
      : NodeHttps.createServer({
          cert: input.serverTls.certificate,
          key: input.serverTls.privateKey,
          minVersion: "TLSv1.2",
          handshakeTimeout: 10_000,
          maxHeaderSize: 32_768,
        });
  server.maxConnections = 64;
  server.headersTimeout = 20_000;
  const endpointHost = (port: number) => {
    if (advertised !== undefined) {
      const endpoint = new URL(advertised);
      endpoint.port = String(port);
      return endpoint.host;
    }
    const host = NodeNet.isIPv6(input.listen.address)
      ? `[${input.listen.address}]`
      : input.listen.address;
    return `${host}:${port}`;
  };
  const validHost = (incoming: NodeHttp.IncomingMessage) => {
    const address = server.address();
    return (
      address !== null &&
      typeof address !== "string" &&
      incoming.headers.host === endpointHost(address.port)
    );
  };
  const validOrigin = (incoming: NodeHttp.IncomingMessage) => {
    if (input.peerTls === undefined || incoming.headers.origin === undefined) return true;
    if (desktopProtocolSchemes.some((scheme) => incoming.headers.origin === `${scheme}://app`))
      return true;
    try {
      const origin = new URL(incoming.headers.origin);
      return (
        origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      );
    } catch {
      return false;
    }
  };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (incoming, response) => {
    if (!validPath(incoming.url) || !validHost(incoming) || !validOrigin(incoming)) {
      response.writeHead(400).end();
      return;
    }
    const upstream = request(options(incoming), (remote) => {
      if ((remote.statusCode ?? 500) >= 300 && (remote.statusCode ?? 500) < 400) {
        remote.destroy();
        response.writeHead(502).end();
        return;
      }
      const responseHeaders = { ...remote.headers };
      delete responseHeaders["set-cookie"];
      response.writeHead(remote.statusCode ?? 502, responseHeaders);
      remote.on("error", () => response.destroy());
      remote.pipe(response);
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    incoming.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    if (
      !validPath(incoming.url) ||
      !validHost(incoming) ||
      !validOrigin(incoming) ||
      incoming.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      socket.destroy();
      return;
    }
    const upstream = request(options(incoming));
    upstream.setTimeout(20_000, () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("response", (response) => {
      response.destroy();
      socket.destroy();
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      sockets.add(remote);
      remote.once("close", () => {
        sockets.delete(remote);
        socket.destroy();
      });
      remote.on("error", () => socket.destroy());
      socket.once("close", () => remote.destroy());
      const headers = response.rawHeaders.reduce<string[]>(
        (lines, value, index, all) =>
          index % 2 === 0 && value.toLowerCase() !== "set-cookie"
            ? [...lines, `${value}: ${all[index + 1]}`]
            : lines,
        [],
      );
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) remote.write(head);
      if (remoteHead.length > 0) socket.write(remoteHead);
      remote.pipe(socket);
      socket.pipe(remote);
    });
    upstream.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.listen.port, input.listen.address, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fleet listener address unavailable.");
  const scheme = input.serverTls === undefined ? "http" : "https";
  return {
    httpBaseUrl: `${scheme}://${endpointHost(address.port)}/`,
    wsBaseUrl: `${scheme === "http" ? "ws" : "wss"}://${endpointHost(address.port)}/`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
