import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Settings from "../serverSettings.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Signals from "./AgentFactRelaySignals.ts";
import * as Store from "./AgentEventStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";

const dependencies = Signals.layer.pipe(Layer.provideMerge(layerDatabase));
it.effect("a commit racing waiter registration cannot lose a cursor wake", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const signals = yield* Signals.AgentFactRelaySignals;
    const log = yield* Store.logState();
    const waiter = yield* signals
      .wait({ epoch: log.epoch, seq: log.headSeq }, 45_000)
      .pipe(Effect.forkChild);
    yield* sql`UPDATE agent_event_log_state SET head_seq = head_seq + 1`;
    yield* signals.pulse;
    yield* Fiber.join(waiter);
    yield* signals.wait({ epoch: log.epoch, seq: log.headSeq }, 45_000);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("polling wakes floor/epoch changes as well as head changes and wait has a ceiling", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const signals = yield* Signals.AgentFactRelaySignals;
    const log = yield* Store.logState();
    yield* signals.poll;
    const waiter = yield* signals
      .wait({ epoch: log.epoch, seq: log.headSeq }, 45_000)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* sql`UPDATE agent_event_log_state SET floor_seq = 2`;
    yield* signals.poll;
    yield* Fiber.join(waiter);
    const bounded = yield* signals
      .wait({ epoch: log.epoch, seq: log.headSeq }, 45_000)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("44 seconds");
    assert.isUndefined(bounded.pollUnsafe());
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(bounded);
    yield* sql`UPDATE agent_event_log_state SET epoch = 'replacement'`;
    yield* signals.wait({ epoch: log.epoch, seq: log.headSeq }, 45_000);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("live disable wakes an origin long poll immediately for a fresh refusal", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Signals.layerPolling.pipe(
        Layer.provideMerge(Signals.layer),
        Layer.provideMerge(
          Settings.layerTest({ agentEventsEnabled: true, linkedEnvironmentsEnabled: true }),
        ),
        Layer.provideMerge(layerDatabase),
      ),
    );
    const sql = Context.get(context, SqlClient.SqlClient);
    const signals = Context.get(context, Signals.AgentFactRelaySignals);
    const settings = Context.get(context, Settings.ServerSettingsService);
    const log = yield* Store.logState().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const waiter = yield* signals
      .wait({ epoch: log.epoch, seq: log.headSeq }, 45_000)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* settings.updateSettings({ agentEventsEnabled: false });
    yield* Fiber.join(waiter);
  }).pipe(Effect.scoped),
);
