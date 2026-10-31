import { type AgentEventCurrentOwner, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FleetUsers from "../lan/FleetUsers.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

const MAX_DIRECTORY_AGE_MS = 2 * 60_000;
const iso = (at: number | null | undefined) =>
  at == null ? null : DateTime.formatIso(DateTime.makeUnsafe(at));
export class OwnerReadError extends Schema.TaggedError<OwnerReadError>()(
  "AgentEventOwnerReadError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Current task owner coordinates could not be established.";
  }
}
export class AgentEventOwners extends Context.Service<
  AgentEventOwners,
  {
    readonly read: (threadId: ThreadId) => Effect.Effect<AgentEventCurrentOwner, OwnerReadError>;
  }
>()("t3/agentEvents/AgentEventOwners") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projections.ProjectionStoreV2;
  const users = yield* Effect.serviceOption(FleetUsers.FleetUsers);
  const read = Effect.fn("AgentEventOwners.read")(
    function* (threadId: ThreadId) {
      const readSnapshot = Effect.fn("AgentEventOwners.readSnapshot")(function* (
        observation?: FleetUsers.FleetUsersObservation,
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const { thread } = yield* projections.getThreadRecords(threadId, []);
            const id = thread.ownerId ?? null;
            const user = observation?.directory.users.find((entry) => entry.id === id);
            const source = (yield* sql<{
              readonly generation: string;
            }>`SELECT generation FROM agent_event_source_state WHERE id = 1`)[0];
            const assignment = (yield* sql<{
              readonly generation: string;
              readonly revision: number;
              readonly ownerId: string | null;
            }>`
          SELECT source_generation AS generation, assignment_revision AS revision, owner_id AS "ownerId"
          FROM agent_event_owner_assignments WHERE thread_id = ${threadId}`)[0];
            const sequence = (yield* sql<{
              readonly sequence: number;
            }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`)[0]!
              .sequence;
            const fresh =
              observation?.status === "fresh" &&
              observation.observedAt !== null &&
              now >= observation.observedAt &&
              now - observation.observedAt <= MAX_DIRECTORY_AGE_MS;
            const revision =
              assignment?.generation === source?.generation && assignment?.ownerId === id
                ? assignment.revision
                : null;
            return {
              state: id === null ? "unassigned" : user === undefined ? "unknown_user" : "assigned",
              id,
              label: user?.name ?? null,
              assignmentRevision: revision,
              sourceGeneration: source?.generation ?? null,
              directoryGeneration: observation?.observationGeneration ?? null,
              directoryDigest: observation?.directoryDigest ?? null,
              directoryStatus:
                observation?.status === "fresh" && !fresh
                  ? "stale"
                  : (observation?.status ?? "unknown"),
              directoryObservedAt: iso(observation?.lastGoodObservedAt),
              directoryCheckedAt: iso(observation?.observedAt),
              asOfSourceSequence: sequence,
              readAt: iso(now)!,
              routingReady: fresh && revision !== null && (id === null || user !== undefined),
            } satisfies AgentEventCurrentOwner;
          }),
        );
      });
      return yield* Option.isSome(users)
        ? users.value.withObservationSnapshot(readSnapshot)
        : readSnapshot();
    },
    Effect.mapError((cause) => new OwnerReadError({ cause })),
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  return AgentEventOwners.of({ read });
});
export const layer = Layer.effect(AgentEventOwners, make);
