import { TurnTokenUsage, type ThreadId, type UsageSummaryInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const HOUR_MS = 3_600_000;
// Day windows are local calendar days; widen to every UTC offset and let `inWindow` cut exactly.
const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;

/** One provider turn that reported usage, with the names a report shows beside it. */
export interface LedgerTurn {
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly driver: string | null;
  readonly providerInstanceId: string | null;
  /** ISO completion time, or the start time of a turn that never completed. */
  readonly at: string;
  readonly model: string | null;
  readonly usage: TurnTokenUsage;
}

interface LedgerRow extends Omit<LedgerTurn, "usage"> {
  readonly usageJson: string;
}

const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));

function ledgerBounds(window: UsageSummaryInput) {
  if (window.sinceTime !== undefined && window.untilTime !== undefined)
    return { from: window.sinceTime, to: window.untilTime };
  const at = (day: string, offsetMs: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(Date.parse(`${day}T00:00:00.000Z`) + offsetMs));
  return {
    from: at(window.sinceDay, -MAX_UTC_OFFSET_MS),
    to: at(window.untilDay, 24 * HOUR_MS + MAX_UTC_OFFSET_MS),
  };
}

/**
 * Every turn with usage in the window, across all threads or one, in a single read of upstream's
 * projection tables. Times are stored as `toISOString` text, so string comparison orders them.
 */
export const readTurnLedger = Effect.fn("UsageReport.readTurnLedger")(function* (
  window: UsageSummaryInput,
  threadId?: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const { from, to } = ledgerBounds(window);
  const rows = yield* sql<LedgerRow>`
    SELECT
      turn.thread_id AS "threadId",
      thread.title AS "threadTitle",
      thread.project_id AS "projectId",
      project.title AS "projectTitle",
      COALESCE(provider_thread.driver, json_extract(provider_thread.payload_json, '$.driver')) AS "driver",
      COALESCE(
        provider_thread.provider_instance_id,
        json_extract(provider_thread.payload_json, '$.providerInstanceId')
      ) AS "providerInstanceId",
      COALESCE(turn.completed_at, turn.started_at) AS "at",
      json_extract(turn.payload_json, '$.model') AS "model",
      json_extract(turn.payload_json, '$.turnTokenUsage') AS "usageJson"
    FROM orchestration_v2_projection_provider_turns AS turn
    LEFT JOIN orchestration_v2_projection_provider_threads AS provider_thread
      ON provider_thread.provider_thread_id = turn.provider_thread_id
    LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = turn.thread_id
    LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
    WHERE COALESCE(turn.completed_at, turn.started_at) >= ${from}
      AND COALESCE(turn.completed_at, turn.started_at) < ${to}
      AND json_extract(turn.payload_json, '$.turnTokenUsage') IS NOT NULL
      ${threadId === undefined ? sql`` : sql`AND turn.thread_id = ${threadId}`}
  `;
  return rows.flatMap(({ usageJson, ...row }): LedgerTurn[] =>
    Option.match(decodeUsage(usageJson), {
      onNone: () => [],
      onSome: (usage) => [{ ...row, usage }],
    }),
  );
});
