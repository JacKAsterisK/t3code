import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SourceStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Delivery from "./AgentEventDelivery.ts";
import * as Deriver from "./AgentFactDeriver.ts";
import * as Signals from "./AgentFactRelaySignals.ts";
import * as Facts from "./AgentFactStore.ts";
import * as Option from "effect/Option";

const start = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  // Protocol admission also requires the flag at startup; enabling both takes a restart.
  if (!(yield* settings.getSettings).agentEventsEnabled) return;
  const source = yield* SourceStore.OrchestrationEventStore;
  const deriver = yield* Deriver.AgentFactDeriver;
  const delivery = yield* Effect.serviceOption(Delivery.AgentEventDelivery);
  const signals = yield* Effect.serviceOption(Signals.AgentFactRelaySignals);
  const changes = yield* settings.subscribeChanges;
  const refresh = Effect.fn("AgentFactRuntime.refresh")(function* () {
    if (!(yield* settings.getSettings).agentEventsEnabled) return;
    const result = yield* deriver.catchUp;
    if (result.facts > 0) {
      if (Option.isSome(signals)) yield* signals.value.pulse;
      if (Option.isSome(delivery)) yield* delivery.value.wake;
    }
  });
  const warn = (cause: unknown) =>
    Effect.logWarning("Agent event fact collection could not advance.", { cause });
  yield* changes.pipe(
    Stream.runForEach(() => refresh().pipe(Effect.catchCause(warn))),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    yield* refresh();
    const through = yield* Facts.progress();
    yield* source.streamApplicationEvents({ afterSequence: through }).pipe(
      Stream.runForEach((stored) =>
        Effect.gen(function* () {
          if (stored.sequence > (yield* Facts.progress())) yield* refresh();
        }),
      ),
    );
  }).pipe(Effect.tapCause(warn), Effect.retry(Schedule.spaced("1 second")), Effect.forkScoped);
});

export const layerForEnvironment = (environment: { readonly id: string; readonly label: string }) =>
  Layer.effectDiscard(start).pipe(Layer.provide(Deriver.layer(environment)));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* ServerEnvironment.ServerEnvironment;
    const environment = yield* server.getDescriptor;
    return layerForEnvironment({ id: environment.environmentId, label: environment.label });
  }),
);
