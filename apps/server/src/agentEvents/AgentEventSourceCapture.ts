import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as FleetUsers from "../lan/FleetUsers.ts";
import { AgentEventCapture } from "../persistence/AgentEventCapture.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";

const absentDirectory: FleetUsers.FleetUsersObservation = {
  status: "never_read",
  observedAt: null,
  lastGoodObservedAt: null,
  directoryDigest: null,
  observationGeneration: "no-fleet-directory",
  directory: FleetUsers.NO_FLEET_USERS,
};

/** Directory capture precedes the SQL lane; filesystem refresh never runs in a source transaction. */
export const withTransaction = Effect.fn("AgentEventSourceCapture.withTransaction")(function* <
  A,
  E,
  R,
>(effect: Effect.Effect<A, E, R>) {
  const sql = yield* SqlClient.SqlClient;
  const users = yield* Effect.serviceOption(FleetUsers.FleetUsers);
  // The enclosing capture and SQL transaction own the span for this per-commit callback.
  const commit = Effect.fnUntraced(function* (observation: FleetUsers.FleetUsersObservation) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const sourceGeneration = yield* Journal.sourceGeneration();
        yield* Journal.recordObservation(observation);
        return yield* effect.pipe(
          Effect.provideService(AgentEventCapture, {
            sourceGeneration,
            directoryGeneration: observation.observationGeneration,
          }),
        );
      }),
    );
  });
  return yield* Option.isSome(users)
    ? users.value.withObservationSnapshot(commit)
    : commit(absentDirectory);
});
