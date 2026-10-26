// @effect-diagnostics nodeBuiltinImport:off -- Offline lifecycle changes use the normal event sink; no provider or effect worker is constructed.
import {
  CommandId,
  EventId,
  OrchestrationV2DomainEventJson,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { nativeWorkStatusDefinitions } from "./nativeWorkStates.ts";
import { strictJson } from "@t3tools/shared/strictJson";

export class OfflineWorkCancellationError extends Schema.TaggedError<OfflineWorkCancellationError>()(
  "OfflineWorkCancellationError",
  { reason: Schema.Literal("invalid-state") },
) {}

const eventTypes = [
  "run.updated",
  "run-attempt.updated",
  "node.updated",
  "provider-session.updated",
  "provider-thread.updated",
  "provider-turn.updated",
  "runtime-request.updated",
  "subagent.updated",
  "turn-item.updated",
] as const;
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const reason =
  "Cancelled by the user during offline T3 home recovery; conversation and session history retained.";

/** Caller owns a staged database and exclusive admission. It must never attach a worker to this layer. */
export const cancelOfflineWork = Effect.fn("OfflineWorkCancellation.cancel")(function* (
  repairId: string,
) {
  if (!/^[a-f0-9]{32}$/.test(repairId))
    return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const occurredAt = DateTime.formatIso(now);
      const byThread = new Map<string, OrchestrationV2DomainEvent[]>();
      const counts: Record<string, number> = {};
      let total = 0;
      // Per-row planning is covered by the enclosing cancellation transaction span.
      const append = Effect.fnUntraced(function* (raw: Record<string, unknown>) {
        if (++total > 20_000)
          return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
        const threadId = raw.threadId;
        if (typeof threadId !== "string")
          return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
        const event = yield* decodeEvent({
          ...raw,
          id: EventId.make(`event:home-repair:${repairId}:${total}`),
          occurredAt,
        });
        const events = byThread.get(threadId) ?? [];
        events.push(event);
        byThread.set(threadId, events);
      });
      for (let index = 0; index < eventTypes.length; index++) {
        const definition = nativeWorkStatusDefinitions[index]!;
        const [table, , busy] = definition;
        const states: readonly string[] = index === 0 ? [...busy, "queued"] : busy;
        const activeGoal =
          index === 4 ? " OR json_extract(payload_json,'$.goal.status')='active'" : "";
        const rows = yield* sql.unsafe<{ thread_id: string; status: string; payload_json: string }>(
          `SELECT thread_id,status,payload_json FROM ${table} WHERE status IN (${states.map(() => "?").join(",")})${activeGoal} ORDER BY thread_id`,
          states,
        );
        for (const row of rows) {
          const parsed: unknown = strictJson(Buffer.from(row.payload_json));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
          const prior = parsed as Record<string, unknown>;
          if (
            prior.status !== row.status ||
            (prior.threadId !== undefined && prior.threadId !== row.thread_id)
          )
            return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
          const payload = { ...prior };
          if (index === 3) Object.assign(payload, { status: "stopped", updatedAt: occurredAt });
          else if (index === 4) {
            Object.assign(payload, {
              status: row.status === "active" ? "idle" : row.status,
              updatedAt: occurredAt,
            });
            if (
              typeof prior.goal === "object" &&
              prior.goal !== null &&
              "status" in prior.goal &&
              prior.goal.status === "active"
            )
              payload.goal = { ...prior.goal, status: "paused" };
          } else if (index === 6)
            Object.assign(payload, {
              status: "cancelled",
              resolvedAt: occurredAt,
              responseCapability: { type: "not_resumable", reason },
            });
          else {
            Object.assign(payload, { status: "cancelled", completedAt: occurredAt });
            if (index === 0) Object.assign(payload, { queuePosition: null });
            if (index === 7 || index === 8) Object.assign(payload, { updatedAt: occurredAt });
            if (index === 8 && typeof payload.streaming === "boolean") payload.streaming = false;
            if (
              index === 8 &&
              payload.type === "secret_request" &&
              payload.secretStatus === "pending"
            )
              payload.secretStatus = "cancelled";
          }
          counts[`${table}:${row.status}`] = (counts[`${table}:${row.status}`] ?? 0) + 1;
          yield* append({
            type: eventTypes[index],
            threadId: row.thread_id,
            payload,
            ...(typeof prior.runId === "string" ? { runId: prior.runId } : {}),
            ...(typeof prior.providerInstanceId === "string"
              ? { providerInstanceId: prior.providerInstanceId }
              : {}),
            ...(typeof prior.driver === "string" ? { driver: prior.driver } : {}),
          });
        }
      }
      const messages = yield* sql<{
        thread_id: string;
        payload_json: string;
      }>`SELECT thread_id,payload_json FROM orchestration_v2_projection_messages WHERE streaming=1 ORDER BY thread_id`;
      for (const row of messages) {
        const prior: unknown = strictJson(Buffer.from(row.payload_json));
        if (prior === null || typeof prior !== "object" || Array.isArray(prior))
          return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
        yield* append({
          type: "message.updated",
          threadId: row.thread_id,
          payload: { ...prior, streaming: false, updatedAt: occurredAt },
        });
      }
      for (const [threadId, events] of byThread) {
        const thread =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
        if (thread.length !== 1)
          return yield* new OfflineWorkCancellationError({ reason: "invalid-state" });
        yield* sink.commitCommand({
          commandId: CommandId.make(`command:home-repair-cancel:${repairId}:${threadId}`),
          threadId: ThreadId.make(threadId),
          commandType: "home-repair.cancel-unfinished",
          acceptedAt: now,
          events,
          effects: [],
        });
      }
      return {
        schemaVersion: 1 as const,
        reason,
        counts,
        events: total,
        threads: byThread.size,
        providerLaunches: 0 as const,
      };
    }),
  );
});
