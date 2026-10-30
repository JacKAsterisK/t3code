import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as FleetUsers from "./FleetUsers.ts";
import * as TaskOwnerBackfill from "./TaskOwnerBackfill.ts";

type OwnerSet = Extract<OrchestrationV2Command, { readonly type: "thread.owner.set" }>;

const insertThread = (
  sql: SqlClient.SqlClient,
  id: string,
  options: { readonly ownerId?: string; readonly deleted?: boolean } = {},
) => {
  const at = "2026-10-01T00:00:00.000Z";
  return sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${id}, 'project:test', ${id}, 'codex', 'full-access', 'default',
      ${at}, ${at}, NULL, ${options.deleted === true ? at : null},
      ${JSON.stringify(options.ownerId === undefined ? { id } : { id, ownerId: options.ownerId })}
    )
  `;
};

/** A backfill whose orchestrator records each owner it is asked to set. */
const harness = (defaultOwnerId: string | null) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OwnerSet>>([]);
    const firstDispatch = yield* Deferred.make<void>();
    const layer = Layer.mergeAll(
      FleetUsers.layerStatic({ users: [], machineId: "machine-a", defaultOwnerId }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command as OwnerSet]).pipe(
            Effect.andThen(Deferred.succeed(firstDispatch, undefined)),
            Effect.as({ sequence: 0, storedEvents: [] } as never),
          ),
      }),
    );
    return { dispatched, firstDispatch, layer };
  });

const layerBase = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-backfill-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "gives only unowned live threads the default owner, once, and never again after a restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const marker = path.join(stateDir, TaskOwnerBackfill.TASK_OWNER_BACKFILL_FILE);
      yield* insertThread(sql, "thread:unowned-b");
      yield* insertThread(sql, "thread:unowned-a");
      yield* insertThread(sql, "thread:owned", { ownerId: "gavin" });
      yield* insertThread(sql, "thread:deleted", { deleted: true });

      const { dispatched, layer } = yield* harness("dan");
      const assigned = yield* TaskOwnerBackfill.make.pipe(
        Effect.flatMap((backfill) => backfill.backfill("dan")),
        Effect.provide(layer),
      );
      assert.equal(assigned, 2);
      assert.deepEqual(
        (yield* Ref.get(dispatched)).map((command) => [
          command.type,
          command.threadId,
          command.ownerId,
          command.commandId,
        ]),
        [
          ["thread.owner.set", "thread:unowned-a", "dan", "server:owner-backfill:thread:unowned-a"],
          ["thread.owner.set", "thread:unowned-b", "dan", "server:owner-backfill:thread:unowned-b"],
        ],
      );
      const written = JSON.parse(yield* fs.readFileString(marker)) as Record<string, unknown>;
      assert.include(written, { version: 1, ownerId: "dan", assigned: 2 });

      // A thread that is unowned later, through this pass or after a restart, keeps no owner.
      yield* insertThread(sql, "thread:unowned-later");
      const again = yield* harness("dan");
      const later = yield* TaskOwnerBackfill.make.pipe(
        Effect.flatMap((backfill) =>
          Effect.all([backfill.backfill("dan"), backfill.backfill("gavin")]),
        ),
        Effect.provide(again.layer),
      );
      assert.deepEqual(later, [0, 0]);
      assert.deepEqual(yield* Ref.get(again.dispatched), []);
    }).pipe(Effect.provide(layerBase)),
);

it.effect("an unreadable marker still counts as a pass", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    yield* fs.writeFileString(
      path.join(stateDir, TaskOwnerBackfill.TASK_OWNER_BACKFILL_FILE),
      "not json",
    );
    yield* insertThread(sql, "thread:unowned-corrupt-marker");

    const { dispatched, layer } = yield* harness("dan");
    const assigned = yield* TaskOwnerBackfill.make.pipe(
      Effect.flatMap((backfill) => backfill.backfill("dan")),
      Effect.provide(layer),
    );
    assert.equal(assigned, 0);
    assert.deepEqual(yield* Ref.get(dispatched), []);
  }).pipe(Effect.provide(layerBase)),
);

it.effect("starts once this machine knows its default owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "thread:unowned-at-start");
      const { dispatched, firstDispatch, layer } = yield* harness("dan");
      yield* TaskOwnerBackfill.make.pipe(
        Effect.flatMap((backfill) => backfill.start()),
        Effect.provide(layer),
      );
      yield* Deferred.await(firstDispatch);
      assert.deepEqual(
        (yield* Ref.get(dispatched)).map((command) => [command.threadId, command.ownerId]),
        [["thread:unowned-at-start", "dan"]],
      );
    }).pipe(Effect.provide(layerBase)),
  ),
);
