// @effect-diagnostics nodeBuiltinImport:off - Effect has no SOCKS proxy or address block list.
import * as NodeNet from "node:net";

import { resolveAllowedAddresses } from "@t3tools/shared/publicAddress";
import * as Effect from "effect/Effect";

// Connect only to checked addresses to prevent DNS rebinding.
const publicAddresses = (host: string) => resolveAllowedAddresses(host);

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

const MAX_EARLY_BYTES = 64 * 1024;

const refuse = (client: NodeNet.Socket, code: number) => {
  client.end(reply(code), () => client.destroy());
};

const readRequest = (data: Buffer) => {
  if (data.length < 5) return "short" as const;
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
};

/** Covers requests Chrome's Local Network Access misses, including speculation prefetches. */
export const publicProxy = Effect.acquireRelease(
  Effect.callback<
    { readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> },
    Error
  >((resume) => {
    const sockets = new Set<NodeNet.Socket>();
    const track = (socket: NodeNet.Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      return socket;
    };
    const server = NodeNet.createServer((client) => {
      track(client);
      let data = Buffer.alloc(0);
      let greeted = false;
      const onData = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (!greeted) {
          if (data.length < 2 || data.length < 2 + data[1]!) return;
          if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
            return void client.end(Buffer.from([5, 0xff]));
          }
          data = data.subarray(2 + data[1]!);
          greeted = true;
          client.write(Buffer.from([5, 0]));
        }
        const request = readRequest(data);
        if (request === "short") return;
        client.off("data", onData);
        if (request === undefined || request.command !== 1 || request.port === 0) {
          return refuse(client, 7);
        }
        const early: Array<Buffer> = [request.rest];
        let earlyBytes = request.rest.length;
        const holdEarly = (chunk: Buffer) => {
          earlyBytes += chunk.length;
          if (earlyBytes > MAX_EARLY_BYTES) return void client.destroy();
          early.push(chunk);
        };
        client.on("data", holdEarly);
        void publicAddresses(request.host).then((addresses) => {
          if (client.destroyed) return;
          client.off("data", holdEarly);
          if (addresses === undefined) return refuse(client, 2);
          client.pause();
          // Try all checked addresses so broken IPv6 routes do not block IPv4 access.
          const upstream = track(
            NodeNet.connect({
              host: request.host,
              port: request.port,
              autoSelectFamily: true,
              lookup: (_host, options, callback) =>
                options.all
                  ? callback(null, [...addresses])
                  : callback(null, addresses[0]!.address, addresses[0]!.family),
            }),
          );
          upstream.once("connect", () => {
            client.write(reply(0));
            for (const chunk of early) upstream.write(chunk);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("close", () => client.destroy());
          client.on("close", () => upstream.destroy());
        });
      };
      client.on("data", onData);
    });
    let listening = false;
    server.on("error", (error) => {
      if (!listening) resume(Effect.fail(error));
    });
    server.listen(0, "127.0.0.1", () => {
      listening = true;
      resume(Effect.succeed({ server, sockets }));
    });
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map(({ server }) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);
