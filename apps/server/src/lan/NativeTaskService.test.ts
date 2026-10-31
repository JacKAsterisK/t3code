// @effect-diagnostics nodeBuiltinImport:off -- Native storage regressions use only newly created temporary databases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type LanTaskLaunchInput,
  type LanTaskObserveResult,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Gateway from "./GatewayCompatibility.ts";
import * as Retention from "../agentEvents/AgentFactRetention.ts";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as CompatibilityFacts from "../agentEvents/AgentGatewayCompatibilityFacts.ts";
import * as Internal from "../agentEvents/AgentInternalFacts.ts";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import type { DispatchModeRefusal } from "../orchestration-v2/DispatchModeLimit.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as NativeTask from "./NativeTaskService.ts";

const assertSnapshot = Effect.fn("fixture.assertNativeWorkSnapshot")(function* (
  page: LanTaskObserveResult,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = (yield* sql<{
    json: string;
  }>`SELECT fact.data_json AS json FROM agent_gateway_compatibility_work_snapshots snapshot
    JOIN agent_event_facts fact ON fact.event_id=snapshot.fact_id WHERE snapshot.thread_id=${page.threadId}`)[0]!;
  const fact = yield* Internal.decodeJson(row.json);
  assert.equal(fact.kind, "gateway_work_snapshot");
  if (fact.kind !== "gateway_work_snapshot") return;
  assert.deepEqual(yield* CompatibilityFacts.readPage(fact.payload.page), page);
});

const threadId = ThreadId.make("thread:lan-test");
const shell = liveThreadShell(threadId, { runtimeMode: "approval-required" });
const projection = idleThreadProjection(shell);
const projectId = shell.projectId;
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const scope = (
  access: McpInvocationContext.McpClientCaller["access"] = "approval-required",
  namespace = "lan:approved-grant",
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:lan"),
  requestNamespace: namespace,
  thread: undefined,
  client: { sessionId: "session", label: "dot", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const input: LanTaskLaunchInput = {
  clientRequestId: "stable-launch",
  projectId,
  title: "Native task",
  message: "Run mocked work",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
};

function run(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: RunId.make("run:lan-test"),
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message:lan-test"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: shell.createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}
function request(kind: OrchestrationV2RuntimeRequest["kind"]): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make(`request:${kind}`),
    nodeId: NodeId.make("node:lan-test"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: shell.createdAt,
    resolvedAt: null,
  };
}
function facts(): Array<OrchestrationV2StoredEvent> {
  const common = { threadId, occurredAt: shell.createdAt };
  return [
    {
      sequence: 2,
      commandId: null,
      event: {
        ...common,
        id: EventId.make("event:created"),
        type: "thread.created",
        payload: projection.thread,
      },
    },
    {
      sequence: 4,
      commandId: null,
      event: {
        ...common,
        id: EventId.make("event:running"),
        type: "run.updated",
        payload: run("running"),
      },
    },
    {
      sequence: 7,
      commandId: null,
      event: {
        ...common,
        id: EventId.make("event:question"),
        type: "runtime-request.updated",
        payload: request("user_input"),
      },
    },
    {
      sequence: 8,
      commandId: null,
      event: {
        ...common,
        id: EventId.make("event:approval"),
        type: "runtime-request.updated",
        payload: request("command"),
      },
    },
    {
      sequence: 11,
      commandId: null,
      event: {
        ...common,
        id: EventId.make("event:completed"),
        type: "run.updated",
        payload: run("completed"),
      },
    },
  ];
}

function layer(
  options: {
    readonly filename?: string;
    readonly events?: ReadonlyArray<OrchestrationV2StoredEvent>;
    readonly launch?: ThreadLaunch.ThreadLaunchService["Service"]["launch"];
    readonly send?: OrchestratorMcp.OrchestratorMcpService["Service"]["sendToThread"];
    readonly runtimeMode?: RuntimeMode;
    readonly requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
    readonly supportsPlan?: boolean;
    readonly controls?: Partial<OrchestrationV2ThreadProjection>;
    readonly restartPending?: boolean;
    readonly sequenceAfterRead?: number;
  } = {},
) {
  const events = options.events ?? facts();
  let sequenceReads = 0;
  const database = Layer.effectDiscard(runMigrations()).pipe(
    Layer.provideMerge(
      NodeSqliteClient.layer({
        filename: options.filename ?? ":memory:",
        readerWorker: false,
        checkpointWorker: false,
      }),
    ),
  );
  return NativeTask.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ ...shell, runtimeMode: options.runtimeMode ?? shell.runtimeMode }),
          getThreadRecords: () =>
            Effect.succeed({
              ...projection,
              runtimeRequests: options.requests ?? [],
              ...options.controls,
            }),
          delegatedTaskResultPending: () => Effect.succeed(options.restartPending ?? false),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          checkWorktreeBase: () => Effect.void,
          launch:
            options.launch ?? (() => Effect.succeed({ threadId, projection, resumed: false })),
        }),
        Layer.mock(OrchestratorMcp.OrchestratorMcpService)(
          options.send === undefined ? {} : { sendToThread: options.send },
        ),
        Layer.mock(EventStore.EventStoreV2)({
          read: (input) =>
            Stream.fromIterable(
              events
                .filter(
                  (event) =>
                    event.sequence > (input?.afterSequence ?? 0) &&
                    event.sequence <= (input?.throughSequence ?? Infinity),
                )
                .slice(0, input?.limit),
            ),
          latestSequence: () =>
            Effect.sync(
              () =>
                (++sequenceReads > 1 ? options.sequenceAfterRead : undefined) ??
                events.at(-1)?.sequence ??
                0,
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "LAN",
              workspaceRoot: "/repo",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: modelSelection.instanceId,
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-01-01T00:00:00.000Z",
              models: [],
              slashCommands: [],
              skills: [],
              ...(options.supportedRuntimeModes === undefined
                ? {}
                : { supportedRuntimeModes: [...options.supportedRuntimeModes] }),
              ...(options.supportsPlan === undefined
                ? {}
                : { showInteractionModeToggle: options.supportsPlan }),
            },
          ]),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        FileSystem.layerNoop({}),
        NodeCrypto.layer,
      ),
    ),
  );
}

it.effect(
  "replays committed questions, approvals and run-terminal facts in bounded pages after reconnect",
  () =>
    Effect.gen(function* () {
      const service = yield* NativeTask.NativeTaskService;
      const first = yield* service.observe(scope(), { threadId, limit: 2 });
      assert.equal(first.hasMore, true);
      assert.equal(first.nextCursor.sequence, 4);
      const next = yield* service.observe(scope(), { threadId, after: first.nextCursor, limit: 2 });
      assert.deepEqual(
        next.events.map((event) => event.kind),
        ["question", "approval"],
      );
      const replay = yield* service.observe(scope(), {
        threadId,
        after: first.nextCursor,
        limit: 2,
      });
      assert.deepEqual(replay, next);
      const last = yield* service.observe(scope(), { threadId, after: next.nextCursor });
      assert.deepEqual(
        last.events.map((event) => [event.eventId, event.kind, event.runId]),
        [[EventId.make("event:completed"), "run_terminal", RunId.make("run:lan-test")]],
      );
      assert.equal(last.hasMore, false);
      assert.equal(last.nextCursor.sequence, 11);
      assert.deepEqual(
        (yield* service.observe(scope(), { threadId, after: last.nextCursor })).events,
        [],
      );
    }).pipe(Effect.provide(layer())),
);

it.effect("reports reset for an obsolete source and a cursor ahead of committed history", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const changed = yield* service.observe(scope(), {
      threadId,
      after: { sourceId: EventId.make("old-source"), sequence: 7 },
    });
    assert.equal(changed.resetReason, "source_changed");
    const ahead = yield* service.observe(scope(), {
      threadId,
      after: { sourceId: EventId.make("event:created"), sequence: 999 },
    });
    assert.equal(ahead.resetReason, "cursor_ahead");
    assert.deepEqual(ahead.events, []);
    const replaced = yield* service.observe(scope(), {
      threadId,
      after: {
        sourceId: EventId.make("event:created"),
        sequence: 7,
        anchorEventId: EventId.make("event:previous-database-branch"),
      },
    });
    assert.equal(replaced.resetReason, "source_changed");
    const missing = yield* service.observe(scope(), {
      threadId,
      after: {
        sourceId: EventId.make("event:created"),
        sequence: 6,
        anchorEventId: EventId.make("event:removed"),
      },
    });
    assert.equal(missing.resetReason, "history_unavailable");
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "refuses payload changes for a durable launch key and separates authenticated principals",
  () => {
    const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
    return Effect.gen(function* () {
      const service = yield* NativeTask.NativeTaskService;
      yield* service.launch(scope(), input);
      yield* service.launch(scope(), {
        ...input,
        modelSelection: { model: "gpt-5", instanceId: modelSelection.instanceId },
      });
      assert.equal(launches[0]?.threadId, launches[1]?.threadId);
      assert.equal(launches[0]?.commandId, launches[1]?.commandId);
      const restarted = Context.get(
        yield* Layer.build(NativeTask.layer),
        NativeTask.NativeTaskService,
      );
      const changed = yield* restarted
        .launch(scope(), { ...input, message: "Different task" })
        .pipe(Effect.flip);
      assert.equal(changed.code, "invalid_request");
      assert.equal(launches.length, 2);
      yield* service.launch(scope("approval-required", "lan:another-approved-grant"), input);
      assert.notEqual(launches[0]?.threadId, launches[2]?.threadId);
    }).pipe(
      Effect.provide(
        layer({
          launch: (request) =>
            Effect.sync(() => {
              launches.push(request);
              return { threadId: request.threadId ?? threadId, projection, resumed: false };
            }),
        }),
      ),
      Effect.scoped,
    );
  },
);

it.effect("retries an uncertain native launch with the original native identities", () => {
  const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  return Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    yield* service.launch(scope(), input).pipe(Effect.flip);
    yield* service.launch(scope(), input);
    assert.equal(launches.length, 2);
    assert.equal(launches[0]?.threadId, launches[1]?.threadId);
    assert.equal(launches[0]?.initialMessage?.messageId, launches[1]?.initialMessage?.messageId);
  }).pipe(
    Effect.provide(
      layer({
        launch: (request) =>
          Effect.suspend(() => {
            launches.push(request);
            return launches.length === 1
              ? Effect.fail(
                  new ThreadLaunch.ThreadLaunchError({
                    operation: "create-thread",
                    commandId: request.commandId,
                    projectId,
                    cause: "Lost reply after native commit",
                  }),
                )
              : Effect.succeed({
                  threadId: request.threadId ?? threadId,
                  projection,
                  resumed: true,
                });
          }),
      }),
    ),
  );
});

it.effect("rejects read-only writes and launches above the client's ceiling", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    assert.equal(
      (yield* service.launch(scope("read-only"), input).pipe(Effect.flip)).code,
      "capability_denied",
    );
    assert.equal(
      (yield* service.launch(scope(), { ...input, runtimeMode: "full-access" }).pipe(Effect.flip))
        .code,
      "runtime_mode_escalation_denied",
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("refuses unsupported provider modes without changing the requested permissions", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const runtime = yield* service
      .launch(scope("full-access"), { ...input, runtimeMode: "auto" })
      .pipe(Effect.flip);
    assert.equal(runtime.code, "invalid_request");
    const plan = yield* service
      .launch(scope(), { ...input, interactionMode: "plan" })
      .pipe(Effect.flip);
    assert.equal(plan.code, "invalid_request");
  }).pipe(
    Effect.provide(layer({ supportedRuntimeModes: ["approval-required"], supportsPlan: false })),
  ),
);

it.effect("requires an exact interruption target and retry-safe message delivery", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const interruption = yield* service
      .interrupt(scope(), { threadId, clientRequestId: "interrupt" })
      .pipe(Effect.flip);
    assert.equal(interruption.code, "invalid_request");
    const restart = yield* service
      .send(scope(), { threadId, clientRequestId: "restart", message: "Continue", mode: "restart" })
      .pipe(Effect.flip);
    assert.equal(restart.code, "invalid_request");
  }).pipe(Effect.provide(layer())),
);

it.effect("keeps a terminal run distinct from queued continuation work", () => {
  const events = facts();
  events.push({
    sequence: 12,
    commandId: null,
    event: {
      id: EventId.make("event:continuation"),
      threadId,
      occurredAt: shell.createdAt,
      type: "run.created",
      payload: {
        ...run("queued"),
        id: RunId.make("run:continuation"),
        ordinal: 2,
        restartContinuationOfRunId: RunId.make("run:lan-test"),
      },
    },
  });
  return Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const observed = yield* service.observe(scope(), { threadId });
    yield* assertSnapshot(observed);
    assert.deepEqual(
      observed.events.slice(-2).map((event) => [event.kind, event.runId, event.status]),
      [
        ["run_terminal", RunId.make("run:lan-test"), "completed"],
        ["run_state", RunId.make("run:continuation"), "queued"],
      ],
    );
    assert.equal(observed.taskWorkState, "working");
    assert.equal(observed.taskResultRunId, null);
  }).pipe(
    Effect.provide(
      layer({
        events,
        controls: {
          runs: [
            run("completed"),
            { ...run("queued"), id: RunId.make("run:continuation"), ordinal: 2 },
          ],
        },
      }),
    ),
  );
});

it.effect("reports an available native task result only after work has settled", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const observed = yield* service.observe(scope(), { threadId });
    yield* assertSnapshot(observed);
    assert.equal(observed.taskWorkState, "result_available");
    assert.equal(observed.taskResultRunId, RunId.make("run:lan-test"));
    assert.equal(observed.taskResultStatus, "completed");
  }).pipe(Effect.provide(layer({ controls: { runs: [run("completed")] } }))),
);

it.effect("waits for native background child work after the top-level run ends", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const observed = yield* service.observe(scope(), { threadId });
    yield* assertSnapshot(observed);
    assert.equal(observed.taskWorkState, "waiting_for_children");
    assert.equal(observed.taskResultRunId, null);
    assert.equal(observed.taskResultStatus, null);
  }).pipe(
    Effect.provide(
      layer({
        controls: {
          runs: [run("completed")],
          providerThreads: [
            {
              id: ProviderThreadId.make("provider-thread:background"),
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "active",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [{ taskId: "native-child", kind: "subagent" }],
              createdAt: shell.createdAt,
              updatedAt: shell.updatedAt,
            },
          ],
        },
      }),
    ),
  ),
);

it.effect("keeps a terminal run working while native restart delivery is pending", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const observed = yield* service.observe(scope(), { threadId });
    yield* assertSnapshot(observed);
    assert.equal(observed.taskWorkState, "working");
    assert.equal(observed.taskResultRunId, null);
    assert.equal(observed.taskResultStatus, null);
  }).pipe(Effect.provide(layer({ controls: { runs: [run("completed")] }, restartPending: true }))),
);

it.effect("defers completion when native state changes during observation", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const observed = yield* service.observe(scope(), { threadId });
    yield* assertSnapshot(observed);
    assert.equal(observed.headSequence, 11);
    assert.equal(observed.taskWorkState, "working");
    assert.equal(observed.taskResultRunId, null);
  }).pipe(Effect.provide(layer({ controls: { runs: [run("completed")] }, sequenceAfterRead: 12 }))),
);

it.effect("preserves dispatch ceilings across a concurrent target mode escalation", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const error = yield* service
      .send(scope(), { threadId, message: "Continue", clientRequestId: "send-key" })
      .pipe(Effect.flip);
    assert.equal(error.code, "runtime_mode_escalation_denied");
  }).pipe(
    Effect.provide(
      layer({
        send: () =>
          Effect.gen(function* () {
            const limit = yield* DispatchModeLimit;
            assert.equal(limit?.runtimeMode, "approval-required");
            if (limit?.refused !== undefined)
              yield* Ref.set<DispatchModeRefusal | undefined>(limit.refused, {
                threadId,
                mode: "runtime",
                runtimeMode: "full-access",
                interactionMode: "default",
              });
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Native dispatch refused.",
            });
          }),
      }),
    ),
  ),
);

it.effect("exposes approval facts without granting approval response authority", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const requests = yield* service.requests(scope(), { threadId });
    assert.deepEqual(
      requests.requests.map((request) => [request.kind, request.canRespond]),
      [
        ["command", false],
        ["user_input", true],
      ],
    );
    const denied = yield* service
      .respond(scope(), {
        threadId,
        requestId: RuntimeRequestId.make("request:command"),
        clientRequestId: "answer",
        answers: { decision: "accept" },
      })
      .pipe(Effect.flip);
    assert.equal(denied.code, "capability_denied");
  }).pipe(Effect.provide(layer({ requests: [request("command"), request("user_input")] }))),
);

it.effect("does not advertise a question response above the caller's current ceiling", () =>
  Effect.gen(function* () {
    const service = yield* NativeTask.NativeTaskService;
    const pending = yield* service.requests(scope("auto"), { threadId });
    assert.equal(pending.requests[0]?.canRespond, false);
    const denied = yield* service
      .respond(scope("auto"), {
        threadId,
        requestId: RuntimeRequestId.make("request:user_input"),
        clientRequestId: "answer:raised-mode",
        answers: {},
      })
      .pipe(Effect.flip);
    assert.equal(denied.code, "runtime_mode_escalation_denied");
  }).pipe(
    Effect.provide(
      layer({
        runtimeMode: "full-access",
        controls: { thread: { ...projection.thread, runtimeMode: "full-access" } },
        requests: [request("user_input")],
      }),
    ),
  ),
);

it.effect(
  "returns the native page with explicit unavailable evidence when controls exceed the private bound",
  () =>
    Effect.gen(function* () {
      const service = yield* NativeTask.NativeTaskService;
      const result = yield* service.observe(scope(), { threadId });
      assert.equal(result.status, "ok");
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{
        json: string;
      }>`SELECT fact.data_json AS json FROM agent_gateway_compatibility_work_snapshots snapshot JOIN agent_event_facts fact ON fact.event_id=snapshot.fact_id`)[0]!;
      const fact = yield* Internal.decodeJson(row.json);
      const snapshot = yield* CompatibilityFacts.readWorkSnapshot(
        (yield* sql<{
          id: string;
        }>`SELECT fact_id AS id FROM agent_gateway_compatibility_work_snapshots`)[0]!.id,
      );
      assert.deepEqual(snapshot.page, result);
      assert.equal(fact.kind, "gateway_work_snapshot");
      assert.deepEqual(snapshot.inputs, {
        status: "unavailable",
        reason: "overflow",
        maxDataBytes: Internal.maxDataBytes,
        pendingRestart: false,
        headSequence: result.headSequence,
        currentSequence: result.headSequence,
      });
    }).pipe(
      Effect.provide(
        layer({
          controls: {
            thread: { ...projection.thread, title: "oversized-title".repeat(1_300_000) },
          },
        }),
      ),
    ),
);

it.effect(
  "native capture survives failed COMMIT and aged unchanged-page receipt reuse across file restart",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-receipt-"))),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const filename = NodePath.join(directory, "state.sqlite");
      const controls = { runs: [run("running")] };
      const observed = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* NativeTask.NativeTaskService;
        const gateway = yield* Gateway.GatewayCompatibility.pipe(
          Effect.provide(Gateway.layer.pipe(Layer.provide(NodeCrypto.layer))),
        );
        const target = {
          principal: "native-regression",
          environmentId: scope().environmentId,
          threadId,
        };
        const error = yield* sql
          .withTransaction(sql`INSERT INTO agent_gateway_compatibility_snapshots
        (principal_id,environment_id,thread_id,fact_id) VALUES ('failed','temporary','temporary','missing-fact')`)
          .pipe(Effect.flip);
        assert.equal(error.reason._tag, "ConstraintError");
        yield* TestClock.setTime(0);
        const first = yield* service.observe(scope(), { threadId });
        yield* gateway.observe(target, first, { expectedDeliverySourceId: null });
        for (let day = 1; day <= 16; day++) {
          yield* TestClock.setTime(day * 86_400_000);
          controls.runs[0] = {
            ...run("running"),
            requestedAt: DateTime.makeUnsafe(day * 86_400_000),
          };
          assert.deepEqual(yield* service.observe(scope(), { threadId }), first);
          yield* Retention.pruneLog(day * 86_400_000);
        }
        assert.deepEqual(
          (yield* gateway.observe(target, first, { expectedDeliverySourceId: first.sourceId }))
            .page,
          first,
        );
        assert.deepEqual(yield* service.observe(scope(), { threadId }), first);
        assert.deepEqual(
          yield* sql`SELECT 1 FROM agent_gateway_compatibility_snapshots WHERE principal_id='failed'`,
          [],
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        return first;
      }).pipe(Effect.provide(layer({ filename, controls })));
      yield* Effect.gen(function* () {
        const service = yield* NativeTask.NativeTaskService;
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* service.observe(scope(), { threadId }), observed);
        const pointer = (yield* sql<{
          fact_id: string | null;
          receipt_json: string;
        }>`SELECT fact_id,receipt_json FROM agent_gateway_compatibility_snapshots`)[0]!;
        assert.isNull(pointer.fact_id);
        assert.deepEqual(JSON.parse(pointer.receipt_json), observed);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(layer({ filename, controls })));
    }).pipe(Effect.scoped),
);
