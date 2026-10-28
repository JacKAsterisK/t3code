import {
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  ProviderRequestKind,
  ThreadId,
  type LanTaskLaunchInput,
  type LanTaskLaunchResult,
  type LanTaskObservation,
  type LanTaskObserveInput,
  type LanTaskObserveResult,
  type LanTaskRequestsInput,
  type LanTaskRequestsResult,
  type LanTaskRespondInput,
  type LanTaskRespondResult,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../mcp/delegatedTaskModes.ts";
import {
  assertLiveCaller,
  assertTargetWithinLimits,
  dispatchFailure,
  isLiveCallerShell,
  readCaller,
  unavailable,
} from "../mcp/threadAccess.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import type { DispatchModeRefusal } from "../orchestration-v2/DispatchModeLimit.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

type Scope = McpInvocationContext.McpInvocationScope;
type Native = OrchestratorMcp.OrchestratorMcpService["Service"];

export class NativeTaskService extends Context.Service<
  NativeTaskService,
  {
    readonly launch: (
      scope: Scope,
      input: LanTaskLaunchInput,
    ) => Effect.Effect<LanTaskLaunchResult, OrchestratorMcpFailure>;
    readonly list: Native["listThreads"];
    readonly read: Native["readThread"];
    readonly send: Native["sendToThread"];
    readonly interrupt: Native["interruptThread"];
    readonly requests: (
      scope: Scope,
      input: LanTaskRequestsInput,
    ) => Effect.Effect<LanTaskRequestsResult, OrchestratorMcpFailure>;
    readonly respond: (
      scope: Scope,
      input: LanTaskRespondInput,
    ) => Effect.Effect<LanTaskRespondResult, OrchestratorMcpFailure>;
    readonly observe: (
      scope: Scope,
      input: LanTaskObserveInput,
    ) => Effect.Effect<LanTaskObserveResult, OrchestratorMcpFailure>;
  }
>()("t3/lan/NativeTaskService") {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

const isApproval = Schema.is(ProviderRequestKind);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function observation(stored: OrchestrationV2StoredEvent): LanTaskObservation | undefined {
  const { event, sequence } = stored;
  const common = { eventId: event.id, sequence, runId: event.runId ?? null };
  if (event.type === "run.updated" || event.type === "run.created") {
    // A terminal run can still have queued work or a pending restart continuation.
    return {
      ...common,
      runId: event.payload.id,
      requestId: null,
      status: event.payload.status,
      kind: ThreadManagement.isTerminalRunStatus(event.payload.status)
        ? "run_terminal"
        : "run_state",
    };
  }
  if (
    event.type === "runtime-request.updated" &&
    (event.payload.kind === "user_input" || isApproval(event.payload.kind))
  ) {
    return {
      ...common,
      requestId: event.payload.id,
      status: event.payload.status,
      kind:
        event.payload.status !== "pending"
          ? "request_state"
          : event.payload.kind === "user_input"
            ? "question"
            : "approval",
    };
  }
  return undefined;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const native = yield* OrchestratorMcp.OrchestratorMcpService;
  const events = yield* EventStore.EventStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const authorize = Effect.fn("NativeTaskService.authorize")(function* (
    scope: Scope,
    write: boolean,
    threadId?: ThreadId,
  ) {
    const caller = yield* readCaller().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    if (write) {
      if (scope.client?.access === "read-only")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This MCP client has read-only access.",
        });
      yield* assertLiveCaller(caller);
    }
    if (threadId !== undefined) {
      const target = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (target === null || target.deletedAt !== null)
        return yield* new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "The thread was not found.",
        });
      if (write) yield* assertTargetWithinLimits(caller.limits, target);
    }
    return caller;
  });

  const claim = Effect.fn("NativeTaskService.claim")(function* (
    scope: Scope,
    operation: string,
    input: { readonly clientRequestId?: string | undefined },
  ) {
    if (input.clientRequestId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A stable clientRequestId is required for LAN mutations.",
      });
    const key = yield* encodeJson([
      scope.environmentId,
      scope.requestNamespace,
      operation,
      input.clientRequestId,
    ]).pipe(Effect.mapError(unavailable));
    const payload = yield* encodeJson(canonical(input)).pipe(Effect.mapError(unavailable));
    const keyDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(key))
      .pipe(Effect.mapError(unavailable));
    const payloadDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(payload))
      .pipe(Effect.mapError(unavailable));
    const commandId = CommandId.make(`lan:${Buffer.from(keyDigest).toString("hex")}`);
    const fingerprint = Buffer.from(payloadDigest).toString("hex");
    yield* sql`INSERT OR IGNORE INTO lan_task_mutations (command_id, payload_fingerprint) VALUES (${commandId}, ${fingerprint})`.pipe(
      Effect.mapError(unavailable),
    );
    const rows = yield* sql<{
      payload_fingerprint: string;
    }>`SELECT payload_fingerprint FROM lan_task_mutations WHERE command_id = ${commandId}`.pipe(
      Effect.mapError(unavailable),
    );
    if (rows[0]?.payload_fingerprint !== fingerprint)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "This clientRequestId was already used with a different payload.",
      });
    return commandId;
  });

  const writeThread = Effect.fn("NativeTaskService.writeThread")(function* <A>(
    scope: Scope,
    input: { readonly threadId: ThreadId; readonly clientRequestId?: string | undefined },
    operation: string,
    run: Effect.Effect<A, OrchestratorMcpFailure>,
  ) {
    const { limits } = yield* authorize(scope, true, input.threadId);
    yield* claim(scope, operation, input);
    const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
    return yield* run.pipe(
      Effect.provideService(DispatchModeLimit, { ...limits, refused }),
      Effect.catch((error) =>
        Effect.flatMap(Ref.get(refused), (refusal) =>
          Effect.fail(
            refusal === undefined
              ? error
              : new OrchestratorMcpFailure({
                  code:
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                  message:
                    "The target thread's modes changed above this client's approved ceiling.",
                }),
          ),
        ),
      ),
    );
  });

  const launch: NativeTaskService["Service"]["launch"] = Effect.fn("NativeTaskService.launch")(
    function* (scope, input) {
      const { limits } = yield* authorize(scope, true);
      yield* resolveRuntimeMode(limits.runtimeMode, input.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, input.interactionMode);
      const provider = (yield* providers.getProviders).find(
        (provider) => provider.instanceId === input.modelSelection.instanceId,
      );
      if (provider === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "provider_unavailable",
          message: "The selected provider instance is unavailable.",
        });
      if (
        provider.supportedRuntimeModes !== undefined &&
        provider.supportedRuntimeModes.length > 0 &&
        !provider.supportedRuntimeModes.includes(input.runtimeMode)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The selected provider does not support the requested runtime mode.",
        });
      if (input.interactionMode === "plan" && provider.showInteractionModeToggle === false)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The selected provider does not support plan mode.",
        });
      const commandId = yield* claim(scope, "launch", input);
      const threadId = ThreadId.make(commandId);
      const messageId = MessageId.make(`${commandId}:initial-message`);
      const project = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      if (input.workspaceStrategy.type === "existing_worktree") {
        const real = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
        const paths = yield* git.listWorktreePaths(project.value.workspaceRoot).pipe(
          Effect.flatMap((paths) => Effect.forEach(paths, real)),
          Effect.mapError(unavailable),
        );
        if (!paths.includes(yield* real(input.workspaceStrategy.worktreePath)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "worktreePath must be one of the project's git worktrees.",
          });
      }
      yield* launches.checkWorktreeBase(input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The requested worktree base does not resolve. No thread was created.",
            }),
        ),
      );
      const result = yield* launches
        .launch({
          ...input,
          commandId,
          threadId,
          initialMessage: { messageId, text: input.message, attachments: [] },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
      const run = result.projection.runs.find((run) => run.userMessageId === messageId);
      return {
        threadId: result.threadId,
        projectId: result.projection.thread.projectId,
        modelSelection: result.projection.thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    },
  );

  const requests: NativeTaskService["Service"]["requests"] = Effect.fn(
    "NativeTaskService.requests",
  )(function* (scope, input) {
    const caller = yield* authorize(scope, false, input.threadId);
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request"],
      })
      .pipe(Effect.mapError(unavailable));
    const canWrite =
      scope.client?.access !== "read-only" &&
      exceededDispatchModeLimit(caller.limits, projection.thread) === undefined &&
      (caller.caller === undefined ||
        isLiveCallerShell(caller.caller, scope.thread?.providerInstanceId));
    return {
      threadId: input.threadId,
      requests: projection.runtimeRequests.flatMap((request) => {
        if (
          request.status !== "pending" ||
          (request.kind !== "user_input" && !isApproval(request.kind))
        )
          return [];
        const item = projection.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === request.id,
        );
        return [
          {
            requestId: request.id,
            kind: request.kind,
            status: request.status,
            canRespond:
              request.kind === "user_input" &&
              canWrite &&
              request.responseCapability.type !== "not_resumable",
            ...(item?.type === "user_input_request" ? { questions: item.questions } : {}),
          },
        ];
      }),
    };
  });

  const respond: NativeTaskService["Service"]["respond"] = Effect.fn("NativeTaskService.respond")(
    function* (scope, input) {
      yield* authorize(scope, true, input.threadId);
      const commandId = yield* claim(scope, "respond", input);
      return yield* writeThread(
        scope,
        input,
        "respond",
        Effect.gen(function* () {
          const projection = yield* threads
            .getThreadRecords(input.threadId, ["runtimeRequests"])
            .pipe(Effect.mapError(unavailable));
          const request = projection.runtimeRequests.find(
            (request) => request.id === input.requestId,
          );
          if (request?.kind !== "user_input")
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "LAN task control answers questions only. Approval decisions remain with the native approval holder.",
            });
          const result = yield* threads
            .dispatch({
              type: "runtime-request.respond",
              threadId: input.threadId,
              requestId: input.requestId,
              commandId,
              answers: input.answers,
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence };
        }),
      );
    },
  );

  const observe: NativeTaskService["Service"]["observe"] = Effect.fn("NativeTaskService.observe")(
    function* (scope, input) {
      yield* authorize(scope, false, input.threadId);
      const first = (yield* events
        .read({ threadId: input.threadId, limit: 1 })
        .pipe(Stream.runCollect, Effect.mapError(unavailable)))[0];
      if (first === undefined) return yield* unavailable();
      const sourceId = first.event.id;
      const headSequence = yield* events
        .latestSequence({ threadId: input.threadId })
        .pipe(Effect.mapError(unavailable));
      let resetReason: LanTaskObserveResult["resetReason"] =
        first.event.type !== "thread.created"
          ? "history_unavailable"
          : input.after !== undefined && input.after.sourceId !== sourceId
            ? "source_changed"
            : input.after !== undefined && input.after.sequence > headSequence
              ? "cursor_ahead"
              : null;
      if (resetReason === null && input.after?.anchorEventId !== undefined) {
        // A restored database can retain thread creation while replacing later history.
        const anchor = (yield* events
          .read({
            threadId: input.threadId,
            afterSequence: Math.max(0, input.after.sequence - 1),
            throughSequence: input.after.sequence,
            limit: 1,
          })
          .pipe(Stream.runCollect, Effect.mapError(unavailable)))[0];
        if (anchor === undefined) resetReason = "history_unavailable";
        else if (anchor.event.id !== input.after.anchorEventId) resetReason = "source_changed";
      }
      if (resetReason !== null)
        return {
          threadId: input.threadId,
          sourceId,
          status: "reset_required",
          resetReason,
          events: [],
          nextCursor: { sourceId, sequence: 0 },
          headSequence,
          hasMore: false,
          taskWorkState: "working",
          taskResultRunId: null,
          taskResultStatus: null,
        };
      const limit = Math.min(100, Math.max(1, input.limit ?? 100));
      const afterSequence = input.after?.sequence ?? 0;
      const rows = yield* events
        .read({
          threadId: input.threadId,
          afterSequence,
          throughSequence: headSequence,
          limit: limit + 1,
        })
        .pipe(Stream.runCollect, Effect.mapError(unavailable));
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const anchorEventId = page.at(-1)?.event.id ?? input.after?.anchorEventId;
      const controls = yield* threads
        .getThreadRecords(
          input.threadId,
          ["runs", "messages", "subagents", "providerThreads", "runtimeRequests", "nodes"],
          { messageRoles: ["user"], omitSettledLeafNodes: true },
        )
        .pipe(Effect.mapError(unavailable));
      const progress = delegatedTaskProgress(controls);
      const pendingRestart =
        progress.state === "result_available" &&
        (yield* threads
          .delegatedTaskResultPending(input.threadId)
          .pipe(Effect.mapError(unavailable)));
      const currentSequence = yield* events
        .latestSequence({ threadId: input.threadId })
        .pipe(Effect.mapError(unavailable));
      // A restart can be pending in the outbox before its continuation has a run.
      // Changes during this read defer completion to the next coherent observation.
      const taskWorkState =
        progress.state === "result_available" &&
        (pendingRestart || currentSequence !== headSequence)
          ? "working"
          : progress.state;
      const resultRun = taskWorkState === "result_available" ? progress.resultRun : undefined;
      return {
        threadId: input.threadId,
        sourceId,
        status: "ok",
        resetReason: null,
        events: page.flatMap((stored) => {
          const item = observation(stored);
          return item === undefined ? [] : [item];
        }),
        nextCursor: {
          sourceId,
          sequence: hasMore ? (page.at(-1)?.sequence ?? afterSequence) : headSequence,
          ...(anchorEventId === undefined ? {} : { anchorEventId }),
        },
        headSequence,
        hasMore,
        taskWorkState,
        taskResultRunId: resultRun?.id ?? null,
        taskResultStatus: resultRun === undefined ? null : runOutcome(resultRun),
      };
    },
  );

  return NativeTaskService.of({
    launch,
    list: Effect.fn("NativeTaskService.list")(function* (scope, input) {
      yield* authorize(scope, false);
      return yield* native.listThreads(scope, input);
    }),
    read: Effect.fn("NativeTaskService.read")(function* (scope, input) {
      yield* authorize(scope, false, input.threadId);
      return yield* native.readThread(scope, input);
    }),
    send: Effect.fn("NativeTaskService.send")(function* (scope, input) {
      if (input.mode !== undefined && input.mode !== "auto" && input.mode !== "queue")
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "LAN messages support auto or queue delivery. Steer and restart require a separate native action.",
        });
      return yield* writeThread(scope, input, "send", native.sendToThread(scope, input));
    }),
    interrupt: Effect.fn("NativeTaskService.interrupt")(function* (scope, input) {
      if (input.runId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "LAN interruption requires an explicit runId so retries cannot select a different run.",
        });
      return yield* writeThread(scope, input, "interrupt", native.interruptThread(scope, input));
    }),
    requests,
    respond,
    observe,
  });
});

export const layer = Layer.effect(NativeTaskService, make);
