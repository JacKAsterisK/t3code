import { AGENT_EVENT_LIMITS, formatAgentEventCursor } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as FleetAccessPolicy from "../lan/FleetAccessPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentEventAuthority from "./AgentEventAuthority.ts";
import * as Store from "./AgentEventStore.ts";
import * as FactAuthority from "./AgentFactAuthority.ts";
import * as RelayAdmission from "./AgentFactRelayAdmission.ts";
import { SECRET_REF_PREFIX } from "./identity.ts";
import {
  failureReason,
  parseCallbackUrl,
  postSigned,
  redactCallbackUrl,
  WebhookTransport,
} from "./WebhookSender.ts";

/** Retry after 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, then every 8 h, ±20%. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];
const MAX_BACKOFF_MS = 8 * 3_600_000;
const MAX_IN_FLIGHT = 4;
const POLL_INTERVAL = Duration.seconds(1);
const SWEEP_INTERVAL = Duration.seconds(60);
const PRUNE_INTERVAL = Duration.hours(1);
/** An authority check that cannot finish waits this long before the event is tried again. */
const UNAVAILABLE_RETRY_MS = 30_000;
/** A secret file no row names, older than this, is left over from an interrupted subscribe. */
const ORPHAN_SECRET_AGE_MS = 10 * 60_000;

export const backoffMs = (attempts: number) =>
  BACKOFF_MS[Math.max(0, attempts - 1)] ?? MAX_BACKOFF_MS;

/** `Retry-After` in seconds or as an HTTP date, kept between 5 s and 8 h. */
export const retryAfterMs = (header: string | undefined, now: number): number | undefined => {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  const seconds = /^\d+$/u.test(trimmed) ? Number(trimmed) * 1000 : undefined;
  const date =
    seconds === undefined
      ? Option.getOrUndefined(DateTime.make(trimmed))?.epochMilliseconds
      : undefined;
  const wait = seconds ?? (date === undefined ? undefined : date - now);
  return wait === undefined || !Number.isFinite(wait)
    ? undefined
    : Math.min(Math.max(wait, BACKOFF_MS[0]!), MAX_BACKOFF_MS);
};

const jittered = (delay: number) =>
  Random.next.pipe(Effect.map((random) => Math.round(delay * (0.8 + random * 0.4))));

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The exact bytes sent and signed: the event's stored `data` is spliced in unchanged, so every
 * retry carries the same event (same id, occurrence time and data) and only the signature and
 * its timestamp change.
 */
export const deliveryBody = (input: {
  readonly eventId: string;
  readonly name: string;
  readonly occurredAt: number;
  readonly dataJson: string;
  readonly cursor: string;
}) =>
  `{"eventId":${encodeString(input.eventId)},"name":${encodeString(input.name)},"timestamp":${encodeString(
    DateTime.formatIso(DateTime.makeUnsafe(input.occurredAt)),
  )},"data":${input.dataJson},"cursor":${encodeString(input.cursor)}}`;

export type AttemptResult =
  | "delivered"
  | "rejected"
  | "gone"
  | "retry"
  | "abandoned"
  | "revoked"
  | "deferred"
  | "skipped";

/** One delivery attempt for one claimed event. */
export const attempt = Effect.fn("AgentEventDelivery.attempt")(function* (claim: {
  readonly subscriptionId: string;
  readonly eventId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const authority = yield* AgentEventAuthority.AgentEventAuthority;
  const settings = yield* ServerSettings.ServerSettingsService;
  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.agentEventsEnabled),
    Effect.orElseSucceed(() => false),
  );
  const now = yield* Clock.currentTimeMillis;
  const subscription = yield* Store.findSubscription(claim.subscriptionId);
  const delivery = yield* Store.findDelivery(claim.subscriptionId, claim.eventId);
  if (subscription === undefined || delivery === undefined || delivery.state !== "sending")
    return "skipped" as const;
  const release = (
    state: "pending" | "abandoned" | "rejected",
    error: string | null,
    at = now,
    releasedAt = now,
  ) =>
    Store.finishAttempt({
      subscriptionId: claim.subscriptionId,
      eventId: claim.eventId,
      state,
      attempted: false,
      nextAttemptAt: at,
      lastStatus: null,
      lastError: error,
      now: releasedAt,
    });
  // Delivery stops exactly at the granted expiry: no grace.
  if (subscription.state !== "active" || subscription.expiresAt <= now) {
    yield* release("pending", null);
    return "skipped" as const;
  }
  const deliveryDeadline = delivery.queuedAt + AGENT_EVENT_LIMITS.abandonAfterMs;
  if (now >= deliveryDeadline) {
    yield* release("abandoned", "delivery_retention_expired");
    return "abandoned" as const;
  }
  const verdict = yield* authority
    .check({
      sessionId: subscription.sessionId,
      attributionSubject: subscription.attributionSubject,
    })
    .pipe(
      Effect.timeoutOption(
        Math.max(0, Math.min(30_000, subscription.expiresAt - now, deliveryDeadline - now)),
      ),
      Effect.map(
        Option.getOrElse((): AgentEventAuthority.AuthorityVerdict => ({ _tag: "Unavailable" })),
      ),
    );
  const authorityAt = yield* Clock.currentTimeMillis;
  if (authorityAt >= deliveryDeadline) {
    yield* release("abandoned", "delivery_retention_expired", authorityAt, authorityAt);
    return "abandoned" as const;
  }
  if (authorityAt >= subscription.expiresAt) {
    yield* release("pending", null, authorityAt, authorityAt);
    return "skipped" as const;
  }
  if (verdict._tag === "Unavailable") {
    yield* release(
      "pending",
      "authority_unavailable",
      authorityAt + UNAVAILABLE_RETRY_MS,
      authorityAt,
    );
    return "deferred" as const;
  }
  if (verdict._tag === "Refused") {
    yield* release("pending", null);
    yield* revoke(subscription.subscriptionId, verdict.reason, now);
    return "revoked" as const;
  }
  const event = yield* Store.loadEvent(delivery.logSeq);
  if (event === undefined) {
    yield* release("abandoned", "event_not_retained");
    return "abandoned" as const;
  }
  const factAuthority = yield* Effect.serviceOption(FactAuthority.AgentFactAuthority);
  const relayAdmission = yield* Effect.serviceOption(RelayAdmission.AgentFactRelayAdmission);
  const checkFact: Effect.Effect<FactAuthority.FactAuthorityVerdict> =
    event.originEnvironmentId === null
      ? Effect.succeed({ _tag: "Allowed" } as const)
      : Option.isNone(factAuthority)
        ? Effect.succeed({ _tag: "Unavailable" } as const)
        : factAuthority.value.check({
            sessionId: subscription.sessionId,
            eventId: event.eventId,
            attributionSubject: subscription.attributionSubject,
            originEnvironmentId: event.originEnvironmentId,
            originGeneration: event.originGeneration,
            threadId: event.threadId,
            relayedFrom: event.relayedFrom,
          });
  const checkAndRecord = (phase: "prepare" | "dispatch") =>
    checkFact.pipe(
      Effect.flatMap((verdict) => {
        if (
          verdict._tag !== "Allowed" ||
          !("relayProof" in verdict) ||
          verdict.relayProof === undefined
        )
          return Effect.succeed(verdict);
        if (Option.isNone(relayAdmission) || event.originEnvironmentId === null)
          return Effect.succeed({ _tag: "Unavailable" } as const);
        return relayAdmission.value
          .record({
            subscriptionId: subscription.subscriptionId,
            eventId: event.eventId,
            originEnvironmentId: event.originEnvironmentId,
            sessionId: subscription.sessionId,
            attributionSubject: subscription.attributionSubject,
            phase,
            proof: verdict.relayProof,
          })
          .pipe(
            Effect.map((recorded) => (recorded ? verdict : ({ _tag: "Unavailable" } as const))),
          );
      }),
    );
  const readable = yield* checkAndRecord("prepare").pipe(
    Effect.timeoutOption(
      Math.max(
        0,
        Math.min(
          30_000,
          subscription.expiresAt - (yield* Clock.currentTimeMillis),
          deliveryDeadline - (yield* Clock.currentTimeMillis),
        ),
      ),
    ),
    Effect.map(
      Option.getOrElse((): FactAuthority.FactAuthorityVerdict => ({ _tag: "Unavailable" })),
    ),
  );
  const preparedAt = yield* Clock.currentTimeMillis;
  if (preparedAt >= deliveryDeadline) {
    yield* release("abandoned", "delivery_retention_expired", preparedAt, preparedAt);
    return "abandoned" as const;
  }
  if (preparedAt >= subscription.expiresAt) {
    yield* release("pending", null, preparedAt, preparedAt);
    return "skipped" as const;
  }
  if (readable._tag === "Unavailable") {
    yield* release(
      "pending",
      "fact_authority_unavailable",
      preparedAt + UNAVAILABLE_RETRY_MS,
      preparedAt,
    );
    return "deferred" as const;
  }
  if (readable._tag === "Refused") {
    yield* release("abandoned", readable.reason);
    return "abandoned" as const;
  }
  let dispatchRefusal: { readonly kind: "session" | "fact"; readonly reason: string } | undefined;
  const canDispatch = Effect.gen(function* () {
    if (!(yield* enabled)) return false;
    const at = yield* Clock.currentTimeMillis;
    if (at >= deliveryDeadline || at >= subscription.expiresAt) return false;
    const current = yield* Store.findSubscription(subscription.subscriptionId);
    if (
      current?.state !== "active" ||
      current.expiresAt <= at ||
      current.sessionId !== subscription.sessionId
    )
      return false;
    const fresh = yield* authority.check({
      sessionId: subscription.sessionId,
      attributionSubject: subscription.attributionSubject,
    });
    if (fresh._tag !== "Allowed") {
      if (fresh._tag === "Refused") dispatchRefusal = { kind: "session", reason: fresh.reason };
      return false;
    }
    const verdict = yield* checkAndRecord("dispatch");
    if (verdict._tag === "Refused") dispatchRefusal = { kind: "fact", reason: verdict.reason };
    return verdict._tag === "Allowed";
  }).pipe(
    Effect.catchCause(() => Effect.succeed(false)),
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  const url = parseCallbackUrl(subscription.callbackUrl);
  const keys = [
    yield* secrets.get(subscription.secretRef),
    ...(subscription.previousSecretRef !== null &&
    subscription.previousSecretUntil !== null &&
    subscription.previousSecretUntil > now
      ? [yield* secrets.get(subscription.previousSecretRef)]
      : []),
  ];
  if (url === undefined || keys.length === 0 || Option.isNone(keys[0]!)) {
    yield* release("pending", null);
    yield* revoke(subscription.subscriptionId, "secret_missing", now);
    return "revoked" as const;
  }
  const { epoch } = yield* Store.logState();
  const lowerPending = yield* Store.lowestOtherUnfinished(claim.subscriptionId, claim.eventId);
  const cursorSeq =
    lowerPending === undefined ? delivery.logSeq : Math.min(delivery.logSeq, lowerPending - 1);
  const body = deliveryBody({
    eventId: event.eventId,
    name: subscription.eventName,
    occurredAt: event.occurredAt,
    dataJson: event.dataJson,
    cursor: formatAgentEventCursor(epoch, cursorSeq),
  });
  if (Buffer.byteLength(body, "utf8") > AGENT_EVENT_LIMITS.maxBodyBytes) {
    yield* release("rejected", "body_too_large");
    return "rejected" as const;
  }
  const sendAt = yield* Clock.currentTimeMillis;
  if (sendAt >= deliveryDeadline) {
    yield* release("abandoned", "delivery_retention_expired", sendAt, sendAt);
    return "abandoned" as const;
  }
  if (sendAt >= subscription.expiresAt || !(yield* enabled)) {
    yield* release("pending", null);
    return "skipped" as const;
  }
  const outcome = yield* postSigned({
    url,
    subscriptionId: subscription.subscriptionId,
    webhookId: event.eventId,
    keys: keys.flatMap((key) => (Option.isSome(key) ? [key.value] : [])),
    body,
    expiresAt: Math.min(subscription.expiresAt, deliveryDeadline),
    canDispatch,
  });
  const finishedAt = yield* Clock.currentTimeMillis;
  if (finishedAt >= deliveryDeadline) {
    yield* release("abandoned", "delivery_retention_expired", finishedAt, finishedAt);
    return "abandoned" as const;
  }
  if (finishedAt >= subscription.expiresAt || !(yield* enabled)) {
    yield* release("pending", null, finishedAt);
    return "skipped" as const;
  }
  if (outcome._tag === "Deferred") {
    if (dispatchRefusal?.kind === "session") {
      yield* release("pending", null, finishedAt, finishedAt);
      yield* revoke(subscription.subscriptionId, dispatchRefusal.reason, finishedAt);
      return "revoked" as const;
    }
    if (dispatchRefusal?.kind === "fact") {
      yield* release("abandoned", dispatchRefusal.reason, finishedAt, finishedAt);
      return "abandoned" as const;
    }
    yield* release(
      "pending",
      "fact_authority_unavailable",
      finishedAt + UNAVAILABLE_RETRY_MS,
      finishedAt,
    );
    return "deferred" as const;
  }
  const status = outcome._tag === "Response" ? outcome.status : null;
  const record = (
    state: "pending" | "delivered" | "rejected" | "abandoned",
    error: string | null,
    nextAttemptAt = finishedAt,
  ) =>
    Store.finishAttempt({
      subscriptionId: claim.subscriptionId,
      eventId: claim.eventId,
      state,
      attempted: true,
      nextAttemptAt,
      lastStatus: status,
      lastError: error,
      now: finishedAt,
    });
  const logged = { subscriptionId: subscription.subscriptionId, eventId: event.eventId, status };
  if (status !== null && status >= 200 && status < 300) {
    yield* record("delivered", null);
    yield* Effect.logInfo("Agent event delivered.", logged);
    return "delivered" as const;
  }
  if (status === 410) {
    yield* record("rejected", "http_410");
    const refs = yield* Store.endSubscription({
      subscriptionId: subscription.subscriptionId,
      state: "gone",
      reason: "callback_returned_410",
      now: finishedAt,
    });
    yield* deleteSecrets(refs);
    yield* Effect.logWarning("Agent event callback is gone; the subscription ended.", {
      ...logged,
      callback: redactCallbackUrl(subscription.callbackUrl),
    });
    return "gone" as const;
  }
  if (status === 413) {
    yield* record("rejected", "http_413");
    yield* Effect.logWarning("Agent event callback refused the event as too large.", logged);
    return "rejected" as const;
  }
  const reason = failureReason(outcome) ?? "failed";
  if (finishedAt - delivery.queuedAt >= AGENT_EVENT_LIMITS.abandonAfterMs) {
    yield* record("abandoned", reason);
    yield* Effect.logWarning("Agent event abandoned after 48 hours of failures.", logged);
    return "abandoned" as const;
  }
  const wait =
    (status === 429
      ? retryAfterMs(outcome._tag === "Response" ? outcome.retryAfter : undefined, finishedAt)
      : undefined) ?? (yield* jittered(backoffMs(delivery.attempts + 1)));
  yield* record("pending", reason, finishedAt + wait);
  yield* Effect.logInfo("Agent event delivery failed; it will be retried.", {
    ...logged,
    reason,
    retryInMs: wait,
  });
  return "retry" as const;
});

const deleteSecrets = Effect.fn("AgentEventDelivery.deleteSecrets")(function* (
  refs: ReadonlyArray<string>,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* Effect.forEach(refs, (ref) => secrets.remove(ref).pipe(Effect.ignore), {
    discard: true,
  });
});

const revoke = Effect.fn("AgentEventDelivery.revoke")(function* (
  subscriptionId: string,
  reason: string,
  now: number,
) {
  const refs = yield* Store.endSubscription({
    subscriptionId,
    state: "revoked",
    reason,
    now,
    fromState: "active",
  });
  yield* deleteSecrets(refs);
  if (refs.length > 0)
    yield* Effect.logWarning("Agent event subscription revoked; delivery stopped.", {
      subscriptionId,
      reason,
    });
});

/** Expires what ran out, and revokes every active subscription whose session lost its access. */
export const sweep = Effect.fn("AgentEventDelivery.sweep")(function* () {
  const authority = yield* AgentEventAuthority.AgentEventAuthority;
  const now = yield* Clock.currentTimeMillis;
  yield* Store.expireDue(now);
  for (const subscription of yield* Store.listSubscriptions(["active"])) {
    const verdict = yield* authority.check({
      sessionId: subscription.sessionId,
      attributionSubject: subscription.attributionSubject,
    });
    if (verdict._tag === "Refused") yield* revoke(subscription.subscriptionId, verdict.reason, now);
  }
  yield* deleteSecrets(yield* Store.retirePreviousSecrets(now));
});

/** Removes secret files no subscription names, left by a subscribe interrupted mid-write. */
export const removeOrphanSecrets = Effect.fn("AgentEventDelivery.removeOrphanSecrets")(
  function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const now = yield* Clock.currentTimeMillis;
    const referenced = yield* Store.referencedSecretRefs();
    const names = yield* fileSystem.readDirectory(config.secretsDir);
    for (const file of names) {
      if (!file.startsWith(SECRET_REF_PREFIX) || !file.endsWith(".bin")) continue;
      const ref = file.slice(0, -".bin".length);
      if (referenced.has(ref)) continue;
      const info = yield* fileSystem.stat(`${config.secretsDir}/${file}`).pipe(Effect.option);
      const modified = Option.isSome(info)
        ? Option.getOrUndefined(info.value.mtime)?.getTime()
        : undefined;
      if (modified !== undefined && now - modified < ORPHAN_SECRET_AGE_MS) continue;
      yield* secrets.remove(ref).pipe(Effect.ignore);
    }
  },
);

/** Wakes the worker early, for example after a subscribe. */
export class AgentEventDelivery extends Context.Service<
  AgentEventDelivery,
  { readonly wake: Effect.Effect<void> }
>()("t3/agentEvents/AgentEventDelivery") {}

/**
 * The delivery worker. It runs while `agentEventsEnabled` is on: at most one event in flight per
 * subscription and four overall, lowest sequence first. Rows left `sending` by a crash go again
 * (the receiver dedupes on the event id). Sweeps run every 60 s and at once when a session is
 * removed or fleet access changes; a probe written by the CLI is picked up within a second.
 */
export const layer = Layer.effect(
  AgentEventDelivery,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const sessions = yield* SessionStore.SessionStore;
    const context = yield* Effect.context<
      | SqlClient.SqlClient
      | ServerSecretStore.ServerSecretStore
      | AgentEventAuthority.AgentEventAuthority
      | ServerConfig.ServerConfig
      | FileSystem.FileSystem
      | WebhookTransport
      | ServerSettings.ServerSettingsService
    >();
    const factAuthority = yield* Effect.serviceOption(FactAuthority.AgentFactAuthority);
    const relayAdmission = yield* Effect.serviceOption(RelayAdmission.AgentFactRelayAdmission);
    const factsContext = Option.isSome(factAuthority)
      ? Context.add(context, FactAuthority.AgentFactAuthority, factAuthority.value)
      : context;
    const deliveryContext = Option.isSome(relayAdmission)
      ? Context.add(factsContext, RelayAdmission.AgentFactRelayAdmission, relayAdmission.value)
      : factsContext;
    const fleetAccess = yield* Effect.serviceOption(FleetAccessPolicy.FleetAccess);
    const enabled = settings.getSettings.pipe(
      Effect.map((current) => current.agentEventsEnabled),
      Effect.orElseSucceed(() => false),
    );
    const settingsChanges = yield* settings.subscribeChanges;
    // Turning events on takes a restart (the /mcp protocol list is fixed then); off stops at once.
    if (!(yield* enabled)) return AgentEventDelivery.of({ wake: Effect.void });

    const inFlight = yield* Ref.make(0);
    const wakeups = yield* Queue.sliding<void>(1);
    const sweeps = yield* Queue.sliding<void>(1);
    const quietly =
      (label: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Agent events ${label} failed.`, { cause }),
          ),
          Effect.asVoid,
        );

    yield* Store.resetSending(yield* Clock.currentTimeMillis).pipe(
      Effect.provide(context),
      quietly("restart reset"),
    );
    yield* removeOrphanSecrets().pipe(Effect.provide(context), quietly("secret cleanup"));

    type Claim = { readonly subscriptionId: string; readonly eventId: string };
    type Cleanup = Claim & { readonly nextAttemptAt: number };
    const cleanup = yield* Ref.make(new Map<string, Cleanup>());
    const releaseClaim = Effect.fn("AgentEventDelivery.releaseClaim")(function* (claim: Cleanup) {
      const now = yield* Clock.currentTimeMillis;
      yield* Store.finishAttempt({
        ...claim,
        state: "pending",
        attempted: false,
        nextAttemptAt: claim.nextAttemptAt,
        lastStatus: null,
        lastError: "delivery_interrupted",
        now,
      });
      yield* Ref.update(cleanup, (pending) => {
        const next = new Map(pending);
        next.delete(claim.subscriptionId);
        return next;
      });
    });
    const releaseOrQueue = Effect.fn("AgentEventDelivery.releaseOrQueue")(function* (
      claim: Cleanup,
    ) {
      yield* releaseClaim(claim).pipe(
        Effect.catchCause((cause) =>
          // Only the tick owns queued cleanup; an immediate release must finish before publishing it.
          Ref.update(cleanup, (waiting) => new Map(waiting).set(claim.subscriptionId, claim)).pipe(
            Effect.andThen(Effect.logWarning("Agent events claim cleanup failed.", { cause })),
          ),
        ),
      );
    });
    const retryCleanup = Effect.gen(function* () {
      for (const claim of (yield* Ref.get(cleanup)).values())
        yield* releaseClaim(claim).pipe(quietly("claim cleanup"));
    }).pipe(Effect.provide(context));
    yield* Effect.addFinalizer(() => retryCleanup);
    const sends = yield* FiberSet.make<void>();
    const handoff = yield* Semaphore.make(1);
    const send = (claim: Claim) =>
      attempt(claim).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const pending = {
                  ...claim,
                  nextAttemptAt: now + (Exit.hasInterrupts(exit) ? 0 : UNAVAILABLE_RETRY_MS),
                };
                yield* releaseOrQueue(pending);
              }),
        ),
        Effect.ensuring(
          Ref.update(inFlight, (count) => count - 1).pipe(
            Effect.andThen(Queue.offer(wakeups, undefined)),
          ),
        ),
        Effect.provide(deliveryContext),
        quietly("delivery"),
      );
    // Disable cannot clear the fiber set between claiming rows and registering their sends.
    const tick = handoff
      .withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* retryCleanup;
            if (!(yield* enabled)) return;
            const now = yield* Clock.currentTimeMillis;
            yield* Store.expireDue(now);
            const free = MAX_IN_FLIGHT - (yield* Ref.get(inFlight));
            const claims = yield* Store.claimDue(now, free);
            if (!(yield* enabled)) {
              yield* Effect.forEach(
                claims,
                (claim) => releaseOrQueue({ ...claim, nextAttemptAt: now }),
                {
                  discard: true,
                },
              );
              return;
            }
            yield* Ref.update(inFlight, (count) => count + claims.length);
            for (const claim of claims) yield* FiberSet.run(sends, restore(send(claim)));
          }),
        ),
      )
      .pipe(Effect.provide(context), quietly("worker"));
    yield* Effect.forkScoped(
      Stream.runForEach(settingsChanges, (current) =>
        handoff
          .withPermit(current.agentEventsEnabled ? Effect.void : FiberSet.clear(sends))
          .pipe(Effect.andThen(Queue.offer(wakeups, undefined))),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        tick.pipe(
          Effect.andThen(
            Effect.race(Queue.take(wakeups), Effect.sleep(POLL_INTERVAL)).pipe(Effect.asVoid),
          ),
        ),
      ),
    );
    const sweepNow = Effect.gen(function* () {
      if (yield* enabled) yield* sweep();
    }).pipe(Effect.provide(context), quietly("sweep"));
    yield* Effect.forkScoped(Effect.forever(Queue.take(sweeps).pipe(Effect.andThen(sweepNow))));
    yield* Effect.forkScoped(
      Queue.offer(sweeps, undefined).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))),
    );
    // Revocation notices: a removed session ends its subscriptions now, not at the next sweep.
    yield* Effect.forkScoped(
      Stream.runForEach(sessions.streamChanges, (change) =>
        change.type === "clientRemoved" ? Queue.offer(sweeps, undefined) : Effect.void,
      ),
    );
    // A fleet policy change can narrow what a fleet machine's credential may share.
    if (Option.isSome(fleetAccess))
      yield* Effect.forkScoped(
        Stream.runForEach(fleetAccess.value.changes, () => Queue.offer(sweeps, undefined)),
      );
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* deleteSecrets(yield* Store.prune(now));
      }).pipe(
        Effect.provide(context),
        quietly("retention"),
        Effect.repeat(Schedule.spaced(PRUNE_INTERVAL)),
      ),
    );
    return AgentEventDelivery.of({ wake: Queue.offer(wakeups, undefined).pipe(Effect.asVoid) });
  }),
);
