import {
  AGENT_EVENT_CATALOG,
  AGENT_EVENT_LIMITS,
  AGENT_EVENT_NAMES,
  type AgentEventName,
  type AgentEventSubscribeResult,
  type AgentEventSubscriptionArguments,
  AgentEventsErrorCode,
  formatAgentEventCursor,
  parseAgentEventCursor,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as AgentEventAuthority from "./AgentEventAuthority.ts";
import * as Store from "./AgentEventStore.ts";
import {
  canonicalJson,
  decodeWebhookSecret,
  newSecretRef,
  principalForSession,
  sameBytes,
  subscriptionIdFor,
} from "./identity.ts";
import { parseCallbackUrl, redactCallbackUrl, verifyCallback } from "./WebhookSender.ts";

/** A JSON-RPC error the events methods answer with. */
export class EventsRpcError extends Schema.TaggedError<EventsRpcError>()("EventsRpcError", {
  code: Schema.Number,
  detail: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return this.detail;
  }
}

const invalidParams = (message: string) =>
  new EventsRpcError({ code: AgentEventsErrorCode.invalidParams, detail: message });
const forbidden = (message: string) =>
  new EventsRpcError({ code: AgentEventsErrorCode.forbidden, detail: message });
const internal = () =>
  new EventsRpcError({
    code: AgentEventsErrorCode.internal,
    detail: "Agent events are unavailable right now.",
  });
const callbackError = (reason: string) =>
  new EventsRpcError({
    code: AgentEventsErrorCode.callbackEndpoint,
    detail: "CallbackEndpointError",
    data: { reason },
  });

/**
 * Who may use `events/*`: an outside OAuth client signed in here. Thread callers, peer links and
 * task-only grants never can. Read access is checked by the caller's scope for list and by the
 * session store (with the fleet cap) for anything that delivers.
 */
const eventsCaller = (scope: McpInvocationContext.McpInvocationScope) => {
  const client = scope.client;
  if (scope.thread !== undefined || client === undefined)
    return Effect.fail(forbidden("Only outside MCP clients signed in to T3 Code can use events."));
  if (client.linked === true)
    return Effect.fail(forbidden("A linked environment's session cannot use events."));
  if (client.taskOnly === true || client.grantId !== undefined)
    return Effect.fail(forbidden("A task grant cannot use events."));
  return Effect.succeed(client);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = Effect.fn("AgentEvents.stringList")(function* (
  value: unknown,
  key: string,
  max: number,
) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((item) => typeof item !== "string" || item.length > AGENT_EVENT_LIMITS.idLength)
  )
    return yield* invalidParams(`arguments.${key} must be at most ${max} strings.`);
  return value as ReadonlyArray<string>;
});

/** The subscription arguments, checked against the advertised schema (no extra keys). */
const decodeArguments = Effect.fn("AgentEvents.decodeArguments")(function* (value: unknown) {
  if (value === undefined || value === null) return {} satisfies AgentEventSubscriptionArguments;
  if (!isRecord(value)) return yield* invalidParams("arguments must be an object.");
  const unknown = Object.keys(value).filter(
    (key) => !["environmentIds", "threadIds", "includeDelegatedResults"].includes(key),
  );
  if (unknown.length > 0)
    return yield* invalidParams(
      `arguments has no property ${unknown.map((key) => `"${key}"`).join(", ")}. There is no owner filter.`,
    );
  const environmentIds = yield* stringList(
    value.environmentIds,
    "environmentIds",
    AGENT_EVENT_LIMITS.environmentIds,
  );
  const threadIds = yield* stringList(value.threadIds, "threadIds", AGENT_EVENT_LIMITS.threadIds);
  const delegated = value.includeDelegatedResults;
  if (delegated !== undefined && typeof delegated !== "boolean")
    return yield* invalidParams("arguments.includeDelegatedResults must be a boolean.");
  return {
    ...(environmentIds === undefined ? {} : { environmentIds }),
    ...(threadIds === undefined ? {} : { threadIds }),
    ...(delegated === undefined ? {} : { includeDelegatedResults: delegated }),
  } satisfies AgentEventSubscriptionArguments;
});

const decodeName = (value: unknown) =>
  typeof value === "string" && (AGENT_EVENT_NAMES as ReadonlyArray<string>).includes(value)
    ? Effect.succeed(value as AgentEventName)
    : Effect.fail(invalidParams(`name must be one of ${AGENT_EVENT_NAMES.join(", ")}.`));

const decodeDelivery = Effect.fn("AgentEvents.decodeDelivery")(function* (
  value: unknown,
  needsSecret: boolean,
) {
  if (!isRecord(value) || value.mode !== "webhook")
    return yield* invalidParams('delivery must be { mode: "webhook", url, secret }.');
  const url = parseCallbackUrl(value.url);
  if (url === undefined) return yield* callbackError("invalid_url");
  if (!needsSecret) return { url, secret: undefined };
  const secret = decodeWebhookSecret(value.secret);
  if (secret === undefined)
    return yield* invalidParams(
      `delivery.secret must be "whsec_" and base64 of ${AGENT_EVENT_LIMITS.secretMinBytes}-${AGENT_EVENT_LIMITS.secretMaxBytes} bytes.`,
    );
  return { url, secret };
});

/** Default 24 h, 1 h to 7 days, never past the session: `ttlMs: null` still gets a finite grant. */
export const grantedTtlMs = (requested: unknown, untilSessionEnds: number) => {
  const asked =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(requested, AGENT_EVENT_LIMITS.minTtlMs), AGENT_EVENT_LIMITS.maxTtlMs)
      : AGENT_EVENT_LIMITS.defaultTtlMs;
  return Math.max(0, Math.min(asked, untilSessionEnds));
};

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const isRpcError = Schema.is(EventsRpcError);

/** Storage and secret failures answer as an internal error; their detail stays in the log. */
const asRpcError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EventsRpcError, R> =>
  effect.pipe(
    Effect.tapError((error) =>
      isRpcError(error)
        ? Effect.void
        : Effect.logError("Agent events request failed.", { cause: error }),
    ),
    Effect.mapError((error) => (isRpcError(error) ? error : internal())),
  );

const deleteSecrets = Effect.fn("AgentEvents.deleteSecrets")(function* (
  refs: ReadonlyArray<string>,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* Effect.forEach(refs, (ref) => secrets.remove(ref).pipe(Effect.ignore), {
    discard: true,
  });
});

export const listEvents = Effect.fn("AgentEvents.list")(function* (
  scope: McpInvocationContext.McpInvocationScope,
) {
  yield* eventsCaller(scope);
  return { events: AGENT_EVENT_CATALOG };
});

/**
 * `events/subscribe`, also the refresh. Authorises, validates, verifies the callback unless
 * verified for this principal and URL in the last 24 h, rotates the secret when it changed (both
 * sign for 10 minutes), and binds the subscription to the calling session.
 */
export const subscribe = Effect.fn("AgentEvents.subscribe")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  params: unknown,
) {
  const client = yield* eventsCaller(scope);
  if (client.sharesOutside === false)
    return yield* forbidden("This credential cannot hand T3 data outside the fleet.");
  if (!isRecord(params)) return yield* invalidParams("params must be an object.");
  const name = yield* decodeName(params.name);
  const args = yield* decodeArguments(params.arguments);
  const delivery = yield* decodeDelivery(params.delivery, true);
  const secret = delivery.secret!;
  const cursorParam = params.cursor;
  if (cursorParam !== undefined && cursorParam !== null && typeof cursorParam !== "string")
    return yield* invalidParams("cursor must be a string or null.");
  const cursor = typeof cursorParam === "string" ? parseAgentEventCursor(cursorParam) : undefined;
  if (typeof cursorParam === "string" && cursor === undefined)
    return yield* invalidParams("cursor is not one this server issued.");
  if (params.ttlMs !== undefined && params.ttlMs !== null && typeof params.ttlMs !== "number")
    return yield* invalidParams("ttlMs must be a number or null.");

  const authority = yield* AgentEventAuthority.AgentEventAuthority;
  const verdict = yield* authority.check({ sessionId: client.sessionId });
  if (verdict._tag === "Unavailable") return yield* internal();
  if (verdict._tag === "Refused")
    return yield* forbidden(
      verdict.reason === "outside_sharing_refused" || verdict.reason === "fleet_read_only"
        ? "This credential cannot hand T3 data outside the fleet."
        : "This session cannot read T3 events.",
    );

  const now = yield* Clock.currentTimeMillis;
  const principalId = principalForSession(client.sessionId);
  const callbackUrl = delivery.url.href;
  const subscriptionId = subscriptionIdFor({
    principalId,
    url: callbackUrl,
    name,
    arguments: args,
  });
  const log = yield* Store.logState();
  if (cursor !== undefined && cursor.epoch === log.epoch && cursor.sequence > log.headSeq)
    return yield* invalidParams("cursor is ahead of this server's event log.");

  const verified = yield* Store.verifiedAt(principalId, callbackUrl);
  if (verified === undefined || now - verified >= AGENT_EVENT_LIMITS.verificationTtlMs) {
    yield* verifyCallback({ url: delivery.url, subscriptionId, keys: [secret] }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Agent event callback verification failed.", {
          subscriptionId,
          callback: redactCallbackUrl(callbackUrl),
          reason: error.reason,
        }),
      ),
      Effect.mapError((error) => callbackError(error.reason)),
    );
    yield* Store.recordVerification(principalId, callbackUrl, now);
  }

  // The new secret is written under a fresh name before any row points at it, so a crash
  // leaves at worst an orphan file, which startup removes.
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const existing = yield* Store.findSubscription(subscriptionId);
  const current =
    existing === undefined
      ? Option.none<Uint8Array>()
      : yield* secrets.get(existing.secretRef).pipe(Effect.orElseSucceed(Option.none));
  const keepSecret = Option.isSome(current) && sameBytes(current.value, secret);
  const secretRef = keepSecret ? existing!.secretRef : newSecretRef(subscriptionId);
  if (!keepSecret) yield* secrets.create(secretRef, secret);
  const rotatingFrom =
    !keepSecret && existing !== undefined && Option.isSome(current) && existing.state === "active"
      ? existing.secretRef
      : undefined;
  const obsolete = [
    ...(!keepSecret && existing !== undefined && rotatingFrom === undefined
      ? [existing.secretRef]
      : []),
    ...(!keepSecret && existing?.previousSecretRef ? [existing.previousSecretRef] : []),
  ];

  const ttl = grantedTtlMs(params.ttlMs, verdict.sessionExpiresAt - now);
  const expiresAt = now + ttl;
  const sql = yield* SqlClient.SqlClient;
  const { watermark, truncated } = yield* sql.withTransaction(
    Effect.gen(function* () {
      const fresh = existing === undefined || existing.logEpoch !== log.epoch;
      yield* Store.upsertSubscription(
        {
          subscriptionId,
          principalId,
          sessionId: client.sessionId,
          attributionSubject: verdict.subject,
          clientLabel: client.label,
          eventName: name,
          argumentsJson: canonicalJson(args),
          callbackUrl,
          secretRef,
          previousSecretRef: keepSecret
            ? (existing?.previousSecretRef ?? null)
            : (rotatingFrom ?? null),
          previousSecretUntil: keepSecret
            ? (existing?.previousSecretUntil ?? null)
            : rotatingFrom === undefined
              ? null
              : now + AGENT_EVENT_LIMITS.secretOverlapMs,
          state: "active",
          expiresAt,
          logEpoch: log.epoch,
          updatedAt: now,
        },
        log.headSeq,
      );
      let truncated = false;
      if (cursor !== undefined) {
        const lost = cursor.epoch !== log.epoch || cursor.sequence < log.floorSeq - 1;
        truncated = lost;
        yield* Store.requeueAfter({
          subscriptionId,
          afterSeq: lost ? log.floorSeq - 1 : cursor.sequence,
          // Behind what it was sent: it lost deliveries, so they go again.
          includeDelivered: lost || fresh || cursor.sequence < existing!.watermarkSeq,
          now,
        });
      }
      return { watermark: yield* Store.recomputeWatermark(subscriptionId, now), truncated };
    }),
  );
  yield* deleteSecrets(obsolete);
  yield* Effect.logInfo("Agent event subscription granted.", {
    subscriptionId,
    client: client.label,
    callback: redactCallbackUrl(callbackUrl),
    refreshed: existing !== undefined,
    truncated,
  });
  return {
    id: subscriptionId,
    refreshBefore: iso(expiresAt),
    cursor: formatAgentEventCursor(log.epoch, watermark),
    truncated,
  } satisfies AgentEventSubscribeResult;
}, asRpcError);

/** `events/unsubscribe`: idempotent, and only ever the caller's own subscription. */
export const unsubscribe = Effect.fn("AgentEvents.unsubscribe")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  params: unknown,
) {
  const client = yield* eventsCaller(scope);
  if (!isRecord(params)) return yield* invalidParams("params must be an object.");
  const name = yield* decodeName(params.name);
  const args = yield* decodeArguments(params.arguments);
  const delivery = yield* decodeDelivery(params.delivery, false);
  const subscriptionId = subscriptionIdFor({
    principalId: principalForSession(client.sessionId),
    url: delivery.url.href,
    name,
    arguments: args,
  });
  const now = yield* Clock.currentTimeMillis;
  const refs = yield* Store.endSubscription({
    subscriptionId,
    state: "unsubscribed",
    reason: "unsubscribed",
    now,
  });
  yield* deleteSecrets(refs);
  if (refs.length > 0)
    yield* Effect.logInfo("Agent event subscription ended by its client.", { subscriptionId });
  return {};
}, asRpcError);
