import { FleetUsersDirectory, type AgentEventDirectoryReference } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { FleetUsersObservation } from "../lan/FleetUsers.ts";
import { randomToken } from "./identity.ts";

export class OwnerJournalConflict extends Schema.TaggedError<OwnerJournalConflict>()(
  "OwnerJournalConflict",
  {
    reason: Schema.Literals(["observation_changed", "source_rebound"]),
    generation: Schema.String,
    sourceSequence: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return "The owner journal already records a different immutable observation.";
  }
}

const Observation = Schema.Struct({
  status: Schema.Literals(["fresh", "unavailable", "invalid", "absent", "never_read"]),
  observedAt: Schema.NullOr(Schema.Number),
  observationGeneration: Schema.String,
  directoryDigest: Schema.NullOr(Schema.String),
  lastGoodObservedAt: Schema.NullOr(Schema.Number),
  directory: FleetUsersDirectory,
});
const decodeObservation = Schema.decodeUnknownEffect(Schema.fromJsonString(Observation));

/** Independent of the delivery-log epoch, so rebuilding facts preserves origin identities. */
export const sourceGeneration = Effect.fn("AgentEventOwnerJournal.sourceGeneration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly generation: string }>`
    SELECT generation FROM agent_event_source_state WHERE id = 1`;
  if (rows[0] !== undefined) return rows[0].generation;
  yield* sql`INSERT OR IGNORE INTO agent_event_source_state (id, generation)
    VALUES (1, ${`src_${randomToken(18)}`})`;
  return (yield* sql<{ readonly generation: string }>`
    SELECT generation FROM agent_event_source_state WHERE id = 1`)[0]!.generation;
});

/** A generation is an observation occurrence, not a content hash. It is never overwritten. */
export const recordObservation = Effect.fn("AgentEventOwnerJournal.recordObservation")(function* (
  observation: FleetUsersObservation,
) {
  const sql = yield* SqlClient.SqlClient;
  const json = stableStringify(observation);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT OR IGNORE INTO agent_event_directories
        (generation, content_digest, status, observed_at, last_good_observed_at, directory_json)
        VALUES (${observation.observationGeneration}, ${observation.directoryDigest},
          ${observation.status}, ${observation.observedAt}, ${observation.lastGoodObservedAt}, ${json})`;
      const rows = yield* sql<{ readonly json: string }>`
        SELECT directory_json AS json FROM agent_event_directories
        WHERE generation = ${observation.observationGeneration}`;
      if (rows[0]?.json !== json)
        return yield* new OwnerJournalConflict({
          reason: "observation_changed",
          generation: observation.observationGeneration,
        });
    }),
  );
});

/** Binds an already-persisted observation inside the native source transaction. */
export const bindDirectoryReference = Effect.fn("AgentEventOwnerJournal.bindDirectoryReference")(
  function* (input: {
    readonly reference: AgentEventDirectoryReference;
    readonly sourceSequences: ReadonlyArray<number>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    for (const sequence of new Set(input.sourceSequences)) {
      yield* sql`INSERT OR IGNORE INTO agent_event_source_directories
      (source_generation, source_sequence, directory_generation)
      VALUES (${input.reference.sourceGeneration}, ${sequence}, ${input.reference.directoryGeneration})`;
      const rows = yield* sql<{
        readonly generation: string;
      }>`SELECT directory_generation AS generation
      FROM agent_event_source_directories WHERE source_generation = ${input.reference.sourceGeneration}
        AND source_sequence = ${sequence}`;
      if (rows[0]?.generation !== input.reference.directoryGeneration)
        return yield* new OwnerJournalConflict({
          reason: "source_rebound",
          generation: input.reference.sourceGeneration,
          sourceSequence: sequence,
        });
    }
  },
);

/** Both the immutable observation and its bindings roll back together. */
export const bindSourceEvents = Effect.fn("AgentEventOwnerJournal.bindSourceEvents")(
  function* (input: {
    readonly sourceGeneration: string;
    readonly sourceSequences: ReadonlyArray<number>;
    readonly observation: FleetUsersObservation;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* recordObservation(input.observation);
        yield* bindDirectoryReference({
          reference: {
            sourceGeneration: input.sourceGeneration,
            directoryGeneration: input.observation.observationGeneration,
          },
          sourceSequences: input.sourceSequences,
        });
      }),
    );
  },
);

export const readObservation = Effect.fn("AgentEventOwnerJournal.readObservation")(function* (
  generation: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly json: string }>`
      SELECT directory_json AS json FROM agent_event_directories WHERE generation = ${generation}`;
  return rows[0] === undefined ? undefined : yield* decodeObservation(rows[0].json);
});

export const readForSource = Effect.fn("AgentEventOwnerJournal.readForSource")(function* (
  sourceGeneration: string,
  sourceSequence: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly json: string }>`
      SELECT d.directory_json AS json FROM agent_event_source_directories s
      JOIN agent_event_directories d ON d.generation = s.directory_generation
      WHERE s.source_generation = ${sourceGeneration} AND s.source_sequence = ${sourceSequence}`;
  return rows[0] === undefined ? undefined : yield* decodeObservation(rows[0].json);
});

/** The assignment coordinate survives native event compaction and never comes from an owner label. */
export const recordAssignment = Effect.fn("AgentEventOwnerJournal.recordAssignment")(
  function* (input: {
    readonly threadId: string;
    readonly sourceGeneration: string;
    readonly sequence: number;
    readonly ownerId: string | null;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO agent_event_owner_assignments (thread_id, source_generation, assignment_revision, owner_id)
    VALUES (${input.threadId}, ${input.sourceGeneration}, ${input.sequence}, ${input.ownerId})
    ON CONFLICT(thread_id) DO UPDATE SET source_generation = excluded.source_generation,
      assignment_revision = excluded.assignment_revision, owner_id = excluded.owner_id
    WHERE agent_event_owner_assignments.source_generation <> excluded.source_generation
      OR agent_event_owner_assignments.assignment_revision < excluded.assignment_revision`;
  },
);
