import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ThreadId,
  LanTaskObservation,
  type LanTaskObserveResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as Gateway from "../lan/GatewayCompatibility.ts";
import * as Facts from "./AgentGatewayCompatibilityFacts.ts";
import * as Retention from "./AgentFactRetention.ts";
import * as Store from "./AgentEventStore.ts";
import * as FactStore from "./AgentFactStore.ts";

const DAY = 86_400_000;
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(LanTaskObservation));
const environmentId = EnvironmentId.make("environment-a");
const page = (thread: string, sequence = 0): LanTaskObserveResult => ({
  threadId: ThreadId.make(thread),
  sourceId: EventId.make("source:" + thread),
  status: "ok",
  resetReason: null,
  events: [],
  nextCursor: { sourceId: EventId.make("source:" + thread), sequence },
  headSequence: sequence,
  hasMore: false,
  taskWorkState: "working",
  taskResultRunId: null,
  taskResultStatus: null,
});
const database = Gateway.layer.pipe(
  Layer.provideMerge(layerDatabase),
  Layer.provide(NodeCrypto.layer),
);

it.effect.each(["legacy", "shadow", "adapter"] as const)(
  "releases idle snapshot roots in %s while retaining current pending data",
  (mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const gateway = yield* Gateway.GatewayCompatibility;
      yield* sql`UPDATE agent_gateway_compatibility_state SET mode=${mode}`;
      yield* TestClock.setTime(0);
      const idle = {
        ...page("idle", 1),
        events: [
          {
            eventId: EventId.make("idle-event"),
            sequence: 1,
            kind: "run_state" as const,
            status: "running" as const,
            runId: null,
            requestId: null,
          },
        ],
      };
      const target = { principal: "principal", environmentId, threadId: idle.threadId };
      yield* Facts.captureWorkSnapshot(environmentId, idle, { controlsJson: "idle controls" });
      yield* gateway.observe(target, idle, { expectedDeliverySourceId: null });
      if (mode !== "legacy")
        for (let index = 1; index <= 65; index++)
          yield* gateway.observe({ ...target, principal: "principal:" + index }, idle, {
            expectedDeliverySourceId: null,
          });
      for (let day = 1; day <= 30; day++) {
        yield* TestClock.setTime(day * DAY);
        yield* Facts.captureWorkSnapshot(environmentId, page("active", day), {
          controlsJson: "controls:" + day,
        });
      }
      // Deduping the original day-zero input must not give it a new retention lifetime.
      yield* gateway.observe(target, idle, { expectedDeliverySourceId: idle.sourceId });
      const current = page("pending", 31);
      const pending: LanTaskObserveResult = {
        ...current,
        events: [
          {
            eventId: EventId.make("pending-event"),
            sequence: 31,
            kind: "run_state" as const,
            status: "running",
            runId: null,
            requestId: null,
          },
        ],
      };
      const pendingTarget = { ...target, threadId: current.threadId };
      yield* gateway.observe(pendingTarget, pending, { expectedDeliverySourceId: null });
      yield* Retention.pruneLog(30 * DAY);
      const state = yield* Store.logState();
      const oldest = (yield* sql<{
        time: number;
      }>`SELECT MIN(recorded_at) AS time FROM agent_event_facts`)[0]!;
      assert.isAtLeast(oldest.time, 16 * DAY);
      assert.isAbove(state.floorSeq, 1);
      assert.deepEqual(yield* gateway.pending(pendingTarget), pending.events);
      assert.deepEqual(yield* gateway.pending(target), idle.events);
      if (mode !== "legacy") {
        const receipt = (yield* sql<{
          fact_id: string | null;
          event_json: string;
          acknowledged: number;
        }>`SELECT fact_id,event_json,acknowledged FROM agent_gateway_compatibility_inbox WHERE thread_id=${idle.threadId}`)[0]!;
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM agent_gateway_compatibility_inbox WHERE thread_id=${idle.threadId} AND fact_id IS NULL AND acknowledged=0 AND event_json=${receipt.event_json}`)[0]!
            .count,
          66,
        );
        assert.isNull(receipt.fact_id);
        assert.equal(receipt.acknowledged, 0);
        assert.equal(receipt.event_json, yield* encodeObservation(idle.events[0]!));
      }
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(database)),
);

it.effect("shares unchanged private work inputs across page variants", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inputs = { controlsJson: "x".repeat(1024 * 1024) };
    for (let index = 0; index < 20; index++) {
      yield* TestClock.setTime(index * 2 * DAY);
      yield* Facts.captureWorkSnapshot(environmentId, page("active", index), {
        ...inputs,
        headSequence: index,
        currentSequence: index,
      });
    }
    const bytes = (yield* sql<{
      bytes: number;
    }>`SELECT SUM(LENGTH(CAST(data_json AS BLOB))) AS bytes FROM agent_event_facts`)[0]!.bytes;
    assert.isBelow(bytes, 2 * 1024 * 1024);
    const occurrenceBytes = (yield* sql<{
      bytes: number;
    }>`SELECT SUM(LENGTH(CAST(bootstrap_json AS BLOB))) AS bytes FROM agent_event_occurrences`)[0]!
      .bytes;
    assert.isBelow(occurrenceBytes, 2 * 1024 * 1024);
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM agent_event_facts WHERE kind='gateway_work_inputs'`)[0]!
        .count,
      1,
    );
    const latest = (yield* sql<{
      id: string;
    }>`SELECT fact_id AS id FROM agent_gateway_compatibility_work_snapshots`)[0]!.id;
    assert.deepEqual((yield* Facts.readWorkSnapshot(latest)).inputs, {
      ...inputs,
      headSequence: 19,
      currentSequence: 19,
    });
    const inputReceipt = (yield* sql<{
      id: string;
      json: string;
    }>`SELECT event_id AS id,bootstrap_json AS json FROM agent_event_occurrences WHERE source_generation LIKE 'work-input:%'`)[0]!;
    yield* sql`UPDATE agent_event_occurrences SET bootstrap_json='{opaque corrupt input' WHERE event_id=${inputReceipt.id}`;
    yield* Retention.pruneLog(38 * DAY);
    assert.equal((yield* Effect.exit(Facts.readWorkSnapshot(latest)))._tag, "Failure");
    const retained = yield* sql`SELECT event_id,data_json FROM agent_event_facts ORDER BY log_seq`;
    assert.equal((yield* Effect.exit(FactStore.restoreInternalFacts()))._tag, "Failure");
    assert.deepEqual(
      yield* sql`SELECT event_id,data_json FROM agent_event_facts ORDER BY log_seq`,
      retained,
    );
    yield* sql`UPDATE agent_event_occurrences SET bootstrap_json=${inputReceipt.json} WHERE event_id=${inputReceipt.id}`;

    assert.isAbove((yield* Store.logState()).floorSeq, 1);
    assert.deepEqual((yield* Facts.readWorkSnapshot(latest)).inputs, {
      ...inputs,
      headSequence: 19,
      currentSequence: 19,
    });
    yield* FactStore.restoreInternalFacts();
    assert.deepEqual((yield* Facts.readWorkSnapshot(latest)).inputs, {
      ...inputs,
      headSequence: 19,
      currentSequence: 19,
    });
    // Reusing a pruned dependency receipt must not allocate a replacement log slot for its ID.
    yield* TestClock.setTime(40 * DAY);
    const head = (yield* Store.logState()).headSeq;
    yield* Facts.captureWorkSnapshot(environmentId, page("active", 20), {
      ...inputs,
      headSequence: 20,
      currentSequence: 20,
    });
    assert.equal((yield* Store.logState()).headSeq, head + 2);
    yield* FactStore.restoreInternalFacts();
    const current = (yield* sql<{
      id: string;
    }>`SELECT fact_id AS id FROM agent_gateway_compatibility_work_snapshots`)[0]!.id;
    assert.deepEqual((yield* Facts.readWorkSnapshot(current)).inputs, {
      ...inputs,
      headSequence: 20,
      currentSequence: 20,
    });
    yield* Retention.pruneLog(100 * DAY);
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM agent_event_occurrences`)[0]!
        .count,
      0,
    );
    process.stdout.write(
      JSON.stringify({
        proof: "gateway_fact_log",
        scenario: "shared_private_work_inputs",
        pages: 20,
        largeInputs: 1,
        payloadBytes: bytes,
        occurrenceBytes,
      }) + "\n",
    );
  }).pipe(Effect.provide(database)),
);

it.effect.each(["shadow", "adapter"] as const)(
  "materializes retired %s generation receipts and isolates stale ACKs",
  (mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const gateway = yield* Gateway.GatewayCompatibility;
      yield* sql`UPDATE agent_gateway_compatibility_state SET mode=${mode}`;
      const initial = page("reset", 1);
      const observed: LanTaskObserveResult = {
        ...initial,
        events: [
          {
            eventId: EventId.make("issued"),
            sequence: 1,
            kind: "run_state",
            status: "running",
            runId: null,
            requestId: null,
          },
        ],
      };
      const target = { principal: "principal", environmentId, threadId: initial.threadId };
      yield* gateway.observe(target, observed, { expectedDeliverySourceId: null });
      const original = yield* encodeObservation(observed.events[0]!);
      const current = yield* gateway.observe(target, observed, {
        expectedDeliverySourceId: initial.sourceId,
        reset: true,
      });
      const retired = (yield* sql<{
        event_json: string;
        fact_id: string | null;
        acknowledged: number;
      }>`SELECT event_json,fact_id,acknowledged FROM agent_gateway_compatibility_inbox WHERE source_id=${initial.sourceId}`)[0]!;
      assert.deepEqual(retired, { event_json: original, fact_id: null, acknowledged: 0 });
      yield* gateway.acknowledge(target, ["issued"], initial.sourceId);
      assert.deepEqual(yield* gateway.pending(target), observed.events);
      yield* gateway.acknowledge(target, ["issued"], current.deliverySourceId);
      yield* Retention.pruneLog(30 * DAY);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM agent_event_facts`)[0]!.count,
        0,
      );
      assert.deepEqual(
        (yield* sql<{
          acknowledged: number;
        }>`SELECT acknowledged FROM agent_gateway_compatibility_inbox WHERE source_id=${initial.sourceId}`)[0]!
          .acknowledged,
        0,
      );
      assert.deepEqual(yield* gateway.pending(target), []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(database)),
);
