import {
  EnvironmentId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as ApprovalPresentation from "../approvals/ApprovalPresentation.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as FleetUsers from "../lan/FleetUsers.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SourceStore from "../persistence/OrchestrationEventStore.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as DeliveryStore from "./AgentEventStore.ts";
import * as Facts from "./AgentFactStore.ts";
import * as Checkpoints from "./AgentFactCheckpoints.ts";
import * as Reducer from "./AgentFactReducer.ts";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";
import { reduceNativeObservation } from "./AgentGatewayCompatibilityReducer.ts";
import { randomToken } from "./identity.ts";

/** An on-demand native read can precede activation; it captures persisted source rows, never
 * historical transitions inferred from today's work projection, and owns no ingestion cursor. */
export const captureNativeObservations = Effect.fn("AgentFactDeriver.captureNativeObservations")(
  function* (environmentId: string, rows: ReadonlyArray<OrchestrationV2StoredEvent>) {
    const observations = [];
    for (const row of rows) {
      const observation = reduceNativeObservation(row);
      if (observation === undefined) continue;
      yield* Facts.appendFact({
        data: CompatibilityFacts.observationData(environmentId, row.event.threadId, observation),
        recordedAt: yield* Clock.currentTimeMillis,
      });
      observations.push(observation);
    }
    return observations;
  },
);

export class DerivationError extends Schema.TaggedError<DerivationError>()(
  "AgentFactDerivationError",
  {
    reason: Schema.Literals(["activation_failed", "replay_failed", "source_gap", "stale_recovery"]),
    sourceSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Event facts could not advance from their durable source checkpoint.";
  }
}
interface SourceState {
  readonly generation: string;
  readonly activatedAt: number | null;
  readonly lastEventId: string | null;
  readonly gapSequence: number | null;
  readonly rebuildSequence: number | null;
  readonly rebuildEventId: string | null;
  readonly bootstrapSequence: number | null;
}
const readSourceState = Effect.fn("AgentFactDeriver.readSourceState")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<SourceState>`SELECT generation, activated_at AS "activatedAt",
    last_event_id AS "lastEventId", gap_sequence AS "gapSequence", rebuild_sequence AS "rebuildSequence",
    rebuild_event_id AS "rebuildEventId", bootstrap_sequence AS "bootstrapSequence" FROM agent_event_source_state WHERE id = 1`)[0]!;
});

/** Source state and log progress are durable; constructing this service never activates collection. */
export class AgentFactDeriver extends Context.Service<
  AgentFactDeriver,
  {
    readonly activate: Effect.Effect<void, DerivationError>;
    readonly rebuild: Effect.Effect<
      { readonly restored: number; readonly cursorEpoch: string },
      DerivationError
    >;
    readonly rebootstrap: (expected: {
      readonly generation: string;
      readonly throughSequence: number;
    }) => Effect.Effect<
      { readonly generation: string; readonly bootstrapSequence: number },
      DerivationError
    >;
    readonly catchUp: Effect.Effect<
      { readonly throughSequence: number; readonly facts: number },
      DerivationError
    >;
  }
>()("t3/agentEvents/AgentFactDeriver") {}

const isDerivationError = Schema.is(DerivationError);
const make = Effect.fn("AgentFactDeriver.make")(function* (environment: {
  readonly id: string;
  readonly label: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const source = yield* SourceStore.OrchestrationEventStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const users = yield* FleetUsers.FleetUsers;
  const lane = yield* Semaphore.make(1);

  const presentations = Effect.fn("AgentFactDeriver.presentations")(function* (
    threadId: string,
    requests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
    items: ReadonlyArray<OrchestrationV2TurnItem>,
  ) {
    const shown = new Map<string, Readonly<Record<string, unknown>>>();
    const byRequest = new Map(requests.map((request) => [request.id, request]));
    for (const item of items) {
      if (item.type !== "approval_request") continue;
      const request = byRequest.get(item.requestId);
      if (request === undefined) continue;
      const presentation = yield* ApprovalPresentation.presentation({
        environmentId: EnvironmentId.make(environment.id),
        threadId: ThreadId.make(threadId),
        request,
        item,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      if (presentation === undefined || request.responseCapability.type !== "live") continue;
      shown.set(request.id, {
        ...presentation,
        ...presentation.expected,
        answerable: {
          via: "t3_approval_request",
          decisions: ["accept", "decline"],
          requiredConsentScope: "turn",
        },
      });
    }
    return (request: OrchestrationV2RuntimeRequest) => shown.get(request.id) ?? {};
  });

  const activateSnapshot = Effect.fn("AgentFactDeriver.activateSnapshot")(function* (
    observation: FleetUsers.FleetUsersObservation,
  ) {
    const generation = yield* Journal.sourceGeneration();
    if ((yield* readSourceState()).activatedAt !== null) return;
    const now = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.makeUnsafe(now);
    const sequence = yield* source.latestApplicationSequence;
    const [active, archived] = yield* Effect.all([
      projections.getShellSnapshot({ location: "active" }),
      projections.getShellSnapshot({ location: "archive" }),
    ]);
    const ids = [
      ...new Set([...active.threads, ...archived.threads].map((thread) => thread.id)),
    ].sort();
    yield* Journal.recordObservation(observation);
    let factCount = 0;
    for (const threadId of ids) {
      const snapshot = yield* projections.getThreadRecords(
        threadId,
        ["runs", "attempts", "runtimeRequests", "turnItems", "messages"],
        { turnItemTypes: ["approval_request", "user_input_request", "secret_request"] },
      );
      const assignment = (yield* sql<{ readonly sequence: number }>`
                SELECT assignment_revision AS sequence FROM agent_event_owner_assignments
                WHERE thread_id = ${threadId} AND source_generation = ${generation}
                  AND owner_id IS ${snapshot.thread.ownerId ?? null}`)[0]?.sequence;
      const approvalPresentation = yield* presentations(
        threadId,
        snapshot.runtimeRequests,
        snapshot.turnItems,
      );
      const bootstrapped = yield* Effect.try({
        try: () =>
          Reducer.bootstrap({
            snapshot,
            sequence,
            assignmentRevision: assignment ?? null,
            environment,
            sourceGeneration: generation,
            observation,
            observedAt,
            transitionOffset: factCount,
            approvalPresentation,
          }),
        catch: (cause) =>
          new DerivationError({
            reason: "activation_failed",
            sourceSequence: sequence,
            cause,
          }),
      });
      const checkpoints = yield* Checkpoints.writes(threadId, bootstrapped.state);
      yield* Facts.writeCheckpoints({
        generation,
        sequence,
        states: checkpoints.states,
        deleteStateKeys: [],
      });
      for (const data of bootstrapped.facts) yield* Facts.appendFact({ data, recordedAt: now });
      factCount += bootstrapped.facts.length;
    }
    yield* DeliveryStore.logState();
    const anchor =
      (yield* sql<{ readonly id: string }>`SELECT event_id AS id
        FROM orchestration_events WHERE sequence = ${sequence}`)[0]?.id ?? null;
    yield* sql`UPDATE agent_event_log_state SET derived_through_sequence = ${sequence} WHERE id = 1`;
    yield* sql`UPDATE agent_event_source_state SET origin_environment_id = ${environment.id}, bootstrap_sequence = ${sequence},
        bootstrap_event_id = ${anchor}, rebuild_sequence = ${sequence}, rebuild_event_id = ${anchor}, activated_at = ${now}, last_event_id = ${anchor} WHERE id = 1`;
  });
  const activate = Effect.fn("AgentFactDeriver.activate")(
    function* () {
      // The directory lane precedes SQL, matching source commitment without share I/O.
      yield* users.withObservationSnapshot((observation) =>
        sql.withTransaction(activateSnapshot(observation)),
      );
    },
    Effect.mapError((cause) =>
      isDerivationError(cause)
        ? cause
        : new DerivationError({ reason: "activation_failed", cause }),
    ),
  );

  const recordGap = Effect.fn("AgentFactDeriver.recordGap")(function* (
    expectedAfter: number,
    nextAvailable: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* readSourceState();
        if (current.gapSequence !== null) return;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE agent_event_source_state SET gap_sequence = ${expectedAfter}, gap_at = ${now} WHERE id = 1`;
        yield* Facts.appendFact({
          recordedAt: now,
          data: {
            schema: "t3.agent-event/1",
            kind: "source_status",
            factKey: `local-source:${current.generation}:gap:${expectedAfter}`,
            summary: "T3 event source history has a gap",
            textIsUntrusted: true,
            environment,
            thread: null,
            run: null,
            owner: null,
            relay: null,
            origin: {
              environmentId: environment.id,
              sourceGeneration: current.generation,
              sourceKind: "peer_status",
              sourceSequence: expectedAfter,
              transitionOrdinal: 0,
              threadSequence: null,
              occurredAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            },
            detail: {
              environmentId: environment.id,
              status: "gap",
              since: DateTime.formatIso(DateTime.makeUnsafe(now)),
              detail: "Source history is unavailable; intervening transitions are unknown.",
              expectedAfter,
              nextAvailable,
            },
          },
        });
      }),
    );
  });

  const deriveOne = Effect.fn("AgentFactDeriver.deriveOne")(function* (
    stored: ApplicationStoredEvent,
    restoring = false,
  ) {
    const through = yield* Facts.progress();
    if (stored.sequence <= through) return 0;
    if (stored.sequence !== through + 1) {
      yield* recordGap(through, stored.sequence);
      return yield* new DerivationError({ reason: "source_gap", sourceSequence: through });
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* readSourceState();
        let states: Array<{
          readonly key: string;
          readonly sourceSequence: number;
          readonly json: string;
        }> = [];
        let deleteStateKeys: ReadonlyArray<string> = [];
        let data: ReadonlyArray<Facts.FactData> = [];
        let privateFacts: ReadonlyArray<Facts.FactWrite> = [];
        if ("event" in stored) {
          const event = stored.event;
          const previous = yield* Checkpoints.load(event);
          if (previous === undefined && event.type !== "thread.created")
            return yield* new DerivationError({
              reason: "source_gap",
              sourceSequence: stored.sequence,
            });
          const before = previous ?? Reducer.emptyState();
          const observation = yield* Journal.readForSource(current.generation, stored.sequence);
          const requests = new Map(
            Object.values(before.requests).map((entry) => [entry.request.id, entry.request]),
          );
          const items = new Map(
            Object.values(before.attentionItems).map((item) => [item.id, item]),
          );
          if (event.type === "runtime-request.updated")
            requests.set(event.payload.id, event.payload);
          if (event.type === "turn-item.updated") items.set(event.payload.id, event.payload);
          const approvalPresentation = yield* presentations(
            event.threadId,
            [...requests.values()],
            [...items.values()],
          );
          const reduced = yield* Effect.try({
            try: () =>
              Reducer.reduce({
                before,
                sequence: stored.sequence,
                event,
                environment,
                sourceGeneration: current.generation,
                approvalPresentation,
                ...(observation === undefined ? {} : { observation }),
              }),
            catch: (cause) =>
              new DerivationError({
                reason: "replay_failed",
                sourceSequence: stored.sequence,
                cause,
              }),
          });
          const checkpoints = yield* Checkpoints.writes(event.threadId, reduced.state, before);
          states = checkpoints.states;
          deleteStateKeys = checkpoints.deleteStateKeys;
          data = reduced.facts;
          if (!restoring && reduced.observation !== undefined)
            privateFacts = [
              {
                data: CompatibilityFacts.observationData(
                  environment.id,
                  event.threadId,
                  reduced.observation,
                ),
                recordedAt: yield* Clock.currentTimeMillis,
              },
            ];
        }
        const now = yield* Clock.currentTimeMillis;
        yield* Facts.commitSource({
          expectedThrough: through,
          throughSequence: stored.sequence,
          states,
          deleteStateKeys,
          facts: [
            ...data.map((data) => ({
              data,
              recordedAt: now,
              ...(restoring ? { restore: true } : {}),
            })),
            ...privateFacts,
          ],
        });
        const id = "event" in stored ? stored.event.id : stored.eventId;
        yield* sql`UPDATE agent_event_source_state SET last_event_id = ${id} WHERE id = 1`;
        return data.length;
      }),
    );
  });

  const catchUp = Effect.fn("AgentFactDeriver.catchUp")(
    function* () {
      yield* activate();
      const through = yield* Facts.progress();
      const current = yield* readSourceState();
      if (current.gapSequence !== null)
        return yield* new DerivationError({ reason: "source_gap", sourceSequence: through });
      const head = yield* source.latestApplicationSequence;
      const anchor =
        through === 0
          ? null
          : (yield* sql<{ readonly id: string }>`
      SELECT event_id AS id FROM orchestration_events WHERE sequence = ${through}`)[0]?.id;
      if (head < through || (through > 0 && anchor !== current.lastEventId)) {
        yield* recordGap(through, head);
        return yield* new DerivationError({ reason: "source_gap", sourceSequence: through });
      }
      let facts = 0;
      yield* source.readApplicationEvents({ afterSequence: through, throughSequence: head }).pipe(
        Stream.runForEach((stored) =>
          deriveOne(stored).pipe(
            Effect.catchTags({
              AgentFactDerivationError: (error) =>
                error.reason === "source_gap"
                  ? Facts.progress().pipe(
                      Effect.flatMap((sequence) => recordGap(sequence, stored.sequence)),
                      Effect.andThen(Effect.fail(error)),
                    )
                  : Effect.fail(error),
            }),
            Effect.tap((count) =>
              Effect.sync(() => {
                facts += count;
              }),
            ),
          ),
        ),
      );
      const advanced = yield* Facts.progress();
      if (advanced !== head) {
        yield* recordGap(advanced, head);
        return yield* new DerivationError({ reason: "source_gap", sourceSequence: advanced });
      }
      return { throughSequence: advanced, facts };
    },
    Effect.mapError((cause) =>
      isDerivationError(cause) ? cause : new DerivationError({ reason: "replay_failed", cause }),
    ),
  );

  const rebuild = Effect.fn("AgentFactDeriver.rebuild")(
    function* () {
      yield* activate();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* readSourceState();
          const through = yield* Facts.progress();
          yield* Facts.restoreInternalFacts();
          if (current.gapSequence !== null || current.rebuildSequence === null)
            return yield* new DerivationError({ reason: "source_gap", sourceSequence: through });
          const base = current.rebuildSequence;
          const anchor =
            base === 0
              ? null
              : (yield* sql<{
                  readonly id: string;
                }>`SELECT event_id AS id FROM orchestration_events WHERE sequence = ${base}`)[0]
                  ?.id;
          if (anchor !== current.rebuildEventId)
            return yield* new DerivationError({ reason: "source_gap", sourceSequence: base });
          const expected = (yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM agent_event_occurrences
        WHERE origin_environment_id = ${environment.id} AND source_generation = ${current.generation}
          AND source_kind IN ('bootstrap', 'orchestration')`)[0]!.count;
          const bootstrap = yield* sql<{
            readonly json: string;
            readonly recordedAt: number;
          }>`SELECT bootstrap_json AS json, recorded_at AS "recordedAt"
        FROM agent_event_occurrences WHERE origin_environment_id = ${environment.id} AND source_generation = ${current.generation}
          AND bootstrap_json IS NOT NULL ORDER BY log_seq`;
          yield* sql`DELETE FROM agent_event_facts WHERE origin_environment_id = ${environment.id} AND origin_generation = ${current.generation}
        AND source_kind IN ('bootstrap', 'orchestration')`;
          yield* sql`DELETE FROM agent_event_derivation_state`;
          yield* sql`INSERT INTO agent_event_derivation_state (state_key, source_sequence, state_json)
        SELECT history.state_key, history.source_sequence, history.state_json FROM agent_event_reducer_history AS history
        WHERE history.source_generation = ${current.generation} AND history.source_sequence <= ${base} AND history.state_json IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agent_event_reducer_history AS newer WHERE newer.source_generation = history.source_generation
            AND newer.state_key = history.state_key AND newer.source_sequence > history.source_sequence AND newer.source_sequence <= ${base})`;
          yield* sql`UPDATE agent_event_log_state SET derived_through_sequence = ${base} WHERE id = 1`;
          yield* sql`UPDATE agent_event_source_state SET last_event_id = ${anchor ?? null} WHERE id = 1`;
          for (const entry of bootstrap)
            yield* Facts.appendFact({
              data: yield* Facts.decodeFactDataJson(entry.json),
              recordedAt: entry.recordedAt,
              restore: true,
            });
          yield* source
            .readApplicationEvents({ afterSequence: base, throughSequence: through })
            .pipe(Stream.runForEach((stored) => deriveOne(stored, true)));
          const restored = (yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM agent_event_facts
        WHERE origin_environment_id = ${environment.id} AND origin_generation = ${current.generation}
          AND source_kind IN ('bootstrap', 'orchestration')`)[0]!.count;
          if ((yield* Facts.progress()) !== through || restored !== expected)
            return yield* new DerivationError({ reason: "source_gap", sourceSequence: through });
          const log = yield* DeliveryStore.logState();
          const slots = (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM (
            SELECT log_seq FROM agent_event_facts UNION ALL SELECT log_seq FROM agent_event_probes
          ) WHERE log_seq >= ${log.floorSeq} AND log_seq <= ${log.headSeq}`)[0]!.count;
          if (slots !== Math.max(0, log.headSeq - log.floorSeq + 1))
            return yield* new DerivationError({ reason: "source_gap", sourceSequence: through });
          const cursorEpoch = randomToken(18);
          yield* sql`UPDATE agent_event_log_state SET epoch = ${cursorEpoch} WHERE id = 1`;
          yield* sql`UPDATE agent_event_subscriptions SET log_epoch = ${cursorEpoch}`;
          return { restored, cursorEpoch };
        }),
      );
    },
    Effect.mapError((cause) =>
      isDerivationError(cause) ? cause : new DerivationError({ reason: "replay_failed", cause }),
    ),
  );

  const rebootstrap = Effect.fn("AgentFactDeriver.rebootstrap")(
    function* (expected: { readonly generation: string; readonly throughSequence: number }) {
      yield* activate();
      return yield* users.withObservationSnapshot((observation) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* readSourceState();
            const through = yield* Facts.progress();
            if (current.generation !== expected.generation || through !== expected.throughSequence)
              return yield* new DerivationError({
                reason: "stale_recovery",
                sourceSequence: through,
              });
            const generation = `src_${randomToken(18)}`;
            const sequence = yield* source.latestApplicationSequence;
            const now = yield* Clock.currentTimeMillis;
            yield* sql`DELETE FROM agent_event_derivation_state`;
            yield* sql`UPDATE agent_event_source_state SET generation = ${generation}, activated_at = NULL,
        bootstrap_sequence = NULL, bootstrap_event_id = NULL, rebuild_sequence = NULL, rebuild_event_id = NULL,
        last_event_id = NULL, gap_sequence = NULL, gap_at = NULL WHERE id = 1`;
            yield* Facts.appendFact({
              recordedAt: now,
              data: {
                schema: "t3.agent-event/1",
                kind: "source_status",
                factKey: `local-source:${generation}:reset`,
                summary: "T3 event collection resumed from a new source snapshot",
                textIsUntrusted: true,
                environment,
                thread: null,
                run: null,
                owner: null,
                relay: null,
                origin: {
                  environmentId: environment.id,
                  sourceGeneration: generation,
                  sourceKind: "peer_status",
                  sourceSequence: sequence,
                  transitionOrdinal: 0,
                  threadSequence: null,
                  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                },
                detail: {
                  environmentId: environment.id,
                  status: "reset",
                  previousGeneration: current.generation,
                  sourceGeneration: generation,
                  since: DateTime.formatIso(DateTime.makeUnsafe(now)),
                  detail:
                    "Intervening transitions are unknown; pending attention is a fresh bootstrap snapshot.",
                },
              },
            });
            yield* activateSnapshot(observation);
            return { generation, bootstrapSequence: sequence };
          }),
        ),
      );
    },
    Effect.mapError((cause) =>
      isDerivationError(cause)
        ? cause
        : new DerivationError({ reason: "activation_failed", cause }),
    ),
  );

  return AgentFactDeriver.of({
    activate: lane.withPermits(1)(activate()).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    rebuild: lane.withPermits(1)(rebuild()).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    rebootstrap: Effect.fn("AgentFactDeriver.rebootstrapGuarded")((expected) =>
      lane
        .withPermits(1)(rebootstrap(expected))
        .pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
    catchUp: lane.withPermits(1)(catchUp()).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  });
});

export const layer = (environment: { readonly id: string; readonly label: string }) =>
  Layer.effect(AgentFactDeriver, make(environment));
