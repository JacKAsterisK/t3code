import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as Store from "./AgentEventStore.ts";
import * as Facts from "./AgentFactStore.ts";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";
import * as Replay from "./AgentFactReplay.ts";

const isReplayGap = Schema.is(Replay.FactReplayGap);
const database = layerDatabase;
const fact = (
  sequence: number,
  owner: string | null,
  overrides: Partial<Facts.FactData> = {},
): Facts.FactData => ({
  schema: "t3.agent-event/1",
  kind: "approval",
  factKey: `request-${sequence}`,
  summary: "Approval needed",
  textIsUntrusted: true,
  environment: { id: "environment-a", label: "Machine A" },
  thread: { id: "thread-a", delegated: true },
  run: null,
  owner: { id: owner },
  origin: {
    environmentId: "environment-a",
    sourceGeneration: "generation-a",
    sourceKind: "orchestration",
    sourceSequence: sequence,
    transitionOrdinal: 0,
    threadSequence: sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
  },
  relay: null,
  detail: {},
  ...overrides,
});
const subscribe = Effect.fn("fixture.subscribeReplay")(function* (id: string, args: unknown = {}) {
  const log = yield* Store.logState();
  yield* Store.upsertSubscription(
    {
      subscriptionId: id,
      principalId: `session:${id}`,
      sessionId: id,
      attributionSubject: "mcp-client:local",
      clientLabel: "Client",
      eventName: "t3.task_activity",
      argumentsJson: JSON.stringify(args),
      callbackUrl: "https://callback.test",
      secretRef: "fixture",
      previousSecretRef: null,
      previousSecretUntil: null,
      state: "active",
      expiresAt: 10_000,
      logEpoch: log.epoch,
      updatedAt: 0,
    },
    log.headSeq,
  );
});

describe("AgentFactReplay", () => {
  it.effect("scans mixed private/catalog/probe slots and detects a missing private payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Facts.appendFact({ data: fact(1, "dan"), recordedAt: 1_000 });
      const privateFact = yield* Facts.appendFact({
        data: {
          ...CompatibilityFacts.observationData("environment-a", "thread-a", {
            eventId: "native-private" as never,
            sequence: 2,
            kind: "run_state",
            status: "running",
            runId: null,
            requestId: null,
          }),
          kind: "gateway_work_snapshot",
          payload: { inputs: { largePrivateSnapshot: "x".repeat(20_000) }, page: "snapshot" },
        },
        recordedAt: 1_000,
      });
      yield* subscribe("operator");
      yield* Store.appendProbe({
        eventId: "private-probe",
        subscriptionId: "operator",
        occurredAt: 1_000,
        dataJson: "{}",
        now: 1_000,
      });
      yield* Facts.appendFact({ data: fact(4, "gavin"), recordedAt: 1_000 });
      yield* subscribe("client");
      const input = { subscriptionId: "client", afterSeq: 0, includeDelivered: true, now: 1_000 };
      assert.equal(yield* Replay.requeueFacts(input), 2);
      assert.deepEqual(
        (yield* Store.listDeliveries("client", 10)).map((row) => row.logSeq).sort((a, b) => a - b),
        [1, 4],
      );
      yield* sql`UPDATE agent_event_deliveries SET state='delivered'`;
      assert.equal(yield* Store.recomputeWatermark("client", 1_000), 4);
      yield* sql`DELETE FROM agent_event_facts WHERE event_id=${privateFact.eventId}`;
      const error = yield* Replay.requeueFacts(input).pipe(Effect.flip);
      assert.equal(isReplayGap(error) ? error.expectedSequence : null, 2);
      assert.equal((yield* Store.findSubscription("client"))!.watermarkSeq, 4);
    }).pipe(Effect.provide(database)),
  );
  it.effect("rolls back matching rather than advancing across a missing retained payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Facts.appendFact({ data: fact(1, "dan"), recordedAt: 1_000 });
      yield* Facts.appendFact({ data: fact(2, "gavin"), recordedAt: 1_000 });
      yield* subscribe("client");
      yield* sql`DELETE FROM agent_event_facts WHERE log_seq = 2`;
      const failure = yield* Effect.flip(
        Replay.requeueFacts({
          subscriptionId: "client",
          afterSeq: 0,
          includeDelivered: true,
          now: 1000,
        }),
      );
      assert.instanceOf(failure, Replay.FactReplayGap);
      assert.strictEqual(failure.expectedSequence, 2);
      assert.strictEqual((yield* Store.findSubscription("client"))!.watermarkSeq, 2);
      assert.deepEqual(yield* Store.listDeliveries("client", 10), []);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "replays all-owner attention for a new callback and recomputes low-cursor progress",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [index, owner] of ["dan", "gavin", null].entries())
          yield* Facts.appendFact({ data: fact(index + 1, owner), recordedAt: 1_000 });
        yield* Facts.appendFact({
          data: fact(4, null, { kind: "run_finished" }),
          recordedAt: 1_000,
        });
        yield* subscribe("operator");
        yield* Store.appendProbe({
          eventId: "operator-probe",
          subscriptionId: "operator",
          occurredAt: 1000,
          dataJson: "{}",
          now: 1000,
        });
        yield* subscribe("client");
        const replay = {
          subscriptionId: "client",
          afterSeq: 0,
          includeDelivered: false,
          now: 1_000,
        };
        assert.strictEqual(yield* Replay.requeueFacts(replay), 3);
        assert.strictEqual((yield* Store.findSubscription("client"))!.watermarkSeq, 0);
        yield* sql`UPDATE agent_event_deliveries SET state = 'delivered', finished_at = 1000`;
        yield* Store.recomputeWatermark("client", 1_000);
        assert.strictEqual((yield* Store.findSubscription("client"))!.watermarkSeq, 5);
        assert.strictEqual(yield* Replay.requeueFacts(replay), 0);
        assert.strictEqual(yield* Replay.requeueFacts({ ...replay, includeDelivered: true }), 3);
        assert.strictEqual((yield* Store.findSubscription("client"))!.watermarkSeq, 0);
        yield* subscribe("with-results", { includeDelegatedResults: true });
        assert.strictEqual(
          yield* Replay.requeueFacts({ ...replay, subscriptionId: "with-results" }),
          4,
        );
      }).pipe(Effect.provide(database)),
  );

  it.effect("preserves in-flight state and refuses malformed retained facts atomically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Facts.appendFact({ data: fact(1, "dan"), recordedAt: 1_000 });
      yield* Facts.appendFact({ data: fact(2, "gavin"), recordedAt: 1_000 });
      yield* subscribe("client");
      const replay = { subscriptionId: "client", afterSeq: 0, includeDelivered: true, now: 1_000 };
      yield* sql`UPDATE agent_event_facts SET data_json = '{}' WHERE log_seq = 2`;
      assert.isTrue((yield* Effect.exit(Replay.requeueFacts(replay)))._tag === "Failure");
      assert.deepEqual(yield* Store.listDeliveries("client", 10), []);
      assert.strictEqual((yield* Store.findSubscription("client"))!.watermarkSeq, 2);
      yield* sql`UPDATE agent_event_facts SET data_json = ${JSON.stringify(fact(2, "gavin"))} WHERE log_seq = 2`;
      assert.strictEqual(yield* Replay.requeueFacts(replay), 2);
      yield* sql`UPDATE agent_event_deliveries SET state = 'sending', attempts = 3`;
      assert.strictEqual(yield* Replay.requeueFacts(replay), 0);
      const delivery = (yield* Store.listDeliveries("client", 10))[0]!;
      assert.strictEqual(delivery.state, "sending");
      assert.strictEqual(delivery.attempts, 3);
    }).pipe(Effect.provide(database)),
  );
});
