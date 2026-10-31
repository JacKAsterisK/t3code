import { AGENT_EVENT_LIMITS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";

const LOG_MS = 14 * 24 * 60 * 60_000;
const LOG_ROWS = 50_000;

/**
 * Only a contiguous prefix can go: an unfinished payload pins the whole suffix after it.
 * The enclosing retention transaction recomputes watermarks for abandonedSubscriptions.
 */
export const pruneLog = Effect.fn("AgentFactRetention.pruneLog")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Expired subscriptions still count toward the same 48-hour retry lifetime.
      const abandoned = yield* sql<{ readonly subscriptionId: string }>`
      UPDATE agent_event_deliveries SET state = 'abandoned', finished_at = ${now},
        last_error = 'delivery_retention_expired'
      WHERE state IN ('pending', 'sending') AND queued_at <= ${now - AGENT_EVENT_LIMITS.abandonAfterMs}
      RETURNING subscription_id AS "subscriptionId"`;
      const state = (yield* sql<{ readonly head: number; readonly floor: number }>`
      SELECT head_seq AS head, floor_seq AS floor FROM agent_event_log_state WHERE id = 1`)[0];
      if (state === undefined) return { abandonedSubscriptions: [], floorSeq: 1 };
      const firstFresh = (yield* sql<{
        readonly sequence: number | null;
      }>`SELECT MIN(log_seq) AS sequence FROM (
        SELECT log_seq FROM agent_event_probes WHERE created_at >= ${now - LOG_MS}
        UNION ALL SELECT log_seq FROM agent_event_facts WHERE recorded_at >= ${now - LOG_MS}
      )`)[0]!.sequence;
      const firstPending = (yield* sql<{ readonly sequence: number | null }>`
      SELECT MIN(log_seq) AS sequence FROM agent_event_deliveries WHERE state IN ('pending', 'sending')`)[0]!
        .sequence;
      const ageCutoff = firstFresh === null ? state.head : firstFresh - 1;
      const desired = Math.max(ageCutoff, state.head - LOG_ROWS);
      yield* CompatibilityFacts.releaseBefore(desired + 1);
      const compatibilityPin = yield* CompatibilityFacts.firstPinnedSequence();
      const cutoff = Math.min(
        desired,
        firstPending === null ? state.head : firstPending - 1,
        compatibilityPin === null ? state.head : compatibilityPin - 1,
      );
      // A source transition allocates all its ordinals atomically. Rebuild needs the whole group.
      const candidateFloor = Math.max(state.floor, cutoff + 1);
      const crossing = (yield* sql<{
        sequence: number | null;
      }>`SELECT MIN(older.log_seq) AS sequence
        FROM agent_event_occurrences older WHERE older.log_seq < ${candidateFloor}
          AND older.source_kind IN ('orchestration', 'bootstrap') AND EXISTS (
            SELECT 1 FROM agent_event_occurrences newer WHERE newer.origin_environment_id=older.origin_environment_id
              AND newer.source_generation=older.source_generation AND newer.source_kind=older.source_kind
              AND newer.source_sequence=older.source_sequence AND newer.log_seq >= ${candidateFloor})`)[0]!
        .sequence;
      const floorSeq = Math.max(state.floor, crossing ?? candidateFloor);
      yield* sql`DELETE FROM agent_event_facts WHERE log_seq < ${floorSeq}`;
      yield* sql`DELETE FROM agent_event_probes WHERE log_seq < ${floorSeq}`;
      yield* pruneReplayHistory(floorSeq);
      yield* sql`UPDATE agent_event_log_state SET floor_seq = ${floorSeq} WHERE id = 1`;
      return {
        abandonedSubscriptions: [...new Set(abandoned.map((row) => row.subscriptionId))],
        floorSeq,
      };
    }),
  );
});

export const status = Effect.fn("AgentFactRetention.status")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const compatibilityPin = yield* CompatibilityFacts.firstPinnedSequence();
  const retained = (yield* sql<{
    readonly rows: number;
    readonly bytes: number;
    readonly pinnedRows: number;
    readonly pinnedBytes: number;
  }>`
    WITH payloads AS (
      SELECT log_seq, LENGTH(CAST(data_json AS BLOB)) AS bytes FROM agent_event_facts
      UNION ALL SELECT log_seq, LENGTH(CAST(data_json AS BLOB)) AS bytes FROM agent_event_probes
    ), pin AS (SELECT MIN(sequence) AS sequence FROM (SELECT MIN(log_seq) AS sequence FROM agent_event_deliveries WHERE state IN ('pending', 'sending') UNION ALL SELECT ${compatibilityPin}))
    SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes,
      COALESCE(SUM(CASE WHEN log_seq >= pin.sequence THEN 1 ELSE 0 END), 0) AS "pinnedRows",
      COALESCE(SUM(CASE WHEN log_seq >= pin.sequence THEN bytes ELSE 0 END), 0) AS "pinnedBytes"
    FROM payloads CROSS JOIN pin`)[0]!;
  const source =
    (yield* sql<{
      readonly generation: string;
      readonly activatedAt: number | null;
      readonly bootstrapSequence: number | null;
      readonly rebuildSequence: number | null;
      readonly throughSequence: number;
      readonly gapSequence: number | null;
      readonly gapAt: number | null;
      readonly pinnedSourceRows: number;
    }>`
    SELECT source.generation, source.activated_at AS "activatedAt", source.bootstrap_sequence AS "bootstrapSequence", source.rebuild_sequence AS "rebuildSequence",
      COALESCE((SELECT derived_through_sequence FROM agent_event_log_state WHERE id = 1), 0) AS "throughSequence",
      source.gap_sequence AS "gapSequence", source.gap_at AS "gapAt",
      (SELECT COUNT(*) FROM orchestration_events WHERE source.activated_at IS NOT NULL AND sequence >= COALESCE(source.rebuild_sequence, source.bootstrap_sequence)) AS "pinnedSourceRows"
    FROM agent_event_source_state AS source WHERE source.id = 1`)[0] ?? null;
  return { ...retained, softCapOverrunRows: Math.max(0, retained.rows - LOG_ROWS), source };
});

const pruneReplayHistory = Effect.fn("AgentFactRetention.pruneReplayHistory")(function* (
  floor: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // A retained private page may refer to an older shared input/observation. Its immutable
  // occurrence is a payload receipt, not a replay slot or a root that holds back the log floor.
  yield* sql`WITH RECURSIVE required(event_id,kind) AS (
    SELECT event_id,kind FROM agent_event_facts WHERE source_kind='gateway' AND kind IN ('gateway_snapshot','gateway_work_snapshot')
    UNION SELECT refs.value, CASE WHEN required.kind='gateway_work_snapshot' AND dependency.source_generation NOT LIKE 'work-input:%'
      THEN 'gateway_snapshot' ELSE NULL END
      FROM required JOIN agent_event_occurrences occurrence ON occurrence.event_id=required.event_id
        AND required.kind IN ('gateway_snapshot','gateway_work_snapshot')
      JOIN json_each(occurrence.bootstrap_json,'$.references') refs
      LEFT JOIN agent_event_occurrences dependency ON dependency.event_id=refs.value
  ) DELETE FROM agent_event_occurrences WHERE log_seq < ${floor} AND event_id NOT IN (SELECT event_id FROM required)`;
  const current = (yield* sql<{
    readonly generation: string;
    readonly environmentId: string | null;
    readonly bootstrap: number | null;
    readonly base: number | null;
    readonly gap: number | null;
    readonly through: number;
  }>`
    SELECT source.generation, origin_environment_id AS "environmentId", bootstrap_sequence AS bootstrap,
      rebuild_sequence AS base, gap_sequence AS gap,
      COALESCE((SELECT derived_through_sequence FROM agent_event_log_state WHERE id = 1), 0) AS through
    FROM agent_event_source_state AS source WHERE source.id = 1`)[0];
  if (current?.bootstrap != null && current.gap === null && current.environmentId !== null) {
    const retained = (yield* sql<{
      readonly firstSource: number | null;
      readonly bootstrap: number;
    }>`
      SELECT MIN(CASE WHEN source_kind = 'orchestration' THEN source_sequence ELSE NULL END) AS "firstSource",
        COALESCE(MAX(CASE WHEN source_kind = 'bootstrap' THEN 1 ELSE 0 END), 0) AS bootstrap
      FROM agent_event_occurrences WHERE source_generation = ${current.generation} AND origin_environment_id = ${current.environmentId}`)[0]!;
    const candidate =
      retained.bootstrap === 1
        ? current.bootstrap
        : Math.max(
            current.bootstrap,
            retained.firstSource === null ? current.through : retained.firstSource - 1,
          );
    const base = Math.max(current.base ?? current.bootstrap, Math.min(current.through, candidate));
    const anchor =
      base === 0
        ? null
        : (yield* sql<{
            readonly id: string;
          }>`SELECT event_id AS id FROM orchestration_events WHERE sequence = ${base}`)[0]?.id;
    if (base === 0 || anchor !== undefined) {
      yield* sql`UPDATE agent_event_source_state SET rebuild_sequence = ${base}, rebuild_event_id = ${anchor ?? null} WHERE id = 1`;
      yield* sql`DELETE FROM agent_event_reducer_history AS old WHERE old.source_generation = ${current.generation}
        AND old.source_sequence < ${base} AND EXISTS (
          SELECT 1 FROM agent_event_reducer_history AS newer
          WHERE newer.source_generation = old.source_generation AND newer.state_key = old.state_key
            AND newer.source_sequence > old.source_sequence AND newer.source_sequence <= ${base})`;
    }
  }
  yield* sql`DELETE FROM agent_event_reducer_history WHERE source_generation NOT IN (SELECT generation FROM agent_event_source_state)
    AND NOT EXISTS (SELECT 1 FROM agent_event_occurrences WHERE source_generation = agent_event_reducer_history.source_generation)`;
  yield* sql`DELETE FROM agent_event_source_directories WHERE NOT EXISTS (
    SELECT 1 FROM orchestration_events WHERE sequence = agent_event_source_directories.source_sequence)`;
  yield* sql`DELETE FROM agent_event_directories WHERE NOT EXISTS (
    SELECT 1 FROM agent_event_source_directories WHERE directory_generation = agent_event_directories.generation)
    AND NOT EXISTS (SELECT 1 FROM agent_event_facts WHERE source_kind <> 'gateway' AND json_extract(data_json, '$.owner.directoryGeneration') = agent_event_directories.generation)
    AND NOT EXISTS (SELECT 1 FROM agent_event_occurrences WHERE source_kind <> 'gateway' AND bootstrap_json IS NOT NULL AND json_extract(bootstrap_json, '$.owner.directoryGeneration') = agent_event_directories.generation)
    AND NOT EXISTS (SELECT 1 FROM agent_event_reducer_history WHERE state_json IS NOT NULL AND json_extract(state_json, '$.assignmentOwner.directoryGeneration') = agent_event_directories.generation)`;
});
