// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- a real HTTPS receiver and X.509 test certificates.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeModule from "node:module";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentEventAuthority from "./AgentEventAuthority.ts";
import { makeTransport } from "./WebhookSender.ts";

/** The independent Standard Webhooks verifier (in the pnpm store through @clerk/backend). */
export const StandardWebhook = (() => {
  const store = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../../../node_modules/.pnpm",
  );
  const entry = NodeFS.readdirSync(store).find((name) => name.startsWith("standardwebhooks@"));
  if (entry === undefined) throw new Error("standardwebhooks is not in the pnpm store.");
  const required = NodeModule.createRequire(import.meta.url)(
    NodePath.join(store, entry, "node_modules", "standardwebhooks"),
  ) as {
    readonly Webhook: new (secret: string) => {
      verify: (payload: string, headers: Record<string, string>) => unknown;
    };
  };
  return required.Webhook;
})();

export const testSecret = (fill = 7) =>
  `whsec_${Buffer.alloc(32, fill).toString("base64")}` as const;

const der = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Buffer => {
  const value = Buffer.concat(parts);
  const length: number[] = [];
  for (let remaining = value.length; remaining > 0; remaining >>>= 8)
    length.unshift(remaining & 255);
  return Buffer.concat([
    Buffer.from([
      tag,
      ...(value.length < 128 ? [value.length] : [0x80 | length.length, ...length]),
    ]),
    value,
  ]);
};
const sequence = (...parts: ReadonlyArray<Uint8Array>) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const utcTime = (millis: number) =>
  der(
    0x17,
    Buffer.from(new Date(millis).toISOString().slice(2, 19).replaceAll(/[-:T]/gu, "").concat("Z")),
  );

/** A self-signed certificate for DNS names, trusted by the transport through `ca`. */
const makeCertificate = (dnsNames: ReadonlyArray<string>) => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const name = sequence(
    der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from(dnsNames[0] ?? "test")))),
  );
  const algorithm = sequence(oid("2a8648ce3d040302"));
  const now = Date.now();
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1, ...NodeCrypto.randomBytes(8)])),
    algorithm,
    name,
    sequence(utcTime(now - 5 * 60_000), utcTime(now + 24 * 60 * 60_000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(
      0xa3,
      sequence(
        sequence(
          oid("551d13"),
          der(0x01, Buffer.from([255])),
          der(0x04, sequence(der(0x01, Buffer.from([255])))),
        ),
        sequence(
          oid("551d0f"),
          der(0x01, Buffer.from([255])),
          der(0x04, der(0x03, Buffer.from([1, 0x86]))),
        ),
        sequence(oid("551d25"), der(0x04, sequence(oid("2b06010505070301")))),
        sequence(
          oid("551d11"),
          der(0x04, sequence(...dnsNames.map((dns) => der(0x82, Buffer.from(dns))))),
        ),
      ),
    ),
  );
  const certificate = sequence(
    body,
    algorithm,
    der(0x03, Buffer.from([0]), NodeCrypto.sign("sha256", body, privateKey)),
  );
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate
      .toString("base64")
      .match(/.{1,64}/gu)!
      .join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

export interface ReceivedRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly remoteAddress: string | undefined;
}

export type Responder = (
  request: ReceivedRequest,
) =>
  | { readonly status: number; readonly body?: string; readonly headers?: Record<string, string> }
  | "hang";

/** Echoes verification challenges and acknowledges events, unless told otherwise. */
const defaultResponder: Responder = (request) => {
  const parsed = JSON.parse(request.body) as { type?: string; challenge?: string };
  return parsed.type === "verification"
    ? { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) }
    : { status: 200, body: "{}" };
};

/** A real HTTPS callback on 127.0.0.1 for `callback.test`, recording every request. */
export const startReceiver = (options: { readonly certificateFor?: string } = {}) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number;
      readonly ca: string;
      readonly received: Array<ReceivedRequest>;
      /** Every request as it arrives, for tests to await instead of polling. */
      readonly requests: Queue.Queue<ReceivedRequest>;
      readonly respond: { current: Responder };
      readonly server: NodeHttps.Server;
    }>((resume) => {
      const certificate = makeCertificate([options.certificateFor ?? "callback.test"]);
      const received: Array<ReceivedRequest> = [];
      const requests = Effect.runSync(Queue.unbounded<ReceivedRequest>());
      const respond = { current: defaultResponder };
      const server = NodeHttps.createServer(
        { key: certificate.key, cert: certificate.cert },
        (request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const record: ReceivedRequest = {
              path: request.url ?? "",
              headers: Object.fromEntries(
                Object.entries(request.headers).map(([key, value]) => [key, String(value)]),
              ),
              body: Buffer.concat(chunks).toString("utf8"),
              remoteAddress: request.socket.remoteAddress,
            };
            received.push(record);
            Queue.offerUnsafe(requests, record);
            const answer = respond.current(record);
            if (answer === "hang") return;
            response.writeHead(answer.status, {
              "content-type": "application/json",
              ...answer.headers,
            });
            response.end(answer.body ?? "");
          });
        },
      );
      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            port: (server.address() as NodeNet.AddressInfo).port,
            ca: certificate.cert,
            received,
            requests,
            respond,
            server,
          }),
        ),
      );
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

/** Treats 127.0.0.1 as the one "public" address, so the guard's real refusal path runs. */
const loopbackAsPublic = (address: string) => address !== "127.0.0.1";

export const receiverTransport = (
  ca: string,
  options: {
    readonly resolve?: (
      host: string,
    ) => Promise<ReadonlyArray<{ address: string; family: number }>>;
    readonly timeoutMs?: number;
  } = {},
) =>
  makeTransport({
    refuses: loopbackAsPublic,
    resolve: options.resolve ?? (async () => [{ address: "127.0.0.1", family: 4 }]),
    ca,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

/** An in-memory secret store with the same names-to-bytes contract. */
export const layerMemorySecrets = Layer.fresh(
  Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const secrets = yield* Ref.make(new Map<string, Uint8Array>());
      return ServerSecretStore.ServerSecretStore.of({
        get: (name) =>
          Ref.get(secrets).pipe(Effect.map((map) => Option.fromNullishOr(map.get(name)))),
        set: (name, value) => Ref.update(secrets, (map) => new Map(map).set(name, value)),
        create: (name, value) => Ref.update(secrets, (map) => new Map(map).set(name, value)),
        getOrCreateRandom: (name, bytes) =>
          Ref.modify(secrets, (map) => {
            const existing = map.get(name);
            if (existing !== undefined) return [existing, map];
            const created = new Uint8Array(NodeCrypto.randomBytes(bytes));
            return [created, new Map(map).set(name, created)];
          }),
        remove: (name) =>
          Ref.update(secrets, (map) => {
            const next = new Map(map);
            next.delete(name);
            return next;
          }),
      } as ServerSecretStore.ServerSecretStore["Service"]);
    }),
  ),
);

export type Verdicts = Ref.Ref<ReadonlyMap<string, AgentEventAuthority.AuthorityVerdict>>;

/** Authority answers per session id; an unknown session is inactive. */
export const layerAuthority = (verdicts: Verdicts) =>
  Layer.succeed(
    AgentEventAuthority.AgentEventAuthority,
    AgentEventAuthority.AgentEventAuthority.of({
      check: ({ sessionId }) =>
        Ref.get(verdicts).pipe(
          Effect.map(
            (map) =>
              map.get(sessionId) ?? ({ _tag: "Refused", reason: "session_inactive" } as const),
          ),
        ),
    }),
  );

export const allowed = (sessionExpiresAt = 8.64e15, subject = "mcp-client:local") =>
  ({ _tag: "Allowed", sessionExpiresAt, subject }) as const;

/** A fresh in-memory database with every migration, 081 included. */
export const layerDatabase = Layer.fresh(SqlitePersistence.layerMemory);

/** A file database, so two server generations can share it across a restart. */
export const layerFileDatabase = (path: string) =>
  Layer.fresh(SqlitePersistence.layerFromPath(path));
