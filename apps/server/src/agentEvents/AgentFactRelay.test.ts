import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Wire from "../../../../packages/contracts/src/agentEventRelay.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as Store from "./AgentEventStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as Relay from "./AgentFactRelay.ts";
import * as Ports from "./AgentFactRelayAccess.ts";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";
import * as Facts from "./AgentFactStore.ts";

const local = { id: "environment-a", label: "Machine A" };
const peer = "environment-b";
const at = "1970-01-01T00:00:01.000Z";
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make(local.id),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "trusted-request",
  thread: undefined,
  linkedEnvironments: true,
  client: {
    sessionId: "authenticated-link-session",
    label: "untrusted display name",
    access: "read-only",
    linked: true,
  },
};
const grant = (generation = "link-generation-1"): Ports.RelayAccess => ({
  verdict: "allowed",
  authorization: {
    peerEnvironmentId: peer,
    generation,
    limits: { runtimeMode: "approval-required", interactionMode: "plan" },
  },
});
const fact = (sequence: number, overrides: Partial<Facts.FactData> = {}): Facts.FactData => ({
  schema: "t3.agent-event/1",
  kind: "approval",
  factKey: `request-${sequence}:pending`,
  summary: "Approval needed",
  textIsUntrusted: true,
  environment: { id: peer, label: "Original peer label" },
  thread: { id: `thread-${sequence}`, delegated: false },
  run: { id: "run-b" },
  owner: { id: "dan", label: "Dan at occurrence", assignmentRevision: 4 },
  origin: {
    environmentId: peer,
    sourceGeneration: "source-b",
    sourceKind: "orchestration",
    sourceSequence: sequence,
    transitionOrdinal: 0,
    threadSequence: sequence,
    occurredAt: at,
  },
  relay: null,
  detail: { requestId: `request-${sequence}` },
  ...overrides,
});
const entry = (
  data: Facts.FactData,
  seq = data.origin.sourceSequence,
): Wire.AgentFactRelayEntry => ({
  seq,
  eventId: Facts.factEventId(data.origin, data.factKey),
  dataJson: stableStringify(data),
});
const page = (
  facts: ReadonlyArray<Wire.AgentFactRelayEntry> = [],
  overrides: Partial<Wire.AgentFactRelayPage> = {},
): Wire.AgentFactRelayPage => ({
  epoch: "peer-epoch-1",
  facts,
  next: { epoch: "peer-epoch-1", seq: facts.at(-1)?.seq ?? 0 },
  floorSeq: 1,
  headSeq: facts.at(-1)?.seq ?? 0,
  truncated: false,
  authorizationGeneration: "peer-authorization-1",
  checkedAt: at,
  ...overrides,
});
const subscribe = Effect.fn("fixture.subscribe")(function* () {
  const log = yield* Store.logState();
  yield* Store.upsertSubscription(
    {
      subscriptionId: "all",
      principalId: "principal",
      sessionId: "outside-session",
      attributionSubject: "mcp-client:outside",
      clientLabel: "Outside",
      eventName: "t3.task_activity",
      argumentsJson: "{}",
      callbackUrl: "https://callback.test",
      secretRef: "fixture",
      previousSecretRef: null,
      previousSecretUntil: null,
      state: "active",
      expiresAt: 100_000,
      logEpoch: log.epoch,
      updatedAt: 0,
    },
    log.headSeq,
  );
});
const fixtureFor = (resuming = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* Semaphore.make(1);
    // Parent owns the additive migration; this test creates only the requested new relay ledger.
    yield* sql`CREATE TABLE IF NOT EXISTS agent_event_relay_imports (
    event_id TEXT PRIMARY KEY, origin_environment_id TEXT NOT NULL,
    original_digest TEXT NOT NULL, relayed_at INTEGER NOT NULL
  )`;
    if (resuming)
      yield* sql`INSERT OR IGNORE INTO agent_event_peer_cursors (environment_id, peer_epoch, peer_seq, status, status_transition, authorization_generation, updated_at, detail) VALUES (${peer}, 'peer-epoch-1', 0, 'following', 0, NULL, 0, NULL)`;
    const state = {
      incoming: grant(),
      outgoing: grant(),
      requester: grant("requester-generation-1"),
      decisions: new Map<string, Wire.AgentFactRelayDecision>(),
      page: page(),
      readCalls: 0,
      proofCalls: 0,
      read: undefined as Ports.AgentFactRelayTransport["Service"]["read"] | undefined,
      validate: undefined as Ports.AgentFactRelayTransport["Service"]["validate"] | undefined,
      wait: undefined as Ports.AgentFactRelayWake["Service"]["wait"] | undefined,
      lastProofCall: undefined as
        | Parameters<Ports.AgentFactRelayTransport["Service"]["validate"]>[0]
        | undefined,
    };
    const access = Ports.AgentFactRelayAccess.of({
      withGate: gate.withPermit,
      incoming: () => Effect.sync(() => state.incoming),
      outgoing: () => Effect.sync(() => state.outgoing),
      requester: () => Effect.sync(() => state.requester),
      originFact: ({ data }) =>
        Effect.sync(() => state.decisions.get(String(data.thread?.id)) ?? { verdict: "allowed" }),
    });
    const transport = Ports.AgentFactRelayTransport.of({
      read: (input) =>
        Effect.suspend(() => {
          state.readCalls++;
          return state.read?.(input) ?? Effect.succeed(state.page);
        }),
      validate: (input) =>
        Effect.suspend(() => {
          state.proofCalls++;
          state.lastProofCall = input;
          return (
            state.validate?.(input) ??
            Effect.succeed({
              authorizationGeneration: state.page.authorizationGeneration,
              checkedAt: at,
              results: input.request.references.map((reference) => ({
                reference,
                decision: { verdict: "allowed" as const },
              })),
            })
          );
        }),
    });
    const services = Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(Ports.AgentFactRelayAccess, access),
      Layer.succeed(Ports.AgentFactRelayTransport, transport),
      Layer.succeed(Ports.AgentFactRelayWake, {
        wait: (after, waitMs) => Effect.suspend(() => state.wait?.(after, waitMs) ?? Effect.void),
      }),
    );
    const relay = yield* Relay.AgentFactRelay.pipe(
      Effect.provide(Relay.layer(local).pipe(Layer.provide(services))),
    );
    return { relay, state, gate, sql };
  });
const fixture = fixtureFor();
const asPeer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
const sqlImports = Effect.fn("fixture.sqlImports")(function* () {
  return yield* (yield* SqlClient.SqlClient)`SELECT * FROM agent_event_relay_imports`;
});
const cached = (eventId: string) => ({
  eventId,
  sessionId: "outside-session",
  attributionSubject: "mcp-client:outside",
});
const localFact = Effect.fn("fixture.localFact")(function* (
  sequence: number,
  overrides: Partial<Facts.FactData> = {},
) {
  const data = fact(sequence, { environment: local, ...overrides });
  return {
    ...data,
    origin: {
      ...data.origin,
      environmentId: local.id,
      sourceGeneration: yield* Journal.sourceGeneration(),
    },
  };
});
const assertEmpty = Effect.fn("fixture.assertEmpty")(function* (
  relay: Relay.AgentFactRelay["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  assert.deepEqual(yield* Facts.readFacts(0), []);
  assert.strictEqual((yield* Store.logState()).headSeq, 0);
  assert.equal((yield* relay.peerCursor(peer))?.peerSeq, 0);
  assert.deepEqual(yield* sql`SELECT * FROM agent_event_occurrences`, []);
  assert.deepEqual(yield* sql`SELECT * FROM agent_event_relay_imports`, []);
  assert.deepEqual(yield* Store.listDeliveries("all", 100), []);
});

describe("AgentFactRelay origin read and proof", () => {
  it.effect(
    "exports only local origins, advancing over private probes and imports without owner filtering",
    () =>
      Effect.gen(function* () {
        const { relay } = yield* fixture;
        yield* subscribe();
        const dan = yield* localFact(1);
        const gavin = yield* localFact(2, { owner: { id: "gavin", label: "Gavin then" } });
        const first = yield* Facts.appendFact({ data: dan, recordedAt: 0 });
        yield* Store.appendProbe({
          eventId: "private-probe",
          subscriptionId: "all",
          occurredAt: 0,
          now: 0,
          dataJson: "private",
        });
        yield* Facts.appendFact({
          data: { ...fact(1), relay: { viaEnvironmentId: local.id, relayedAt: at } },
          recordedAt: 0,
          relayedFrom: peer,
        });
        const last = yield* Facts.appendFact({ data: gavin, recordedAt: 0 });
        const a = yield* asPeer(
          relay.readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 }, limit: 2 }),
        );
        assert.deepEqual(
          a.facts.map((row) => row.eventId),
          [first.eventId],
        );
        assert.strictEqual(a.next.seq, 2);
        const b = yield* asPeer(relay.readOrigin({ after: a.next, limit: 2 }));
        assert.deepEqual(
          b.facts.map((row) => row.eventId),
          [last.eventId],
        );
        assert.strictEqual(b.next.seq, 4);
        assert.strictEqual(b.facts[0]!.dataJson, stableStringify(gavin));
        const privateFact = yield* Facts.appendFact({
          data: {
            ...CompatibilityFacts.observationData(local.id, "thread-a", {
              eventId: "native-private" as never,
              sequence: 3,
              kind: "run_state",
              status: "running",
              runId: null,
              requestId: null,
            }),
            kind: "gateway_work_snapshot",
            payload: { inputs: { private: "x".repeat(20_000) }, page: "snapshot" },
          },
          recordedAt: 0,
        });
        const none = yield* asPeer(relay.readOrigin({ after: b.next }));
        assert.deepEqual(none.facts, []);
        assert.deepEqual(none.next, { ...b.next, seq: privateFact.logSeq });
        assert.deepEqual(
          (yield* asPeer(
            relay.validateOrigin({
              references: [
                {
                  eventId: privateFact.eventId,
                  originGeneration: "native-private",
                  threadId: "thread-a",
                },
              ],
              authorizationGeneration: none.authorizationGeneration,
            }),
          )).results[0]!.decision,
          { verdict: "unavailable" },
        );
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "requires trusted peer admission beyond the linked flag, refusing spoofed contexts and unbounded inputs",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        const contexts: ReadonlyArray<Invocation.McpInvocationScope> = [
          { ...scope, client: undefined },
          { ...scope, client: { ...scope.client!, linked: false } },
          { ...scope, client: { ...scope.client!, taskOnly: true } },
          { ...scope, linkedEnvironments: false },
          { ...scope, capabilities: new Set() },
          { ...scope, environmentId: EnvironmentId.make(peer) },
          {
            ...scope,
            thread: {
              threadId: "thread" as never,
              providerInstanceId: "codex" as never,
              providerSessionId: "provider",
            },
          },
        ];
        for (const context of contexts)
          assert.strictEqual(
            (yield* Effect.flip(
              relay
                .readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 } })
                .pipe(Effect.provideService(Invocation.McpInvocationContext, context)),
            )).reason,
            "capability_denied",
          );
        state.incoming = { verdict: "refused", reason: "credential_changed" };
        assert.strictEqual(
          (yield* Effect.flip(asPeer(relay.readOrigin({ after: null })))).reason,
          "capability_denied",
        );
        state.incoming = { verdict: "unavailable" };
        assert.strictEqual(
          (yield* Effect.flip(
            asPeer(relay.readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 } })),
          )).reason,
          "authority_unavailable",
        );
        state.incoming = grant();
        for (const extra of [
          { limit: 0 },
          { limit: 101 },
          { waitMs: 45_001 },
          { waitMs: -1 },
          { environmentId: peer },
        ])
          assert.strictEqual(
            (yield* Effect.flip(
              asPeer(
                relay.readOrigin({
                  after: { epoch: (yield* Store.logState()).epoch, seq: 0 },
                  ...extra,
                }),
              ),
            )).reason,
            "invalid_request",
          );
        assert.strictEqual(
          (yield* Effect.flip(
            asPeer(relay.validateOrigin({ references: [], authorizationGeneration: null })),
          )).reason,
          "invalid_request",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            asPeer(
              relay.validateOrigin({
                references: Array.from({ length: 101 }, () => ({
                  eventId: "e",
                  threadId: null,
                  originGeneration: "g",
                })),
                authorizationGeneration: null,
              }),
            ),
          )).reason,
          "invalid_request",
        );
        yield* asPeer(
          relay.readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 } }),
        ); // A trusted read-only link is sufficient.
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "proves current deletion/source/access state while preserving historical owner data",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        const dan = yield* localFact(1);
        const gavin = yield* localFact(2, { owner: { id: "gavin", label: "Old Gavin" } });
        const d = yield* Facts.appendFact({ data: dan, recordedAt: 0 });
        const g = yield* Facts.appendFact({ data: gavin, recordedAt: 0 });
        state.decisions.set("thread-2", { verdict: "refused", reason: "thread_unreadable" });
        const exported = yield* asPeer(
          relay.readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 } }),
        );
        assert.deepEqual(
          exported.facts.map((row) => row.eventId),
          [d.eventId],
        );
        assert.strictEqual(exported.next.seq, 2);
        const references = [
          {
            eventId: d.eventId,
            originGeneration: dan.origin.sourceGeneration,
            threadId: "thread-1",
          },
          {
            eventId: g.eventId,
            originGeneration: gavin.origin.sourceGeneration,
            threadId: "thread-2",
          },
          { eventId: "missing", originGeneration: "missing", threadId: null },
          { eventId: d.eventId, originGeneration: "old-generation", threadId: "thread-1" },
          {
            eventId: d.eventId,
            originGeneration: dan.origin.sourceGeneration,
            threadId: "different-thread",
          },
        ];
        const proof = yield* asPeer(
          relay.validateOrigin({ references, authorizationGeneration: "link-generation-1" }),
        );
        assert.deepEqual(
          proof.results.map((result) => result.decision),
          [
            { verdict: "allowed" },
            { verdict: "refused", reason: "thread_unreadable" },
            { verdict: "unavailable" },
            { verdict: "refused", reason: "source_changed" },
            { verdict: "refused", reason: "source_changed" },
          ],
        );
        const stale = yield* asPeer(
          relay.validateOrigin({ references, authorizationGeneration: "old-link" }),
        );
        assert.isTrue(stale.results.every((result) => result.decision.verdict === "unavailable"));
        state.decisions.set("thread-1", { verdict: "unavailable" });
        assert.strictEqual(
          (yield* Effect.flip(
            asPeer(relay.readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 } })),
          )).reason,
          "authority_unavailable",
        );
        assert.strictEqual((yield* Facts.readFacts(0))[1]!.dataJson, stableStringify(gavin));
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("handles origin epoch/floor resets, first-follow head and restored-head cursors", () =>
    Effect.gen(function* () {
      const { relay, sql } = yield* fixture;
      yield* Facts.appendFact({ data: yield* localFact(1), recordedAt: 0 });
      yield* Facts.appendFact({ data: yield* localFact(2), recordedAt: 0 });
      const log = yield* Store.logState();
      yield* sql`UPDATE agent_event_log_state SET floor_seq = 2 WHERE id = 1`;
      for (const after of [
        { epoch: "old-epoch", seq: 2 },
        { epoch: log.epoch, seq: 0 },
        { epoch: log.epoch, seq: 3 },
      ]) {
        const result = yield* asPeer(relay.readOrigin({ after }));
        assert.isTrue(result.truncated);
        assert.deepEqual(
          result.facts.map((row) => row.seq),
          [2],
        );
      }
      const initial = yield* asPeer(relay.readOrigin({ after: null }));
      assert.isFalse(initial.truncated);
      assert.deepEqual(initial.facts, []);
      assert.equal(initial.next.seq, log.headSeq);
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("caps serialized page bytes and resumes without losing the batch suffix", () =>
    Effect.gen(function* () {
      const { relay } = yield* fixture;
      for (let sequence = 1; sequence <= 40; sequence++)
        yield* Facts.appendFact({
          data: yield* localFact(sequence, { detail: { text: '\\"'.repeat(2000) } }),
          recordedAt: 0,
        });
      const first = yield* asPeer(
        relay.readOrigin({ after: { epoch: (yield* Store.logState()).epoch, seq: 0 } }),
      );
      assert.isBelow(
        Buffer.byteLength(stableStringify(first)),
        Wire.AGENT_FACT_RELAY_LIMITS.pageBytes + 1,
      );
      assert.isAbove(first.next.seq, 0);
      assert.isBelow(first.next.seq, 40);
      const second = yield* asPeer(relay.readOrigin({ after: first.next }));
      const third = yield* asPeer(relay.readOrigin({ after: second.next }));
      assert.strictEqual(first.facts.length + second.facts.length + third.facts.length, 40);
      assert.strictEqual(third.next.seq, 40);
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "releases SQL and authority gates during long-poll waits and rechecks removal after wake",
    () =>
      Effect.gen(function* () {
        const { relay, state, gate } = yield* fixture;
        const waiting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.wait = (_after, waitMs) =>
          Effect.gen(function* () {
            assert.strictEqual(waitMs, 45_000);
            yield* Deferred.succeed(waiting, undefined);
            yield* Deferred.await(release);
          });
        const log = yield* Store.logState();
        const fiber = yield* asPeer(
          relay.readOrigin({ after: { epoch: log.epoch, seq: 0 }, waitMs: 45_000 }),
        ).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* gate.withPermit(
          Effect.gen(function* () {
            state.incoming = { verdict: "refused", reason: "session_inactive" };
            yield* Facts.appendFact({ data: yield* localFact(1), recordedAt: 0 });
          }),
        );
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.strictEqual(result.failure.reason, "capability_denied");
      }).pipe(Effect.provide(layerDatabase)),
  );
});

describe("AgentFactRelay import transactions and source statuses", () => {
  it.effect(
    "uses the shared allocator/matcher and dedupes original bytes across a later epoch replay",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        yield* subscribe();
        yield* Store.appendProbe({
          eventId: "probe",
          subscriptionId: "all",
          dataJson: "{}",
          occurredAt: 0,
          now: 0,
        });
        const original = [
          entry(fact(1)),
          entry(
            fact(2, {
              owner: { id: "gavin", label: "Gavin at occurrence", assignmentRevision: 8 },
            }),
          ),
        ];
        state.page = page(original);
        const first = yield* relay.followOnce(peer);
        assert.strictEqual(first.imported, 2);
        assert.strictEqual(first.cursor.peerSeq, 2);
        assert.strictEqual(first.cursor.statusTransition, 1);
        const rows = yield* Facts.readFacts(0);
        assert.deepEqual(
          rows.map((row) => row.logSeq),
          [2, 3, 4],
        );
        assert.strictEqual(rows[0]!.eventId, original[0]!.eventId);
        assert.strictEqual(rows[0]!.occurredAt, 1_000);
        assert.strictEqual(rows[0]!.relayedFrom, peer);
        const saved = yield* Facts.decodeFactDataJson(rows[1]!.dataJson);
        assert.deepEqual(saved.owner, {
          id: "gavin",
          label: "Gavin at occurrence",
          assignmentRevision: 8,
        });
        assert.deepEqual(saved.relay, {
          viaEnvironmentId: local.id,
          relayedAt: "1970-01-01T00:00:00.000Z",
        });
        assert.strictEqual((yield* Store.listDeliveries("all", 100)).length, 4);
        yield* TestClock.adjust("2 seconds");
        state.page = page(original, {
          epoch: "peer-epoch-2",
          next: { epoch: "peer-epoch-2", seq: 2 },
          truncated: true,
        });
        const repeated = yield* relay.followOnce(peer);
        assert.strictEqual(repeated.imported, 0);
        assert.strictEqual(repeated.cursor.statusTransition, 3);
        assert.deepEqual((yield* Facts.readFacts(0)).slice(0, 2), rows.slice(0, 2));
        assert.strictEqual(
          (yield* Store.listDeliveries("all", 100)).filter((row) =>
            original.some((fact) => fact.eventId === row.eventId),
          ).length,
          2,
        );
        const statuses = yield* Effect.forEach(
          (yield* Facts.readFacts(0)).filter((row) => row.kind === "source_status"),
          (row) => Facts.decodeFactDataJson(row.dataJson),
        );
        assert.deepEqual(
          statuses.map((data) => data.detail.status),
          ["following", "gap", "following"],
        );
        assert.isTrue(
          statuses.every(
            (data) =>
              data.origin.sourceKind === "peer_status" &&
              data.origin.environmentId === local.id &&
              data.thread === null &&
              data.owner === null,
          ),
        );
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect.each(["fact", "matching", "cursor", "receipt"] as const)(
    "rolls back imports, matching, allocation and status when %s persistence fails",
    (stage) =>
      Effect.gen(function* () {
        const { relay, state, sql } = yield* fixture;
        yield* subscribe();
        state.page = page([entry(fact(1)), entry(fact(2))]);
        if (stage === "fact")
          yield* sql`CREATE TRIGGER refuse_relay BEFORE INSERT ON agent_event_facts WHEN NEW.fact_key = 'request-2:pending' BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
        else if (stage === "receipt")
          yield* sql`CREATE TRIGGER refuse_relay BEFORE INSERT ON agent_event_relay_imports BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
        else if (stage === "matching")
          yield* sql`CREATE TRIGGER refuse_relay BEFORE INSERT ON agent_event_deliveries BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
        else
          yield* sql`CREATE TRIGGER refuse_relay BEFORE INSERT ON agent_event_peer_cursors BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
        assert.strictEqual((yield* Effect.flip(relay.followOnce(peer))).reason, "storage");
        yield* assertEmpty(relay);
        yield* sql`DROP TRIGGER refuse_relay`;
        assert.strictEqual((yield* relay.followOnce(peer)).imported, 2);
        assert.strictEqual((yield* Store.listDeliveries("all", 100)).length, 3);
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("refuses same-ID changed bytes without committing a gap or advancing the cursor", () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      state.page = page([entry(fact(1))]);
      yield* relay.followOnce(peer);
      const cursor = yield* relay.peerCursor(peer);
      const head = (yield* Store.logState()).headSeq;
      state.page = page([entry(fact(1, { owner: { id: "new-owner" } }))], {
        epoch: "peer-epoch-2",
        next: { epoch: "peer-epoch-2", seq: 1 },
        truncated: true,
      });
      assert.strictEqual((yield* relay.followOnce(peer)).cursor.detail, "identity_changed");
      const refused = yield* relay.peerCursor(peer);
      assert.equal(refused?.peerSeq, cursor?.peerSeq);
      assert.equal(refused?.peerEpoch, cursor?.peerEpoch);
      assert.isNull(refused?.authorizationGeneration);
      assert.strictEqual((yield* Store.logState()).headSeq, head + 1);
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "advances over filtered slots and reports floor and epoch gaps as durable occurrences",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        state.page = page([], { next: { epoch: "peer-epoch-1", seq: 100 }, headSeq: 100 });
        assert.strictEqual((yield* relay.followOnce(peer)).cursor.peerSeq, 100);
        state.page = page([entry(fact(1), 101)], {
          next: { epoch: "peer-epoch-1", seq: 101 },
          headSeq: 101,
        });
        assert.strictEqual((yield* relay.followOnce(peer)).imported, 1);
        state.page = page([entry(fact(2), 103)], {
          floorSeq: 103,
          headSeq: 103,
          truncated: true,
          next: { epoch: "peer-epoch-1", seq: 103 },
        });
        assert.strictEqual((yield* relay.followOnce(peer)).cursor.statusTransition, 3);
        state.page = page([], {
          epoch: "peer-epoch-2",
          floorSeq: 1,
          headSeq: 0,
          truncated: true,
          next: { epoch: "peer-epoch-2", seq: 0 },
        });
        assert.strictEqual((yield* relay.followOnce(peer)).cursor.statusTransition, 5);
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "gives recurring unreachable/unsupported/following cycles distinct IDs across service recreation",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture;
        first.state.read = () => Effect.fail(new Ports.RelayPeerError({ reason: "unsupported" }));
        assert.strictEqual((yield* first.relay.followOnce(peer)).cursor.statusTransition, 1);
        assert.strictEqual((yield* first.relay.followOnce(peer)).cursor.statusTransition, 1);
        first.state.read = undefined;
        assert.strictEqual((yield* first.relay.followOnce(peer)).cursor.statusTransition, 2);
        const second = yield* fixture;
        second.state.read = () => Effect.fail(new Ports.RelayPeerError({ reason: "unreachable" }));
        assert.strictEqual((yield* second.relay.followOnce(peer)).cursor.statusTransition, 3);
        yield* second.relay.followOnce(peer);
        second.state.read = undefined;
        assert.strictEqual((yield* second.relay.followOnce(peer)).cursor.statusTransition, 4);
        second.state.read = () => Effect.fail(new Ports.RelayPeerError({ reason: "unreachable" }));
        assert.strictEqual((yield* second.relay.followOnce(peer)).cursor.statusTransition, 5);
        const rows = yield* Facts.readFacts(0);
        assert.strictEqual(new Set(rows.map((row) => row.eventId)).size, 5);
        assert.deepEqual(
          rows.map((row) => row.sourceSequence),
          [1, 2, 3, 4, 5],
        );
        const statuses = yield* Effect.forEach(rows, (row) =>
          Facts.decodeFactDataJson(row.dataJson),
        );
        assert.deepEqual(
          statuses.map((data) => data.detail.status),
          ["unsupported", "following", "unreachable", "following", "unreachable"],
        );
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect.each([
    "session_inactive",
    "links_disabled",
    "credential_changed",
    "read_scope_lost",
    "outside_sharing_refused",
  ] as const)("stops polling after %s removal and invalidates stored source authority", (reason) =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      state.page = page([entry(fact(1))]);
      yield* relay.followOnce(peer);
      state.outgoing = { verdict: "refused", reason };
      const next = yield* relay.followOnce(peer);
      assert.strictEqual(state.readCalls, 1);
      assert.strictEqual(next.cursor.peerSeq, 1);
      assert.isNull(next.cursor.authorizationGeneration);
      assert.strictEqual(next.cursor.status, "unreachable");
      assert.deepEqual((yield* relay.checkCached(cached(entry(fact(1)).eventId))).decision, {
        verdict: "refused",
        reason,
      });
      assert.strictEqual(state.proofCalls, 0);
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("releases the removal gate during pulls and rechecks generation before import", () =>
    Effect.gen(function* () {
      const { relay, state, gate } = yield* fixture;
      const called = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.read = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(called, undefined);
          yield* Deferred.await(release);
          return page([entry(fact(1))]);
        });
      const fiber = yield* relay.followOnce(peer).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(called);
      yield* gate.withPermit(
        Effect.sync(() => {
          state.outgoing = grant("link-generation-2");
        }),
      );
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(result.failure.reason, "authority_unavailable");
      yield* assertEmpty(relay);
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("refuses an in-flight stale pull after a competing cursor commit", () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      const called = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.read = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(called, undefined);
          yield* Deferred.await(release);
          return page([entry(fact(1))]);
        });
      const older = yield* relay.followOnce(peer).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(called);
      state.read = undefined;
      state.page = page([entry(fact(1)), entry(fact(2))]);
      yield* relay.followOnce(peer);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(older);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "stale_cursor");
      assert.strictEqual((yield* relay.peerCursor(peer))!.peerSeq, 2);
      assert.strictEqual((yield* Facts.readFacts(0)).length, 3);
    }).pipe(Effect.provide(layerDatabase)),
  );
});

describe("AgentFactRelay canonical wire and one-hop fencing", () => {
  it.effect("strictly decodes raw peer responses before unknown fields can be discarded", () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      state.read = () => Effect.succeed({ ...page(), forgedAuthority: "yes" });
      assert.strictEqual((yield* relay.followOnce(peer)).cursor.detail, "invalid_page");
      assert.deepEqual(yield* sqlImports(), []);
      assert.isTrue((yield* Facts.readFacts(0)).every((row) => row.kind === "source_status"));
      state.read = undefined;
      const original = entry(fact(1));
      state.page = page([original]);
      yield* relay.followOnce(peer);
      state.validate = (input) =>
        Effect.succeed({
          authorizationGeneration: "peer-authorization-1",
          checkedAt: at,
          results: input.request.references.map((reference) => ({
            reference: { ...reference, forgedAuthority: true },
            decision: { verdict: "allowed" },
          })),
        });
      assert.deepEqual((yield* relay.checkCached(cached(original.eventId))).decision, {
        verdict: "unavailable",
      });
    }).pipe(Effect.provide(layerDatabase)),
  );
  const invalidPages: ReadonlyArray<readonly [string, () => Wire.AgentFactRelayPage]> = [
    [
      "imported origin",
      () => page([entry(fact(1, { relay: { viaEnvironmentId: "environment-c", relayedAt: at } }))]),
    ],
    [
      "foreign origin",
      () => {
        const data = fact(1);
        return page([
          entry({ ...data, origin: { ...data.origin, environmentId: "environment-c" } }),
        ]);
      },
    ],
    ["changed event ID", () => page([{ ...entry(fact(1)), eventId: "forged" }])],
    ["duplicate event ID", () => page([entry(fact(1)), entry(fact(1), 2)])],
    ["noncanonical bytes", () => page([{ ...entry(fact(1)), dataJson: JSON.stringify(fact(1)) }])],
    [
      "unknown fact field",
      () =>
        page([{ ...entry(fact(1)), dataJson: stableStringify({ ...fact(1), injected: true }) }]),
    ],
    [
      "private probe",
      () => page([{ ...entry(fact(1)), dataJson: stableStringify({ ...fact(1), kind: "probe" }) }]),
    ],
    [
      "unbounded UTF-8 bytes",
      () => page([entry(fact(1, { detail: { text: "\u732b".repeat(7000) } }))]),
    ],
    [
      "oversized whole page",
      () =>
        page(
          Array.from({ length: 30 }, (_, i) =>
            entry(fact(i + 1, { detail: { text: "x".repeat(10_000) } })),
          ),
        ),
    ],
    ["next epoch mismatch", () => page([], { next: { epoch: "wrong", seq: 0 } })],
    ["next past head", () => page([], { next: { epoch: "peer-epoch-1", seq: 1 } })],
    ["cursor stall with remaining source", () => page([], { headSeq: 1 })],
    [
      "unbounded scanned slots",
      () => page([], { next: { epoch: "peer-epoch-1", seq: 101 }, headSeq: 101 }),
    ],
    [
      "out-of-range fact",
      () => page([entry(fact(1))], { next: { epoch: "peer-epoch-1", seq: 0 } }),
    ],
    [
      "foreign source-status target",
      () =>
        page([
          entry(
            fact(1, {
              kind: "source_status",
              thread: null,
              owner: null,
              run: null,
              detail: { environmentId: "environment-c", status: "following" },
            }),
          ),
        ]),
    ],
    ["false reset", () => page([], { truncated: true })],
    ["invalid floor", () => page([], { floorSeq: 0 })],
  ];
  it.effect.each(invalidPages)(
    "refuses %s without advancing the peer cursor or importing data",
    ([_name, invalid]) =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        state.page = invalid();
        assert.strictEqual((yield* relay.followOnce(peer)).cursor.detail, "invalid_page");
        assert.equal((yield* relay.peerCursor(peer))?.peerSeq, 0);
        assert.deepEqual(yield* sqlImports(), []);
        assert.isTrue((yield* Facts.readFacts(0)).every((row) => row.kind === "source_status"));
      }).pipe(Effect.provide(layerDatabase)),
  );
});

describe("AgentFactRelay fresh cached-fact authority", () => {
  it.effect(
    "requires current origin proof on every check and revalidates authorization changes",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        const original = entry(fact(1));
        state.page = page([original]);
        yield* relay.followOnce(peer);
        const input = cached(original.eventId);
        const allowed = yield* relay.checkCached(input);
        assert.deepEqual(allowed.decision, { verdict: "allowed" });
        assert.strictEqual(allowed.originAuthorizationGeneration, "peer-authorization-1");
        assert.strictEqual(allowed.authorizationGeneration, "requester-generation-1");
        assert.deepEqual(state.lastProofCall!.authorization.limits, {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        state.validate = (call) =>
          Effect.succeed({
            authorizationGeneration: "peer-authorization-1",
            checkedAt: at,
            results: call.request.references.map((reference) => ({
              reference,
              decision: { verdict: "refused" as const, reason: "thread_unreadable" as const },
            })),
          });
        assert.deepEqual((yield* relay.checkCached(input)).decision, {
          verdict: "refused",
          reason: "thread_unreadable",
        });
        state.validate = () => Effect.fail(new Ports.RelayPeerError({ reason: "unreachable" }));
        assert.deepEqual((yield* relay.checkCached(input)).decision, { verdict: "unavailable" });
        state.validate = undefined;
        state.page = page([], {
          authorizationGeneration: "peer-authorization-2",
          next: { epoch: "peer-epoch-1", seq: 1 },
          headSeq: 1,
        });
        assert.deepEqual((yield* relay.checkCached(input)).decision, { verdict: "unavailable" });
        yield* relay.followOnce(peer);
        assert.deepEqual((yield* relay.checkCached(input)).decision, { verdict: "allowed" });
        assert.strictEqual(state.proofCalls, 5);
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect.each(["requester", "link", "deletion", "revocation", "source_status"] as const)(
    "rechecks %s after origin proof without blocking removal",
    (change) =>
      Effect.gen(function* () {
        const { relay, state, sql, gate } = yield* fixture;
        const original = entry(fact(1));
        state.page = page([original]);
        yield* relay.followOnce(peer);
        const called = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.validate = (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(called, undefined);
            yield* Deferred.await(release);
            return {
              authorizationGeneration: "peer-authorization-1",
              checkedAt: at,
              results: input.request.references.map((reference) => ({
                reference,
                decision: { verdict: "allowed" as const },
              })),
            };
          });
        const fiber = yield* relay.checkCached(cached(original.eventId)).pipe(Effect.forkChild);
        yield* Deferred.await(called);
        yield* gate.withPermit(
          Effect.gen(function* () {
            if (change === "requester") state.requester = grant("requester-generation-2");
            if (change === "link") state.outgoing = grant("link-generation-2");
            if (change === "revocation")
              state.requester = { verdict: "refused", reason: "session_inactive" };
            if (change === "source_status")
              yield* sql`UPDATE agent_event_peer_cursors SET authorization_generation = NULL, status = 'unreachable' WHERE environment_id = ${peer}`;
            if (change === "deletion")
              yield* sql`DELETE FROM agent_event_facts WHERE event_id = ${original.eventId}`;
          }),
        );
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        assert.deepEqual(
          result.decision,
          change === "revocation"
            ? { verdict: "refused", reason: "session_inactive" }
            : { verdict: "unavailable" },
        );
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "defers missing, local, mismatched and uncertain proofs without trusting the cache",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        assert.deepEqual((yield* relay.checkCached(cached("missing"))).decision, {
          verdict: "unavailable",
        });
        const localRow = yield* Facts.appendFact({ data: yield* localFact(1), recordedAt: 0 });
        assert.deepEqual((yield* relay.checkCached(cached(localRow.eventId))).decision, {
          verdict: "unavailable",
        });
        assert.strictEqual(state.proofCalls, 0);
        const original = entry(fact(1));
        state.page = page([original]);
        yield* relay.followOnce(peer);
        for (const results of [
          [],
          [
            {
              reference: { eventId: "wrong", originGeneration: "source-b", threadId: "thread-1" },
              decision: { verdict: "allowed" as const },
            },
          ],
        ]) {
          state.validate = () =>
            Effect.succeed({
              authorizationGeneration: "peer-authorization-1",
              checkedAt: at,
              results,
            });
          assert.deepEqual((yield* relay.checkCached(cached(original.eventId))).decision, {
            verdict: "unavailable",
          });
        }
        state.requester = { verdict: "unavailable" };
        state.validate = () =>
          Effect.die("Must not request a proof without current requester authority");
        assert.deepEqual((yield* relay.checkCached(cached(original.eventId))).decision, {
          verdict: "unavailable",
        });
      }).pipe(Effect.provide(layerDatabase)),
  );
});

describe("AgentFactRelay retained import receipts", () => {
  it.effect("refuses unbounded follow waits before transport or durable writes", () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      for (const waitMs of [-1, 45_001, 1.5, Number.NaN])
        assert.strictEqual(
          (yield* Effect.flip(relay.followOnce(peer, waitMs))).reason,
          "invalid_request",
        );
      assert.strictEqual(state.readCalls, 0);
      yield* assertEmpty(relay);
    }).pipe(Effect.provide(layerDatabase)),
  );
  it.effect(
    "dedupes pruned imports by original digest without allocating a new fact or relay timestamp",
    () =>
      Effect.gen(function* () {
        const { relay, state, sql } = yield* fixture;
        const original = entry(fact(1));
        state.page = page([original]);
        yield* relay.followOnce(peer);
        const receipt = yield* sql`SELECT * FROM agent_event_relay_imports`;
        // Model the payload/occurrence prefix removed by log retention; the import receipt must outlive it.
        yield* sql`DELETE FROM agent_event_facts`;
        yield* sql`DELETE FROM agent_event_occurrences`;
        const head = (yield* Store.logState()).headSeq;
        yield* sql`UPDATE agent_event_log_state SET floor_seq = head_seq + 1 WHERE id = 1`;
        yield* TestClock.adjust("2 seconds");
        state.page = page([original], {
          epoch: "peer-epoch-2",
          next: { epoch: "peer-epoch-2", seq: 1 },
          truncated: true,
        });
        assert.strictEqual((yield* relay.followOnce(peer)).imported, 0);
        assert.deepEqual(yield* sql`SELECT * FROM agent_event_relay_imports`, receipt);
        assert.strictEqual((yield* Store.logState()).headSeq, head + 2); // gap + following only
        assert.isTrue((yield* Facts.readFacts(0)).every((row) => row.kind === "source_status"));
        state.page = page([entry(fact(1, { summary: "Changed after pruning" }))], {
          epoch: "peer-epoch-3",
          next: { epoch: "peer-epoch-3", seq: 1 },
          truncated: true,
        });
        assert.strictEqual((yield* relay.followOnce(peer)).cursor.detail, "identity_changed");
        assert.strictEqual((yield* relay.peerCursor(peer))!.peerEpoch, "peer-epoch-2");
      }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("retains the tighter link ceiling when the requester has broader modes", () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      const original = entry(fact(1));
      state.page = page([original]);
      yield* relay.followOnce(peer);
      state.requester = {
        verdict: "allowed",
        authorization: {
          peerEnvironmentId: peer,
          generation: "requester-generation-2",
          limits: { runtimeMode: "full-access", interactionMode: "default" },
        },
      };
      assert.deepEqual((yield* relay.checkCached(cached(original.eventId))).decision, {
        verdict: "allowed",
      });
      assert.deepEqual(state.lastProofCall!.authorization.limits, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect("enforces the long-poll ceiling even when the wake source never signals", () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      const waiting = yield* Deferred.make<void>();
      state.wait = () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never));
      const log = yield* Store.logState();
      const fiber = yield* asPeer(
        relay.readOrigin({ after: { epoch: log.epoch, seq: 0 }, waitMs: 45_000 }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust("45 seconds");
      assert.strictEqual((yield* Fiber.join(fiber)).next.seq, 0);
    }).pipe(Effect.provide(layerDatabase)),
  );

  it.effect(
    "rolls back a fact that exceeds the 16KiB event budget after relay metadata is added",
    () =>
      Effect.gen(function* () {
        const { relay, state } = yield* fixture;
        const base = fact(1, { detail: { text: "" } });
        const original = fact(1, {
          detail: {
            text: "x".repeat(
              Wire.AGENT_FACT_RELAY_LIMITS.factBytes - Buffer.byteLength(stableStringify(base)),
            ),
          },
        });
        assert.strictEqual(
          Buffer.byteLength(stableStringify(original)),
          Wire.AGENT_FACT_RELAY_LIMITS.factBytes,
        );
        state.page = page([entry(original)]);
        assert.strictEqual((yield* Effect.flip(relay.followOnce(peer))).reason, "storage");
        yield* assertEmpty(relay);
      }).pipe(Effect.provide(layerDatabase)),
  );
});

it.effect(
  "first follow skips retained terminal facts, queues new facts and resumes a durable cursor",
  () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixtureFor(false);
      yield* subscribe();
      const old = entry(fact(1, { kind: "run_finished" }));
      const next = entry(fact(2));
      const requests: Wire.AgentFactRelayRead[] = [];
      state.read = (input) =>
        Effect.sync(() => {
          requests.push(input.request);
          return input.request.after === null
            ? page([], { headSeq: 1, next: { epoch: "peer-epoch-1", seq: 1 } })
            : page([next]);
        });
      assert.equal((yield* relay.followOnce(peer)).imported, 0);
      assert.equal(requests[0]?.waitMs, 0);
      assert.isNull(requests[0]!.after);
      assert.isFalse(
        (yield* Store.listDeliveries("all", 100)).some((row) => row.eventId === old.eventId),
      );
      assert.equal((yield* relay.followOnce(peer)).imported, 1);
      assert.deepEqual(requests[1]?.after, { epoch: "peer-epoch-1", seq: 1 });
      assert.isTrue(
        (yield* Store.listDeliveries("all", 100)).some((row) => row.eventId === next.eventId),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "invalid pages durably invalidate authority once and recovery creates a new following transition",
  () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      state.page = page([entry(fact(1))]);
      const first = yield* relay.followOnce(peer);
      state.read = () => Effect.succeed({ ...page(), unknown: true });
      const bad = yield* relay.followOnce(peer);
      assert.equal(bad.cursor.status, "unsupported");
      assert.equal(bad.cursor.detail, "invalid_page");
      assert.isNull(bad.cursor.authorizationGeneration);
      assert.equal(bad.cursor.peerSeq, first.cursor.peerSeq);
      assert.equal(
        (yield* relay.followOnce(peer)).cursor.statusTransition,
        bad.cursor.statusTransition,
      );
      state.read = undefined;
      state.page = page([], { headSeq: 1, next: { epoch: "peer-epoch-1", seq: 1 } });
      assert.equal(
        (yield* relay.followOnce(peer)).cursor.statusTransition,
        bad.cursor.statusTransition + 1,
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "same-epoch restored head records an atomic gap and dedupes replay without repeating it",
  () =>
    Effect.gen(function* () {
      const { relay, state, sql } = yield* fixture;
      state.page = page([entry(fact(1)), entry(fact(2))]);
      yield* relay.followOnce(peer);
      state.page = page([entry(fact(1))], { truncated: true });
      yield* sql`CREATE TRIGGER refuse_reset BEFORE UPDATE ON agent_event_peer_cursors BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
      assert.equal((yield* Effect.flip(relay.followOnce(peer))).reason, "storage");
      assert.equal((yield* relay.peerCursor(peer))?.peerSeq, 2);
      yield* sql`DROP TRIGGER refuse_reset`;
      const restored = yield* relay.followOnce(peer);
      assert.equal(restored.imported, 0);
      assert.equal(restored.cursor.peerSeq, 1);
      assert.equal(restored.cursor.statusTransition, 3);
      state.page = page([], { headSeq: 1, next: { epoch: "peer-epoch-1", seq: 1 } });
      assert.equal((yield* relay.followOnce(peer)).cursor.statusTransition, 3);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "a third environment sees private peer-status holes but can validate only self status",
  () =>
    Effect.gen(function* () {
      const { relay, state } = yield* fixture;
      state.incoming = {
        verdict: "allowed",
        authorization: {
          peerEnvironmentId: "environment-c",
          generation: "c-link",
          limits: { runtimeMode: "approval-required", interactionMode: "plan" },
        },
      };
      const self = yield* localFact(1, {
        kind: "source_status",
        thread: null,
        owner: null,
        run: null,
        detail: { environmentId: local.id, status: "following" },
      });
      const privateStatus = yield* localFact(2, {
        kind: "source_status",
        thread: null,
        owner: null,
        run: null,
        detail: { environmentId: peer, status: "unreachable", detail: "private peer reason" },
      });
      const first = yield* Facts.appendFact({ data: self, recordedAt: 0 });
      const hidden = yield* Facts.appendFact({ data: privateStatus, recordedAt: 0 });
      const log = yield* Store.logState();
      const third = { ...scope, client: { ...scope.client!, sessionId: "environment-c-link" } };
      const exported = yield* relay
        .readOrigin({ after: { epoch: log.epoch, seq: 0 } })
        .pipe(Effect.provideService(Invocation.McpInvocationContext, third));
      assert.deepEqual(
        exported.facts.map((row) => row.eventId),
        [first.eventId],
      );
      assert.equal(exported.next.seq, hidden.logSeq);
      const proof = yield* relay
        .validateOrigin({
          authorizationGeneration: null,
          references: [first, hidden].map((row) => ({
            eventId: row.eventId,
            originGeneration: self.origin.sourceGeneration,
            threadId: null,
          })),
        })
        .pipe(Effect.provideService(Invocation.McpInvocationContext, third));
      assert.deepEqual(
        proof.results.map((row) => row.decision.verdict),
        ["allowed", "refused"],
      );
      state.incoming = { verdict: "refused", reason: "read_scope_lost" };
      const cachedReference = {
        eventId: first.eventId,
        originGeneration: self.origin.sourceGeneration,
        threadId: null,
      };
      const revoked = yield* Effect.flip(
        relay
          .validateOrigin({
            authorizationGeneration: proof.authorizationGeneration,
            references: [cachedReference],
          })
          .pipe(Effect.provideService(Invocation.McpInvocationContext, third)),
      );
      assert.equal(revoked.reason, "capability_denied");
    }).pipe(Effect.provide(layerDatabase)),
);
