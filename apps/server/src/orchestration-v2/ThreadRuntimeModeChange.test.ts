import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ServerSettings from "../serverSettings.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { McpInvocationContext, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ThreadCreationOrigin, ThreadRuntimeModeChange } from "./ThreadRuntimeModeChange.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runtime-mode management never starts a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const testSettings = (enabled: boolean) => ({
  linkedEnvironmentsEnabled: true,
  allowAgentFullAccessLaunches: true,
  ...(enabled ? { allowAgentFullAccessModeChanges: true } : {}),
});

const testLayer = (
  enabled: boolean,
  withCeiling = false,
  runtimeModes?: ReadonlyArray<RuntimeMode>,
  settingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>,
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
        ...(settingsLayer === undefined ? { settings: testSettings(enabled) } : { settingsLayer }),
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

const ownerOrigin = { kind: "owner-local", environmentId: caller.environmentId } as const;
const seed = Effect.gen(function* () {
  yield* create(target);
  yield* create(caller.threadId);
  yield* send(caller.threadId, "caller");
}).pipe(Effect.provideService(ThreadCreationOrigin, ownerOrigin));

const linkedActor = {
  kind: "client",
  actor: { kind: "linked-client", sessionId: "authenticated-session", label: "Peer" },
  revalidate: Effect.succeed({
    limits: { runtimeMode: "full-access", interactionMode: "default" },
    fenced: false,
  } as const),
} as const;

const mcpScope = (callerThread?: ThreadId, taskOnly = false): McpInvocationScope => ({
  environmentId: caller.environmentId,
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client:
    callerThread === undefined
      ? { sessionId: "outside", label: "Outside", access: "auto", taskOnly }
      : undefined,
  thread:
    callerThread === undefined
      ? undefined
      : { threadId: callerThread, providerInstanceId: instanceId, providerSessionId: "fixture" },
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
    const linked = linkedActor;
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

const setFixtureModes = Effect.fn("RuntimeModeTest.setFixtureModes")(function* (withLink: boolean) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  for (const threadId of [target, caller.threadId]) {
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:stored-mode:" + threadId),
          type: "thread.runtime-mode-updated",
          threadId,
          occurredAt: now,
          payload: {
            ...thread,
            runtimeMode: "full-access",
            ...(withLink
              ? {
                  linkOrigin: { sessionId: "fixture-link", label: "Peer", access: "auto" as const },
                }
              : {}),
          },
        },
      ],
    });
  }
});

it.effect(
  "caps a fenced caller at its linked access even when the owner raised its stored mode",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* setFixtureModes(true);
      assert.propertyVal(
        yield* change("fenced-cap", "auto", "full-access").pipe(Effect.flip),
        "code",
        "runtime_mode_escalation_denied",
      );
    }).pipe(Effect.provide(testLayer(true))),
);

it.effect("caps a thread caller whose stored mode is above the managed ceiling", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* setFixtureModes(false);
    assert.propertyVal(
      yield* change("managed-cap", "auto", "full-access").pipe(Effect.flip),
      "code",
      "runtime_mode_escalation_denied",
    );
  }).pipe(Effect.provide(testLayer(true, true))),
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

it.effect.each([true, false])(
  "denies externally launched callers and targets (task-only: %s)",
  (taskOnly) =>
    Effect.gen(function* () {
      yield* seed;
      const commissioned = ThreadId.make("thread:external");
      yield* create(commissioned).pipe(
        Effect.provideService(McpInvocationContext, mcpScope(undefined, taskOnly)),
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { thread } = yield* orchestrator.getThreadRecords(commissioned, []);
      assert.equal(thread.launchProvenance?.kind, taskOnly ? "task-grant" : "outside-oauth");
      assert.propertyVal(
        yield* change("raise-external-target", "full-access", "auto", caller, commissioned).pipe(
          Effect.flip,
        ),
        "code",
        "runtime_mode_escalation_denied",
      );
      yield* send(commissioned, "external");
      const agent = { ...caller, threadId: commissioned };
      assert.propertyVal(
        yield* change("external-raises-other", "full-access", "auto", agent).pipe(Effect.flip),
        "code",
        "runtime_mode_escalation_denied",
      );
      assert.equal(
        (yield* orchestrator.getThreadRecords(target, ["turnItems"])).turnItems.length,
        0,
      );
      const descendant = ThreadId.make("thread:external-descendant");
      yield* create(descendant).pipe(
        Effect.provideService(McpInvocationContext, mcpScope(commissioned)),
      );
      assert.deepEqual(
        (yield* orchestrator.getThreadRecords(descendant, [])).thread.launchProvenance,
        thread.launchProvenance,
      );
      const child = ThreadId.make("thread:owner-descendant");
      yield* create(child).pipe(
        Effect.provideService(McpInvocationContext, mcpScope(caller.threadId)),
      );
      assert.deepEqual((yield* orchestrator.getThreadRecords(child, [])).thread.launchProvenance, {
        kind: "owner-descendant",
        environmentId: caller.environmentId,
      });
      yield* change("raise-owner-descendant", "full-access", "auto", caller, child);
    }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses elevation on a thread created without verified provenance", () =>
  Effect.gen(function* () {
    yield* seed;
    const unknown = ThreadId.make("thread:unknown");
    yield* create(unknown);
    assert.propertyVal(
      yield* change("raise-unknown", "full-access", "auto", caller, unknown).pipe(Effect.flip),
      "code",
      "runtime_mode_escalation_denied",
    );
    yield* send(unknown, "unknown");
    assert.propertyVal(
      yield* change("unknown-raises-owner", "full-access", "auto", {
        ...caller,
        threadId: unknown,
      }).pipe(Effect.flip),
      "code",
      "runtime_mode_escalation_denied",
    );
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect(
  "refuses an increase from a provider fallback even when stored modes would allow it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      assert.propertyVal(
        yield* change("effective-caller", "full-access").pipe(Effect.flip),
        "code",
        "runtime_mode_escalation_denied",
      );
      assert.propertyVal(
        yield* change("effective-target", "auto-accept-edits", "auto", linkedActor).pipe(
          Effect.flip,
        ),
        "code",
        "runtime_mode_escalation_denied",
      );
    }).pipe(
      Effect.provide(
        testLayer(true, false, ["approval-required", "auto-accept-edits", "full-access"]),
      ),
    ),
);

const addWaitingLink = Effect.fn("RuntimeModeTest.addWaitingLink")(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make("event:pending-link"),
        type: "turn-item.updated",
        threadId: target,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:pending-link"),
          threadId: target,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "link_request",
          linkStatus: "pending",
          status: "waiting",
          reason: "Link fixture",
          title: "Link request",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      },
    ],
  });
});

const addDelegatedTask = Effect.fn("RuntimeModeTest.addDelegatedTask")(function* (
  state: "pending" | "claimed" | "delivered",
  childThreadId: ThreadId | null = null,
  remoteStop?: {
    readonly status: "cancelled" | "interrupted";
    readonly stoppedThere: boolean | undefined;
  },
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const id = NodeId.make("node:mode-delegate");
  yield* sink.write({
    events: [
      {
        id: EventId.make("event:mode-delegate"),
        type: "subagent.updated",
        threadId: target,
        occurredAt: now,
        payload: {
          id,
          threadId: target,
          runId: null,
          parentNodeId: id,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "",
          title: null,
          model: null,
          completionDelivery: { state, observedByRunId: null },
          ...(remoteStop !== undefined
            ? {
                remoteChild: {
                  threadId: ThreadId.make("thread:remote-child"),
                  environmentId: EnvironmentId.make("other"),
                  label: "Peer",
                  ...(remoteStop.stoppedThere === undefined
                    ? {}
                    : { stoppedThere: remoteStop.stoppedThere }),
                },
              }
            : {}),
          status: remoteStop?.status ?? "completed",
          result: "finished",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});

it.effect.each(["pending", "claimed"] as const)(
  "refuses an idle parent with unfinished delegation (%s)",
  (state) =>
    Effect.gen(function* () {
      yield* seed;
      yield* addDelegatedTask(state);
      assert.propertyVal(
        yield* change("parent-busy", "full-access").pipe(Effect.flip),
        "code",
        "thread_busy",
      );
    }).pipe(Effect.provide(testLayer(true))),
);

it.effect.each([
  { status: "cancelled", stoppedThere: undefined },
  { status: "interrupted", stoppedThere: undefined },
  { status: "cancelled", stoppedThere: false },
  { status: "cancelled", stoppedThere: true },
] as const)(
  "checks remote stop debt after result delivery ($status, $stoppedThere)",
  (remoteStop) =>
    Effect.gen(function* () {
      yield* seed;
      yield* addDelegatedTask("delivered", null, remoteStop);
      const changeMode = change("parent-downgrade", "approval-required", "auto", linkedActor);
      const acknowledged = remoteStop.stoppedThere === true;
      if (acknowledged) {
        yield* changeMode;
      } else {
        assert.propertyVal(yield* changeMode.pipe(Effect.flip), "code", "thread_busy");
      }
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const receipt = yield* receipts.getByCommandId(CommandId.make("parent-downgrade"));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { thread } = yield* orchestrator.getThreadRecords(target, []);

      assert.equal(thread.runtimeMode, acknowledged ? "approval-required" : "auto");
      assert.equal(receipt._tag, acknowledged ? "Some" : "None");
    }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses a child with an undelivered completion", () =>
  Effect.gen(function* () {
    yield* seed;
    const child = ThreadId.make("thread:mode-local-child");
    yield* create(child).pipe(Effect.provideService(ThreadCreationOrigin, ownerOrigin));
    yield* addDelegatedTask("claimed", child);
    assert.propertyVal(
      yield* change("child-busy", "full-access", "auto", caller, child).pipe(Effect.flip),
      "code",
      "thread_busy",
    );
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses a parent if a local child resumes after the first idle check", () =>
  Effect.gen(function* () {
    yield* seed;
    const child = ThreadId.make("thread:mode-local-child");
    yield* create(child);
    yield* addDelegatedTask("delivered", child);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const checks = yield* Ref.make(0);
    const actor = {
      ...linkedActor,
      revalidate: Ref.updateAndGet(checks, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 1
            ? linkedActor.revalidate
            : send(child, "resumed child").pipe(
                Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
                Effect.orDie,
                Effect.andThen(linkedActor.revalidate),
              ),
        ),
      ),
    };
    assert.propertyVal(
      yield* change("child-resumed", "approval-required", "auto", actor).pipe(Effect.flip),
      "code",
      "thread_busy",
    );
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    assert.equal((yield* receipts.getByCommandId(CommandId.make("child-resumed")))._tag, "None");
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("allows an idle thread in a shared switching session while a sibling is running", () =>
  Effect.gen(function* () {
    yield* seed;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const sessionId = ProviderSessionId.make("provider-session:mode-shared");
    const driver = ProviderDriverKind.make("codex");
    const session = {
      id: sessionId,
      driver,
      providerInstanceId: instanceId,
      status: "running",
      cwd: process.cwd(),
      model: null,
      extensionStatuses: [],
      lastError: null,
      capabilities: {
        ...CodexProviderCapabilitiesV2,
        sessions: {
          ...CodexProviderCapabilitiesV2.sessions,
          supportsMultipleProviderThreadsPerSession: true,
          supportsRuntimeModeSwitchInSession: true,
        },
      },
      createdAt: now,
      updatedAt: now,
    } as const;
    yield* sink.write({
      events: [
        ...[target, caller.threadId].map((threadId) => ({
          id: EventId.make("event:attach:" + threadId),
          type: "provider-session.attached" as const,
          threadId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: session,
        })),
        {
          id: EventId.make("event:mode-provider-thread"),
          type: "provider-thread.updated",
          threadId: target,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make("provider-thread:mode-target"),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: sessionId,
            appThreadId: target,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const result = yield* change("shared-session", "full-access");
    assert.deepEqual(
      result.storedEvents.map(({ event }) => event.type),
      ["thread.runtime-mode-updated", "turn-item.updated"],
    );
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses an unanswered link card with no active run", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* addWaitingLink();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const shell = yield* orchestrator.getThreadShell(target);
    assert.equal(shell?.activeRunId, null);
    const { turnItems } = yield* orchestrator.getThreadRecords(target, ["turnItems"]);
    assert.deepInclude(turnItems[0], { type: "link_request", status: "waiting" });
    assert.propertyVal(
      yield* change("pending-link", "approval-required", "auto", linkedActor).pipe(Effect.flip),
      "code",
      "thread_busy",
    );
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses a client revoked while the target lock is held", () =>
  Effect.gen(function* () {
    yield* seed;
    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const revoked = yield* Ref.make(false);
    const holding = yield* locks
      .withLock(
        target,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const actor = {
      ...linkedActor,
      revalidate: Ref.get(revoked).pipe(
        Effect.flatMap((value) => (value ? Effect.undefined : linkedActor.revalidate)),
      ),
    };
    const pending = yield* change("revoked", "approval-required", "auto", actor).pipe(
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Ref.set(revoked, true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holding);
    assert.propertyVal(yield* Fiber.join(pending), "code", "capability_denied");
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    assert.equal((yield* receipts.getByCommandId(CommandId.make("revoked")))._tag, "None");
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses a still-authorized linked client if links turn off after admission", () => {
  const settingsLayer = ServerSettings.layerTest(testSettings(true)).pipe(Layer.orDie);
  return Effect.gen(function* () {
    yield* seed;
    const settings = yield* ServerSettings.ServerSettingsService;
    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const holding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const lock = yield* locks
      .withLock(
        target,
        Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(holding);
    const pending = yield* change("links-off", "approval-required", "auto", linkedActor).pipe(
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* settings.updateSettings({ linkedEnvironmentsEnabled: false });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(lock);
    assert.propertyVal(yield* Fiber.join(pending), "code", "capability_denied");
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    assert.equal((yield* receipts.getByCommandId(CommandId.make("links-off")))._tag, "None");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    assert.equal((yield* orchestrator.getThreadRecords(target, [])).thread.runtimeMode, "auto");
  }).pipe(
    Effect.provide(Layer.merge(testLayer(true, false, undefined, settingsLayer), settingsLayer)),
  );
});

it.effect.each(["approval-required", "auto"] as const)(
  "refuses a %s request when a card is written after idle inspection",
  (requestedMode) =>
    Effect.gen(function* () {
      yield* seed;
      const inspected = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const rechecks = yield* Ref.make(0);
      const actor = {
        ...linkedActor,
        revalidate: Ref.updateAndGet(rechecks, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? linkedActor.revalidate
              : Deferred.succeed(inspected, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                  Effect.andThen(linkedActor.revalidate),
                ),
          ),
        ),
      };
      const pending = yield* change("raced", requestedMode, "auto", actor).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(inspected);
      yield* addWaitingLink();
      yield* Deferred.succeed(resume, undefined);
      assert.propertyVal(yield* Fiber.join(pending), "code", "thread_busy");
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      assert.equal((yield* receipts.getByCommandId(CommandId.make("raced")))._tag, "None");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { thread, turnItems } = yield* orchestrator.getThreadRecords(target, ["turnItems"]);
      assert.equal(thread.runtimeMode, "auto");
      assert.deepEqual(
        turnItems.map((item) => item.type),
        ["link_request"],
      );
    }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses to elevate a stored thread whose creation predates provenance", () =>
  Effect.gen(function* () {
    yield* seed;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const { thread } = yield* orchestrator.getThreadRecords(target, []);
    const { launchProvenance: _launchProvenance, ...oldThread } = thread;
    const legacyId = ThreadId.make("thread:pre-1.0.51");
    const occurredAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:pre-1.0.51"),
          type: "thread.created",
          threadId: legacyId,
          occurredAt,
          payload: {
            ...oldThread,
            id: legacyId,
            lineage: { ...oldThread.lineage, rootThreadId: legacyId },
          },
        },
      ],
    });
    assert.isUndefined(
      (yield* orchestrator.getThreadRecords(legacyId, [])).thread.launchProvenance,
    );
    const rejected = yield* change("legacy-upgrade", "full-access", "auto", caller, legacyId).pipe(
      Effect.flip,
    );
    assert.propertyVal(rejected, "code", "runtime_mode_escalation_denied");
  }).pipe(Effect.provide(testLayer(true))),
);
