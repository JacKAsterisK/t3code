// @effect-diagnostics nodeBuiltinImport:off -- the sender pins each TLS connection to checked addresses, which Effect's HTTP client cannot.
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

import { AGENT_EVENT_LIMITS, type AgentEventCallbackFailureReason } from "@t3tools/contracts";
import {
  isLoopbackAddress,
  isNonPublicAddress,
  type ResolvedAddress,
  resolveAllowedAddresses,
} from "@t3tools/shared/publicAddress";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { constantTimeEqual, randomToken, webhookSignature } from "./identity.ts";

const CALLBACK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Dev harness only: lets callbacks reach 127/8 and ::1. Refused unless the server has a devUrl. */
const ALLOW_LOOPBACK_ENV = "T3CODE_AGENT_EVENTS_ALLOW_LOOPBACK_CALLBACKS";

export type PostFailureReason =
  | "timeout"
  | "tls_error"
  | "address_refused"
  | "connection_failed"
  | "invalid_url";

export type PostOutcome =
  | {
      readonly _tag: "Response";
      readonly status: number;
      readonly retryAfter: string | undefined;
      readonly body: string;
      /** The address the connection reached. */
      readonly remoteAddress: string | undefined;
    }
  | { readonly _tag: "Failed"; readonly reason: PostFailureReason };

export interface WebhookTransportOptions {
  readonly refuses: (address: string, family: number) => boolean;
  readonly resolve?: (host: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  /** Extra trusted roots, for tests. Production trusts the system and NODE_EXTRA_CA_CERTS. */
  readonly ca?: string;
  readonly timeoutMs?: number;
}

export class WebhookTransport extends Context.Service<
  WebhookTransport,
  {
    readonly post: (input: {
      readonly url: URL;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }) => Effect.Effect<PostOutcome>;
  }
>()("t3/agentEvents/WebhookSender/WebhookTransport") {}

/** HTTPS only, no credentials or fragment, bounded length. Addresses are checked per connection. */
export const parseCallbackUrl = (value: unknown): URL | undefined => {
  if (typeof value !== "string" || value.length > AGENT_EVENT_LIMITS.callbackUrlLength)
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.hostname.length > 0
    ? url
    : undefined;
};

/** Origin and path only: a query can carry a token, so logs and diagnostics never show it. */
export const redactCallbackUrl = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search === "" ? "" : "?…"}`;
  } catch {
    return "(invalid url)";
  }
};

const TLS_ERROR =
  /^(ERR_TLS|ERR_SSL|ERR_OSSL|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/u;

const classify = (error: unknown): PostFailureReason => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "ETIMEDOUT") return "timeout";
  if (TLS_ERROR.test(code)) return "tls_error";
  return "connection_failed";
};

/**
 * One POST, never followed: the host is resolved once, every answer must pass `refuses`, and
 * the socket may only connect to those answers (a second lookup cannot rebind it). TLS still
 * checks the certificate against the original hostname.
 */
export const makeTransport = (options: WebhookTransportOptions): WebhookTransport["Service"] => ({
  post: ({ url, headers, body }) => {
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const attempt = Effect.callback<PostOutcome>((resume) => {
      let request: ReturnType<typeof NodeHttps.request> | undefined;
      let settled = false;
      const finish = (outcome: PostOutcome) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(outcome));
      };
      void resolveAllowedAddresses(host, {
        refuses: options.refuses,
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      }).then((addresses) => {
        if (settled) return;
        if (addresses === undefined) return finish({ _tag: "Failed", reason: "address_refused" });
        try {
          request = NodeHttps.request({
            protocol: "https:",
            host,
            port: url.port === "" ? 443 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: { ...headers, "content-length": String(Buffer.byteLength(body, "utf8")) },
            agent: false,
            ...(NodeNet.isIP(host) === 0 ? { servername: host } : {}),
            ...(options.ca === undefined ? {} : { ca: options.ca }),
            lookup: (_hostname, lookupOptions, callback) =>
              lookupOptions.all
                ? (callback as (error: null, addresses: Array<ResolvedAddress>) => void)(null, [
                    ...addresses,
                  ])
                : callback(null, addresses[0]!.address, addresses[0]!.family),
          });
        } catch (error) {
          return finish({ _tag: "Failed", reason: classify(error) });
        }
        request.on("response", (response) => {
          const chunks: Array<Buffer> = [];
          let size = 0;
          const remoteAddress = response.socket?.remoteAddress;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
            else response.destroy();
          });
          const done = () =>
            finish({
              _tag: "Response",
              status: response.statusCode ?? 0,
              retryAfter:
                typeof response.headers["retry-after"] === "string"
                  ? response.headers["retry-after"]
                  : undefined,
              body: Buffer.concat(chunks).toString("utf8"),
              remoteAddress,
            });
          response.on("end", done);
          response.on("close", done);
          response.on("error", done);
        });
        request.on("error", (error) => finish({ _tag: "Failed", reason: classify(error) }));
        request.end(body);
      });
      return Effect.sync(() => {
        settled = true;
        request?.destroy();
      });
    });
    return attempt.pipe(
      Effect.timeoutOption(Duration.millis(options.timeoutMs ?? CALLBACK_TIMEOUT_MS)),
      Effect.map(Option.getOrElse((): PostOutcome => ({ _tag: "Failed", reason: "timeout" }))),
    );
  },
});

/**
 * Production policy: public addresses only. The dev harness may also allow loopback, but only
 * on a dev server (`devUrl`), so a shipped build can never call back into its own machine.
 */
export const layerTransport = Layer.effect(
  WebhookTransport,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const asked = process.env[ALLOW_LOOPBACK_ENV] === "1";
    const allowLoopback = asked && config.devUrl !== undefined;
    if (asked && !allowLoopback)
      yield* Effect.logWarning(
        `${ALLOW_LOOPBACK_ENV} is ignored: it only applies to a dev server.`,
      );
    return makeTransport({
      refuses: allowLoopback
        ? (address, family) =>
            !isLoopbackAddress(address, family) && isNonPublicAddress(address, family)
        : isNonPublicAddress,
    });
  }),
);

export class CallbackEndpointError extends Schema.TaggedError<CallbackEndpointError>()(
  "CallbackEndpointError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The callback endpoint failed verification: ${this.reason}.`;
  }
}

/** How a response or failure reads as a callback failure; undefined for a 2xx. */
export const failureReason = (
  outcome: PostOutcome,
): AgentEventCallbackFailureReason | undefined => {
  if (outcome._tag === "Failed") return outcome.reason;
  if (outcome.status >= 300 && outcome.status < 400) return "redirect_refused";
  if (outcome.status < 200 || outcome.status >= 300) return `http_${outcome.status}`;
  return undefined;
};

export const signedHeaders = (input: {
  readonly webhookId: string;
  readonly timestampSeconds: number;
  readonly subscriptionId: string;
  readonly keys: ReadonlyArray<Uint8Array>;
  readonly body: string;
}) => ({
  "content-type": "application/json",
  "webhook-id": input.webhookId,
  "webhook-timestamp": String(input.timestampSeconds),
  "webhook-signature": webhookSignature(
    input.keys,
    input.webhookId,
    input.timestampSeconds,
    input.body,
  ),
  "x-mcp-subscription-id": input.subscriptionId,
});

/** POSTs one signed body, signed now: the exact bytes signed are the bytes sent. */
export const postSigned = Effect.fn("AgentEvents.postSigned")(function* (input: {
  readonly url: URL;
  readonly subscriptionId: string;
  readonly webhookId: string;
  readonly keys: ReadonlyArray<Uint8Array>;
  readonly body: string;
}) {
  const transport = yield* WebhookTransport;
  const timestampSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return yield* transport.post({
    url: input.url,
    body: input.body,
    headers: signedHeaders({ ...input, timestampSeconds }),
  });
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * Proves the callback wants these events: a signed, single-use challenge it must echo in a 2xx
 * JSON body. Every call makes a fresh challenge; none is stored or reused.
 */
export const verifyCallback = Effect.fn("AgentEvents.verifyCallback")(function* (input: {
  readonly url: URL;
  readonly subscriptionId: string;
  readonly keys: ReadonlyArray<Uint8Array>;
}) {
  const challenge = randomToken(32);
  const outcome = yield* postSigned({
    ...input,
    webhookId: `msg_verification_${randomToken(12)}`,
    body: encodeJson({ type: "verification", challenge }),
  });
  const failed = failureReason(outcome);
  if (failed !== undefined) return yield* new CallbackEndpointError({ reason: failed });
  if (outcome._tag !== "Response")
    return yield* new CallbackEndpointError({ reason: "challenge_failed" });
  const echoed = Option.getOrUndefined(decodeJson(outcome.body));
  const value =
    typeof echoed === "object" && echoed !== null && "challenge" in echoed
      ? echoed.challenge
      : undefined;
  if (typeof value !== "string" || !constantTimeEqual(value, challenge))
    return yield* new CallbackEndpointError({ reason: "challenge_failed" });
});
