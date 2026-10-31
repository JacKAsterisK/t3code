import { assert, it } from "@effect/vitest";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Fleet from "../lan/FleetAccessPolicy.ts";
import * as Settings from "../serverSettings.ts";
import * as Delivery from "./AgentEventDelivery.ts";
import * as Relay from "./AgentFactRelay.ts";
import * as Access from "./AgentFactRelayAccess.ts";
import * as Runtime from "./AgentFactRelayRuntime.ts";
import * as Signals from "./AgentFactRelaySignals.ts";
import * as Facts from "./AgentFactStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";

const data: Facts.FactData = {
  schema: "t3.agent-event/1",
  kind: "approval",
  factKey: "pending",
  summary: "Approval needed",
  textIsUntrusted: true,
  environment: { id: "peer", label: "Peer" },
  thread: { id: "thread", delegated: false },
  run: { id: "run" },
  owner: null,
  origin: {
    environmentId: "peer",
    sourceGeneration: "source",
    sourceKind: "orchestration",
    sourceSequence: 1,
    transitionOrdinal: 0,
    threadSequence: 1,
    occurredAt: "1970-01-01T00:00:00.000Z",
  },
  relay: null,
  detail: { requestId: "request" },
};
const page = {
  epoch: "peer-epoch",
  facts: [
    {
      seq: 1,
      eventId: Facts.factEventId(data.origin, data.factKey),
      dataJson: stableStringify(data),
    },
  ],
  next: { epoch: "peer-epoch", seq: 1 },
  floorSeq: 1,
  headSeq: 1,
  truncated: false,
  authorizationGeneration: "origin-1",
  checkedAt: "1970-01-01T00:00:00.000Z",
};
const fixture = Effect.fn("fixture.relayRuntime")(function* (enabled = true) {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Gate.ApprovalAdmissionGate;
  yield* sql`INSERT INTO peer_environment_links(environment_id, secret_name, label, urls_json, access, linked_at, expires_at) VALUES ('peer', 'test-secret-ref', 'Peer', '[]', 'read-only', '1970-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO agent_event_peer_cursors (environment_id, peer_epoch, peer_seq, status, status_transition, authorization_generation, updated_at, detail) VALUES ('peer', 'peer-epoch', 0, 'following', 0, NULL, 0, NULL)`;
  const responses = yield* Queue.unbounded<typeof page | "unsupported">();
  const requests = yield* Queue.unbounded<void>();
  const cancelled = yield* Queue.unbounded<void>();
  const wakes = yield* Queue.unbounded<void>();
  const allowed = yield* Ref.make(true);
  const calls = yield* Ref.make(0);
  const access = Layer.mock(Access.AgentFactRelayAccess)({
    withGate: gate.withGate,
    outgoing: () =>
      Ref.get(allowed).pipe(
        Effect.map((allowed) =>
          allowed
            ? {
                verdict: "allowed",
                authorization: {
                  peerEnvironmentId: "peer",
                  generation: "pointer-1",
                  limits: { runtimeMode: "approval-required", interactionMode: "plan" },
                },
              }
            : { verdict: "refused", reason: "read_scope_lost" },
        ),
      ),
  });
  const transport = Layer.mock(Access.AgentFactRelayTransport)({
    read: () =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1);
        yield* Queue.offer(requests, undefined);
        const response = yield* Queue.take(responses);
        if (response === "unsupported")
          return yield* new Access.RelayPeerError({ reason: "unsupported" });
        return response;
      }).pipe(Effect.onInterrupt(() => Queue.offer(cancelled, undefined))),
  });
  const services = yield* Runtime.layer.pipe(
    Layer.provideMerge(Relay.layer({ id: "here", label: "Here" })),
    Layer.provideMerge(Signals.layerWake.pipe(Layer.provideMerge(Signals.layer))),
    Layer.provideMerge(access),
    Layer.provide(transport),
    Layer.provideMerge(
      Settings.layerTest({ linkedEnvironmentsEnabled: true, agentEventsEnabled: enabled }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Fleet.FleetAccess)({ changes: Stream.empty }),
        Layer.mock(Sessions.SessionStore)({
          cookieName: "fixture",
          legacyCookieName: undefined,
          streamChanges: Stream.empty,
        }),
        Layer.mock(Delivery.AgentEventDelivery)({
          wake: Queue.offer(wakes, undefined).pipe(Effect.asVoid),
        }),
      ),
    ),
    Layer.build,
  );
  return {
    sql,
    gate,
    responses,
    requests,
    cancelled,
    wakes,
    allowed,
    calls,
    runtime: Context.get(services, Runtime.AgentFactRelayRuntime),
    relay: Context.get(services, Relay.AgentFactRelay),
    settings: Context.get(services, Settings.ServerSettingsService),
  };
});
const dependencies = Layer.mergeAll(layerDatabase, Gate.layer);

it.effect(
  "background import commits once, wakes delivery after commit, and revocation cancels an in-flight follow without holding admission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.runtime.run.pipe(Effect.forkChild);
      yield* Queue.take(f.requests);
      yield* f.gate.withGate(Effect.void);
      yield* f.runtime.reconcile;
      yield* f.runtime.reconcile;
      assert.equal(yield* Ref.get(f.calls), 1);
      yield* Queue.offer(f.responses, page);
      yield* Queue.take(f.wakes);
      assert.equal((yield* f.relay.peerCursor("peer"))?.peerSeq, 1);
      assert.equal(
        (yield* Facts.readFacts(0)).filter((row) => row.relayedFrom === "peer").length,
        1,
      );
      yield* TestClock.adjust(100);
      yield* Queue.take(f.requests);
      yield* Queue.offer(f.responses, { ...page, facts: [] });
      yield* Queue.take(f.wakes);
      assert.equal(
        (yield* Facts.readFacts(0)).filter((row) => row.relayedFrom === "peer").length,
        1,
      );
      yield* TestClock.adjust(100);
      yield* Queue.take(f.requests);
      yield* f.settings.updateSettings({ agentEventsEnabled: false });
      yield* Queue.take(f.cancelled);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(f.calls), 3);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect.each(["unsupported", "invalid_page"] as const)(
  "%s peers retry hourly without duplicating status facts",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.runtime.reconcile;
      yield* Queue.take(f.requests);
      yield* Queue.offer(
        f.responses,
        mode === "unsupported"
          ? "unsupported"
          : { ...page, facts: [], next: { epoch: "wrong", seq: 0 } },
      );
      yield* Queue.take(f.wakes);
      assert.equal((yield* f.relay.peerCursor("peer"))?.status, "unsupported");
      yield* TestClock.adjust("59 minutes");
      assert.equal(yield* Ref.get(f.calls), 1);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(f.requests);
      yield* Queue.offer(
        f.responses,
        mode === "unsupported"
          ? "unsupported"
          : { ...page, facts: [], next: { epoch: "wrong", seq: 0 } },
      );
      yield* Queue.take(f.wakes);
      assert.equal(
        (yield* Facts.readFacts(0)).filter((row) => row.kind === "source_status").length,
        1,
      );
      yield* Ref.set(f.allowed, false);
      yield* f.runtime.reconcile;
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(f.calls), 2);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("enabling events after startup does not start a follower until restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    yield* f.settings.updateSettings({ agentEventsEnabled: true });
    yield* f.runtime.reconcile;
    assert.equal(yield* Ref.get(f.calls), 0);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);
