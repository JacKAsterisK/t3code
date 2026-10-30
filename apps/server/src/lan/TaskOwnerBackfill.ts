/**
 * T3 Code LAN: once this machine knows its default owner from fleet-users.json, it gives every
 * thread it hosts that has no owner that default, exactly once. A marker in userdata records the
 * pass, so a later read never reassigns a thread. Owners only change by a person's choice after it.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";
import * as FleetUsers from "./FleetUsers.ts";

export const TASK_OWNER_BACKFILL_FILE = "task-owner-backfill.json";

const Marker = Schema.Struct({
  version: Schema.Literal(1),
  ownerId: Schema.String,
  assigned: Schema.Number,
  completedAt: Schema.String,
});

export const make = Effect.gen(function* () {
  const fleetUsers = yield* FleetUsers.FleetUsers;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const markerFile = path.join(config.stateDir, TASK_OWNER_BACKFILL_FILE);

  const ran = fs.exists(markerFile).pipe(
    Effect.flatMap((exists) =>
      exists
        ? readFleetJson(markerFile, Marker).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.as(true),
          )
        : Effect.succeed(false),
    ),
    // An unreadable marker still records a pass: never reassign on a doubt.
    Effect.orElseSucceed(() => true),
  );

  /** Assigns every unowned thread here to `ownerId`; returns how many it assigned. */
  const backfill = Effect.fn("TaskOwnerBackfill.backfill")(function* (ownerId: string) {
    if (yield* ran) return 0;
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.ownerId') IS NULL
      ORDER BY thread_id
    `;
    let assigned = 0;
    for (const row of rows) {
      yield* orchestrator
        .dispatch({
          type: "thread.owner.set",
          // One per thread: a pass cut short and run again replays what it already did.
          commandId: CommandId.make(`server:owner-backfill:${row.thread_id}`),
          threadId: ThreadId.make(row.thread_id),
          ownerId,
        })
        .pipe(
          Effect.tap(() => Effect.sync(() => (assigned += 1))),
          Effect.catchCause((cause) =>
            Effect.logWarning("Task owner backfill skipped a thread.", {
              threadId: row.thread_id,
              cause,
            }),
          ),
        );
    }
    yield* writeFleetJson(markerFile, {
      version: 1,
      ownerId,
      assigned,
      completedAt: DateTime.formatIso(yield* DateTime.now),
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    yield* Effect.logInfo("Assigned this machine's unowned tasks to its default owner.", {
      ownerId,
      assigned,
    });
    return assigned;
  });

  const start = Effect.fn("TaskOwnerBackfill.start")(function* () {
    yield* forkParked(
      fleetUsers.changes.pipe(
        Stream.map((directory) => directory.defaultOwnerId),
        Stream.filter((ownerId): ownerId is string => ownerId !== null),
        Stream.take(1),
        Stream.runForEach((ownerId) =>
          backfill(ownerId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Task owner backfill failed; it runs again at next start.", {
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  });

  return { backfill, start };
});
