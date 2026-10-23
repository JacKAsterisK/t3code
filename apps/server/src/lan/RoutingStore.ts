import {
  type EnvironmentId,
  EventId,
  type LanTaskLaunchResult,
  LanTaskObservation,
  LanTaskEventCursor,
  type LanTaskObserveResult,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(LanTaskObservation));
const decodeObservation = Schema.decodeUnknownEffect(Schema.fromJsonString(LanTaskObservation));
const decodeCursor = Schema.decodeUnknownEffect(LanTaskEventCursor);
const decodeSourceId = Schema.decodeUnknownEffect(EventId);

export class RoutingStore extends Context.Service<
  RoutingStore,
  {
    readonly own: (
      principal: string,
      environmentId: EnvironmentId,
      task: LanTaskLaunchResult,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly owned: (
      principal: string,
      environmentId: EnvironmentId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, OrchestratorMcpFailure>;
    readonly ingest: (
      principal: string,
      environmentId: EnvironmentId,
      page: LanTaskObserveResult,
      options: {
        readonly reset?: boolean;
        readonly expectedDeliverySourceId: EventId | null;
      },
    ) => Effect.Effect<EventId, OrchestratorMcpFailure>;
    readonly checkpoint: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      | { readonly cursor: typeof LanTaskEventCursor.Type; readonly deliverySourceId: EventId }
      | undefined,
      OrchestratorMcpFailure
    >;
    readonly cursor: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<typeof LanTaskEventCursor.Type | undefined, OrchestratorMcpFailure>;
    readonly pending: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      expectedDeliverySourceId?: EventId,
    ) => Effect.Effect<ReadonlyArray<typeof LanTaskObservation.Type>, OrchestratorMcpFailure>;
    readonly acknowledge: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      ids: ReadonlyArray<string>,
      sourceId: EventId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("t3/lan/RoutingStore") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "LAN routing persistence is unavailable.",
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const own = Effect.fn("RoutingStore.own")(function* (
    principal: string,
    environmentId: EnvironmentId,
    task: LanTaskLaunchResult,
  ) {
    yield* sql`INSERT OR IGNORE INTO lan_owned_threads (principal_id, environment_id, project_id, thread_id)
      VALUES (${principal}, ${environmentId}, ${task.projectId}, ${task.threadId})`;
  }, Effect.mapError(unavailable));
  const owned = Effect.fn("RoutingStore.owned")(function* (
    principal: string,
    environmentId: EnvironmentId,
    projectId?: ProjectId,
  ) {
    const rows =
      projectId === undefined
        ? yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM lan_owned_threads WHERE principal_id=${principal} AND environment_id=${environmentId}`
        : yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM lan_owned_threads WHERE principal_id=${principal} AND environment_id=${environmentId} AND project_id=${projectId}`;
    return rows.map((row) => row.thread_id);
  }, Effect.mapError(unavailable));
  const ingest = Effect.fn("RoutingStore.ingest")(function* (
    principal: string,
    environmentId: EnvironmentId,
    page: LanTaskObserveResult,
    options: { readonly reset?: boolean; readonly expectedDeliverySourceId: EventId | null },
  ) {
    if (page.status !== "ok") return yield* unavailable();
    let previous = -1;
    const ids = new Set<string>();
    if (
      page.nextCursor.sourceId !== page.sourceId ||
      page.nextCursor.sequence > page.headSequence ||
      page.events.length > 100
    )
      return yield* unavailable();
    for (const event of page.events) {
      if (
        event.sequence <= previous ||
        event.sequence > page.nextCursor.sequence ||
        ids.has(event.eventId)
      )
        return yield* unavailable();
      previous = event.sequence;
      ids.add(event.eventId);
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* checkpoint(principal, environmentId, page.threadId);
        if (
          (current?.deliverySourceId ?? null) !== options.expectedDeliverySourceId ||
          (current !== undefined && !options.reset && current.cursor.sourceId !== page.sourceId)
        )
          return yield* unavailable();
        // A restored history may retain thread.created and reuse event IDs. The
        // delivery generation must change independently of that native cursor.
        const deliverySourceId = options.reset
          ? EventId.make(yield* crypto.randomUUIDv4())
          : (current?.deliverySourceId ?? page.sourceId);
        for (const event of page.events) {
          const encoded = yield* encodeObservation(event);
          yield* sql`INSERT OR IGNORE INTO lan_observation_inbox
          (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json)
          VALUES (${principal}, ${environmentId}, ${page.threadId}, ${deliverySourceId}, ${event.eventId}, ${event.sequence}, ${encoded})`;
        }
        // A cursor never passes events whose durable delivery records failed to commit.
        yield* sql`INSERT INTO lan_observation_cursors (principal_id, environment_id, thread_id, source_id, sequence, anchor_event_id, delivery_source_id)
        VALUES (${principal}, ${environmentId}, ${page.threadId}, ${page.sourceId}, ${page.nextCursor.sequence}, ${page.nextCursor.anchorEventId ?? null}, ${deliverySourceId})
        ON CONFLICT(principal_id, environment_id, thread_id) DO UPDATE SET
          source_id=excluded.source_id, sequence=excluded.sequence, anchor_event_id=excluded.anchor_event_id, delivery_source_id=excluded.delivery_source_id
          WHERE (source_id=excluded.source_id AND sequence<=excluded.sequence) OR ${options.reset ? 1 : 0}`;
        return deliverySourceId;
      }),
    );
  }, Effect.mapError(unavailable));
  const checkpoint = Effect.fn("RoutingStore.checkpoint")(function* (
    principal: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{
      source_id: string;
      sequence: number;
      anchor_event_id: string | null;
      delivery_source_id: string;
    }>`SELECT source_id, sequence, anchor_event_id, delivery_source_id FROM lan_observation_cursors
      WHERE principal_id=${principal} AND environment_id=${environmentId} AND thread_id=${threadId}`;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          cursor: yield* decodeCursor({
            sourceId: row.source_id,
            sequence: row.sequence,
            ...(row.anchor_event_id === null ? {} : { anchorEventId: row.anchor_event_id }),
          }),
          deliverySourceId: yield* decodeSourceId(row.delivery_source_id),
        };
  }, Effect.mapError(unavailable));
  const cursor = Effect.fn("RoutingStore.cursor")(function* (
    principal: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    return (yield* checkpoint(principal, environmentId, threadId))?.cursor;
  });
  const pending = Effect.fn("RoutingStore.pending")(function* (
    principal: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    expectedDeliverySourceId?: EventId,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* checkpoint(principal, environmentId, threadId);
        if (
          expectedDeliverySourceId !== undefined &&
          current?.deliverySourceId !== expectedDeliverySourceId
        )
          return yield* unavailable();
        if (current === undefined) return [];
        const rows = yield* sql<{ event_json: string }>`SELECT event_json FROM lan_observation_inbox
      WHERE principal_id=${principal} AND environment_id=${environmentId} AND thread_id=${threadId} AND acknowledged=0
      AND source_id=${current.deliverySourceId}
      ORDER BY sequence LIMIT 101`;
        return yield* Effect.forEach(rows, (row) => decodeObservation(row.event_json));
      }),
    );
  }, Effect.mapError(unavailable));
  const acknowledge = Effect.fn("RoutingStore.acknowledge")(function* (
    principal: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    ids: ReadonlyArray<string>,
    sourceId: EventId,
  ) {
    if (ids.length === 0) return;
    yield* sql`UPDATE lan_observation_inbox SET acknowledged=1 WHERE principal_id=${principal}
      AND environment_id=${environmentId} AND thread_id=${threadId} AND source_id=${sourceId}
      AND ${sql.in("event_id", ids)}`;
  }, Effect.mapError(unavailable));
  return RoutingStore.of({ own, owned, ingest, checkpoint, cursor, pending, acknowledge });
});
export const layer = Layer.effect(RoutingStore, make);
