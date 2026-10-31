import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as DeliveryStore from "./AgentEventStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";
import * as Internal from "./AgentInternalFacts.ts";
import * as Matcher from "./AgentFactMatcher.ts";
import * as Facts from "./AgentFactStore.ts";

const isFactStoreConflict = Schema.is(Facts.FactStoreConflict);
const database = layerDatabase;
const fact = (sequence: number, overrides: Partial<Facts.FactData> = {}): Facts.FactData => ({
  schema: "t3.agent-event/1",
  kind: "approval",
  factKey: "request-a:pending",
  summary: "Approval needed",
  textIsUntrusted: true,
  environment: { id: "environment-a", label: "Machine A" },
  thread: { id: "thread%3Aone", delegated: false },
  run: { id: "run-a" },
  owner: { state: "assigned", id: "dan", label: "Dan" },
  origin: {
    environmentId: "environment-a",
    sourceGeneration: "source-a",
    sourceKind: "orchestration",
    sourceSequence: sequence,
    transitionOrdinal: 0,
    threadSequence: sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
  },
  relay: null,
  detail: { requestId: "request-a" },
  ...overrides,
});
const subscribe = Effect.fn("fixture.subscribe")(function* (
  id: string,
  args: unknown = {},
  eventName = "t3.task_activity",
  expiresAt = 10_000,
) {
  const log = yield* DeliveryStore.logState();
  yield* DeliveryStore.upsertSubscription(
    {
      subscriptionId: id,
      principalId: "principal-a",
      sessionId: "session-a",
      attributionSubject: "client-a",
      clientLabel: "Client A",
      eventName,
      argumentsJson: JSON.stringify(args),
      callbackUrl: "https://callback.test",
      secretRef: "fixture",
      previousSecretRef: null,
      previousSecretUntil: null,
      state: "active",
      expiresAt,
      logEpoch: log.epoch,
      updatedAt: 0,
    },
    log.headSeq,
  );
});

describe("AgentFactStore", () => {
  it.effect(
    "keeps private facts lossless above the catalog limit, advancing watermarks without deliveries",
    () =>
      Effect.gen(function* () {
        yield* subscribe("all");
        const data = CompatibilityFacts.observationData("environment-a", "thread-a", {
          eventId: "native-event" as never,
          sequence: 1,
          kind: "run_state",
          status: "running",
          runId: null,
          requestId: null,
        });
        const privateData = {
          ...data,
          kind: "gateway_work_snapshot" as const,
          payload: { inputs: { complete: "x".repeat(20_000) }, page: "snapshot" },
        };
        const first = yield* Facts.appendFact({ data: privateData, recordedAt: 1 });
        assert.deepEqual(yield* DeliveryStore.listDeliveries("all", 100), []);
        const subscriber = (yield* DeliveryStore.findSubscription("all"))!;
        assert.equal(subscriber.watermarkSeq, first.logSeq);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql<{
            sequence: number;
          }>`SELECT matched_through_sequence AS sequence FROM agent_event_subscriptions WHERE subscription_id='all'`)[0]!
            .sequence,
          first.logSeq,
        );
        assert.isUndefined(yield* DeliveryStore.loadEvent(first.logSeq));
        assert.deepEqual(
          (yield* Internal.decodeJson((yield* Facts.readFacts(0, 100, true))[0]!.dataJson)).payload,
          { inputs: { complete: "x".repeat(20_000) }, page: "snapshot" },
        );
        const tooLarge = yield* Effect.flip(
          Facts.appendFact({
            data: {
              ...privateData,
              factKey: "too-large",
              payload: { inputs: "x".repeat(Internal.maxDataBytes), page: "snapshot" },
            },
            recordedAt: 2,
          }),
        );
        assert.equal(isFactStoreConflict(tooLarge) ? tooLarge.reason : null, "payload_too_large");
        assert.equal((yield* DeliveryStore.logState()).headSeq, first.logSeq);
        yield* Facts.appendFact({
          data: fact(2, {
            kind: "source_status",
            thread: null,
            detail: { environmentId: "environment-b" },
          }),
          recordedAt: 2,
        });
        const warning = (yield* DeliveryStore.loadEvent(first.logSeq + 1))!;
        assert.equal(warning.originEnvironmentId, "environment-a");
        assert.equal(
          (yield* Facts.decodeFactDataJson(warning.dataJson)).detail.environmentId,
          "environment-b",
        );
      }).pipe(Effect.provide(database)),
  );
  it("matches attention for every owner and suppresses only delegated run results by default", () => {
    for (const owner of [{ id: "dan" }, { id: "gavin" }, { state: "unassigned", id: null }]) {
      for (const kind of ["approval", "question", "secret", "blocked"] as const)
        assert.isTrue(
          Matcher.matches(
            "t3.task_activity",
            {},
            fact(1, {
              kind,
              owner,
              thread: { id: "thread%3Aone", delegated: true },
            }),
          ),
        );
    }
    const result = fact(1, {
      kind: "run_finished",
      thread: { id: "thread%3Aone", delegated: true },
    });
    assert.isFalse(Matcher.matches("t3.task_activity", {}, result));
    assert.isTrue(Matcher.matches("t3.run_finished", { includeDelegatedResults: true }, result));
    assert.isFalse(Matcher.matches("t3.approval_needed", {}, result));
    assert.isTrue(Matcher.matches("t3.question_asked", {}, fact(1, { kind: "secret" })));
  });

  it("keeps environment-qualified ids exact and sends source warnings through thread filters", () => {
    const data = fact(1);
    assert.isTrue(Matcher.matches("t3.task_activity", { threadIds: ["thread%3Aone"] }, data));
    assert.isTrue(
      Matcher.matches(
        "t3.task_activity",
        {
          threadIds: ["<t3-thread://v2/environment-a/thread%3Aone>"],
        },
        data,
      ),
    );
    assert.isFalse(
      Matcher.matches(
        "t3.task_activity",
        {
          threadIds: ["t3-thread://v2/environment-b/thread%3Aone"],
        },
        data,
      ),
    );
    assert.isFalse(Matcher.matches("t3.task_activity", { threadIds: ["thread:one"] }, data));
    assert.isTrue(
      Matcher.matches(
        "t3.task_activity",
        { threadIds: ["some-thread"] },
        fact(1, { kind: "source_status", thread: null }),
      ),
    );
    const peerStatus = fact(1, {
      kind: "source_status",
      thread: null,
      detail: { environmentId: "environment-b" },
    });
    assert.isTrue(
      Matcher.matches("t3.task_activity", { environmentIds: ["environment-b"] }, peerStatus),
    );
    assert.isFalse(
      Matcher.matches("t3.task_activity", { environmentIds: ["environment-a"] }, peerStatus),
    );
    const imported = {
      ...peerStatus,
      relay: { viaEnvironmentId: "environment-c", relayedAt: "2026-01-01T00:00:01.000Z" },
    };
    assert.isFalse(
      Matcher.matches("t3.task_activity", { environmentIds: ["environment-b"] }, imported),
    );
    assert.isTrue(
      Matcher.matches("t3.task_activity", { environmentIds: ["environment-a"] }, imported),
    );
    assert.isFalse(
      Matcher.matches(
        "t3.task_activity",
        {
          threadIds: ["some-thread"],
          environmentIds: ["environment-b"],
        },
        fact(1, { kind: "source_status", thread: null }),
      ),
    );
  });

  it.effect(
    "shares the probe allocator and preserves occurrence identity on duplicate imports",
    () =>
      Effect.gen(function* () {
        yield* subscribe("all");
        const input = { data: fact(20), recordedAt: 1_000 };
        const first = yield* Facts.appendFact(input);
        assert.deepEqual(yield* Facts.appendFact({ ...input, recordedAt: 2_000 }), {
          ...first,
          created: false,
        });
        assert.strictEqual(
          (yield* DeliveryStore.appendProbe({
            eventId: "probe-a",
            subscriptionId: "all",
            occurredAt: 1_000,
            dataJson: "{}",
            now: 1_000,
          })).logSeq,
          2,
        );
        const repeated = yield* Facts.appendFact({ ...input, data: fact(21) });
        assert.strictEqual(repeated.logSeq, 3);
        assert.notStrictEqual(repeated.eventId, first.eventId);
        assert.deepEqual(
          (yield* Facts.readFacts(0)).map((row) => row.logSeq),
          [1, 3],
        );
        assert.strictEqual((yield* Facts.readFacts(0))[0]!.recordedAt, 1_000);
        assert.strictEqual((yield* DeliveryStore.findSubscription("all"))!.watermarkSeq, 0);
        assert.strictEqual((yield* DeliveryStore.listDeliveries("all", 10)).length, 3);
        assert.strictEqual(
          Facts.factEventId(input.data.origin, input.data.factKey),
          Facts.factEventId(
            { ...input.data.origin, occurredAt: "later" } as Facts.FactOrigin,
            input.data.factKey,
          ),
        );
        const conflict = yield* Effect.flip(
          Facts.appendFact({ ...input, data: { ...input.data, summary: "A different payload" } }),
        );
        assert.instanceOf(conflict, Facts.FactStoreConflict);
        assert.strictEqual(conflict.reason, "identity_changed");
        assert.strictEqual((yield* DeliveryStore.logState()).headSeq, 3);
      }).pipe(Effect.provide(database)),
  );

  it.effect("matches active subscriptions atomically without owner-based exclusion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* subscribe("all");
      yield* subscribe("questions", {}, "t3.question_asked");
      yield* subscribe("other-env", { environmentIds: ["environment-b"] });
      yield* subscribe("expired", {}, "t3.task_activity", 1_000);
      for (const [index, owner] of [
        { id: "dan" },
        { id: "gavin" },
        { state: "unassigned", id: null },
      ].entries())
        yield* Facts.appendFact({ data: fact(index + 1, { owner }), recordedAt: 1_000 });
      assert.strictEqual((yield* DeliveryStore.listDeliveries("all", 10)).length, 3);
      for (const id of ["questions", "other-env", "expired"])
        assert.strictEqual((yield* DeliveryStore.listDeliveries(id, 10)).length, 0);
      const progress = yield* sql<{ readonly id: string; readonly sequence: number }>`
        SELECT subscription_id AS id, matched_through_sequence AS sequence FROM agent_event_subscriptions`;
      assert.deepEqual(Object.fromEntries(progress.map((row) => [row.id, row.sequence])), {
        all: 3,
        questions: 3,
        "other-env": 3,
        expired: 0,
      });
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "rolls back facts, deliveries, checkpoint deletion and head when a checkpoint write fails",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* subscribe("all");
        yield* sql`INSERT INTO agent_event_derivation_state (state_key, source_sequence, state_json)
          VALUES ('obsolete', 0, '{}')`;
        yield* sql`CREATE TRIGGER refuse_checkpoint BEFORE INSERT ON agent_event_derivation_state
          BEGIN SELECT RAISE(ABORT, 'fixture_checkpoint_failure'); END`;
        const input = {
          expectedThrough: 0,
          throughSequence: 40,
          deleteStateKeys: ["obsolete"],
          states: [{ key: "thread-a", sourceSequence: 40, json: '{"revision":40}' }],
          facts: [{ data: fact(40), recordedAt: 1_000 }],
        };
        assert.isTrue((yield* Effect.exit(Facts.commitSource(input)))._tag === "Failure");
        assert.strictEqual((yield* DeliveryStore.logState()).headSeq, 0);
        assert.strictEqual(yield* Facts.progress(), 0);
        assert.isUndefined(yield* Facts.readState("thread-a"));
        assert.deepEqual(yield* Facts.readState("obsolete"), { sourceSequence: 0, json: "{}" });
        assert.deepEqual(yield* Facts.readFacts(0), []);
        assert.deepEqual(yield* DeliveryStore.listDeliveries("all", 10), []);
        yield* sql`DROP TRIGGER refuse_checkpoint`;
        yield* Facts.commitSource(input);
        assert.strictEqual(yield* Facts.progress(), 40);
        assert.isUndefined(yield* Facts.readState("obsolete"));
        assert.deepEqual(yield* Facts.readState("thread-a"), {
          sourceSequence: 40,
          json: '{"revision":40}',
        });
        const stale = yield* Effect.flip(
          Facts.commitSource({
            ...input,
            throughSequence: 41,
            facts: [{ data: fact(41), recordedAt: 2_000 }],
          }),
        );
        assert.instanceOf(stale, Facts.FactStoreConflict);
        assert.strictEqual(stale.reason, "progress_changed");
        assert.strictEqual((yield* DeliveryStore.logState()).headSeq, 1);
        assert.strictEqual((yield* DeliveryStore.listDeliveries("all", 10)).length, 1);
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    "refuses malformed stored subscription filters without moving past missing deliveries",
    () =>
      Effect.gen(function* () {
        yield* subscribe("malformed", { owner: "dan" });
        assert.isTrue(
          (yield* Effect.exit(Facts.appendFact({ data: fact(1), recordedAt: 1_000 })))._tag ===
            "Failure",
        );
        assert.strictEqual((yield* DeliveryStore.logState()).headSeq, 0);
        assert.deepEqual(yield* Facts.readFacts(0), []);
      }).pipe(Effect.provide(database)),
  );
});
