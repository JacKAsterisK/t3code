// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off -- The stopped helper owns a single SQLite writer and emits only reviewed work metadata.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  CommandId,
  EventId,
  OrchestrationV2DomainEventJson,
  ThreadId,
  type NativeUnfinishedWorkRequest,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  createPrivateSnapshotDirectory,
  inspectUnfinishedWorkRows,
  NativeMaintenanceError,
  stoppedUnfinishedWorkDatabase,
  type NativeBuildIdentity,
  type NativeWorkEntry,
} from "./NativeMaintenance.ts";
import { staleNativeProjectionClassifier } from "./nativeStaleWork.ts";
import { offlineEventForWork } from "./OfflineWorkCancellation.ts";
import { emptyNativeWork, nativeWorkStatusDefinitions } from "./nativeWorkStates.ts";

const descriptors: Readonly<Record<string, readonly [kind: string, id: string]>> = {
  orchestration_v2_projection_runs: ["run", "run_id"],
  orchestration_v2_projection_run_attempts: ["run_attempt", "attempt_id"],
  orchestration_v2_projection_nodes: ["node", "node_id"],
  orchestration_v2_projection_provider_sessions: ["provider_session", "provider_session_id"],
  orchestration_v2_projection_provider_threads: ["provider_thread", "provider_thread_id"],
  orchestration_v2_projection_provider_turns: ["provider_turn", "provider_turn_id"],
  orchestration_v2_projection_runtime_requests: ["runtime_request", "runtime_request_id"],
  orchestration_v2_projection_subagents: ["subagent", "subagent_id"],
  orchestration_v2_projection_turn_items: ["turn_item", "turn_item_id"],
  orchestration_v2_effect_outbox: ["effect", "effect_id"],
  orchestration_v2_thread_launch_workflows: ["workflow", "command_id"],
  orchestration_v2_projection_context_transfers: ["context_transfer", "context_transfer_id"],
  scheduled_tasks: ["scheduled_task", "task_id"],
  scheduled_task_webhook_pending: ["scheduled_webhook", "delivery_id"],
};
const schemaError = () => new NativeMaintenanceError({ reason: "schema" });
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const stopReason = "Stopped by the user through T3 maintenance.";
const staleReason = "Settled obsolete work after stopped T3 admission verified its terminal owner.";
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const bucketNames = Object.keys(emptyNativeWork()) as Array<
  keyof ReturnType<typeof emptyNativeWork>
>;
const isMaintenanceError = Schema.is(NativeMaintenanceError);
const classifyFailure = (cause: unknown) =>
  isMaintenanceError(cause) ? cause : new NativeMaintenanceError({ reason: "io", cause });

function readReview(db: NodeSqlite.DatabaseSync, request: NativeUnfinishedWorkRequest) {
  const {
    entries,
    workGeneration,
    carriedWork,
    staleWork: _legacyStale,
    ...blocking
  } = inspectUnfinishedWorkRows(db);
  const scope = {
    includeScheduledWork: request.includeScheduledWork ?? true,
    includeRestartContinuations: request.includeRestartContinuations ?? true,
  };
  for (const category of bucketNames) {
    const count = entries
      .filter((item) => item.category === category && !item.carried && !item.stale)
      .reduce((sum, item) => sum + item.count, 0);
    if (blocking[category] !== count) throw schemaError();
  }
  if (entries.length > 20_000) throw schemaError();
  const stale = staleNativeProjectionClassifier(db, DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const staleWork: Record<string, number> = {};
  const threadTitle = db.prepare(
    "SELECT title FROM orchestration_v2_projection_threads WHERE thread_id=?",
  );
  const byThread = new Map<
    string | null,
    {
      threadId: string | null;
      title: string | null;
      items: Array<ReturnType<typeof describe>["item"]>;
    }
  >();
  function describe(entry: NativeWorkEntry) {
    const { row, table, category, count, carried } = entry;
    const descriptor = descriptors[table];
    if (descriptor === undefined) throw schemaError();
    const [kind, identifier] = descriptor;
    const id = text(row[identifier]);
    const status = text(row.status ?? row.last_run_status ?? row.state);
    if (id === null || status === null) throw schemaError();
    const threadId =
      text(row.thread_id ?? row.target_thread_id) ??
      (table === "scheduled_task_webhook_pending"
        ? text(
            db.prepare("SELECT thread_id FROM scheduled_tasks WHERE task_id=?").get(row.task_id!)
              ?.thread_id,
          )
        : table === "orchestration_v2_projection_provider_sessions"
          ? text(
              db
                .prepare(
                  "SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=? ORDER BY thread_id LIMIT 1",
                )
                .get(id)?.thread_id ??
                db
                  .prepare(
                    "SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_session_id=? AND thread_id IS NOT NULL ORDER BY thread_id LIMIT 1",
                  )
                  .get(id)?.thread_id,
            )
          : null);
    const isStale = entry.stale === true || (category === "backgroundAgents" && stale(table, row));
    if (isStale) {
      if (entry.stale !== true) blocking[category] -= count;
      const staleKind = kind === "turn_item" ? (text(row.type) ?? kind) : kind;
      staleWork[staleKind] = (staleWork[staleKind] ?? 0) + count;
    }
    const selected =
      category === "scheduledWork"
        ? scope.includeScheduledWork
        : category === "restartContinuations"
          ? scope.includeRestartContinuations
          : !carried;
    const item = {
      id,
      kind: kind === "turn_item" ? (text(row.type) ?? kind) : kind,
      status,
      category,
      count,
      blocking: !carried && !isStale,
      stale: isStale,
      selected,
      title: text(row.title),
    };
    return { entry, threadId, item };
  }
  const described = entries.map(describe).sort((a, b) => {
    const key = (value: typeof a) =>
      JSON.stringify([value.threadId, value.entry.table, value.item.id, value.item.category]);
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const { threadId, item } of described) {
    const group = byThread.get(threadId) ?? {
      threadId,
      title: threadId === null ? null : text(threadTitle.get(threadId)?.title),
      items: [],
    };
    group.items.push(item);
    byThread.set(threadId, group);
  }
  const threads = [...byThread.values()];
  const reviewSha256 = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        homeDirectory: request.homeDirectory,
        environmentId: request.environmentId,
        scope,
        workGeneration,
        threads,
      }),
    )
    .digest("hex");
  return {
    workGeneration,
    reviewSha256,
    scope,
    threads,
    blocking,
    carriedWork,
    staleWork,
    described,
  };
}

const tryIo = <A>(fn: () => A) => Effect.try({ try: fn, catch: classifyFailure });
const withReader = <A>(file: string, use: (db: NodeSqlite.DatabaseSync) => A): A => {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    return use(db);
  } finally {
    db.close();
  }
};
const dataVersion = (db: NodeSqlite.DatabaseSync) =>
  db.prepare("PRAGMA data_version").get()!.data_version;

// Store-only transitions match the existing outbox and scheduler recovery statuses.
function settleStoreRow(
  db: NodeSqlite.DatabaseSync,
  entry: NativeWorkEntry,
  id: string,
  now: string,
  reason: string,
) {
  switch (entry.table) {
    case "orchestration_v2_effect_outbox":
      db.prepare(
        "UPDATE orchestration_v2_effect_outbox SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL, completed_at=?, updated_at=?, last_error=? WHERE effect_id=?",
      ).run(now, now, reason, id);
      return true;
    case "orchestration_v2_thread_launch_workflows":
      db.prepare(
        "UPDATE orchestration_v2_thread_launch_workflows SET status='failed', updated_at=?, last_error=? WHERE command_id=?",
      ).run(now, reason, id);
      return true;
    case "scheduled_tasks":
      db.prepare(
        "UPDATE scheduled_tasks SET enabled=0, next_run_at=NULL, updated_at=?, last_run_status=CASE WHEN last_run_status='running' THEN 'failed' ELSE last_run_status END, last_run_error=CASE WHEN last_run_status='running' THEN ? ELSE last_run_error END WHERE task_id=?",
      ).run(now, reason, id);
      return true;
    case "scheduled_task_webhook_pending":
      db.prepare(
        "UPDATE scheduled_task_webhook_pending SET state='failed' WHERE delivery_id=?",
      ).run(id);
      return true;
    default:
      return false;
  }
}

const applyReview = Effect.fn("NativeUnfinishedWork.applyReview")(function* (
  db: NodeSqlite.DatabaseSync,
  reviewed: ReturnType<typeof readReview>["described"],
  request: NativeUnfinishedWorkRequest,
) {
  const sink = yield* EventSink.EventSinkV2;
  const requestId = request.nonce;
  const reason = request.operation === "settle-stale-work" ? staleReason : stopReason;
  const now = yield* DateTime.now;
  const at = DateTime.formatIso(now);
  const eventsByThread = new Map<string, Array<OrchestrationV2DomainEvent>>();
  const seen = new Set<string>();
  const restarts = new Set(
    reviewed
      .filter(({ item }) => item.selected && item.category === "restartContinuations")
      .map(({ entry, item }) => entry.table + "\0" + item.id),
  );
  let eventCount = 0;
  for (const { entry, threadId, item } of reviewed) {
    if (!item.selected) continue;
    const entity = entry.table + "\0" + item.id;
    if (seen.has(entity)) continue;
    seen.add(entity);
    if (yield* tryIo(() => settleStoreRow(db, entry, item.id, at, reason))) continue;
    if (
      threadId === null ||
      db
        .prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?")
        .get(threadId) === undefined
    )
      return yield* schemaError();
    const { row, table } = entry;
    const index = nativeWorkStatusDefinitions.findIndex(([name]) => name === table);
    if (
      typeof row.payload_json !== "string" ||
      (row.thread_id !== null && row.thread_id !== undefined && row.thread_id !== threadId)
    )
      return yield* schemaError();
    const cancelRestarts = restarts.has(entity);
    const raw =
      index >= 0
        ? yield* offlineEventForWork(
            index,
            { thread_id: text(row.thread_id), payload_json: row.payload_json, status: item.status },
            threadId,
            at,
            reason,
            cancelRestarts,
            item.id,
          )
        : table === "orchestration_v2_projection_context_transfers"
          ? {
              type: "context-transfer.updated",
              threadId,
              payload: {
                ...JSON.parse(row.payload_json),
                status: "failed",
                error: reason,
                updatedAt: at,
              },
            }
          : null;
    if (raw === null) return yield* schemaError();
    const event = yield* decodeEvent({
      ...raw,
      id: EventId.make("event:stopped-work:" + requestId + ":" + ++eventCount),
      occurredAt: at,
    });
    const threadEvents = eventsByThread.get(threadId) ?? [];
    threadEvents.push(event);
    eventsByThread.set(threadId, threadEvents);
  }
  for (const [threadId, events] of eventsByThread) {
    yield* sink.commitCommand({
      commandId: CommandId.make("command:stopped-work:" + requestId + ":" + threadId),
      threadId: ThreadId.make(threadId),
      commandType:
        request.operation === "settle-stale-work"
          ? "native.settle-stale-work"
          : "native.cancel-unfinished-work",
      acceptedAt: now,
      events,
      effects: [],
    });
  }
  return { entities: seen.size, events: eventCount };
});

const backup = (file: string) =>
  Effect.acquireUseRelease(
    tryIo(() => new NodeSqlite.DatabaseSync(file, { readOnly: true })),
    (source) =>
      Effect.tryPromise({
        try: async () => {
          const directory = createPrivateSnapshotDirectory("t3-unfinished-work-");
          const output = NodePath.join(directory, "statev2.sqlite");
          await NodeSqlite.backup(source, output);
          const fd = NodeFS.openSync(output, "r+");
          try {
            NodeFS.fsyncSync(fd);
          } finally {
            NodeFS.closeSync(fd);
          }
          return directory;
        },
        catch: classifyFailure,
      }),
    (source) => Effect.sync(() => source.close()),
  );

// Durably describe the proposed change before committing. After an interrupted
// invocation the generation decides whether this receipt was applied.
function savePreparedReceipt(directory: string, receipt: object) {
  const destination = NodePath.join(directory, "prepared-receipt.json");
  const handle = NodeFS.openSync(destination, "wx");
  try {
    NodeFS.writeFileSync(handle, JSON.stringify(receipt) + "\n", "utf8");
    NodeFS.fsyncSync(handle);
  } finally {
    NodeFS.closeSync(handle);
  }
}

export const unfinishedWork = Effect.fn("NativeUnfinishedWork.execute")(function* (
  request: NativeUnfinishedWorkRequest,
  compiledIdentity: NativeBuildIdentity,
) {
  const file = yield* stoppedUnfinishedWorkDatabase(request);
  return yield* unfinishedWorkAt(file, request, compiledIdentity);
});

export const unfinishedWorkAt = Effect.fn("NativeUnfinishedWork.executeAt")(function* (
  file: string,
  request: NativeUnfinishedWorkRequest,
  compiledIdentity: NativeBuildIdentity,
) {
  const identity = {
    schemaVersion: 1 as const,
    operation: request.operation,
    nonce: request.nonce,
    homeDirectory: request.homeDirectory,
    environmentId: request.environmentId,
    generationVersion: 2 as const,
    processStopped: true as const,
    compiledIdentity,
  };
  const publicReview = ({ described: _private, ...review }: ReturnType<typeof readReview>) =>
    review;
  const initial = yield* tryIo(() => withReader(file, (db) => readReview(db, request)));
  if (request.operation === "inspect-unfinished-work")
    return { ...identity, ...publicReview(initial) };
  const verifyReview = (review: ReturnType<typeof readReview>) => {
    if (
      review.workGeneration !== request.expectedWorkGeneration ||
      review.reviewSha256 !== request.expectedReviewSha256
    )
      throw new NativeMaintenanceError({ reason: "changed" });
    if (
      request.operation === "cancel-unfinished-work" &&
      review.described.some(({ item }) => item.blocking && !item.selected)
    )
      throw new NativeMaintenanceError({ reason: "busy" });
  };
  const selected = (review: ReturnType<typeof readReview>) =>
    review.described.filter(
      ({ item }) => item.selected && (request.operation !== "settle-stale-work" || item.stale),
    );
  yield* tryIo(() => verifyReview(initial));
  if (selected(initial).length === 0)
    return {
      ...identity,
      ...publicReview(initial),
      backupDirectory: null,
      cancelled: { entities: 0, events: 0 },
      providerLaunches: 0,
    };
  return yield* Effect.acquireUseRelease(
    tryIo(() => new NodeSqlite.DatabaseSync(file, { enableForeignKeyConstraints: true })),
    (db) =>
      Effect.gen(function* () {
        const version = yield* tryIo(() => dataVersion(db));
        const backupDirectory = yield* backup(file);
        const database = NodeSqliteClient.layerFromDatabase(db);
        const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
          Layer.provideMerge(database),
        );
        const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const before = yield* tryIo(() => {
                if (version !== dataVersion(db))
                  throw new NativeMaintenanceError({ reason: "changed" });
                const review = readReview(db, request);
                verifyReview(review);
                return review;
              });
              const cancelled = yield* applyReview(db, selected(before), request);
              const after = yield* tryIo(() => readReview(db, request));
              if (request.operation === "settle-stale-work" && selected(after).length !== 0)
                return yield* new NativeMaintenanceError({ reason: "busy" });
              if (
                request.operation === "cancel-unfinished-work" &&
                bucketNames.some((category) => after.blocking[category] !== 0)
              )
                return yield* new NativeMaintenanceError({ reason: "busy" });
              const receipt = {
                ...identity,
                ...publicReview(after),
                backupDirectory,
                previousWorkGeneration: before.workGeneration,
                previousReviewSha256: before.reviewSha256,
                settledThreads: before.threads.flatMap((group) => {
                  const items = group.items.filter(
                    (item) =>
                      item.selected && (request.operation !== "settle-stale-work" || item.stale),
                  );
                  return items.length > 0 ? [{ ...group, items }] : [];
                }),
                cancelled,
                providerLaunches: 0 as const,
              };
              yield* tryIo(() => savePreparedReceipt(backupDirectory, receipt));
              return receipt;
            }),
          );
        }).pipe(Effect.provide(sink), Effect.mapError(classifyFailure), Effect.scoped);
      }),
    (db) => Effect.sync(() => db.close()),
  );
});
