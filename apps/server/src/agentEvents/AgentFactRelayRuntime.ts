import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Fleet from "../lan/FleetAccessPolicy.ts";
import * as Links from "../peer/PeerLinks.ts";
import * as Discovery from "../peer/PeerFactRelayDiscovery.ts";
import * as Settings from "../serverSettings.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Delivery from "./AgentEventDelivery.ts";
import * as Outside from "./AgentEventAuthority.ts";
import * as Relay from "./AgentFactRelay.ts";
import * as Access from "./AgentFactRelayAccess.ts";
import * as Admission from "./AgentFactRelayAdmission.ts";
import * as Permissions from "./AgentFactRelayPermissions.ts";
import * as Signals from "./AgentFactRelaySignals.ts";
import * as Transport from "./AgentFactRelayTransport.ts";

export class AgentFactRelayRuntime extends Context.Service<
  AgentFactRelayRuntime,
  {
    readonly reconcile: Effect.Effect<void>;
    readonly run: Effect.Effect<void>;
  }
>()("t3/agentEvents/AgentFactRelayRuntime") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const access = yield* Access.AgentFactRelayAccess;
  const relay = yield* Relay.AgentFactRelay;
  const signals = yield* Signals.AgentFactRelaySignals;
  const delivery = yield* Effect.serviceOption(Delivery.AgentEventDelivery);
  const fleet = yield* Fleet.FleetAccess;
  const links = yield* Effect.serviceOption(Links.PeerLinks);
  const sessions = yield* Sessions.SessionStore;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const started = (yield* settings.getSettings).agentEventsEnabled;
  const workers = new Map<
    string,
    { readonly generation: string; readonly fiber: Fiber.Fiber<void, never> }
  >();
  const follow = Effect.fn("AgentFactRelayRuntime.follow")(function* (environmentId: string) {
    let failures = 0;
    while (true) {
      const result = yield* relay.followOnce(environmentId).pipe(Effect.result);
      if (result._tag === "Success") {
        // followOnce returns after its import/cursor/status transaction has committed.
        yield* signals.pulse;
        if (Option.isSome(delivery)) yield* delivery.value.wake;
      }
      const status = result._tag === "Success" ? result.success.cursor.status : "unreachable";
      failures = status === "following" ? 0 : failures + 1;
      const delay =
        status === "unsupported"
          ? 3_600_000
          : status === "following"
            ? 100
            : Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
      yield* Effect.sleep(delay);
    }
  });
  const reconcile = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const allowed = new Map<string, string>();
    if (
      started &&
      Option.isSome(current) &&
      current.value.agentEventsEnabled &&
      current.value.linkedEnvironmentsEnabled
    ) {
      const rows = yield* sql<{
        environment_id: string;
      }>`SELECT environment_id FROM peer_environment_links ORDER BY environment_id`;
      for (const row of rows) {
        const grant = yield* access.outgoing(row.environment_id);
        if (grant.verdict === "allowed")
          allowed.set(row.environment_id, grant.authorization.generation);
      }
    }
    for (const [id, worker] of workers) {
      if (allowed.get(id) === worker.generation) continue;
      workers.delete(id);
      yield* Fiber.interrupt(worker.fiber);
      if (
        !allowed.has(id) &&
        Option.isSome(current) &&
        current.value.agentEventsEnabled &&
        current.value.linkedEnvironmentsEnabled
      ) {
        const stopped = yield* relay.followOnce(id, 0).pipe(Effect.result);
        if (stopped._tag === "Success") {
          yield* signals.pulse;
          if (Option.isSome(delivery)) yield* delivery.value.wake;
        }
      }
    }
    for (const [id, generation] of allowed) {
      if (workers.has(id)) continue;
      const fiber = yield* follow(id).pipe(Effect.forkIn(scope));
      workers.set(id, { generation, fiber });
    }
  }).pipe(
    lock.withPermit,
    Effect.catchCause((cause) =>
      Effect.logWarning("Fact relay reconciliation is unavailable.", { cause }),
    ),
  );
  const run = Effect.scoped(
    Effect.gen(function* () {
      if (!started) return;
      const changes = yield* settings.subscribeChanges;
      yield* changes.pipe(
        Stream.runForEach(() => reconcile),
        Effect.forkScoped,
      );
      yield* fleet.changes.pipe(
        Stream.runForEach(() => reconcile),
        Effect.forkScoped,
      );
      yield* sessions.streamChanges.pipe(
        Stream.runForEach(() => reconcile),
        Effect.forkScoped,
      );
      if (Option.isSome(links) && links.value.subscribeChanges !== undefined) {
        const changes = yield* links.value.subscribeChanges;
        yield* changes.pipe(
          Stream.runForEach(() => reconcile),
          Effect.forkScoped,
        );
      }
      // Also sees SQL-only pointer edits and cross-process revocations.
      yield* reconcile.pipe(Effect.repeat(Schedule.spaced("1 second")));
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(workers.values(), (worker) => Fiber.interrupt(worker.fiber), { discard: true }),
  );
  return AgentFactRelayRuntime.of({ reconcile, run });
});
export const layer = Layer.effect(AgentFactRelayRuntime, make);
export const layerBackground = Layer.mergeAll(
  Signals.layerPolling,
  Layer.effectDiscard(
    AgentFactRelayRuntime.pipe(Effect.flatMap((runtime) => Effect.forkScoped(runtime.run))),
  ).pipe(Layer.provide(layer)),
);

const layerRelay = Layer.unwrap(
  Effect.gen(function* () {
    const descriptor = yield* (yield* Environment.ServerEnvironment).getDescriptor;
    return Relay.layer({ id: descriptor.environmentId, label: descriptor.label });
  }),
);
/** Build before authority/delivery capture their optional relay dependencies. */
export const layerServices = Layer.mergeAll(layerRelay, Admission.layer).pipe(
  Layer.provideMerge(Transport.layer.pipe(Layer.provide(Discovery.layer))),
  Layer.provideMerge(Signals.layerWake.pipe(Layer.provideMerge(Signals.layer))),
  Layer.provideMerge(Permissions.layer.pipe(Layer.provideMerge(Outside.layer))),
);
