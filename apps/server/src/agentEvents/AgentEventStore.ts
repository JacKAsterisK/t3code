import type { AgentEventDeliveryState, AgentEventSubscriptionState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { randomToken } from "./identity.ts";

/**
 * T3 Code LAN: MCP Events persistence (migration 081). Plain functions over the SQL client so the
 * server and the `t3 agent-events` CLI, a second process on the same database, share one code
 * path. Times are epoch milliseconds.
 */

export interface LogState {
  readonly epoch: string;
  /** The highest sequence the log has handed out. */
  readonly headSeq: number;
  /** The lowest sequence still retained; a cursor below `floorSeq - 1` lost history. */
  readonly floorSeq: number;
}

export interface SubscriptionRow {
  readonly subscriptionId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly attributionSubject: string;
  readonly clientLabel: string;
  readonly eventName: string;
  readonly argumentsJson: string;
  readonly callbackUrl: string;
  readonly secretRef: string;
  readonly previousSecretRef: string | null;
  readonly previousSecretUntil: number | null;
  readonly state: AgentEventSubscriptionState;
  readonly expiresAt: number;
  readonly logEpoch: string;
  readonly watermarkSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt: number | null;
  readonly endedReason: string | null;
}

export interface DeliveryRow {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly logSeq: number;
  readonly state: AgentEventDeliveryState;
  readonly attempts: number;
  readonly queuedAt: number;
  readonly nextAttemptAt: number;
  readonly lastAttemptAt: number | null;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly finishedAt: number | null;
}

/** Delivered, rejected and abandoned rows count as handled for the cursor. */
const UNFINISHED = ["pending", "sending"] as const;

const subscriptionColumns = (sql: SqlClient.SqlClient) => sql`
  subscription_id AS "subscriptionId", principal_id AS "principalId", session_id AS "sessionId",
  attribution_subject AS "attributionSubject", client_label AS "clientLabel",
  event_name AS "eventName", arguments_json AS "argumentsJson", callback_url AS "callbackUrl",
  secret_ref AS "secretRef", previous_secret_ref AS "previousSecretRef",
  previous_secret_until AS "previousSecretUntil", state, expires_at AS "expiresAt",
  log_epoch AS "logEpoch", watermark_seq AS "watermarkSeq", created_at AS "createdAt",
  updated_at AS "updatedAt", ended_at AS "endedAt", ended_reason AS "endedReason"`;

const deliveryColumns = (sql: SqlClient.SqlClient) => sql`
  subscription_id AS "subscriptionId", event_id AS "eventId", log_seq AS "logSeq", state,
  attempts, queued_at AS "queuedAt", next_attempt_at AS "nextAttemptAt",
  last_attempt_at AS "lastAttemptAt", last_status AS "lastStatus", last_error AS "lastError",
  finished_at AS "finishedAt"`;

/** The log's identity, created with a random epoch on first use. */
export const logState = Effect.fn("AgentEventStore.logState")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = sql<LogState>`
    SELECT epoch, head_seq AS "headSeq", floor_seq AS "floorSeq"
    FROM agent_event_log_state WHERE id = 1`;
  const existing = (yield* read)[0];
  if (existing !== undefined) return existing;
  yield* sql`
    INSERT OR IGNORE INTO agent_event_log_state (id, epoch, head_seq, floor_seq)
    VALUES (1, ${randomToken(12)}, 0, 1)`;
  return (yield* read)[0]!;
});

export const findSubscription = Effect.fn("AgentEventStore.findSubscription")(function* (
  subscriptionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<SubscriptionRow>`
    SELECT ${subscriptionColumns(sql)} FROM agent_event_subscriptions
    WHERE subscription_id = ${subscriptionId}`;
  return rows[0];
});

export const listSubscriptions = Effect.fn("AgentEventStore.listSubscriptions")(function* (
  states?: ReadonlyArray<AgentEventSubscriptionState>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* states === undefined
    ? sql<SubscriptionRow>`
        SELECT ${subscriptionColumns(sql)} FROM agent_event_subscriptions ORDER BY created_at`
    : sql<SubscriptionRow>`
        SELECT ${subscriptionColumns(sql)} FROM agent_event_subscriptions
        WHERE ${sql.in("state", states)} ORDER BY created_at`;
});

export const listDeliveries = Effect.fn("AgentEventStore.listDeliveries")(function* (
  subscriptionId: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<DeliveryRow>`
    SELECT ${deliveryColumns(sql)} FROM agent_event_deliveries
    WHERE subscription_id = ${subscriptionId} ORDER BY log_seq DESC LIMIT ${limit}`;
});

export const findDelivery = Effect.fn("AgentEventStore.findDelivery")(function* (
  subscriptionId: string,
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<DeliveryRow>`
    SELECT ${deliveryColumns(sql)} FROM agent_event_deliveries
    WHERE subscription_id = ${subscriptionId} AND event_id = ${eventId}`;
  return rows[0];
});

export const deliveryCounts = Effect.fn("AgentEventStore.deliveryCounts")(function* (
  subscriptionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly state: AgentEventDeliveryState; readonly count: number }>`
    SELECT state, COUNT(*) AS count FROM agent_event_deliveries
    WHERE subscription_id = ${subscriptionId} GROUP BY state`;
  return Object.fromEntries(rows.map((row) => [row.state, row.count])) as Partial<
    Record<AgentEventDeliveryState, number>
  >;
});

/**
 * The cursor a subscription may report: every matching event at or below it is handled. It is
 * recomputed, never carried forward, so a replay that requeues events moves it back below them.
 */
export const recomputeWatermark = Effect.fn("AgentEventStore.recomputeWatermark")(function* (
  subscriptionId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const { headSeq } = yield* logState();
  const lowest = (yield* sql<{ readonly seq: number | null }>`
    SELECT MIN(log_seq) AS seq FROM agent_event_deliveries
    WHERE subscription_id = ${subscriptionId} AND ${sql.in("state", UNFINISHED)}`)[0]?.seq;
  const watermark = lowest === null || lowest === undefined ? headSeq : lowest - 1;
  yield* sql`
    UPDATE agent_event_subscriptions SET watermark_seq = ${watermark}, updated_at = ${now}
    WHERE subscription_id = ${subscriptionId}`;
  return watermark;
});

/** The lowest unfinished event other than `eventId`, for the cursor a delivery body carries. */
export const lowestOtherUnfinished = Effect.fn("AgentEventStore.lowestOtherUnfinished")(function* (
  subscriptionId: string,
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const seq = (yield* sql<{ readonly seq: number | null }>`
      SELECT MIN(log_seq) AS seq FROM agent_event_deliveries
      WHERE subscription_id = ${subscriptionId} AND event_id <> ${eventId}
        AND ${sql.in("state", UNFINISHED)}`)[0]?.seq;
  return seq ?? undefined;
});

export type SubscriptionWrite = Omit<
  SubscriptionRow,
  "watermarkSeq" | "createdAt" | "endedAt" | "endedReason"
>;

/** Creates or reactivates a subscription; its delivery progress is kept. */
export const upsertSubscription = Effect.fn("AgentEventStore.upsertSubscription")(function* (
  row: SubscriptionWrite,
  initialWatermark: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO agent_event_subscriptions (
      subscription_id, principal_id, session_id, attribution_subject, client_label, event_name,
      arguments_json, callback_url, secret_ref, previous_secret_ref, previous_secret_until, state,
      expires_at, log_epoch, watermark_seq, created_at, updated_at, ended_at, ended_reason
    ) VALUES (
      ${row.subscriptionId}, ${row.principalId}, ${row.sessionId}, ${row.attributionSubject},
      ${row.clientLabel}, ${row.eventName}, ${row.argumentsJson}, ${row.callbackUrl},
      ${row.secretRef}, ${row.previousSecretRef}, ${row.previousSecretUntil}, ${row.state},
      ${row.expiresAt}, ${row.logEpoch}, ${initialWatermark}, ${row.updatedAt}, ${row.updatedAt},
      NULL, NULL
    )
    ON CONFLICT (subscription_id) DO UPDATE SET
      session_id = excluded.session_id,
      attribution_subject = excluded.attribution_subject,
      client_label = excluded.client_label,
      secret_ref = excluded.secret_ref,
      previous_secret_ref = excluded.previous_secret_ref,
      previous_secret_until = excluded.previous_secret_until,
      state = excluded.state,
      expires_at = excluded.expires_at,
      log_epoch = excluded.log_epoch,
      updated_at = excluded.updated_at,
      ended_at = NULL,
      ended_reason = NULL`;
});

/**
 * Ends a subscription. Expiry keeps its queued events, so subscribing again with the last cursor
 * resumes; every other ending drops them. Returns the secret names the caller should delete.
 */
export const endSubscription = Effect.fn("AgentEventStore.endSubscription")(function* (input: {
  readonly subscriptionId: string;
  readonly state: Exclude<AgentEventSubscriptionState, "active">;
  readonly reason: string;
  readonly now: number;
  /** Only end it from this state, so a racing refresh is not undone. */
  readonly fromState?: AgentEventSubscriptionState;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* findSubscription(input.subscriptionId);
      if (row === undefined || row.state === input.state) return [];
      if (input.fromState !== undefined && row.state !== input.fromState) return [];
      yield* sql`
        UPDATE agent_event_subscriptions
        SET state = ${input.state}, ended_at = ${input.now}, ended_reason = ${input.reason},
            updated_at = ${input.now}
        WHERE subscription_id = ${input.subscriptionId}`;
      if (input.state === "expired") return [];
      yield* sql`
        DELETE FROM agent_event_deliveries
        WHERE subscription_id = ${input.subscriptionId} AND ${sql.in("state", UNFINISHED)}`;
      yield* recomputeWatermark(input.subscriptionId, input.now);
      if (input.state === "gone")
        yield* sql`
          DELETE FROM agent_event_callback_verifications
          WHERE principal_id = ${row.principalId} AND callback_url = ${row.callbackUrl}`;
      // An unsubscribed, revoked or gone subscription never signs again.
      yield* sql`
        UPDATE agent_event_subscriptions SET previous_secret_ref = NULL, previous_secret_until = NULL
        WHERE subscription_id = ${input.subscriptionId}`;
      return [row.secretRef, ...(row.previousSecretRef === null ? [] : [row.previousSecretRef])];
    }),
  );
});

/** Ends every active subscription whose grant has run out: delivery stops exactly then. */
export const expireDue = Effect.fn("AgentEventStore.expireDue")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly subscriptionId: string }>`
    UPDATE agent_event_subscriptions
    SET state = 'expired', ended_at = expires_at, ended_reason = 'refresh_before_passed',
        updated_at = ${now}
    WHERE state = 'active' AND expires_at <= ${now}
    RETURNING subscription_id AS "subscriptionId"`;
});

/**
 * Appends a probe to the log and queues it for its one subscription, in one transaction. The same
 * event id twice is the same probe: nothing is added and the first one is returned.
 */
export const appendProbe = Effect.fn("AgentEventStore.appendProbe")(function* (input: {
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly occurredAt: number;
  readonly dataJson: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* logState();
      const existing = (yield* sql<{ readonly logSeq: number }>`
        SELECT log_seq AS "logSeq" FROM agent_event_probes WHERE event_id = ${input.eventId}`)[0];
      if (existing !== undefined) return { logSeq: existing.logSeq, created: false };
      const logSeq = (yield* sql<{ readonly headSeq: number }>`
        UPDATE agent_event_log_state SET head_seq = head_seq + 1 WHERE id = 1
        RETURNING head_seq AS "headSeq"`)[0]!.headSeq;
      yield* sql`
        INSERT INTO agent_event_probes (log_seq, event_id, subscription_id, occurred_at, data_json, created_at)
        VALUES (${logSeq}, ${input.eventId}, ${input.subscriptionId}, ${input.occurredAt},
                ${input.dataJson}, ${input.now})`;
      yield* sql`
        INSERT INTO agent_event_deliveries (subscription_id, event_id, log_seq, state, queued_at, next_attempt_at)
        VALUES (${input.subscriptionId}, ${input.eventId}, ${logSeq}, 'pending', ${input.now}, ${input.now})`;
      yield* recomputeWatermark(input.subscriptionId, input.now);
      return { logSeq, created: true };
    }),
  );
});

/**
 * Requeues the subscription's logged events after `afterSeq`. Delivered ones are requeued only
 * when `includeDelivered`: the client's cursor is behind what it was sent, so it lost some.
 * Events already queued or in flight keep their place.
 */
export const requeueAfter = Effect.fn("AgentEventStore.requeueAfter")(function* (input: {
  readonly subscriptionId: string;
  readonly afterSeq: number;
  readonly includeDelivered: boolean;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const includeDelivered = input.includeDelivered ? 1 : 0;
  yield* sql`
    INSERT INTO agent_event_deliveries (subscription_id, event_id, log_seq, state, queued_at, next_attempt_at)
    SELECT subscription_id, event_id, log_seq, 'pending', ${input.now}, ${input.now}
    FROM agent_event_probes
    WHERE subscription_id = ${input.subscriptionId} AND log_seq > ${input.afterSeq}
    ON CONFLICT (subscription_id, event_id) DO UPDATE SET
      state = 'pending', attempts = 0, queued_at = excluded.queued_at,
      next_attempt_at = excluded.next_attempt_at, last_status = NULL, last_error = NULL,
      finished_at = NULL
    WHERE agent_event_deliveries.state NOT IN ('pending', 'sending')
      AND (${includeDelivered} = 1 OR agent_event_deliveries.state <> 'delivered')`;
});

/** After a restart nothing is in flight: an interrupted send goes again with the same event id. */
export const resetSending = Effect.fn("AgentEventStore.resetSending")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE agent_event_deliveries SET state = 'pending', next_attempt_at = ${now}
    WHERE state = 'sending'`;
});

/**
 * Claims up to `limit` due events, at most one per subscription and none for a subscription with
 * one in flight, each the subscription's lowest due sequence. Only active, unexpired
 * subscriptions are served.
 */
export const claimDue = Effect.fn("AgentEventStore.claimDue")(function* (
  now: number,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (limit <= 0) return [];
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const due = yield* sql<{ readonly subscriptionId: string; readonly eventId: string }>`
        SELECT d.subscription_id AS "subscriptionId", d.event_id AS "eventId"
        FROM agent_event_deliveries d
        JOIN agent_event_subscriptions s ON s.subscription_id = d.subscription_id
        WHERE d.state = 'pending' AND d.next_attempt_at <= ${now}
          AND s.state = 'active' AND s.expires_at > ${now}
          AND NOT EXISTS (
            SELECT 1 FROM agent_event_deliveries x
            WHERE x.subscription_id = d.subscription_id AND x.state = 'sending')
          AND d.log_seq = (
            SELECT MIN(y.log_seq) FROM agent_event_deliveries y
            WHERE y.subscription_id = d.subscription_id AND y.state = 'pending'
              AND y.next_attempt_at <= ${now})
        ORDER BY d.next_attempt_at, d.log_seq
        LIMIT ${limit}`;
      for (const row of due)
        yield* sql`
          UPDATE agent_event_deliveries SET state = 'sending'
          WHERE subscription_id = ${row.subscriptionId} AND event_id = ${row.eventId}
            AND state = 'pending'`;
      return due;
    }),
  );
});

/** The logged event a delivery refers to. */
export const loadEvent = Effect.fn("AgentEventStore.loadEvent")(function* (logSeq: number) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly eventId: string;
    readonly occurredAt: number;
    readonly dataJson: string;
  }>`
    SELECT event_id AS "eventId", occurred_at AS "occurredAt", data_json AS "dataJson"
    FROM agent_event_probes WHERE log_seq = ${logSeq}`;
  return rows[0];
});

/** Records an attempt's result; a finished one moves the subscription's cursor. */
export const finishAttempt = Effect.fn("AgentEventStore.finishAttempt")(function* (input: {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly state: AgentEventDeliveryState;
  readonly attempted: boolean;
  readonly nextAttemptAt: number;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const finished = input.state !== "pending" && input.state !== "sending";
  const attempted = input.attempted ? 1 : 0;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        UPDATE agent_event_deliveries
        SET state = ${input.state}, attempts = attempts + ${attempted},
            next_attempt_at = ${input.nextAttemptAt},
            last_attempt_at = CASE WHEN ${attempted} = 1 THEN ${input.now} ELSE last_attempt_at END,
            last_status = CASE WHEN ${attempted} = 1 THEN ${input.lastStatus} ELSE last_status END,
            last_error = ${input.lastError},
            finished_at = ${finished ? input.now : null}
        WHERE subscription_id = ${input.subscriptionId} AND event_id = ${input.eventId}
          AND state = 'sending'`;
      if (finished) yield* recomputeWatermark(input.subscriptionId, input.now);
    }),
  );
});

export const verifiedAt = Effect.fn("AgentEventStore.verifiedAt")(function* (
  principalId: string,
  callbackUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly verifiedAt: number }>`
    SELECT verified_at AS "verifiedAt" FROM agent_event_callback_verifications
    WHERE principal_id = ${principalId} AND callback_url = ${callbackUrl}`;
  return rows[0]?.verifiedAt;
});

export const recordVerification = Effect.fn("AgentEventStore.recordVerification")(function* (
  principalId: string,
  callbackUrl: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO agent_event_callback_verifications (principal_id, callback_url, verified_at)
    VALUES (${principalId}, ${callbackUrl}, ${now})
    ON CONFLICT (principal_id, callback_url) DO UPDATE SET verified_at = excluded.verified_at`;
});

/** Drops a rotation's previous secret once its overlap is over; returns the name to delete. */
export const retirePreviousSecrets = Effect.fn("AgentEventStore.retirePreviousSecrets")(function* (
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly subscriptionId: string; readonly secretRef: string }>`
          SELECT subscription_id AS "subscriptionId", previous_secret_ref AS "secretRef"
          FROM agent_event_subscriptions
          WHERE previous_secret_ref IS NOT NULL AND previous_secret_until <= ${now}`;
      for (const row of rows)
        yield* sql`
            UPDATE agent_event_subscriptions
            SET previous_secret_ref = NULL, previous_secret_until = NULL
            WHERE subscription_id = ${row.subscriptionId} AND previous_secret_ref = ${row.secretRef}`;
      return rows.map((row) => row.secretRef);
    }),
  );
});

/** Every secret name a row still points at, so orphaned files can be told apart. */
export const referencedSecretRefs = Effect.fn("AgentEventStore.referencedSecretRefs")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly secretRef: string | null }>`
      SELECT secret_ref AS "secretRef" FROM agent_event_subscriptions
      UNION SELECT previous_secret_ref FROM agent_event_subscriptions`;
  return new Set(rows.flatMap((row) => (row.secretRef === null ? [] : [row.secretRef])));
});

const RETENTION = {
  logMs: 14 * 24 * 60 * 60_000,
  logRows: 50_000,
  deliveriesMs: 7 * 24 * 60 * 60_000,
  endedSubscriptionsMs: 7 * 24 * 60 * 60_000,
} as const;

/**
 * Retention. Logged events go after 14 days or past 50,000 rows, but never while a delivery is
 * still unfinished for them; the floor rises past every pruned sequence. Finished deliveries and
 * ended subscriptions go after 7 days. Returns the secret names of deleted subscriptions.
 */
export const prune = Effect.fn("AgentEventStore.prune")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const state = yield* logState();
      const pruned = yield* sql<{ readonly logSeq: number }>`
        DELETE FROM agent_event_probes
        WHERE (created_at < ${now - RETENTION.logMs}
               OR log_seq <= ${state.headSeq - RETENTION.logRows})
          AND NOT EXISTS (
            SELECT 1 FROM agent_event_deliveries d
            WHERE d.log_seq = agent_event_probes.log_seq AND d.state IN ('pending', 'sending'))
        RETURNING log_seq AS "logSeq"`;
      const highest = pruned.reduce((max, row) => Math.max(max, row.logSeq), 0);
      if (highest + 1 > state.floorSeq)
        yield* sql`UPDATE agent_event_log_state SET floor_seq = ${highest + 1} WHERE id = 1`;
      yield* sql`
        DELETE FROM agent_event_deliveries
        WHERE state NOT IN ('pending', 'sending') AND finished_at < ${now - RETENTION.deliveriesMs}`;
      yield* sql`
        DELETE FROM agent_event_callback_verifications
        WHERE verified_at < ${now - 24 * 60 * 60_000}`;
      const ended = yield* sql<SubscriptionRow>`
        SELECT ${subscriptionColumns(sql)} FROM agent_event_subscriptions
        WHERE state <> 'active' AND ended_at < ${now - RETENTION.endedSubscriptionsMs}`;
      for (const row of ended) {
        yield* sql`DELETE FROM agent_event_deliveries WHERE subscription_id = ${row.subscriptionId}`;
        yield* sql`DELETE FROM agent_event_subscriptions WHERE subscription_id = ${row.subscriptionId}`;
      }
      return ended.flatMap((row) => [
        row.secretRef,
        ...(row.previousSecretRef === null ? [] : [row.previousSecretRef]),
      ]);
    }),
  );
});
