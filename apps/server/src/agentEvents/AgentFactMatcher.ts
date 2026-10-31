import type {
  AgentEventEnvelope,
  AgentEventKind,
  AgentEventSubscriptionArguments,
} from "@t3tools/contracts";
import { AGENT_EVENT_LIMITS } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as DeliveryStore from "./AgentEventStore.ts";

const kindsByName: Readonly<Record<string, ReadonlyArray<AgentEventKind>>> = {
  "t3.approval_needed": ["approval"],
  "t3.question_asked": ["question", "secret"],
  "t3.task_blocked": ["blocked"],
  "t3.run_finished": ["run_finished"],
  "t3.owner_changed": ["owner_changed"],
};
const Arguments = Schema.Struct({
  environmentIds: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(AGENT_EVENT_LIMITS.environmentIds)),
  ),
  threadIds: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(AGENT_EVENT_LIMITS.threadIds)),
  ),
  includeDelegatedResults: Schema.optionalKey(Schema.Boolean),
});
export const decodeArgumentsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Arguments));

/** Owner labels never take part in matching or authorization. */
export const matches = (
  name: string,
  args: AgentEventSubscriptionArguments,
  data: AgentEventEnvelope,
): boolean => {
  if (name !== "t3.task_activity" && !kindsByName[name]?.includes(data.kind)) return false;
  if (
    args.environmentIds !== undefined &&
    !args.environmentIds.includes(
      data.relay === null &&
        data.kind === "source_status" &&
        typeof data.detail.environmentId === "string"
        ? data.detail.environmentId
        : data.environment.id,
    )
  )
    return false;
  // Source availability affects every selected thread on that source, even with no thread payload.
  if (args.threadIds !== undefined && data.kind !== "source_status") {
    const threadId = data.thread?.id;
    if (
      typeof threadId !== "string" ||
      !args.threadIds.some((filter) => {
        const href = filter.startsWith("<") && filter.endsWith(">") ? filter.slice(1, -1) : filter;
        const link = parseThreadLinkHref(href);
        return link === null
          ? !href.startsWith("t3-thread:") && href === threadId
          : link.threadId === threadId &&
              (link.environmentId === null || link.environmentId === data.environment.id);
      })
    )
      return false;
  }
  return (
    data.kind !== "run_finished" ||
    data.thread?.delegated !== true ||
    args.includeDelegatedResults === true
  );
};

/** Runs inside the fact transaction, so progress never passes a fact whose eligible deliveries are missing. */
export const queueFact = Effect.fn("AgentFactMatcher.queueFact")(function* (input: {
  readonly eventId: string;
  readonly logSeq: number;
  readonly data: AgentEventEnvelope;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  for (const subscription of yield* DeliveryStore.listSubscriptions(["active"])) {
    if (subscription.expiresAt <= input.now) continue;
    const args = yield* decodeArgumentsJson(subscription.argumentsJson, {
      onExcessProperty: "error",
    });
    if (matches(subscription.eventName, args, input.data))
      yield* sql`INSERT OR IGNORE INTO agent_event_deliveries
        (subscription_id, event_id, log_seq, state, queued_at, next_attempt_at)
        VALUES (${subscription.subscriptionId}, ${input.eventId}, ${input.logSeq}, 'pending', ${input.now}, ${input.now})`;
    yield* sql`UPDATE agent_event_subscriptions
      SET matched_through_sequence = ${input.logSeq}
      WHERE subscription_id = ${subscription.subscriptionId}`;
    yield* DeliveryStore.recomputeWatermark(subscription.subscriptionId, input.now);
  }
});

export const advancePrivateSlot = Effect.fn("AgentFactMatcher.advancePrivateSlot")(function* (
  logSeq: number,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const subscription of yield* DeliveryStore.listSubscriptions(["active"])) {
    if (subscription.expiresAt <= now) continue;
    yield* sql`UPDATE agent_event_subscriptions SET matched_through_sequence = ${logSeq} WHERE subscription_id = ${subscription.subscriptionId}`;
    yield* DeliveryStore.recomputeWatermark(subscription.subscriptionId, now);
  }
});
