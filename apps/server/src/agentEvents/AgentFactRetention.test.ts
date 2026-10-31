import { assert, describe, it } from "@effect/vitest";
import { AGENT_EVENT_LIMITS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as Store from "./AgentEventStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { EnvironmentId, EventId, ThreadId, type LanTaskObserveResult } from "@t3tools/contracts";
import * as Compatibility from "../lan/GatewayCompatibility.ts";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";
import * as Retention from "./AgentFactRetention.ts";

const database = layerDatabase;
const DAY = 24 * 60 * 60_000;
const seed = Effect.fn("fixture.seedRetention")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* Store.logState();
  yield* Store.upsertSubscription(
    {
      subscriptionId: "client",
      principalId: "session:a",
      sessionId: "a",
      attributionSubject: "mcp-client:local",
      clientLabel: "Client",
      eventName: "t3.task_activity",
      argumentsJson: "{}",
      callbackUrl: "https://callback.test",
      secretRef: "fixture",
      previousSecretRef: null,
      previousSecretUntil: null,
      state: "active",
      expiresAt: 50 * DAY,
      logEpoch: state.epoch,
      updatedAt: 0,
    },
    0,
  );
  yield* sql`UPDATE agent_event_log_state SET head_seq = 4 WHERE id = 1`;
  yield* sql`INSERT INTO agent_event_probes (log_seq, event_id, subscription_id, occurred_at, data_json, created_at)
    VALUES (1, 'probe-a', 'client', 0, '{}', 0), (3, 'probe-b', 'client', ${20 * DAY}, '{}', ${20 * DAY})`;
  yield* sql`INSERT INTO agent_event_facts (log_seq, event_id, fact_key, kind, origin_environment_id, origin_generation,
    source_kind, source_sequence, transition_ordinal, occurred_at, recorded_at, data_json)
    VALUES (2, 'fact-a', 'a', 'approval', 'local', 'generation', 'orchestration', 1, 0, 0, 0, '{}'),
      (4, 'fact-b', 'b', 'approval', 'local', 'generation', 'orchestration', 2, 0, 0, 0, '{}')`;
});

describe("AgentFactRetention", () => {
  it.effect(
    "materializes aged unacknowledged generations and snapshots without losing receipts",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const sql = yield* SqlClient.SqlClient;
        const compatibility = yield* Compatibility.GatewayCompatibility.pipe(
          Effect.provide(Compatibility.layer.pipe(Layer.provide(NodeCrypto.layer))),
        );
        const target = {
          principal: "grant:client",
          environmentId: EnvironmentId.make("environment-a"),
          threadId: ThreadId.make("thread-a"),
        };
        const sourceId = EventId.make("native:create");
        const page: LanTaskObserveResult = {
          threadId: target.threadId,
          sourceId,
          status: "ok",
          resetReason: null,
          events: [
            {
              eventId: EventId.make("native:running"),
              sequence: 2,
              kind: "run_state",
              status: "running",
              runId: null,
              requestId: null,
            },
          ],
          nextCursor: { sourceId, sequence: 2, anchorEventId: EventId.make("native:running") },
          headSequence: 2,
          hasMore: false,
          taskWorkState: "working",
          taskResultRunId: null,
          taskResultStatus: null,
        };
        yield* compatibility.startShadow({ mode: "legacy", generation: 0 });
        yield* compatibility.observe(target, page, { expectedDeliverySourceId: null });
        const pin = yield* CompatibilityFacts.firstPinnedSequence();
        assert.equal(pin, 1);
        yield* Retention.pruneLog(20 * DAY);
        assert.isAbove((yield* Store.logState()).floorSeq, 1);
        assert.equal((yield* Retention.status()).pinnedRows, 0);
        yield* compatibility.acknowledge(
          target,
          [page.events[0]!.eventId],
          EventId.make("obsolete"),
        );
        assert.equal((yield* compatibility.pending(target)).length, 1);
        yield* compatibility.acknowledge(target, [page.events[0]!.eventId], sourceId);
        const receipt = (yield* sql<{
          event_json: string;
          fact_id: string | null;
          acknowledged: number;
        }>`SELECT event_json, fact_id, acknowledged FROM agent_gateway_compatibility_inbox`)[0]!;
        assert.equal(receipt.acknowledged, 1);
        assert.isNull(receipt.fact_id);
        assert.isString(receipt.event_json);
        yield* compatibility.observe(
          target,
          { ...page, events: [] },
          { expectedDeliverySourceId: sourceId },
        );
        yield* Retention.pruneLog(20 * DAY);
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM agent_event_facts WHERE kind='gateway_observation'`)[0]!
            .count,
          0,
        );
        assert.deepEqual(
          (yield* sql`SELECT event_json, fact_id, acknowledged FROM agent_gateway_compatibility_inbox`)[0],
          receipt,
        );
        assert.deepEqual(yield* compatibility.pending(target), []);
        const snapshot = (yield* sql<{
          receipt: string;
          id: string | null;
        }>`SELECT receipt_json AS receipt, fact_id AS id FROM agent_gateway_compatibility_snapshots`)[0]!;
        assert.isNull(snapshot.id);
        assert.deepEqual(JSON.parse(snapshot.receipt), { ...page, events: [] });
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        process.stdout.write(
          JSON.stringify({
            proof: "gateway_fact_log",
            scenario: "pending_ack_retention",
            unacknowledgedReceiptRetained: true,
            staleAckIgnored: true,
            ackReceiptRetained: true,
            prunedAfterAck: true,
          }) + "\n",
        );
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "pins the contiguous mixed-log suffix and advances the floor only after the oldest payload is handled",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seed();
        yield* sql`UPDATE agent_event_facts SET source_kind='gateway', data_json='private bytes are not directory JSON' WHERE log_seq=4`;
        yield* sql`INSERT INTO agent_event_directories (generation,status,directory_json) VALUES ('unreferenced','missing','{}')`;
        yield* sql`INSERT INTO agent_event_occurrences (event_id,log_seq,origin_environment_id,source_generation,source_kind,source_sequence,data_digest,recorded_at,bootstrap_json)
          VALUES ('fact-b',4,'local','generation','gateway',2,'sentinel',0,'private occurrence is not directory JSON')`;
        yield* sql`INSERT INTO agent_event_deliveries (subscription_id, event_id, log_seq, state, queued_at, next_attempt_at)
        VALUES ('client', 'probe-a', 1, 'pending', ${20 * DAY}, ${20 * DAY})`;
        assert.deepEqual(yield* Retention.pruneLog(20 * DAY), {
          abandonedSubscriptions: [],
          floorSeq: 1,
        });
        assert.strictEqual(
          (yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM agent_event_facts`)[0]!.count,
          2,
        );
        const pinned = yield* Retention.status();
        assert.strictEqual(pinned.pinnedRows, 4);
        assert.isAbove(pinned.pinnedBytes, 0);
        assert.strictEqual(pinned.pinnedBytes, pinned.bytes);
        assert.strictEqual(pinned.softCapOverrunRows, 0);
        yield* sql`UPDATE agent_event_deliveries SET state = 'delivered', finished_at = ${20 * DAY}`;
        assert.deepEqual(yield* Retention.pruneLog(20 * DAY), {
          abandonedSubscriptions: [],
          floorSeq: 3,
        });
        assert.deepEqual(
          (yield* sql<{ readonly seq: number }>`SELECT log_seq AS seq FROM agent_event_probes
        UNION ALL SELECT log_seq FROM agent_event_facts ORDER BY seq`).map((row) => row.seq),
          [3, 4],
        );
        // An old timestamp after a fresh event cannot punch a hole in the retained suffix.
        assert.strictEqual((yield* Store.logState()).floorSeq, 3);
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    "counts expired time toward abandonment so an expired subscriber cannot pin data forever",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seed();
        yield* sql`UPDATE agent_event_subscriptions SET state = 'expired', expires_at = ${18 * DAY}`;
        yield* sql`INSERT INTO agent_event_deliveries (subscription_id, event_id, log_seq, state, queued_at, next_attempt_at)
        VALUES ('client', 'probe-a', 1, 'pending', ${20 * DAY - AGENT_EVENT_LIMITS.abandonAfterMs}, ${20 * DAY})`;
        assert.deepEqual(yield* Retention.pruneLog(20 * DAY), {
          abandonedSubscriptions: ["client"],
          floorSeq: 3,
        });
        const delivery = yield* Store.findDelivery("client", "probe-a");
        assert.strictEqual(delivery!.state, "abandoned");
        assert.strictEqual(delivery!.finishedAt, 20 * DAY);
        assert.strictEqual(delivery!.lastError, "delivery_retention_expired");
        assert.strictEqual(yield* Store.recomputeWatermark("client", 20 * DAY), 4);
      }).pipe(Effect.provide(database)),
  );

  it.effect("keeps at most the last 50,000 allocated sequences when no payload pins the log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Store.logState();
      yield* sql`UPDATE agent_event_log_state SET head_seq = 50002 WHERE id = 1`;
      yield* sql`WITH RECURSIVE sequences(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequences WHERE n < 50002)
        INSERT INTO agent_event_facts (log_seq, event_id, fact_key, kind, origin_environment_id, origin_generation,
          source_kind, source_sequence, transition_ordinal, occurred_at, recorded_at, data_json)
        SELECT n, 'event-' || n, 'key-' || n, 'approval', 'local', 'generation', 'orchestration', n, 0, 0, 0, '{}'
        FROM sequences`;
      assert.deepEqual(yield* Retention.pruneLog(1_000), {
        abandonedSubscriptions: [],
        floorSeq: 3,
      });
      assert.strictEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM agent_event_facts`)[0]!.count,
        50_000,
      );
    }).pipe(Effect.provide(database)),
  );
});
