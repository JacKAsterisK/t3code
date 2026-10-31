// @effect-diagnostics nodeBuiltinImport:off -- Fact identities hash immutable origin coordinates.
import * as NodeCrypto from "node:crypto";
import { AGENT_EVENT_LIMITS, type AgentEventEnvelope } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as DeliveryStore from "./AgentEventStore.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as Matcher from "./AgentFactMatcher.ts";
import * as Internal from "./AgentInternalFacts.ts";

export interface FactOrigin {
  readonly environmentId: string;
  readonly sourceGeneration: string;
  readonly sourceKind: "orchestration" | "bootstrap" | "peer_status" | "gateway";
  readonly sourceSequence: number;
  readonly transitionOrdinal: number;
}
export interface FactData extends Omit<AgentEventEnvelope, "origin" | "kind"> {
  readonly kind: Exclude<AgentEventEnvelope["kind"], "probe">;
  readonly origin: FactOrigin & AgentEventEnvelope["origin"];
}
const FactEnvelope = Schema.Struct({
  schema: Schema.Literal("t3.agent-event/1"),
  kind: Schema.Literals([
    "approval",
    "question",
    "secret",
    "blocked",
    "run_finished",
    "owner_changed",
    "request_closed",
    "source_status",
  ]),
  factKey: Schema.String,
  summary: Schema.String.check(Schema.isMaxLength(280)),
  textIsUntrusted: Schema.Literal(true),
  environment: Schema.Struct({ id: Schema.String, label: Schema.String }),
  thread: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  run: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  owner: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  origin: Schema.Struct({
    environmentId: Schema.String,
    sourceGeneration: Schema.String,
    sourceKind: Schema.Literals(["orchestration", "bootstrap", "peer_status"]),
    sourceSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    transitionOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    threadSequence: Schema.NullOr(Schema.Number),
    occurredAt: Schema.String,
  }),
  relay: Schema.NullOr(
    Schema.Struct({ viaEnvironmentId: Schema.String, relayedAt: Schema.String }),
  ),
  detail: Schema.Record(Schema.String, Schema.Unknown),
  truncatedFields: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const decodeFactDataJson = Schema.decodeUnknownEffect(Schema.fromJsonString(FactEnvelope));

export interface FactWrite {
  readonly data: FactData | Internal.InternalFact;
  readonly recordedAt: number;
  readonly relayedFrom?: string;
  readonly restore?: boolean;
}
export interface FactRow {
  readonly logSeq: number;
  readonly eventId: string;
  readonly factKey: string;
  readonly kind: string;
  readonly originEnvironmentId: string;
  readonly originGeneration: string;
  readonly sourceKind: string;
  readonly sourceSequence: number;
  readonly transitionOrdinal: number;
  readonly threadId: string | null;
  readonly occurredAt: number;
  readonly recordedAt: number;
  readonly relayedFrom: string | null;
  readonly dataJson: string;
}
export class FactStoreConflict extends Schema.TaggedError<FactStoreConflict>()(
  "FactStoreConflict",
  {
    reason: Schema.Literals([
      "identity_changed",
      "progress_changed",
      "out_of_order",
      "invalid_origin",
      "invalid_payload",
      "payload_too_large",
      "checkpoint_changed",
      "restore_missing",
    ]),
    sourceSequence: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return "The event fact or source checkpoint conflicts with durable state.";
  }
}

export const factEventId = (origin: FactOrigin, factKey: string): string =>
  `t3e1_${NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        version: 1,
        factKey,
        environmentId: origin.environmentId,
        sourceGeneration: origin.sourceGeneration,
        sourceKind: origin.sourceKind,
        sourceSequence: origin.sourceSequence,
        transitionOrdinal: origin.transitionOrdinal,
      }),
    )
    .digest("base64url")}`;
const columns = (sql: SqlClient.SqlClient) => sql`
  log_seq AS "logSeq", event_id AS "eventId", fact_key AS "factKey", kind,
  origin_environment_id AS "originEnvironmentId", origin_generation AS "originGeneration",
  source_kind AS "sourceKind", source_sequence AS "sourceSequence", transition_ordinal AS "transitionOrdinal",
  thread_id AS "threadId", occurred_at AS "occurredAt", recorded_at AS "recordedAt",
  relayed_from AS "relayedFrom", data_json AS "dataJson"`;

export const appendFact = Effect.fn("AgentFactStore.appendFact")(function* (input: FactWrite) {
  const sql = yield* SqlClient.SqlClient;
  const origin = input.data.origin;
  const internal = Internal.isInternal(input.data);
  const occurredAt =
    origin.occurredAt === null
      ? input.recordedAt
      : Option.getOrUndefined(DateTime.make(origin.occurredAt))?.epochMilliseconds;
  if (occurredAt === undefined || input.data.environment.id !== origin.environmentId)
    return yield* new FactStoreConflict({ reason: "invalid_origin" });
  const eventId = factEventId(
    {
      environmentId: origin.environmentId,
      sourceGeneration: origin.sourceGeneration,
      sourceKind: origin.sourceKind,
      sourceSequence: origin.sourceSequence,
      transitionOrdinal: origin.transitionOrdinal,
    },
    input.data.factKey,
  );
  const dataJson = stableStringify(input.data);
  if (
    Buffer.byteLength(dataJson, "utf8") >
    (internal ? Internal.maxDataBytes : AGENT_EVENT_LIMITS.maxDataBytes)
  )
    return yield* new FactStoreConflict({ reason: "payload_too_large" });
  if (internal)
    yield* Internal.decodeJson(dataJson, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new FactStoreConflict({ reason: "invalid_payload" })),
    );
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing =
        (yield* sql<FactRow>`SELECT ${columns(sql)} FROM agent_event_facts WHERE event_id = ${eventId}`)[0];
      if (existing !== undefined) {
        if (existing.dataJson !== dataJson)
          return yield* new FactStoreConflict({
            reason: "identity_changed",
            sourceSequence: origin.sourceSequence,
          });
        return {
          eventId,
          logSeq: existing.logSeq,
          created: false,
          ...(internal ? { liveFactId: eventId } : {}),
        };
      }
      const log = yield* DeliveryStore.logState();
      const digest = NodeCrypto.createHash("sha256").update(dataJson).digest("hex");
      if (internal && !input.restore) {
        const receipt = (yield* sql<{
          logSeq: number;
          digest: string;
        }>`SELECT log_seq AS "logSeq",data_digest AS digest
          FROM agent_event_occurrences WHERE event_id=${eventId} AND source_kind='gateway'`)[0];
        if (receipt !== undefined) {
          if (receipt.digest !== digest)
            return yield* new FactStoreConflict({
              reason: "identity_changed",
              sourceSequence: origin.sourceSequence,
            });
          // A retained slot without its payload is a gap. A pruned dependency stays a receipt;
          // allocating another slot here would change its original occurrence coordinates.
          if (receipt.logSeq >= log.floorSeq)
            return yield* new FactStoreConflict({
              reason: "restore_missing",
              sourceSequence: origin.sourceSequence,
            });
          return { eventId, logSeq: receipt.logSeq, created: false, liveFactId: null };
        }
      }
      const restore = input.restore
        ? (yield* sql<{
            readonly logSeq: number;
            readonly digest: string;
            readonly recordedAt: number;
          }>`
        SELECT log_seq AS "logSeq", data_digest AS digest, recorded_at AS "recordedAt"
        FROM agent_event_occurrences WHERE event_id = ${eventId}`)[0]
        : undefined;
      if (
        input.restore &&
        (restore === undefined || restore.logSeq < log.floorSeq || restore.logSeq > log.headSeq)
      )
        return yield* new FactStoreConflict({
          reason: "restore_missing",
          sourceSequence: origin.sourceSequence,
        });
      if (restore !== undefined && restore.digest !== digest)
        return yield* new FactStoreConflict({
          reason: "identity_changed",
          sourceSequence: origin.sourceSequence,
        });
      const recordedAt = restore?.recordedAt ?? input.recordedAt;
      const logSeq =
        restore?.logSeq ??
        (yield* sql<{ readonly sequence: number }>`
      UPDATE agent_event_log_state SET head_seq = head_seq + 1 WHERE id = 1 RETURNING head_seq AS sequence`)[0]!
          .sequence;
      const threadId = typeof input.data.thread?.id === "string" ? input.data.thread.id : null;
      yield* sql`INSERT INTO agent_event_facts
      (log_seq, event_id, fact_key, kind, origin_environment_id, origin_generation, source_kind,
       source_sequence, transition_ordinal, thread_id, occurred_at, recorded_at, relayed_from, data_json)
      VALUES (${logSeq}, ${eventId}, ${input.data.factKey}, ${input.data.kind}, ${origin.environmentId},
        ${origin.sourceGeneration}, ${origin.sourceKind}, ${origin.sourceSequence}, ${origin.transitionOrdinal},
        ${threadId}, ${occurredAt}, ${recordedAt}, ${input.relayedFrom ?? null}, ${dataJson})`;
      yield* sql`INSERT OR IGNORE INTO agent_event_occurrences
        (event_id, log_seq, origin_environment_id, source_generation, source_kind, source_sequence, data_digest, recorded_at, bootstrap_json)
        VALUES (${eventId}, ${logSeq}, ${origin.environmentId}, ${origin.sourceGeneration}, ${origin.sourceKind},
          ${origin.sourceSequence}, ${digest}, ${recordedAt}, ${origin.sourceKind === "bootstrap" || internal ? dataJson : null})`;
      if (!input.restore) {
        if (Internal.isInternal(input.data)) yield* Matcher.advancePrivateSlot(logSeq, recordedAt);
        else yield* Matcher.queueFact({ eventId, logSeq, data: input.data, now: recordedAt });
      }
      return { eventId, logSeq, created: true, ...(internal ? { liveFactId: eventId } : {}) };
    }),
  );
});

export const progress = Effect.fn("AgentFactStore.progress")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* DeliveryStore.logState();
  return (yield* sql<{ readonly sequence: number }>`
    SELECT derived_through_sequence AS sequence FROM agent_event_log_state WHERE id = 1`)[0]!
    .sequence;
});

/** Reducer checkpoints, matching deliveries, allocated log entries and source progress are one commit. */
export const commitSource = Effect.fn("AgentFactStore.commitSource")(function* (input: {
  readonly expectedThrough: number;
  readonly deleteStateKeys?: ReadonlyArray<string>;
  readonly throughSequence: number;
  readonly states: ReadonlyArray<{
    readonly key: string;
    readonly sourceSequence: number;
    readonly json: string;
  }>;
  readonly facts: ReadonlyArray<FactWrite>;
}) {
  const sql = yield* SqlClient.SqlClient;
  if (input.throughSequence <= input.expectedThrough)
    return yield* new FactStoreConflict({
      reason: "out_of_order",
      sourceSequence: input.throughSequence,
    });
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* progress()) !== input.expectedThrough)
        return yield* new FactStoreConflict({
          reason: "progress_changed",
          sourceSequence: input.throughSequence,
        });
      const facts = yield* Effect.forEach(input.facts, appendFact);
      yield* writeCheckpoints({
        generation: yield* Journal.sourceGeneration(),
        sequence: input.throughSequence,
        states: input.states,
        deleteStateKeys: input.deleteStateKeys ?? [],
      });
      yield* sql`UPDATE agent_event_log_state SET derived_through_sequence = ${input.throughSequence} WHERE id = 1`;
      return facts;
    }),
  );
});

export const readState = Effect.fn("AgentFactStore.readState")(function* (key: string) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly sourceSequence: number; readonly json: string }>`
    SELECT source_sequence AS "sourceSequence", state_json AS json FROM agent_event_derivation_state WHERE state_key = ${key}`)[0];
});

export const readFacts = Effect.fn("AgentFactStore.readFacts")(function* (
  afterSequence: number,
  limit = 100,
  includeInternal = false,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<FactRow>`SELECT ${columns(sql)} FROM agent_event_facts
    WHERE log_seq > ${afterSequence} AND (${includeInternal ? 1 : 0} = 1 OR source_kind <> 'gateway') ORDER BY log_seq LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
});

/** Versioned entity checkpoints preserve a compact replay base as the retained fact floor moves. */
export const writeCheckpoints = Effect.fn("AgentFactStore.writeCheckpoints")(function* (input: {
  readonly generation: string;
  readonly sequence: number;
  readonly states: ReadonlyArray<{
    readonly key: string;
    readonly sourceSequence: number;
    readonly json: string;
  }>;
  readonly deleteStateKeys: ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  for (const key of input.deleteStateKeys)
    yield* sql`DELETE FROM agent_event_derivation_state WHERE state_key = ${key}`;
  for (const state of input.states)
    yield* sql`INSERT INTO agent_event_derivation_state (state_key, source_sequence, state_json)
      VALUES (${state.key}, ${state.sourceSequence}, ${state.json})
      ON CONFLICT (state_key) DO UPDATE SET source_sequence = excluded.source_sequence, state_json = excluded.state_json`;
  for (const entry of [
    ...input.states.map((state) => ({
      key: state.key,
      sequence: state.sourceSequence,
      json: state.json,
    })),
    ...input.deleteStateKeys.map((key) => ({ key, sequence: input.sequence, json: null })),
  ]) {
    yield* sql`INSERT OR IGNORE INTO agent_event_reducer_history (source_generation, state_key, source_sequence, state_json)
      VALUES (${input.generation}, ${entry.key}, ${entry.sequence}, ${entry.json})`;
    const stored = (yield* sql<{
      readonly json: string | null;
    }>`SELECT state_json AS json FROM agent_event_reducer_history
      WHERE source_generation = ${input.generation} AND state_key = ${entry.key} AND source_sequence = ${entry.sequence}`)[0];
    if (stored?.json !== entry.json)
      return yield* new FactStoreConflict({
        reason: "checkpoint_changed",
        sourceSequence: entry.sequence,
      });
  }
});

/** Read a retained private fact or the original payload receipt of a pruned dependency. */
export const readInternalFact = Effect.fn("AgentFactStore.readInternalFact")(function* (
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = (yield* sql<{
    json: string | null;
    digest: string;
  }>`SELECT COALESCE(fact.data_json,occurrence.bootstrap_json) AS json,
    occurrence.data_digest AS digest FROM agent_event_occurrences occurrence
    LEFT JOIN agent_event_facts fact ON fact.event_id=occurrence.event_id AND fact.log_seq=occurrence.log_seq
    WHERE occurrence.event_id=${eventId} AND occurrence.source_kind='gateway'
      AND (fact.event_id IS NOT NULL OR occurrence.log_seq < (SELECT floor_seq FROM agent_event_log_state WHERE id=1))`)[0];
  if (
    payload?.json == null ||
    NodeCrypto.createHash("sha256").update(payload.json).digest("hex") !== payload.digest
  )
    return yield* new FactStoreConflict({ reason: "restore_missing" });
  const data = yield* Internal.decodeJson(payload.json, { onExcessProperty: "error" });
  if (factEventId(data.origin, data.factKey) !== eventId)
    return yield* new FactStoreConflict({ reason: "identity_changed" });
  return data;
});

const validateInternalReferences = Effect.fn("AgentFactStore.validateInternalReferences")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    // Keep only validated identities, never a second copy of their private payloads.
    const checked = new Set<string>();
    let after = 0;
    while (true) {
      const rows = yield* sql<{
        id: string;
        sequence: number;
      }>`SELECT event_id AS id,log_seq AS sequence
      FROM agent_event_facts WHERE source_kind='gateway' AND log_seq > ${after} ORDER BY log_seq LIMIT 100`;
      if (rows.length === 0) return;
      for (const row of rows) {
        const pending = [row.id];
        while (pending.length > 0) {
          const id = pending.pop()!;
          if (checked.has(id)) continue;
          const fact = yield* readInternalFact(id);
          checked.add(id);
          for (const reference of fact.references)
            if (!checked.has(reference)) pending.push(reference);
        }
      }
      after = rows.at(-1)!.sequence;
    }
  },
);

/** Private read snapshots restore from their original manifest, never from today's projection. */
export const restoreInternalFacts = Effect.fn("AgentFactStore.restoreInternalFacts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        (yield* sql`SELECT 1 FROM agent_event_facts fact LEFT JOIN agent_event_occurrences occurrence
        ON occurrence.event_id=fact.event_id WHERE fact.source_kind='gateway' AND occurrence.event_id IS NULL LIMIT 1`)
          .length > 0
      )
        return yield* new FactStoreConflict({ reason: "restore_missing" });
      yield* sql`DELETE FROM agent_event_facts WHERE source_kind = 'gateway'`;
      let sequence = (yield* DeliveryStore.logState()).floorSeq - 1;
      let restored = 0;
      while (true) {
        const entries = yield* sql<{
          readonly eventId: string;
          readonly logSeq: number;
          readonly recordedAt: number;
        }>`SELECT event_id AS "eventId", log_seq AS "logSeq", recorded_at AS "recordedAt"
          FROM agent_event_occurrences WHERE source_kind='gateway' AND log_seq > ${sequence} ORDER BY log_seq LIMIT 100`;
        if (entries.length === 0) {
          yield* validateInternalReferences();
          return restored;
        }
        for (const entry of entries) {
          const payload = (yield* sql<{
            readonly json: string;
          }>`SELECT bootstrap_json AS json FROM agent_event_occurrences WHERE event_id=${entry.eventId}`)[0]!;
          yield* appendFact({
            data: yield* Internal.decodeJson(payload.json),
            recordedAt: entry.recordedAt,
            restore: true,
          });
          sequence = entry.logSeq;
          restored++;
        }
      }
    }),
  );
});
