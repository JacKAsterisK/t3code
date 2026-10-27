// @effect-diagnostics nodeBuiltinImport:off - Tests observe actual native file/SQLite ownership handles and deliver private Node stdin bytes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeModule from "node:module";
import * as NodeStream from "node:stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpServer } from "effect/http";
import { DESKTOP_BACKEND_SHUTDOWN_COMMAND } from "@t3tools/contracts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerConfig from "../config.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as ProcessRunner from "../processRunner.ts";
import { awaitDesktopShutdown } from "../launcherWatch.ts";
import * as Keybindings from "../keybindings.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});

it.effect.each(["startup", "shutdown"] as const)(
  "%s cancels queued buffered wakes and holds durable messages",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const bufferedThreads = [] as ThreadId[];
      const durableThreads = [] as ThreadId[];
      for (const kind of ["buffered", "user", "notification", "delegated"] as const) {
        const threadId = yield* createThread(`wake:${trigger}:${kind}`);
        const buffered = kind === "buffered";
        (buffered ? bufferedThreads : durableThreads).push(threadId);
        const messageId = MessageId.make(`message:${threadId}`);
        const runId = yield* createRun(threadId, "queued", {
          userMessageId: messageId,
          startedAt: null,
          queuePosition: 1,
        });
        yield* createRun(threadId, "completed", { ordinal: 2 });
        yield* projections.apply({
          id: EventId.make(`message:${threadId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "Queued work",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: kind === "user" ? "user" : "agent",
            creationSource: buffered ? "provider" : "server",
            ...(kind === "user" || kind === "delegated"
              ? {}
              : {
                  notification: {
                    source: { kind: "background_task" as const },
                    outcome: "updated" as const,
                    summary: "Background activity updated",
                  },
                }),
            ...(kind === "delegated"
              ? { delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } }
              : {}),
          },
        });
      }
      assert.deepEqual(
        new Set(yield* projections.getRecoveryThreadIds("runtime")),
        new Set([...bufferedThreads, ...durableThreads]),
      );
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 1);
      for (const threadId of bufferedThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "cancelled");
        assert.isNotNull(projection.runs[0]?.completedAt);
        assert.isNull(projection.runs[0]?.queuePosition);
        assert.equal(projection.runs[1]?.status, "completed");
      }
      for (const threadId of durableThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "queued");
        assert.isTrue(projection.runs[0]?.queueHeld);
      }
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("stops a session its thread detached, which kept its live status", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("detached-session");
    const providerSessionId = ProviderSessionId.make("session:recovery:detached");
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:attached"),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:detached"),
      type: "provider-session.detached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);

    const summary = yield* recovery.reconcile("startup");

    assert.equal(summary.stoppedSessions, 1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(rows, [{ status: "stopped" }]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("selects unfinished recovery work without reading settled thread histories", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (let index = 0; index < 600; index += 1) {
      yield* createRun(yield* createThread(`settled-${index}`), "completed");
    }
    const queued = yield* createThread("queued");
    const archived = yield* createThread("archived", { archivedAt: now });
    const deleted = yield* createThread("deleted", { deletedAt: now });
    const blocked = yield* createThread("blocked");
    yield* createRun(queued, "completed");
    for (const threadId of [queued, archived, deleted, blocked]) {
      yield* createRun(threadId, "queued", threadId === queued ? { ordinal: 2 } : {});
    }
    yield* createRun(blocked, "waiting", { ordinal: 2 });
    const background = yield* createThread("background");
    yield* createRun(background, "completed");
    yield* projections.apply({
      id: EventId.make("event:recovery:background"),
      type: "turn-item.updated",
      threadId: background,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:recovery:background"),
        threadId: background,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "dynamic_tool",
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        toolName: "background",
        input: null,
        output: null,
      },
    });
    const outboxOnly = yield* createThread("outbox-only");
    yield* outbox.enqueue([
      {
        id: "effect:recovery:outbox-only",
        commandId: CommandId.make("command:recovery:outbox-only"),
        threadId: outboxOnly,
        request: { type: "provider-turn.start", runId: RunId.make("run:outbox-only") },
      },
    ]);
    const requestOnly = yield* createThread("request-only");
    yield* projections.apply({
      id: EventId.make("event:recovery:request-only"),
      type: "runtime-request.updated",
      threadId: requestOnly,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:recovery:pending"),
        nodeId: NodeId.make("node:recovery:request"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process stopped" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const delivery = yield* createThread("delivery", { archivedAt: now });
    yield* createRun(delivery, "completed", {
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: MessageId.make("message:delivery"), taskIds: [] },
      },
    });

    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${ThreadId.make("thread:recovery:settled-599")}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${queued} AND ordinal = 1
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly]),
    );
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [delivery]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const recoveryState = yield* projections.getRuntimeRecoveryProjection(queued);
    assert.deepEqual(
      recoveryState.runs.map((run) => run.id),
      [RunId.make(`run:${queued}:2`)],
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), [
      queued,
      ThreadId.make("thread:recovery:settled-599"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recovers terminal subagent results until their cross-thread transfer exists", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const parent = yield* createThread("subagent-parent");
    const children: Array<ThreadId> = [];
    for (const name of ["terminal", "archived", "deleted", "running", "held", "queued"]) {
      const child = yield* createThread(`subagent-${name}`, {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
        forkedFrom: { type: "node", nodeId: NodeId.make(`node:${name}`) },
        archivedAt: name === "archived" ? now : null,
        deletedAt: name === "deleted" ? now : null,
      });
      yield* createRun(child, name === "running" ? "running" : "completed");
      if (name === "held" || name === "queued") {
        yield* createRun(child, "queued", {
          ordinal: 2,
          startedAt: null,
          ...(name === "held" ? { queueHeld: true } : {}),
        });
      }
      children.push(child);
    }
    const terminalChildren = new Set([children[0]!, children[1]!, children[4]!]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      terminalChildren,
    );

    const completed = children[0]!;
    const transferId = ContextTransferId.make("transfer:recovery:subagent-result");
    yield* projections.apply({
      id: EventId.make("event:recovery:subagent-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: transferId,
        type: "subagent_result",
        sourceThreadId: completed,
        targetThreadId: parent,
        sourcePoint: { threadId: completed },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    const archivedChild = children[1];
    assert.isDefined(archivedChild);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      new Set([archivedChild, children[4]!]),
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_context_transfers SET payload_json = '{}'
      WHERE context_transfer_id = ${transferId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([parent, completed]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "memory", layer: ProjectionStore.layerMemory },
])("recovers only recorded follow-up results with $name projections", ({ layer }) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const parent = yield* createThread("followup-parent");
    const child = yield* createThread("followup-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      forkedFrom: { type: "node", nodeId: NodeId.make("node:original") },
    });
    const originalRunId = yield* createRun(child, "completed");
    yield* projections.apply({
      id: EventId.make("event:original-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: ContextTransferId.make("transfer:original-result"),
        type: "subagent_result",
        sourceThreadId: child,
        targetThreadId: parent,
        sourcePoint: { threadId: child, runId: originalRunId },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    yield* createRun(child, "completed", { ordinal: 2 });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const taskId = NodeId.make("node:followup");
    yield* createRun(child, "completed", { ordinal: 3, delegatedTaskId: taskId });
    yield* createRun(child, "running", { ordinal: 4 });
    const task = {
      id: taskId,
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make("node:parent"),
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Check the follow-up.",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("event:followup-task"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: task,
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [child]);
    yield* projections.apply({
      id: EventId.make("event:followup-settled"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "Follow-up result.", completedAt: now },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("includes shared sessions and provider-owned background rosters in recovery", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const first = yield* createThread("shared-first");
    const second = yield* createThread("shared-second", { archivedAt: now });
    const providerSessionId = ProviderSessionId.make("session:recovery:shared");
    for (const threadId of [first, second]) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:session`),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const roster = yield* createThread("roster");
    yield* projections.apply({
      id: EventId.make("event:recovery:roster"),
      type: "provider-thread.updated",
      threadId: roster,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:recovery:roster"),
        appThreadId: roster,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "background", description: "Still running", kind: "command" },
        ],
      },
    });
    const prepared = yield* createThread("prepared-continuation");
    const preparedSessionId = ProviderSessionId.make("session:recovery:prepared");
    const preparedProviderThreadId = ProviderThreadId.make("provider-thread:recovery:prepared");
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-session"),
      type: "provider-session.attached",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedSessionId,
        driver,
        providerInstanceId,
        status: "stopped",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-thread"),
      type: "provider-thread.updated",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedProviderThreadId,
        appThreadId: prepared,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: preparedSessionId,
        nativeThreadRef: { driver, nativeId: "native:prepared", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
    const preparedRunId = yield* createRun(prepared, "starting", {
      providerThreadId: preparedProviderThreadId,
      restartContinuationOfRunId: RunId.make("run:recovery:source"),
    });
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([first, second, roster, prepared]),
    );
    const preparedState = yield* projections.getRuntimeRecoveryProjection(prepared);
    assert.deepEqual(
      preparedState.providerSessions.map((session) => session.id),
      [preparedSessionId],
    );
    assert.equal(restartContinuationRun(preparedState, yield* DateTime.now)?.id, preparedRunId);
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_sessions SET payload_json = '{}'
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([first, second]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the run that owns a background roster, not a queued or resumed one", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const withRoster = Effect.fn(function* (threadId: ThreadId) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:roster`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks: [
            { taskId: "background", description: "Still running", kind: "command" },
          ],
        },
      });
    });
    const runIds = (threadId: ThreadId) =>
      projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.map((state) => state.runs.map((run) => run.id)));
    const settled = yield* createThread("roster-before-queue");
    const settledRun = yield* createRun(settled, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${settled}`),
    });
    const queuedRun = yield* createRun(settled, "queued", { ordinal: 2, completedAt: null });
    yield* withRoster(settled);
    assert.deepEqual(yield* runIds(settled), [settledRun, queuedRun]);
    const resumed = yield* createThread("roster-after-resume");
    const resumedRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    });
    const continuationRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      ordinal: 2,
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    });
    yield* withRoster(resumed);
    assert.deepEqual(yield* runIds(resumed), [resumedRun, continuationRun]);
    const quiet = yield* createThread("no-roster-before-queue");
    yield* createRun(quiet, "completed");
    const quietQueued = yield* createRun(quiet, "queued", { ordinal: 2, completedAt: null });
    assert.deepEqual(yield* runIds(quiet), [quietQueued]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes the run whose subagent lost its shell, past a wake cut before it started", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("subagent-shell");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:session`),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const settledRun = yield* createRun(threadId, "completed", { providerThreadId });
    yield* createRun(threadId, "starting", {
      ordinal: 2,
      providerThreadId,
      startedAt: null,
      completedAt: null,
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:roster`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "shell", description: "sleep 150", kind: "command", parentTaskId: "agent" },
        ],
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      { kind: "subagent", label: "sleep 150 (subagent agent)", id: "agent" },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("wakes a settled run whose native subagent ran on its own provider thread", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("native-subagent");
    const parentProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const childProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}:child`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    const subagentId = NodeId.make(`node:${threadId}:subagent`);
    // An older thread on the same Codex session is recovered first and stops it.
    const sibling = yield* createThread("a-shared-session");
    yield* createRun(sibling, "completed");
    for (const boundThreadId of [sibling, threadId]) {
      yield* projections.apply({
        id: EventId.make(`event:${boundThreadId}:session`),
        type: "provider-session.attached",
        threadId: boundThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const settledRun = yield* createRun(threadId, "completed", {
      providerThreadId: parentProviderThreadId,
    });
    for (const [id, nativeId] of [
      [parentProviderThreadId, "native-thread"],
      [childProviderThreadId, "agent-thread"],
    ] as const) {
      yield* projections.apply({
        id: EventId.make(`event:${id}`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id,
          appThreadId:
            id === parentProviderThreadId ? threadId : ThreadId.make(`${threadId}:child`),
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId,
          nativeThreadRef: { driver, nativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: id === parentProviderThreadId ? 1 : null,
          lastRunOrdinal: id === parentProviderThreadId ? 1 : null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const subagent = {
      threadId,
      runId: settledRun,
      origin: "provider_native",
      driver,
      providerInstanceId,
      childThreadId: null,
      prompt: "audit src",
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    } as const;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: subagentId,
        parentNodeId: NodeId.make(`node:${threadId}:root`),
        createdBy: "agent",
        providerThreadId: childProviderThreadId,
        nativeTaskRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        title: null,
        model: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent-item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: TurnItemId.make(`item:${threadId}:subagent`),
        nodeId: subagentId,
        providerThreadId: childProviderThreadId,
        providerTurnId: null,
        nativeItemRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        parentItemId: null,
        ordinal: 1,
        type: "subagent",
        title: "audit",
        subagentId,
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      {
        kind: "subagent",
        label: "audit (id agent-thread)",
        id: TurnItemId.make(`item:${threadId}:subagent`),
      },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("marks fork descendants unreadable when their source is missing or corrupt", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createThread("source");
    const sourceRun = yield* createRun(source, "completed");
    const fork = yield* createThread("fork", {
      forkedFrom: { type: "run", threadId: source, runId: sourceRun },
    });
    const descendant = yield* createThread("descendant", {
      forkedFrom: { type: "run", threadId: fork, runId: RunId.make("run:fork") },
    });
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{}'
      WHERE run_id = ${sourceRun}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([source, fork, descendant]),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${source}`;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([fork, descendant]),
    );
  }).pipe(Effect.provide(layerTest)),
);

const seedCompletedWarmTurn = Effect.fn("test.seedCompletedWarmTurn")(function* (trigger: string) {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:warm-session:" + trigger);
  const providerSessionId = ProviderSessionId.make("session:warm:" + trigger);
  const providerThreadId = ProviderThreadId.make("provider-thread:warm:" + trigger);
  const runId = RunId.make("run:warm:" + trigger);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("message:warm:" + trigger),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make("event:warm:thread:" + trigger),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:warm"),
        title: "Completed warm turn",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      id: EventId.make("event:warm:session:" + trigger),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    {
      id: EventId.make("event:warm:provider-thread:" + trigger),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId,
        nativeThreadRef: { driver, nativeId: "native-warm", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    },
    {
      id: EventId.make("event:warm:run:" + trigger),
      type: "run.created",
      threadId,
      runId,
      providerInstanceId,
      occurredAt: now,
      payload: run,
    },
    {
      id: EventId.make("event:warm:completed:" + trigger),
      type: "run.updated",
      threadId,
      runId,
      providerInstanceId,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    },
  ];
  yield* sink.write({ events });
  return { sink, store, projections, recovery, sql, threadId, run, now };
});

it.effect.each(["startup", "shutdown"] as const)(
  "%s persists idle warm-session cleanup through the event store with the projection at the event head",
  (trigger) =>
    Effect.gen(function* () {
      const { store, projections, recovery, sql, threadId } = yield* seedCompletedWarmTurn(trigger);
      const beforeHead = yield* store.latestSequence();
      const before = yield* projections.getThreadProjection(threadId);
      assert.equal(before.runs[0]?.status, "completed");
      assert.equal(before.providerSessions[0]?.status, "ready");
      assert.equal(before.providerThreads[0]?.status, "active");
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.stoppedSessions, 1);
      const stored = yield* store.read({ afterSequence: beforeHead }).pipe(Stream.runCollect);
      assert.deepEqual(
        stored.map(({ event }) => [
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
        [
          ["provider-thread.updated", "idle"],
          ["provider-session.updated", "stopped"],
        ],
      );
      const after = yield* projections.getThreadProjection(threadId);
      assert.equal(after.runs[0]?.status, "completed");
      assert.equal(after.providerSessions[0]?.status, "stopped");
      assert.equal(after.providerThreads[0]?.status, "idle");
      const head = yield* store.latestSequence();
      const metadata = yield* sql<{
        readonly last_sequence: number;
      }>`SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'`;
      assert.equal(head, beforeHead + 2);
      assert.deepEqual(metadata, [{ last_sequence: head }]);
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect.each(["normal", "prepare-failure"] as const)(
  "desktop stdin close performs shutdown before both ownership releases: %s",
  (scenario) =>
    Effect.gen(function* () {
      const { sink, store, projections, recovery, sql, threadId, run, now } =
        yield* seedCompletedWarmTurn("desktop:" + scenario);
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-graceful-owner-" });
      const statePath = path.join(root, "home", "userdata", "server-runtime.json");
      const ownerPath = path.join(path.dirname(statePath), "server-owner.sqlite");
      const admissionPath = path.join(root, "home", "native-admission.lock");
      const started = yield* Deferred.make<void>();
      const input = new NodeStream.PassThrough();
      let admissionFd: number | undefined,
        admissionReleased = false,
        ownerReleased = false;
      let providersClosed = false,
        reconciled = false;
      const releases: Array<{ resource: string; reconciled: boolean; providersClosed: boolean }> =
        [];
      if (scenario === "prepare-failure") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:shutdown:queued"),
              type: "run.created",
              threadId,
              runId: RunId.make("run:shutdown:queued"),
              providerInstanceId,
              occurredAt: now,
              payload: {
                ...run,
                id: RunId.make("run:shutdown:queued"),
                ordinal: 2,
                userMessageId: MessageId.make("message:shutdown:queued"),
                status: "queued",
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                queuePosition: 1,
                queueHeld: false,
              },
            },
          ],
        });
        yield* (yield* EffectOutbox.EffectOutboxV2).enqueue([
          {
            id: "effect:shutdown:continuation",
            commandId: CommandId.make("command:shutdown:continuation"),
            threadId,
            request: { type: "provider-runtime.continue", sourceRunId: run.id },
          },
        ]);
      }
      const beforeHead = yield* store.latestSequence();
      const mutableNodeFS: typeof NodeFS = NodeModule.createRequire(import.meta.url)("node:fs");
      const originalOpen = NodeFS.openSync,
        originalClose = NodeFS.closeSync;
      const originalDbClose = NodeSqlite.DatabaseSync.prototype.close;
      const openSpy = vi
        .spyOn(mutableNodeFS, "openSync")
        .mockImplementation((...args: Parameters<typeof NodeFS.openSync>) => {
          const fd = originalOpen(...args);
          if (String(args[0]) === admissionPath && admissionFd === undefined) admissionFd = fd;
          return fd;
        });
      const closeSpy = vi.spyOn(mutableNodeFS, "closeSync").mockImplementation((fd) => {
        if (fd === admissionFd && !admissionReleased) {
          admissionReleased = true;
          releases.push({ resource: "native admission", reconciled, providersClosed });
        }
        originalClose(fd);
      });
      const dbCloseSpy = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "close")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync) {
          const file = String(this.prepare("PRAGMA database_list").get()?.file ?? "");
          if (
            file.replaceAll("\\", "/").toLowerCase() ===
              ownerPath.replaceAll("\\", "/").toLowerCase() &&
            !ownerReleased
          ) {
            ownerReleased = true;
            releases.push({ resource: "server owner", reconciled, providersClosed });
          }
          originalDbClose.call(this);
        });
      NodeModule.syncBuiltinESMExports();
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          ServerConfig.ServerConfig,
          ServerConfig.make({
            ...(yield* ServerConfig.deriveServerPaths(path.join(root, "home"), undefined)),
            baseDir: path.join(root, "home"),
            cwd: root,
            logLevel: "Error",
            traceMinLevel: "Info",
            traceTimingEnabled: false,
            traceBatchWindowMs: 200,
            traceMaxBytes: 1024,
            traceMaxFiles: 1,
            otlpTracesUrl: undefined,
            otlpMetricsUrl: undefined,
            otlpLogsUrl: undefined,
            otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
            otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
            otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
            otelEnvironment: OtelEnvironment.none,
            staticDir: undefined,
            devUrl: undefined,
            devAllowedOrigins: [],
            desktopBootstrapToken: "synthetic-desktop-token",
            desktopShutdownOnStdin: true,
            mode: "desktop",
            host: "127.0.0.1",
            port: 3773,
            noBrowser: true,
            startupPresentation: "browser",
            autoBootstrapProjectFromCwd: false,
            logWebSocketEvents: false,
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          }),
        ),
        Layer.mock(Keybindings.Keybindings)({
          start: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          shutdown: Effect.sync(() => {
            providersClosed = true;
          }),
        }),
        Layer.succeed(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService, {
          ...recovery,
          prepareForShutdown:
            scenario === "prepare-failure"
              ? Effect.fail(
                  new ProviderRuntimeRecovery.ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    cause: "continuation preparation failed",
                  }),
                )
              : recovery.prepareForShutdown,
          reconcile: (trigger) =>
            recovery.reconcile(trigger).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  reconciled = true;
                }),
              ),
            ),
        }),
        Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({}),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({ managed: false }),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({}),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(AnalyticsService.AnalyticsService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
        Layer.succeed(ServerActivation, Effect.never),
      );
      // Same ownership-outside-runtime Layer.unwrap structure as server.ts.
      const runtime = Layer.unwrap(
        Effect.gen(function* () {
          yield* ServerOwnership.acquireServerOwnership(statePath);
          return ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies));
        }),
      );
      try {
        const server = yield* Effect.raceFirst(
          Layer.launch(runtime),
          awaitDesktopShutdown(input).pipe(Effect.andThen(Effect.interrupt)),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        input.end(DESKTOP_BACKEND_SHUTDOWN_COMMAND);
        const exited = yield* Fiber.await(server);
        assert.isTrue(Exit.isFailure(exited) && Cause.hasInterruptsOnly(exited.cause));
        assert.deepEqual(releases, [
          { resource: "server owner", reconciled: scenario === "normal", providersClosed: true },
          {
            resource: "native admission",
            reconciled: scenario === "normal",
            providersClosed: true,
          },
        ]);
        const after = yield* projections.getThreadProjection(threadId);
        const head = yield* store.latestSequence();
        assert.equal(
          after.providerSessions[0]?.status,
          scenario === "normal" ? "stopped" : "ready",
        );
        assert.equal(after.providerThreads[0]?.status, scenario === "normal" ? "idle" : "active");
        assert.equal(head, beforeHead + (scenario === "normal" ? 2 : 0));
        const metadata = yield* sql<{
          readonly last_sequence: number;
        }>`SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'`;
        assert.deepEqual(metadata, [{ last_sequence: head }]);
        if (scenario === "prepare-failure") {
          assert.equal(after.runs[1]?.status, "queued");
          const pending = yield* sql<{
            readonly status: string;
          }>`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = 'effect:shutdown:continuation'`;
          assert.deepEqual(pending, [{ status: "pending" }]);
        }
      } finally {
        input.destroy();
        openSpy.mockRestore();
        closeSpy.mockRestore();
        dbCloseSpy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerRecoveryTest, ProcessRunner.layer).pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
        ),
      ),
    ),
);

it.effect("startup ends the provider turn of a native child root it cancels", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const now = yield* DateTime.now;
    const parentThreadId = yield* createThread("native-child-root-turn-parent");
    const threadId = yield* createThread("native-child-root-turn");
    const rootNodeId = NodeId.make(`node:${threadId}:thread-root`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const providerTurnId = ProviderTurnId.make(`provider-turn:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:root`),
      type: "node.updated",
      threadId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: rootNodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    // A native subagent's turn belongs to no run attempt.
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:provider-turn`),
      type: "provider-turn.updated",
      threadId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: rootNodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    const subagentId = NodeId.make(`node:${parentThreadId}:subagent`);
    yield* projections.apply({
      id: EventId.make(`event:${parentThreadId}:subagent`),
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: {
        id: subagentId,
        threadId: parentThreadId,
        runId: null,
        parentNodeId: NodeId.make(`node:${parentThreadId}:root`),
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId,
        childThreadId: threadId,
        nativeTaskRef: null,
        title: null,
        model: null,
        prompt: "sleep 300",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    });

    yield* recovery.reconcile("startup");

    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(
      {
        root: projection.nodes.find((node) => node.id === rootNodeId)?.status,
        providerTurn: projection.providerTurns.find((turn) => turn.id === providerTurnId)?.status,
      },
      { root: "cancelled", providerTurn: "cancelled" },
      "a root startup recovery cancelled left its provider turn running",
    );
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect.each([
  { trigger: "startup", type: "todo_list" },
  { trigger: "shutdown", type: "todo_list" },
  { trigger: "startup", type: "proposed_plan" },
  { trigger: "shutdown", type: "proposed_plan" },
] as const)(
  "$trigger settles historical $type snapshots through projected events",
  ({ trigger, type }) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* EventStore.EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = yield* createThread(`historical-${type}:${trigger}`);
      const steps = [
        { id: "finished", text: "Keep the recorded result", status: "completed" },
        { id: "unfinished", text: "Keep the unfinished task", status: "running" },
        { id: "later", text: "Keep the remaining task", status: "pending" },
      ] as const;
      const events: OrchestrationV2DomainEvent[] = [];
      const terminalStatuses = [
        ["completed", "completed"],
        ["cancelled", "cancelled"],
        ["failed", "failed"],
        ["interrupted", "interrupted"],
        ["rolled_back", "interrupted"],
      ] as const;
      const expectedStatuses = new Map<
        NodeId,
        "completed" | "interrupted" | "failed" | "cancelled"
      >();
      for (const [index, [status, proposedStatus]] of terminalStatuses.entries()) {
        const runId = yield* createRun(threadId, status, { ordinal: index + 1, completedAt: now });
        const nodeId = NodeId.make(`node:historical-todo:${trigger}:${status}`);
        expectedStatuses.set(nodeId, type === "todo_list" ? "completed" : proposedStatus);
        const planId = PlanId.make(`plan:historical-todo:${trigger}:${status}`);
        const providerTurnId = ProviderTurnId.make(
          `provider-turn:historical-todo:${trigger}:${status}`,
        );
        const nativeItemRef = {
          driver,
          nativeId:
            type === "todo_list" ? `turn-plan:${providerTurnId}` : `proposal:${providerTurnId}`,
          strength: "strong",
        } as const;
        const snapshotStatus = ["pending", "running", "waiting"] as const;
        events.push(
          {
            id: EventId.make(`event:${nodeId}`),
            type: "node.updated",
            threadId,
            runId,
            nodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: type === "todo_list" ? "todo_list" : "plan",
              status: index === 0 ? "completed" : snapshotStatus[index % snapshotStatus.length]!,
              countsForRun: false,
              providerThreadId: null,
              providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: index === 0 ? now : null,
            },
          },
          {
            id: EventId.make(`event:${planId}`),
            type: "plan.updated",
            threadId,
            runId,
            nodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: planId,
              threadId,
              runId,
              nodeId,
              status: "active",
              ...(type === "todo_list"
                ? ({
                    kind: "todo_list",
                    steps,
                    explanation: "Preserve the actual task progress",
                  } as const)
                : ({
                    kind: "proposed_plan",
                    markdown: "## Preserve the partial proposal",
                  } as const)),
            },
          },
          {
            id: EventId.make(`event:item:${nodeId}`),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:${nodeId}`),
              threadId,
              runId,
              nodeId,
              providerThreadId: null,
              providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: index,
              status: snapshotStatus[index % snapshotStatus.length]!,
              title: "Recorded plan",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              planId,
              ...(type === "todo_list"
                ? ({
                    type: "todo_list",
                    steps,
                    explanation: "Preserve the actual task progress",
                  } as const)
                : ({
                    type: "proposed_plan",
                    markdown: "## Preserve the partial proposal",
                    streaming: true,
                  } as const)),
            },
          },
        );
      }
      const latestRunId = yield* createRun(threadId, "completed", { ordinal: 6 });
      const heldRunId = yield* createRun(threadId, "queued", { ordinal: 7, queueHeld: true });
      const heldNodeId = NodeId.make(`node:held-todo:${trigger}`);
      events.push({
        id: EventId.make(`event:${heldNodeId}`),
        type: "node.updated",
        threadId,
        runId: heldRunId,
        nodeId: heldNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: heldNodeId,
          threadId,
          runId: heldRunId,
          parentNodeId: null,
          rootNodeId: heldNodeId,
          kind: "todo_list",
          status: "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      const workNodeId = NodeId.make(`node:work:${trigger}`);
      events.push({
        id: EventId.make(`event:${workNodeId}`),
        type: "node.updated",
        threadId,
        runId: latestRunId,
        nodeId: workNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: workNodeId,
          threadId,
          runId: latestRunId,
          parentNodeId: null,
          rootNodeId: workNodeId,
          kind: "todo_list",
          status: "running",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* sink.write({ events });
      const before = yield* projections.getThreadProjection(threadId);
      const beforeHead = yield* store.latestSequence();
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);
      const bounded = yield* projections.getRuntimeRecoveryProjection(threadId);
      assert.equal(
        bounded.nodes.filter((node) => node.kind === "todo_list" || node.kind === "plan").length,
        6,
      );
      assert.equal(bounded.turnItems.filter((item) => item.type === type).length, 5);
      assert.equal(bounded.runs.length, 6);
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.stoppedSessions, 0);
      assert.equal(summary.closedRequests, 0);
      const after = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.plans, before.plans);
      assert.deepEqual(
        after.nodes.find((node) => node.id === heldNodeId),
        before.nodes.find((node) => node.id === heldNodeId),
      );
      assert.deepEqual(
        after.nodes.find((node) => node.id === workNodeId),
        before.nodes.find((node) => node.id === workNodeId),
      );
      for (const node of after.nodes.filter(
        (node) => node.id !== heldNodeId && node.id !== workNodeId,
      )) {
        const original = before.nodes.find((candidate) => candidate.id === node.id)!;
        assert.deepEqual(node, {
          ...original,
          status: expectedStatuses.get(node.id)!,
          completedAt: now,
        });
      }
      for (const item of after.turnItems) {
        const original = before.turnItems.find((candidate) => candidate.id === item.id)!;
        assert.deepEqual(item, {
          ...original,
          status: expectedStatuses.get(item.nodeId!)!,
          completedAt: now,
          updatedAt: now,
          ...(original.type === "proposed_plan" ? { streaming: false } : {}),
        });
      }
      const stored = yield* store.read({ afterSequence: beforeHead }).pipe(Stream.runCollect);
      assert.equal(stored.length, 9);
      assert.equal(stored.filter(({ event }) => event.type === "node.updated").length, 4);
      assert.equal(stored.filter(({ event }) => event.type === "turn-item.updated").length, 5);
      const head = yield* store.latestSequence();
      const metadata = yield* sql<{
        readonly last_sequence: number;
      }>`SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'`;
      assert.equal(head, beforeHead + 9);
      assert.deepEqual(metadata, [{ last_sequence: head }]);
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
      yield* recovery.reconcile(trigger);
      assert.equal(yield* store.latestSequence(), head);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("keeps request-linked, counting and mismatched historical plan items unchanged", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* EventStore.EventStoreV2;
    const threadId = yield* createThread("historical-plan-guards");
    const now = yield* DateTime.now;
    const runId = yield* createRun(threadId, "completed");
    const events: OrchestrationV2DomainEvent[] = [];
    for (const [index, scenario] of ["request-linked", "counting", "mismatched"].entries()) {
      const nodeId = NodeId.make(`node:historical-guard:${scenario}`);
      events.push(
        {
          id: EventId.make(`event:${nodeId}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: scenario === "mismatched" ? "plan" : "todo_list",
            status: scenario === "mismatched" ? "completed" : "running",
            countsForRun: scenario === "counting",
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId:
              scenario === "request-linked" ? RuntimeRequestId.make("request:retained") : null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: scenario === "mismatched" ? now : null,
          },
        },
        {
          id: EventId.make(`event:item:${nodeId}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${nodeId}`),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: index,
            type: "todo_list",
            status: "running",
            title: "Preserve guarded plan",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            planId: PlanId.make(`plan:${nodeId}`),
            steps: [{ id: "unfinished", text: "Still unfinished", status: "running" }],
          },
        },
      );
    }
    yield* sink.write({ events });
    const before = yield* projections.getThreadProjection(threadId);
    const beforeHead = yield* store.latestSequence();
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    const bounded = yield* projections.getRuntimeRecoveryProjection(threadId);
    assert.deepEqual(bounded.nodes, []);
    assert.deepEqual(bounded.turnItems, []);
    yield* recovery.reconcile("startup");
    const after = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(after.nodes, before.nodes);
    assert.deepEqual(after.turnItems, before.turnItems);
    assert.equal(yield* store.latestSequence(), beforeHead);
  }).pipe(Effect.provide(layerRecoveryTest)),
);
