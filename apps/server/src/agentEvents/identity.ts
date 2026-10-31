// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import { AGENT_EVENT_LIMITS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** JSON with object keys sorted at every level, so equal values always hash the same. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return jsonText(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${jsonText(key)}:${canonicalJson(entry)}`).join(",")}}`;
};

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest();

/**
 * A subscription's owner: the session that approved it, which has no refresh, so it is the whole
 * lineage. A re-sign-in of the same app (deterministic client id) is a new owner; revoking or
 * expiring the session ends delivery. Fleet attribution is stored beside it, never in it.
 */
export const principalForSession = (sessionId: string) => `session:${sessionId}`;

export const subscriptionIdFor = (input: {
  readonly principalId: string;
  readonly url: string;
  readonly name: string;
  readonly arguments: unknown;
}) =>
  `sub_${sha256(
    canonicalJson([input.principalId, input.url, input.name, canonicalJson(input.arguments)]),
  )
    .toString("base64url")
    .slice(0, 32)}`;

/** Deterministic: the same fact always gets the same event id, so re-adding it is a no-op. */
export const eventIdFor = (transition: string, factKey: string, revision: string) =>
  `t3e1_${sha256(`${transition}|${factKey}|${revision}`).toString("base64url").slice(0, 32)}`;

/**
 * ServerSecretStore names are flat file names in its one directory, case-insensitive on Windows,
 * so they are lower-case hex. Every secret gets a fresh name, so a rotation writes the new file
 * before the row points at it and never overwrites one a delivery may be reading.
 */
export const SECRET_REF_PREFIX = "agent-events-";
export const newSecretRef = (subscriptionId: string) =>
  `${SECRET_REF_PREFIX}${sha256(subscriptionId).toString("hex").slice(0, 24)}-${NodeCrypto.randomBytes(8).toString("hex")}`;

export const randomToken = (bytes: number) => NodeCrypto.randomBytes(bytes).toString("base64url");

/** The key bytes of a `whsec_` secret, or undefined when it is not a valid Standard Webhooks secret. */
export const decodeWebhookSecret = (secret: unknown): Uint8Array | undefined => {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return undefined;
  const encoded = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length >= AGENT_EVENT_LIMITS.secretMinBytes &&
    bytes.length <= AGENT_EVENT_LIMITS.secretMaxBytes
    ? new Uint8Array(bytes)
    : undefined;
};

/** Standard Webhooks `webhook-signature`: one `v1,<sig>` per key, space separated. */
export const webhookSignature = (
  keys: ReadonlyArray<Uint8Array>,
  webhookId: string,
  timestampSeconds: number,
  body: string,
) =>
  keys
    .map(
      (key) =>
        `v1,${NodeCrypto.createHmac("sha256", key)
          .update(`${webhookId}.${timestampSeconds}.${body}`, "utf8")
          .digest("base64")}`,
    )
    .join(" ");

export const constantTimeEqual = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

export const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
