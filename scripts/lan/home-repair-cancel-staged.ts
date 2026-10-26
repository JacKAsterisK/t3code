// @effect-diagnostics nodeBuiltinImport:off -- Only synthetic or transaction-owned staged state is opened for domain cancellation; providers and workers are absent.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import * as EventSink from "../../apps/server/src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../apps/server/src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import { cancelOfflineWork } from "../../apps/server/src/lan/OfflineWorkCancellation.ts";
import { migrateRepairStagedHome, validateRepairStagedHome } from "./home-repair-migrations.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";

export async function cancelRepairStagedWork(home: string, repairId: string) {
  await migrateRepairStagedHome(home);
  const file = NodePath.join(home, "userdata", "statev2.sqlite");
  const database = NodeSqliteClient.layer({ filename: file });
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(database),
  );
  const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
  const summary = await Effect.runPromise(
    cancelOfflineWork(repairId).pipe(
      Effect.provide(sink),
      Effect.provide([NodeServices.layer, Logger.layer([], { mergeWithExisting: false })]),
      Effect.scoped,
    ),
  );
  await validateRepairStagedHome(home);
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const work = inspectStoppedRepairWork(file);
  if (
    [
      work.activeRuns,
      work.queuedRuns,
      work.pendingRequests,
      work.backgroundAgents,
      work.scheduledWork,
      work.restartContinuations,
    ].some((count) => count !== 0)
  )
    throw new Error(
      "Staged cancellation left unsupported unfinished work; originals were not changed.",
    );
  return summary;
}
