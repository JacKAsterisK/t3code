import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { ThreadRuntimeModeChange } from "./ThreadRuntimeModeChange.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runtime-mode management never starts a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const testLayer = (
  enabled: boolean,
  withCeiling = false,
  runtimeModes?: ReadonlyArray<RuntimeMode>,
) => {
  const databaseLayer = SqlitePersistence.layerMemory;
  return Layer.merge(
    CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "mcp-runtime-mode-change" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer,
        runEffectWorker: false,
        ...(runtimeModes === undefined
          ? {}
          : {
              providerInstances: {
                getInstance: () =>
                  Effect.succeed({
                    snapshot: {
                      getSnapshot: Effect.succeed({ supportedRuntimeModes: runtimeModes }),
                    },
                  } as ProviderInstance),
              },
            }),
        settings: {
          allowAgentFullAccessLaunches: true,
          ...(enabled ? { allowAgentFullAccessModeChanges: true } : {}),
        },
        ...(withCeiling
          ? {
              managedPolicy: {
                schemaVersion: 1 as const,
                organization: "Fixture",
                limits: { maxRuntimeMode: "auto" as const },
              },
            }
          : {}),
      },
    ),
  );
};

const target = ThreadId.make("thread:runtime-mode-target");
const caller = {
  kind: "thread",
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread:runtime-mode-caller"),
  providerInstanceId: instanceId,
} as const;

const create = Effect.fn("RuntimeModeTest.create")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:" + threadId),
    threadId,
    projectId: ProjectId.make("project:runtime-mode"),
    title: threadId,
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

const send = Effect.fn("RuntimeModeTest.send")(function* (threadId: ThreadId, key: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send:" + key),
    threadId,
    messageId: MessageId.make("message:" + key),
    text: key,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

const seed = Effect.gen(function* () {
  yield* create(target);
  yield* create(caller.threadId);
  yield* send(caller.threadId, "caller");
});

const change = Effect.fn("RuntimeModeTest.change")(function* (
  key: string,
  runtimeMode: RuntimeMode,
  expectedRuntimeMode: RuntimeMode = "auto",
  actor: NonNullable<typeof ThreadRuntimeModeChange.Service>["caller"] = caller,
  threadId: ThreadId = target,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator
    .dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(key),
      threadId,
      runtimeMode,
    })
    .pipe(Effect.provideService(ThreadRuntimeModeChange, { caller: actor, expectedRuntimeMode }));
});

it.layer(testLayer(false))("the mode-change grant is separate from the launch grant", (it) => {
  it.effect("defaults off and does not record a rejected command", () =>
    Effect.gen(function* () {
      yield* seed;
      const receipt = yield* CommandReceiptStore.CommandReceiptStoreV2;
      assert.match(
        String(yield* change("raise", "full-access").pipe(Effect.flip)),
        /local owner setting/,
      );
      assert.equal((yield* receipt.getByCommandId(CommandId.make("raise")))._tag, "None");
    }),
  );
});

it.effect("changes an idle target and commits the authenticated audit with it", () =>
  Effect.gen(function* () {
    yield* seed;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* change("raise", "full-access");
    assert.deepEqual(
      result.storedEvents.map(({ event }) => event.type),
      ["thread.runtime-mode-updated", "turn-item.updated"],
    );
    const { thread, turnItems } = yield* orchestrator.getThreadRecords(target, ["turnItems"]);
    assert.equal(thread.runtimeMode, "full-access");
    const audit = turnItems.find((item) => item.type === "system_notice");
    assert.deepEqual(audit?.runtimeModeChange, {
      actor: {
        kind: "thread",
        environmentId: caller.environmentId,
        threadId: caller.threadId,
        title: caller.threadId,
      },
      from: "auto",
      to: "full-access",
      reason: "local-owner-policy",
    });
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("accepts only one concurrent change at the same expected mode", () =>
  Effect.gen(function* () {
    yield* seed;
    const results = yield* Effect.all(
      [
        Effect.result(change("raise", "full-access")),
        Effect.result(change("lower", "approval-required")),
      ],
      { concurrency: 2 },
    );
    assert.lengthOf(results.filter(Result.isSuccess), 1);
    assert.match(String(results.find(Result.isFailure)?.failure), /runtime mode changed/);
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses a running target and the active calling thread", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* send(target, "target");
    const blocked = yield* change("raise", "full-access").pipe(Effect.flip);
    assert.propertyVal(blocked, "code", "thread_busy");
    const self = yield* change("self", "full-access", "auto", caller, caller.threadId).pipe(
      Effect.flip,
    );
    assert.propertyVal(self, "code", "thread_busy");
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect.each(["queued", "waiting"] as const)("refuses a %s run", (status) =>
  Effect.gen(function* () {
    yield* seed;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* send(target, "target");
    const {
      runs: [run],
    } = yield* orchestrator.getThreadRecords(target, ["runs"]);
    assert.isDefined(run);
    const occurredAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:test:busy-run"),
          type: "run.updated",
          threadId: target,
          runId: run.id,
          occurredAt,
          payload: { ...run, status },
        },
      ],
    });
    assert.propertyVal(
      yield* change("raise", "full-access").pipe(Effect.flip),
      "code",
      "thread_busy",
    );
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses a linked raise and accepts a linked downgrade under the link ceiling", () =>
  Effect.gen(function* () {
    yield* seed;
    const linked = {
      kind: "client",
      actor: { kind: "linked-client", sessionId: "authenticated-session", label: "Peer" },
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      fenced: false,
    } as const;
    assert.propertyVal(
      yield* change("raise", "full-access", "auto", linked).pipe(Effect.flip),
      "code",
      "runtime_mode_escalation_denied",
    );
    assert.propertyVal(
      yield* change("claimed-noop", "full-access", "full-access", linked).pipe(Effect.flip),
      "code",
      "mode_changed",
    );
    const lowered = yield* change("lower", "approval-required", "auto", linked);
    const audit = lowered.storedEvents.at(-1)?.event;
    assert.deepInclude(audit?.payload, {
      runtimeModeChange: {
        actor: linked.actor,
        from: "auto",
        to: "approval-required",
        reason: "within-caller-limit",
      },
    });
    const kept = yield* change("keep", "approval-required", "approval-required", linked);
    assert.deepEqual(kept.storedEvents, []);
  }).pipe(Effect.provide(testLayer(true))),
);

it.layer(testLayer(true, true))("managed runtime ceiling", (it) => {
  it.effect("owner opt-in cannot raise the administrator ceiling", () =>
    Effect.gen(function* () {
      yield* seed;
      assert.propertyVal(
        yield* change("raise", "full-access").pipe(Effect.flip),
        "_tag",
        "OrchestratorRuntimeModeAboveCeilingError",
      );
    }),
  );
});

it.effect("refuses any explicitly unsupported provider mode without coercion", () =>
  Effect.gen(function* () {
    yield* seed;
    const rejected = yield* change("unsupported", "approval-required").pipe(Effect.flip);
    assert.propertyVal(rejected, "code", "unsupported_runtime_mode");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    assert.equal((yield* orchestrator.getThreadRecords(target, [])).thread.runtimeMode, "auto");
  }).pipe(Effect.provide(testLayer(true, false, ["auto", "full-access"]))),
);
