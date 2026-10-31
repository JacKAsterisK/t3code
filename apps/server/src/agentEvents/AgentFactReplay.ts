import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Store from "./AgentEventStore.ts";
import * as Facts from "./AgentFactStore.ts";
import * as Internal from "./AgentInternalFacts.ts";
import * as Matcher from "./AgentFactMatcher.ts";

export class FactReplayGap extends Schema.TaggedError<FactReplayGap>()("AgentFactReplayGap", {
  expectedSequence: Schema.Number,
  nextAvailable: Schema.NullOr(Schema.Number),
}) {
  override get message(): string {
    return "Retained event payloads are missing within the replay range.";
  }
}

/** Refresh replays retained matching facts, including facts logged before this callback existed. */
export const requeueFacts = Effect.fn("AgentFactReplay.requeueFacts")(function* (input: {
  readonly subscriptionId: string;
  readonly afterSeq: number;
  readonly includeDelivered: boolean;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const subscription = yield* Store.findSubscription(input.subscriptionId);
      if (
        subscription === undefined ||
        subscription.state !== "active" ||
        subscription.expiresAt <= input.now
      )
        return 0;
      const args = yield* Matcher.decodeArgumentsJson(subscription.argumentsJson, {
        onExcessProperty: "error",
      });
      const { headSeq } = yield* Store.logState();
      let sequence = input.afterSeq;
      let requeued = 0;
      while (sequence < headSeq) {
        const rows = yield* sql<{
          readonly logSeq: number;
          readonly eventId: string;
          readonly dataJson: string | null;
        }>`
        SELECT log_seq AS "logSeq", event_id AS "eventId", data_json AS "dataJson" FROM (
          SELECT log_seq, event_id, ${Internal.catalogPayload(sql)} AS data_json FROM agent_event_facts
          UNION ALL SELECT log_seq, event_id, NULL AS data_json FROM agent_event_probes
        ) WHERE log_seq > ${sequence} AND log_seq <= ${headSeq} ORDER BY log_seq LIMIT 1000`;
        if (rows.length === 0)
          return yield* new FactReplayGap({ expectedSequence: sequence + 1, nextAvailable: null });
        for (const row of rows) {
          if (row.logSeq !== sequence + 1)
            return yield* new FactReplayGap({
              expectedSequence: sequence + 1,
              nextAvailable: row.logSeq,
            });
          sequence = row.logSeq;
          // Probe replay is subscription-private and handled by the existing probe path.
          if (row.dataJson === null) continue;
          const data = yield* Facts.decodeFactDataJson(row.dataJson, { onExcessProperty: "error" });
          if (!Matcher.matches(subscription.eventName, args, data)) continue;
          const changed = yield* sql<{ readonly id: string }>`
          INSERT INTO agent_event_deliveries (subscription_id, event_id, log_seq, state, queued_at, next_attempt_at)
          VALUES (${input.subscriptionId}, ${row.eventId}, ${row.logSeq}, 'pending', ${input.now}, ${input.now})
          ON CONFLICT (subscription_id, event_id) DO UPDATE SET state = 'pending', attempts = 0,
            queued_at = excluded.queued_at, next_attempt_at = excluded.next_attempt_at,
            last_status = NULL, last_error = NULL, finished_at = NULL
          WHERE agent_event_deliveries.state NOT IN ('pending', 'sending')
            AND (${input.includeDelivered ? 1 : 0} = 1 OR agent_event_deliveries.state <> 'delivered')
          RETURNING event_id AS id`;
          requeued += changed.length;
        }
      }
      yield* sql`UPDATE agent_event_subscriptions SET matched_through_sequence = ${headSeq}
      WHERE subscription_id = ${input.subscriptionId}`;
      yield* Store.recomputeWatermark(input.subscriptionId, input.now);
      return requeued;
    }),
  );
});
