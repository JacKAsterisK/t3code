import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../serverSettings.ts";
import * as Store from "./AgentEventStore.ts";
import * as Ports from "./AgentFactRelayAccess.ts";

export class AgentFactRelaySignals extends Context.Service<
  AgentFactRelaySignals,
  {
    readonly pulse: Effect.Effect<void>;
    readonly poll: Effect.Effect<void>;
    readonly wait: Ports.AgentFactRelayWake["Service"]["wait"];
  }
>()("t3/agentEvents/AgentFactRelaySignals") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<void>();
  const previous = yield* Ref.make<string | null>(null);
  const pulse = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const poll = Effect.gen(function* () {
    const current = yield* Store.logState();
    const key = `${current.epoch}:${current.headSeq}:${current.floorSeq}`;
    if ((yield* Ref.getAndSet(previous, key)) !== key) yield* pulse;
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchCause((cause) =>
      Effect.logWarning("Fact relay commit notifications are unavailable.", { cause }),
    ),
  );
  const wait = Effect.fn("AgentFactRelaySignals.wait")(
    (after: Parameters<Ports.AgentFactRelayWake["Service"]["wait"]>[0], waitMs: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const current = yield* Store.logState();
          if (current.epoch !== after.epoch || current.headSeq !== after.seq) return;
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.timeoutOption(waitMs),
          );
        }),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.ignoreCause),
  );
  return AgentFactRelaySignals.of({ pulse, poll, wait });
});
export const layer = Layer.effect(AgentFactRelaySignals, make);
export const layerWake = Layer.effect(
  Ports.AgentFactRelayWake,
  AgentFactRelaySignals.pipe(
    Effect.map((signals) => Ports.AgentFactRelayWake.of({ wait: signals.wait })),
  ),
);
export const layerPolling = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    if (!(yield* settings.getSettings).agentEventsEnabled) return;
    const signals = yield* AgentFactRelaySignals;
    const changes = yield* settings.subscribeChanges;
    yield* changes.pipe(
      Stream.runForEach(() => signals.pulse),
      Effect.forkScoped,
    );
    // Cross-process CLI probes commit without this process's in-memory pulse.
    const poll = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.option);
      if (Option.isSome(current) && current.value.agentEventsEnabled) yield* signals.poll;
    });
    yield* poll.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  }),
);
