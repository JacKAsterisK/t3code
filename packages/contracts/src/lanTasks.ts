import * as Schema from "effect/Schema";
import {
  EventId,
  NonNegativeInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2UserInputQuestion,
} from "./orchestrationV2.ts";
import {
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./providerPolicy.ts";

export const LanTaskClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const LanTaskLaunchInput = Schema.Struct({
  clientRequestId: LanTaskClientRequestId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
});
export type LanTaskLaunchInput = typeof LanTaskLaunchInput.Type;
export const LanTaskLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runId: Schema.NullOr(RunId),
  status: Schema.NullOr(OrchestrationV2RunStatus),
});
export type LanTaskLaunchResult = typeof LanTaskLaunchResult.Type;

export const LanTaskRequestsInput = Schema.Struct({ threadId: ThreadId });
export type LanTaskRequestsInput = typeof LanTaskRequestsInput.Type;
export const LanTaskRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  kind: Schema.Union([ProviderRequestKind, Schema.Literal("user_input")]),
  status: Schema.Literals(["pending", "resolved", "expired", "cancelled"]),
  questions: Schema.optional(Schema.Array(OrchestrationV2UserInputQuestion)),
  canRespond: Schema.Boolean,
});
export const LanTaskRequestsResult = Schema.Struct({
  threadId: ThreadId,
  requests: Schema.Array(LanTaskRequest),
});
export type LanTaskRequestsResult = typeof LanTaskRequestsResult.Type;
export const LanTaskRespondInput = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  clientRequestId: LanTaskClientRequestId,
  answers: ProviderUserInputAnswers,
});
export type LanTaskRespondInput = typeof LanTaskRespondInput.Type;
export const LanTaskRespondResult = Schema.Struct({ sequence: NonNegativeInt });
export type LanTaskRespondResult = typeof LanTaskRespondResult.Type;

export const LanTaskEventCursor = Schema.Struct({
  sourceId: EventId,
  sequence: NonNegativeInt,
  anchorEventId: Schema.optional(EventId),
});
export const LanTaskObserveInput = Schema.Struct({
  threadId: ThreadId,
  after: Schema.optional(LanTaskEventCursor),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type LanTaskObserveInput = typeof LanTaskObserveInput.Type;
export const LanTaskObservation = Schema.Struct({
  eventId: EventId,
  sequence: NonNegativeInt,
  kind: Schema.Literals(["run_state", "run_terminal", "question", "approval", "request_state"]),
  runId: Schema.NullOr(RunId),
  requestId: Schema.NullOr(RuntimeRequestId),
  status: Schema.Union([
    OrchestrationV2RunStatus,
    Schema.Literals(["pending", "resolved", "expired", "cancelled"]),
  ]),
});
export type LanTaskObservation = typeof LanTaskObservation.Type;
export const LanTaskObserveResult = Schema.Struct({
  threadId: ThreadId,
  sourceId: EventId,
  status: Schema.Literals(["ok", "reset_required"]),
  resetReason: Schema.NullOr(
    Schema.Literals(["source_changed", "cursor_ahead", "history_unavailable"]),
  ),
  events: Schema.Array(LanTaskObservation).check(Schema.isMaxLength(100)),
  nextCursor: LanTaskEventCursor,
  headSequence: NonNegativeInt,
  hasMore: Schema.Boolean,
  taskWorkState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  taskResultRunId: Schema.NullOr(RunId),
  taskResultStatus: Schema.NullOr(OrchestrationV2RunStatus),
});
export type LanTaskObserveResult = typeof LanTaskObserveResult.Type;
