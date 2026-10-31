import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Access from "./AgentFactRelayAccess.ts";
import * as Admission from "./AgentFactRelayAdmission.ts";
import * as Store from "./AgentEventStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";

const input = {
  subscriptionId: "subscription",
  eventId: "event",
  originEnvironmentId: "peer",
  sessionId: "subscriber",
  attributionSubject: "mcp-client:outside",
  phase: "prepare" as const,
  proof: {
    checkedAt: "1970-01-01T00:00:00.000Z",
    authorizationGeneration: "requester-1",
    originAuthorizationGeneration: "origin-1",
  },
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Gate.ApprovalAdmissionGate;
  const generation = yield* Ref.make("requester-1");
  const { epoch } = yield* Store.logState();
  yield* Store.upsertSubscription(
    {
      subscriptionId: "subscription",
      principalId: "principal",
      sessionId: "subscriber",
      attributionSubject: "mcp-client:outside",
      clientLabel: "Outside",
      eventName: "t3.task_activity",
      argumentsJson: "{}",
      callbackUrl: "https://callback.test",
      secretRef: "isolated",
      previousSecretRef: null,
      previousSecretUntil: null,
      state: "active",
      expiresAt: 100_000,
      logEpoch: epoch,
      updatedAt: 0,
    },
    0,
  );
  yield* sql`INSERT INTO agent_event_facts(log_seq, event_id, fact_key, kind, origin_environment_id, origin_generation, source_kind, source_sequence, transition_ordinal, occurred_at, recorded_at, relayed_from, data_json) VALUES (1, 'event', 'key', 'approval', 'peer', 'source', 'orchestration', 1, 0, 0, 0, 'peer', '{}')`;
  yield* sql`INSERT INTO agent_event_deliveries(subscription_id, event_id, log_seq, state, queued_at, next_attempt_at) VALUES ('subscription', 'event', 1, 'sending', 0, 0)`;
  yield* sql`INSERT INTO agent_event_peer_cursors(environment_id, peer_epoch, peer_seq, status, status_transition, authorization_generation, updated_at) VALUES ('peer', 'epoch', 1, 'following', 1, 'origin-1', 0)`;
  const access = Layer.mock(Access.AgentFactRelayAccess)({
    withGate: gate.withGate,
    requester: () =>
      Ref.get(generation).pipe(
        Effect.map((generation) => ({
          verdict: "allowed",
          authorization: {
            peerEnvironmentId: "peer",
            generation,
            limits: { runtimeMode: "approval-required", interactionMode: "plan" },
          },
        })),
      ),
  });
  const context = yield* Admission.layer.pipe(Layer.provide(access), Layer.build);
  return { sql, generation, admission: Context.get(context, Admission.AgentFactRelayAdmission) };
});
const dependencies = Layer.mergeAll(layerDatabase, Gate.layer);

it.effect(
  "persists both admission phases with local time and exact origin/requester generations, cascading on deletion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* TestClock.setTime(5_000);
      assert.isTrue(yield* f.admission.record(input));
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* f.admission.record({ ...input, phase: "dispatch" }));
      assert.deepEqual(
        yield* f.sql`SELECT phase, checked_at, origin_checked_at, requester_generation, origin_authorization_generation FROM agent_event_fact_authority_checks ORDER BY check_id`,
        [
          {
            phase: "prepare",
            checked_at: 5_000,
            origin_checked_at: input.proof.checkedAt,
            requester_generation: "requester-1",
            origin_authorization_generation: "origin-1",
          },
          {
            phase: "dispatch",
            checked_at: 6_000,
            origin_checked_at: input.proof.checkedAt,
            requester_generation: "requester-1",
            origin_authorization_generation: "origin-1",
          },
        ],
      );
      yield* f.sql`DELETE FROM agent_event_deliveries`;
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_event_fact_authority_checks`, []);
      assert.isFalse(yield* f.admission.record(input));
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "rejects requester, source, subscription expiry and attribution changes after a network proof",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.set(f.generation, "requester-2");
      assert.isFalse(yield* f.admission.record(input));
      yield* Ref.set(f.generation, "requester-1");
      yield* f.sql`UPDATE agent_event_peer_cursors SET authorization_generation = 'origin-2'`;
      assert.isFalse(yield* f.admission.record(input));
      yield* f.sql`UPDATE agent_event_peer_cursors SET authorization_generation = 'origin-1'`;
      yield* f.sql`UPDATE agent_event_subscriptions SET attribution_subject = 'mcp-client:replacement'`;
      assert.isFalse(yield* f.admission.record(input));
      yield* f.sql`UPDATE agent_event_subscriptions SET attribution_subject = 'mcp-client:outside'`;
      yield* TestClock.setTime(100_000);
      assert.isFalse(yield* f.admission.record(input));
      yield* TestClock.setTime(0);
      yield* f.sql`DELETE FROM agent_event_facts`;
      assert.isFalse(yield* f.admission.record(input));
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_event_fact_authority_checks`, []);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
