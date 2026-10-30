/**
 * T3 Code LAN: once this machine knows its default owner from fleet-users.json, it gives every
 * thread it hosts that has no owner that default, once. A marker in userdata records a pass that
 * covered every thread, so a later read never reassigns one. A pass that could not label a thread
 * writes no marker and runs again at next start. Owners only change by a person's choice after it.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
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

/** Some threads could not be labelled; the pass leaves no marker so the next start retries. */
export class TaskOwnerBackfillIncompleteError extends Schema.TaggedError<TaskOwnerBackfillIncompleteError>()(
  "TaskOwnerBackfillIncompleteError",
  {
    ownerId: Schema.String,
    assigned: Schema.Number,
    failed: Schema.Number,
  },
) {
  override get message(): string {
    return `Task owner backfill could not label ${this.failed} thread(s); it runs again at next start.`;
  }
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
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
    // Fresh ids each pass, so a thread a failed pass left is tried again instead of replayed.
    const pass = yield* crypto.randomUUIDv4();
    let assigned = 0;
    let failed = 0;
    for (const row of rows) {
      yield* orchestrator
        .dispatch({
          // Conditional: an owner someone chose since the read above stays.
          type: "thread.owner.assign-default",
          commandId: CommandId.make(`server:owner-backfill:${pass}:${row.thread_id}`),
          threadId: ThreadId.make(row.thread_id),
          ownerId,
        })
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.storedEvents.length > 0) assigned += 1;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => (failed += 1)).pipe(
              Effect.andThen(
                Effect.logWarning("Task owner backfill could not label a thread.", {
                  threadId: row.thread_id,
                  cause,
                }),
              ),
            ),
          ),
        );
    }
    if (failed > 0) {
      return yield* new TaskOwnerBackfillIncompleteError({ ownerId, assigned, failed });
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
