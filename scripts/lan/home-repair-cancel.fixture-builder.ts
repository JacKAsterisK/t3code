// @effect-diagnostics nodeBuiltinImport:off -- Standalone generated fixtures only; no credentials, provider adapters, workers or installed state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import {
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
} from "../../packages/contracts/src/index.ts";
import * as EventStore from "../../apps/server/src/orchestration-v2/EventStore.ts";
import * as EventSink from "../../apps/server/src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../../apps/server/src/orchestration-v2/TurnItemPositionStore.ts";
import { runMigrations } from "../../apps/server/src/persistence/Migrations.ts";
import { assertOrdinaryNativePath } from "../../packages/shared/src/nativeHomeSelection.ts";

const CodexProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
};

const decodeFixtureEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);

export async function migrateCancellationFixtureDatabase(database: string, head: number) {
  await Effect.runPromise(
    runMigrations({ toMigrationInclusive: head }).pipe(
      Effect.provide([
        NodeSqliteClient.layer({ filename: database }),
        NodeServices.layer,
        Logger.layer([], { mergeWithExisting: false }),
      ]),
      Effect.scoped,
    ),
  );
}

const now = "2026-10-25T00:00:00.000Z",
  threadId = "thread:offline-fixture",
  modelSelection = { instanceId: "codex", model: "synthetic-no-model" };
export async function seedCancellationFixture(
  file: string,
  secondThread = false,
  unfinished = true,
) {
  const database = NodeSqliteClient.layer({ filename: file });
  const stores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provideMerge(database));
  const writers = EventSink.layer.pipe(Layer.provideMerge(stores));
  const events: Record<string, unknown>[] = [];
  const add = (type: string, payload: Record<string, unknown>) =>
    events.push({ id: `event:fixture:${events.length}`, threadId, type, occurredAt: now, payload });
  add("thread.created", {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture",
    title: "Retained session",
    providerInstanceId: "codex",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: "provider-thread:fixture",
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  });
  add("provider-session.attached", {
    id: "session:fixture",
    driver: "codex",
    providerInstanceId: "codex",
    status: "ready",
    cwd: "C:/synthetic",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  });
  add("provider-thread.updated", {
    id: "provider-thread:fixture",
    driver: "codex",
    providerInstanceId: "codex",
    providerSessionId: "session:fixture",
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 15,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  for (let i = 0; i < 15; i++) {
    add("message.updated", {
      id: `message:${i}`,
      threadId,
      runId: `run:${i}`,
      nodeId: null,
      role: "user",
      text: `Retained request ${i}`,
      attachments:
        i === 0
          ? [
              {
                type: "file",
                id: "retained",
                name: "retained.txt",
                mimeType: "text/plain",
                sizeBytes: 25,
              },
            ]
          : [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
    });
    add("run.created", {
      id: `run:${i}`,
      threadId,
      ordinal: i + 1,
      providerInstanceId: "codex",
      modelSelection,
      providerThreadId: "provider-thread:fixture",
      userMessageId: `message:${i}`,
      rootNodeId: `node:${i}`,
      activeAttemptId: `attempt:${i}`,
      status: i === 14 ? "running" : "queued",
      queuePosition: i + 1,
      requestedAt: now,
      startedAt: i === 14 ? now : null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
    add("run-attempt.created", {
      id: `attempt:${i}`,
      runId: `run:${i}`,
      attemptOrdinal: 1,
      rootNodeId: `node:${i}`,
      providerInstanceId: "codex",
      providerThreadId: "provider-thread:fixture",
      providerTurnId: i === 14 ? "turn:fixture" : null,
      reason: "initial",
      status: i === 14 ? "running" : "pending",
      startedAt: i === 14 ? now : null,
      completedAt: null,
    });
  }
  for (let i = 0; i < 234; i++)
    add("node.updated", {
      id: `node:${i}`,
      threadId,
      runId: i < 14 ? `run:${i}` : "run:14",
      parentNodeId: null,
      rootNodeId: i < 14 ? `node:${i}` : "node:14",
      kind: "tool_call",
      status: i < 14 ? "pending" : i < 232 ? "running" : "waiting",
      countsForRun: true,
      providerThreadId: "provider-thread:fixture",
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    });
  add("provider-turn.updated", {
    id: "turn:fixture",
    providerThreadId: "provider-thread:fixture",
    nodeId: "node:14",
    runAttemptId: "attempt:14",
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: now,
    completedAt: null,
  });
  for (let i = 0; i < 2; i++)
    add("runtime-request.updated", {
      id: `request:${i}`,
      nodeId: `node:${232 + i}`,
      providerTurnId: "turn:fixture",
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability:
        i === 0 ? { type: "message" } : { type: "live", providerSessionId: "session:fixture" },
      createdAt: now,
      resolvedAt: null,
    });
  for (let i = 0; i < 220; i++)
    add("turn-item.updated", {
      id: `item:${i}`,
      threadId,
      runId: "run:14",
      nodeId: `node:${14 + i}`,
      providerThreadId: "provider-thread:fixture",
      providerTurnId: "turn:fixture",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: i,
      status: i < 218 ? "running" : "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "assistant_message",
      messageId: "message:streaming",
      text: "Retained partial response",
      streaming: true,
    });
  add("message.updated", {
    id: "message:streaming",
    threadId,
    runId: "run:14",
    nodeId: "node:14",
    role: "assistant",
    text: "Retained partial response",
    attachments: [],
    streaming: true,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: now,
    updatedAt: now,
  });
  const additional: Record<string, unknown>[] = [];
  if (secondThread) {
    for (const [type, suffix] of [
      ["thread.created", "thread"],
      ["message.updated", "message"],
      ["run.created", "run"],
    ] as const) {
      const source = events.find((event) => event.type === type)!;
      const payload = { ...(source.payload as Record<string, unknown>) };
      Object.assign(payload, {
        id: `${suffix}:second`,
        ...(type === "thread.created"
          ? {
              lineage: {
                rootThreadId: "thread:second",
                parentThreadId: null,
                relationshipToParent: null,
              },
            }
          : { threadId: "thread:second" }),
        ...(type === "run.created"
          ? { userMessageId: "message:second", rootNodeId: null, activeAttemptId: null, ordinal: 1 }
          : {}),
      });
      additional.push({
        ...source,
        id: `event:second:${suffix}`,
        threadId: "thread:second",
        payload,
      });
    }
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const nativeSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const modern = yield* sql`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_event_source_state'
      `;
      // These genuine schema-67/71 homes predate the source journal. Seed their native
      // log and projection atomically without the current EventSink's post-83 capture.
      const service = {
        write: Effect.fn("seedCancellationFixture.write")(function* (input: {
          events: ReadonlyArray<OrchestrationV2DomainEvent>;
        }) {
          // Follow-up fixtures on an upgraded home keep the real current capture contract.
          if (modern.length > 0) return yield* nativeSink.write(input);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const ordinals = new Map(
                input.events.flatMap((event) =>
                  event.type === "run.created" || event.type === "run.updated"
                    ? [[event.payload.id, event.payload.ordinal] as const]
                    : [],
                ),
              );
              const events = yield* Effect.forEach(
                input.events,
                (
                  event,
                ): Effect.Effect<
                  OrchestrationV2DomainEvent,
                  TurnItemPositionStore.TurnItemPositionStoreError
                > =>
                  event.type === "turn-item.updated"
                    ? positions
                        .normalize(
                          event.payload,
                          event.payload.runId === null
                            ? undefined
                            : ordinals.get(event.payload.runId),
                        )
                        .pipe(Effect.map((payload) => ({ ...event, payload })))
                    : Effect.succeed(event),
              );
              const stored = yield* eventStore.append({ events });
              yield* Effect.forEach(stored, ({ event }) => projectionStore.apply(event), {
                discard: true,
              });
              const sequence = stored.at(-1)?.sequence;
              if (sequence !== undefined)
                yield* sql`
                  INSERT INTO orchestration_v2_projection_metadata
                    (projection_name, schema_version, last_sequence, updated_at)
                  VALUES ('thread-projections', ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}, ${sequence}, ${now})
                  ON CONFLICT(projection_name) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    last_sequence = excluded.last_sequence,
                    updated_at = excluded.updated_at
                `;
            }),
          );
        }),
      };
      yield* service.write({
        events: yield* Effect.forEach(
          unfinished
            ? [...events, ...additional]
            : events
                .filter(
                  (event) =>
                    event.type === "thread.created" ||
                    (event.type === "message.updated" &&
                      ["message:0", "message:1"].includes(
                        String((event.payload as Record<string, unknown>).id),
                      )),
                )
                .map((event) => ({
                  ...event,
                  payload: {
                    ...(event.payload as Record<string, unknown>),
                    ...(event.type === "thread.created"
                      ? { activeProviderThreadId: null }
                      : { runId: null, nodeId: null }),
                  },
                })),
          (event) => decodeFixtureEvent(event),
        ),
      });
    }).pipe(
      Effect.provide(writers),
      Effect.provide([NodeServices.layer, Logger.layer([], { mergeWithExisting: false })]),
      Effect.scoped,
    ),
  );
}

export async function createCancellationFixture(root: string) {
  if (!NodePath.isAbsolute(root) || NodePath.resolve(root) !== root)
    throw new Error("Fixture requires a canonical absolute root.");
  assertOrdinaryNativePath(root, true);
  if (NodeFS.existsSync(root) && NodeFS.readdirSync(root).length)
    throw new Error("Fixture root must be new or empty.");
  NodeFS.mkdirSync(root, { recursive: true });
  const localAppData = NodePath.join(root, "AppData", "Local"),
    appDataDirectory = NodePath.join(root, "AppData", "Roaming");
  const homes = [
    {
      home: NodePath.join(root, ".t3"),
      head: 67,
      id: "11111111-1111-4111-8111-111111111111",
      unfinished: true,
    },
    {
      home: NodePath.join(localAppData, "T3CodeLAN", "data"),
      head: 71,
      id: "22222222-2222-4222-8222-222222222222",
      unfinished: false,
    },
  ];
  for (const { home, head, id, unfinished } of homes) {
    const state = NodePath.join(home, "userdata");
    NodeFS.mkdirSync(NodePath.join(state, "attachments"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(state, "environment-id"), id + "\n", { flag: "wx" });
    NodeFS.writeFileSync(NodePath.join(home, "native-admission.lock"), "synthetic admission file", {
      flag: "wx",
    });
    NodeFS.writeFileSync(NodePath.join(state, "server-owner.sqlite"), "synthetic owner file", {
      flag: "wx",
    });
    NodeFS.writeFileSync(
      NodePath.join(state, "attachments", "retained.txt"),
      "Retained attachment bytes",
      {
        flag: "wx",
      },
    );
    const database = NodePath.join(state, "statev2.sqlite");
    await Effect.runPromise(
      runMigrations({ toMigrationInclusive: head }).pipe(
        Effect.provide([
          NodeSqliteClient.layer({ filename: database }),
          NodeServices.layer,
          Logger.layer([], { mergeWithExisting: false }),
        ]),
        Effect.scoped,
      ),
    );
    await seedCancellationFixture(database, false, unfinished);
    const db = new NodeSqlite.DatabaseSync(database);
    try {
      db.exec(
        `INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_at,last_run_status,last_run_error,run_count) VALUES ('retained-disabled','Retained disabled schedule','Synthetic only',0,'{}','project:fixture',NULL,'{}','{}','full-access','default','user','web','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z',NULL,NULL,'completed',NULL,1)`,
      );
    } finally {
      db.close();
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(homes[1]!.home, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        claudeFixture: {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: NodePath.join(root, "synthetic-claude-one") },
          environment: [],
        },
        claudeFixtureTwo: {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: NodePath.join(root, "synthetic-claude-two") },
          environment: [],
        },
      },
    }),
    { flag: "wx" },
  );
  for (const profile of [
    NodePath.join(appDataDirectory, "t3code-v2"),
    NodePath.join(localAppData, "T3CodeLAN", "electron-profile"),
  ]) {
    NodeFS.mkdirSync(profile, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(profile, "Local State"),
      "opaque synthetic placeholder, no usable DPAPI or credential",
      { flag: "wx" },
    );
  }
  const report = {
    schemaVersion: 1,
    synthetic: true,
    usableCredentials: false,
    genuineMigrationSchemas: true,
    userHomeDirectory: root,
    localAppData,
    appDataDirectory,
    originalWork: { queued: 14, running: 1, pendingRequests: 2 },
    homes,
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "synthetic-cancellation-fixture.json"),
    JSON.stringify(report) + "\n",
    { flag: "wx" },
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--root" || !process.argv[3])
      throw new Error("Invalid fixture arguments");
    process.stdout.write(JSON.stringify(await createCancellationFixture(process.argv[3])) + "\n");
  } catch {
    process.stderr.write("synthetic_cancellation_fixture_refused\n");
    process.exitCode = 1;
  }
}
