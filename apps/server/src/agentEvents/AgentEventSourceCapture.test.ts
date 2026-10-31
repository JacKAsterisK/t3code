import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2DomainEventJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import * as Owners from "./AgentEventOwners.ts";

import * as FleetUsers from "../lan/FleetUsers.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";

const at = "2026-01-01T00:00:00.000Z";
const thread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-a",
  projectId: "project-a",
  title: "Task A",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-a" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ownerId: "dan",
};
const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const native = (id: string, type: string) =>
  decode({ id, type, threadId: "thread-a", occurredAt: at, payload: thread });
const core = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(layerDatabase),
);
const sink = (label: string) =>
  EventSink.EventSinkV2.pipe(
    Effect.provide(
      EventSink.layer.pipe(
        Layer.provide(
          FleetUsers.layerStatic({
            users: [{ id: "dan", name: label }],
            machineId: null,
            defaultOwnerId: null,
          }),
        ),
      ),
    ),
  );

describe("AgentEventSourceCapture", () => {
  it.effect(
    "resolves current assignment and directory freshness without rewriting historical owner evidence",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const current = yield* Ref.make<FleetUsers.FleetUsersObservation>({
          status: "fresh" as const,
          observedAt: 1_000,
          lastGoodObservedAt: 1_000,
          observationGeneration: "initial",
          directoryDigest: "digest-a",
          directory: {
            users: [
              { id: "dan", name: "Dan" },
              { id: "gavin", name: "Gavin" },
            ],
            machineId: null,
            defaultOwnerId: null,
          },
        });
        const users = Layer.mock(FleetUsers.FleetUsers)({
          withObservationSnapshot: (use) => Ref.get(current).pipe(Effect.flatMap(use)),
        });
        const services = yield* Layer.build(
          Layer.merge(EventSink.layer, Owners.layer).pipe(Layer.provide(users)),
        );
        const writer = Context.get(services, EventSink.EventSinkV2);
        const owners = Context.get(services, Owners.AgentEventOwners);
        const created = (yield* writer.write({
          events: [native("created", "thread.created")],
        }))[0]!;
        const first = yield* owners.read(created.event.threadId);
        assert.strictEqual(first.assignmentRevision, created.sequence);
        assert.strictEqual(first.sourceGeneration, created.agentEventDirectory!.sourceGeneration);
        assert.strictEqual(first.directoryGeneration, "initial");
        assert.strictEqual(first.routingReady, true);
        yield* Ref.update(current, (value) => ({
          ...value,
          status: "unavailable" as const,
          observedAt: 2_000,
          observationGeneration: "failed",
        }));
        yield* TestClock.setTime(2_000);
        const unavailable = yield* owners.read(created.event.threadId);
        assert.strictEqual(unavailable.label, "Dan");
        assert.strictEqual(unavailable.directoryStatus, "unavailable");
        assert.strictEqual(unavailable.routingReady, false);
        yield* Ref.update(current, (value) => ({
          ...value,
          status: "fresh" as const,
          observedAt: 1_000,
          observationGeneration: "old-success",
        }));
        yield* TestClock.setTime(200_000);
        assert.strictEqual((yield* owners.read(created.event.threadId)).directoryStatus, "stale");
        yield* Ref.update(current, (value) => ({
          ...value,
          status: "fresh" as const,
          observedAt: 200_000,
          lastGoodObservedAt: 200_000,
          observationGeneration: "renamed",
          directoryDigest: "digest-b",
          directory: {
            ...value.directory,
            users: [
              { id: "dan", name: "Daniel" },
              { id: "gavin", name: "Gavin" },
            ],
          },
        }));
        assert.strictEqual((yield* owners.read(created.event.threadId)).label, "Daniel");
        const changed = (yield* writer.write({
          events: [
            decode({
              id: "assigned",
              type: "thread.owner-set",
              threadId: thread.id,
              occurredAt: at,
              payload: { ...thread, ownerId: "gavin" },
            }),
          ],
        }))[0]!;
        const latest = yield* owners.read(created.event.threadId);
        assert.strictEqual(latest.id, "gavin");
        assert.strictEqual(latest.assignmentRevision, changed.sequence);
        assert.strictEqual(latest.directoryGeneration, "renamed");
        assert.strictEqual(latest.routingReady, true);
        assert.strictEqual(
          (yield* Journal.readForSource(
            created.agentEventDirectory!.sourceGeneration,
            created.sequence,
          ))!.directory.users[0]!.name,
          "Dan",
        );
      }).pipe(Effect.provide(core)),
  );
  it.effect(
    "captures immutable observations at native commitment and preserves references through source replay",
    () =>
      Effect.gen(function* () {
        const old = yield* sink("Dan");
        const first = (yield* old.write({ events: [native("created", "thread.created")] }))[0]!;
        const renamed = yield* sink("Daniel");
        const second = (yield* renamed.write({
          events: [native("renamed", "thread.metadata-updated")],
        }))[0]!;
        assert.isDefined(first.agentEventDirectory);
        assert.isDefined(second.agentEventDirectory);
        assert.strictEqual(
          first.agentEventDirectory!.sourceGeneration,
          second.agentEventDirectory!.sourceGeneration,
        );
        assert.notStrictEqual(
          first.agentEventDirectory!.directoryGeneration,
          second.agentEventDirectory!.directoryGeneration,
        );
        assert.strictEqual(
          (yield* Journal.readForSource(
            first.agentEventDirectory!.sourceGeneration,
            first.sequence,
          ))!.directory.users[0]!.name,
          "Dan",
        );
        assert.strictEqual(
          (yield* Journal.readForSource(
            second.agentEventDirectory!.sourceGeneration,
            second.sequence,
          ))!.directory.users[0]!.name,
          "Daniel",
        );
        const store = yield* EventStore.EventStoreV2;
        const replay = yield* store.read().pipe(Stream.runCollect);
        assert.deepEqual(
          replay.map((stored) => stored.agentEventDirectory),
          [first.agentEventDirectory, second.agentEventDirectory],
        );
      }).pipe(Effect.provide(core)),
  );

  it.effect(
    "rolls back source, observation and bindings together when native projection commit fails",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const writer = yield* sink("Dan");
        yield* sql`CREATE TRIGGER refuse_thread BEFORE INSERT ON orchestration_v2_projection_threads
        BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
        const failure = yield* Effect.flip(
          writer.write({ events: [native("created", "thread.created")] }),
        );
        assert.instanceOf(failure, EventSink.EventSinkWriteError);
        for (const table of [
          "orchestration_events",
          "agent_event_source_state",
          "agent_event_directories",
          "agent_event_source_directories",
          "agent_event_owner_assignments",
        ])
          assert.strictEqual(
            (yield* sql<{
              readonly count: number;
            }>`SELECT COUNT(*) AS count FROM ${sql(table)}`)[0]!.count,
            0,
          );
        yield* sql`DROP TRIGGER refuse_thread`;
        const stored = (yield* writer.write({ events: [native("created", "thread.created")] }))[0]!;
        assert.isDefined(stored.agentEventDirectory);
        assert.isDefined(
          yield* Journal.readForSource(
            stored.agentEventDirectory!.sourceGeneration,
            stored.sequence,
          ),
        );
      }).pipe(Effect.provide(core)),
  );
});
