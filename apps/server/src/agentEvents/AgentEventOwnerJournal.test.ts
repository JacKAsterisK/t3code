import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { FleetUsersObservation } from "../lan/FleetUsers.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";

const database = layerDatabase;
const observed: FleetUsersObservation = {
  status: "fresh",
  observedAt: 1_000,
  lastGoodObservedAt: 1_000,
  observationGeneration: "observation-a",
  directoryDigest: "a".repeat(64),
  directory: {
    users: [
      { id: "dan", name: "Dan" },
      { id: "gavin", name: "Gavin" },
    ],
    machineId: "machine-319682d2fc67441f86be9b87",
    defaultOwnerId: "dan",
  },
};

describe("AgentEventOwnerJournal", () => {
  it.effect(
    "stores distinct observations of equal content without merging their occurrence identities",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const generation = yield* Journal.sourceGeneration();
        assert.strictEqual(yield* Journal.sourceGeneration(), generation);
        const later = {
          ...observed,
          observationGeneration: "observation-b",
          observedAt: 2_000,
          lastGoodObservedAt: 2_000,
        };
        yield* Journal.bindSourceEvents({
          sourceGeneration: generation,
          sourceSequences: [10],
          observation: observed,
        });
        yield* Journal.bindSourceEvents({
          sourceGeneration: generation,
          sourceSequences: [11],
          observation: later,
        });
        yield* Journal.recordObservation(later);
        assert.strictEqual(
          (yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM agent_event_directories`)[0]!.count,
          2,
        );
        assert.deepEqual(yield* Journal.readForSource(generation, 10), observed);
        assert.deepEqual(yield* Journal.readForSource(generation, 11), later);
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    "preserves historical labels and refuses observation replacement or source rebinding atomically",
    () =>
      Effect.gen(function* () {
        const generation = yield* Journal.sourceGeneration();
        yield* Journal.bindSourceEvents({
          sourceGeneration: generation,
          sourceSequences: [1],
          observation: observed,
        });
        const renamed: FleetUsersObservation = {
          ...observed,
          observationGeneration: "renamed",
          directoryDigest: "b".repeat(64),
          directory: {
            ...observed.directory,
            users: [{ id: "dan", name: "Daniel" }, observed.directory.users[1]!],
          },
        };
        const rebound = yield* Effect.flip(
          Journal.bindSourceEvents({
            sourceGeneration: generation,
            sourceSequences: [2, 1],
            observation: renamed,
          }),
        );
        assert.instanceOf(rebound, Journal.OwnerJournalConflict);
        assert.strictEqual(rebound.reason, "source_rebound");
        assert.isUndefined(yield* Journal.readForSource(generation, 2));
        assert.isUndefined(yield* Journal.readObservation("renamed"));
        const replaced = yield* Effect.flip(
          Journal.recordObservation({
            ...renamed,
            observationGeneration: observed.observationGeneration,
          }),
        );
        assert.instanceOf(replaced, Journal.OwnerJournalConflict);
        assert.strictEqual(replaced.reason, "observation_changed");
        assert.strictEqual(
          (yield* Journal.readForSource(generation, 1))!.directory.users[0]!.name,
          "Dan",
        );
        yield* Journal.bindSourceEvents({
          sourceGeneration: generation,
          sourceSequences: [2],
          observation: renamed,
        });
        assert.strictEqual(
          (yield* Journal.readForSource(generation, 2))!.directory.users[0]!.name,
          "Daniel",
        );
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    "retains explicit unknown and stale freshness, including nullable observation times and digests",
    () =>
      Effect.gen(function* () {
        const unknown: FleetUsersObservation = {
          ...observed,
          status: "never_read",
          observationGeneration: "unknown",
          observedAt: null,
          lastGoodObservedAt: null,
          directoryDigest: null,
        };
        const stale: FleetUsersObservation = {
          ...observed,
          status: "unavailable",
          observationGeneration: "stale",
          observedAt: 4_000,
        };
        yield* Journal.recordObservation(unknown);
        yield* Journal.recordObservation(stale);
        assert.deepEqual(yield* Journal.readObservation("unknown"), unknown);
        assert.deepEqual(yield* Journal.readObservation("stale"), stale);
        assert.isUndefined(yield* Journal.readForSource("missing", 1));
      }).pipe(Effect.provide(database)),
  );

  it.effect("adds empty Phase 2 storage without resetting Phase 0 sequence state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM agent_event_source_state`)[0]!.count,
        0,
      );
      assert.strictEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM agent_event_directories`)[0]!.count,
        0,
      );
      yield* sql`INSERT INTO agent_event_log_state (id, epoch, head_seq, floor_seq) VALUES (1, 'existing', 7, 2)`;
      const generation = yield* Journal.sourceGeneration();
      assert.match(generation, /^src_[A-Za-z0-9_-]+$/u);
      assert.deepEqual(
        (yield* sql`SELECT epoch, head_seq, floor_seq, derived_through_sequence FROM agent_event_log_state`)[0],
        {
          epoch: "existing",
          head_seq: 7,
          floor_seq: 2,
          derived_through_sequence: 0,
        },
      );
    }).pipe(Effect.provide(database)),
  );
});
