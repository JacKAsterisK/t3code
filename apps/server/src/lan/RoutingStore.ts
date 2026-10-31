import {
  type EnvironmentId,
  EventId,
  type LanTaskLaunchResult,
  type LanTaskObservation,
  type LanTaskEventCursor,
  type LanTaskObserveResult,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlClient from "effect/sql/SqlClient";
import * as GatewayCompatibility from "./GatewayCompatibility.ts";

export class RoutingStore extends Context.Service<
  RoutingStore,
  {
    readonly own: (
      principal: string,
      environmentId: EnvironmentId,
      task: LanTaskLaunchResult,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly owned: (
      principal: string,
      environmentId: EnvironmentId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, OrchestratorMcpFailure>;
    readonly admission: (
      target: Parameters<GatewayCompatibility.GatewayCompatibility["Service"]["admission"]>[0],
    ) => Effect.Effect<
      Effect.Success<ReturnType<GatewayCompatibility.GatewayCompatibility["Service"]["admission"]>>,
      OrchestratorMcpFailure
    >;
    readonly observe: (
      principal: string,
      environmentId: EnvironmentId,
      page: LanTaskObserveResult,
      options: Parameters<GatewayCompatibility.GatewayCompatibility["Service"]["observe"]>[2],
    ) => Effect.Effect<
      Effect.Success<ReturnType<GatewayCompatibility.GatewayCompatibility["Service"]["observe"]>>,
      OrchestratorMcpFailure
    >;
    readonly ingest: (
      principal: string,
      environmentId: EnvironmentId,
      page: LanTaskObserveResult,
      options: {
        readonly reset?: boolean;
        readonly expectedDeliverySourceId: EventId | null;
      },
    ) => Effect.Effect<EventId, OrchestratorMcpFailure>;
    readonly checkpoint: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      | { readonly cursor: typeof LanTaskEventCursor.Type; readonly deliverySourceId: EventId }
      | undefined,
      OrchestratorMcpFailure
    >;
    readonly cursor: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<typeof LanTaskEventCursor.Type | undefined, OrchestratorMcpFailure>;
    readonly pending: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      expectedDeliverySourceId?: EventId,
    ) => Effect.Effect<ReadonlyArray<LanTaskObservation>, OrchestratorMcpFailure>;
    readonly acknowledge: (
      principal: string,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      ids: ReadonlyArray<string>,
      sourceId: EventId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("t3/lan/RoutingStore") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "LAN routing persistence is unavailable.",
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const compatibility = yield* GatewayCompatibility.GatewayCompatibility;
  const own = Effect.fn("RoutingStore.own")(function* (
    principal: string,
    environmentId: EnvironmentId,
    task: LanTaskLaunchResult,
  ) {
    yield* sql`INSERT OR IGNORE INTO lan_owned_threads (principal_id, environment_id, project_id, thread_id)
      VALUES (${principal}, ${environmentId}, ${task.projectId}, ${task.threadId})`;
  }, Effect.mapError(unavailable));
  const owned = Effect.fn("RoutingStore.owned")(function* (
    principal: string,
    environmentId: EnvironmentId,
    projectId?: ProjectId,
  ) {
    const rows =
      projectId === undefined
        ? yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM lan_owned_threads WHERE principal_id=${principal} AND environment_id=${environmentId}`
        : yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM lan_owned_threads WHERE principal_id=${principal} AND environment_id=${environmentId} AND project_id=${projectId}`;
    return rows.map((row) => row.thread_id);
  }, Effect.mapError(unavailable));
  const admission: RoutingStore["Service"]["admission"] = (target) =>
    compatibility.admission(target).pipe(Effect.mapError(unavailable));
  const observe: RoutingStore["Service"]["observe"] = (principal, environmentId, page, options) =>
    compatibility
      .observe({ principal, environmentId, threadId: page.threadId }, page, options)
      .pipe(Effect.mapError(unavailable));
  const ingest: RoutingStore["Service"]["ingest"] = (principal, environmentId, page, options) =>
    compatibility
      .ingest({ principal, environmentId, threadId: page.threadId }, page, options)
      .pipe(Effect.mapError(unavailable));
  const checkpoint: RoutingStore["Service"]["checkpoint"] = (principal, environmentId, threadId) =>
    compatibility
      .checkpoint({ principal, environmentId, threadId })
      .pipe(Effect.mapError(unavailable));
  const cursor: RoutingStore["Service"]["cursor"] = (principal, environmentId, threadId) =>
    checkpoint(principal, environmentId, threadId).pipe(Effect.map((current) => current?.cursor));
  const pending: RoutingStore["Service"]["pending"] = (
    principal,
    environmentId,
    threadId,
    expectedSourceId,
  ) =>
    compatibility
      .pending({ principal, environmentId, threadId }, expectedSourceId)
      .pipe(Effect.mapError(unavailable));
  const acknowledge: RoutingStore["Service"]["acknowledge"] = (
    principal,
    environmentId,
    threadId,
    ids,
    sourceId,
  ) =>
    compatibility
      .acknowledge({ principal, environmentId, threadId }, ids, sourceId)
      .pipe(Effect.mapError(unavailable));
  return RoutingStore.of({
    own,
    owned,
    admission,
    observe,
    ingest,
    checkpoint,
    cursor,
    pending,
    acknowledge,
  });
});
export const layer = Layer.effect(RoutingStore, make).pipe(
  Layer.provideMerge(GatewayCompatibility.layer),
);
