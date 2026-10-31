// @effect-diagnostics nodeBuiltinImport:off -- Stable occurrence keys hash immutable source coordinates.
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { FleetUsersObservation } from "../lan/FleetUsers.ts";
import { factEventId, type FactData } from "./AgentFactStore.ts";
import { reduceNativeObservation } from "./AgentGatewayCompatibilityReducer.ts";

const RequestState = Schema.Struct({
  request: OrchestrationV2RuntimeRequestJson,
  incarnation: Schema.String,
  fingerprint: Schema.NullOr(Schema.String),
  latestEventId: Schema.NullOr(Schema.String),
  lost: Schema.Boolean,
});
export const ReducerState = Schema.Struct({
  version: Schema.Literal(1),
  sourceSequence: Schema.Number,
  thread: Schema.NullOr(OrchestrationV2AppThreadJson),
  assignmentRevision: Schema.Number,
  assignmentOwner: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  requests: Schema.Record(Schema.String, RequestState),
  attentionItems: Schema.Record(Schema.String, OrchestrationV2TurnItemJson),
  secrets: Schema.Record(
    Schema.String,
    Schema.Struct({
      incarnation: Schema.String,
      name: Schema.String,
      pending: Schema.Boolean,
      fingerprint: Schema.String,
      latestEventId: Schema.NullOr(Schema.String),
    }),
  ),
  runs: Schema.Record(Schema.String, OrchestrationV2RunJson),
  attempts: Schema.Record(Schema.String, OrchestrationV2RunAttemptJson),
  results: Schema.Record(
    Schema.String,
    Schema.Struct({
      messageId: Schema.String,
      preview: Schema.String,
      sourceSequence: Schema.Number,
    }),
  ),
  failures: Schema.Record(Schema.String, Schema.String),
});
export type ReducerState = typeof ReducerState.Type;
export const encodeState = Schema.encodeEffect(Schema.fromJsonString(ReducerState));
export const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(ReducerState));
export const emptyState = (): ReducerState => ({
  version: 1,
  sourceSequence: 0,
  thread: null,
  assignmentRevision: 0,
  assignmentOwner: null,
  requests: {},
  attentionItems: {},
  secrets: {},
  runs: {},
  attempts: {},
  results: {},
  failures: {},
});

export class ReducerGap extends Schema.TaggedError<ReducerGap>()("AgentFactReducerGap", {
  threadId: Schema.String,
  sourceSequence: Schema.Number,
}) {
  override get message(): string {
    return "Historical thread state is missing before this source event.";
  }
}

const lookup = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const shortened = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const iso = (time: number | null | undefined): string | null =>
  time == null ? null : DateTime.formatIso(DateTime.makeUnsafe(time));
const terminalAttempt = (status: string): boolean =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);
const keyFor = (
  input: { environmentId: string; sourceGeneration: string; threadId: string },
  kind: string,
  occurrence: string,
): string =>
  `t3f1_${NodeCrypto.createHash("sha256")
    .update(
      stableStringify([
        input.environmentId,
        input.sourceGeneration,
        input.threadId,
        kind,
        occurrence,
      ]),
    )
    .digest("base64url")}`;

const ownerAt = (
  state: ReducerState,
  sequence: number,
  generation: string,
  observation: FleetUsersObservation | undefined,
): Record<string, unknown> => {
  const id = state.thread?.ownerId ?? null;
  const user =
    id === null ? undefined : observation?.directory.users.find((entry) => entry.id === id);
  const defaultId = observation?.directory.defaultOwnerId;
  return {
    state: id === null ? "unassigned" : user === undefined ? "unknown_user" : "assigned",
    id,
    label: user?.name ?? null,
    assignmentRevision: state.assignmentRevision === 0 ? null : state.assignmentRevision,
    sourceGeneration: generation,
    directoryGeneration: observation?.observationGeneration ?? null,
    directoryDigest: observation?.directoryDigest ?? null,
    directoryObservedAt: iso(observation?.lastGoodObservedAt),
    directoryStatus: observation?.status ?? "unknown",
    directoryCheckedAt: iso(observation?.observedAt),
    asOfSourceSequence: sequence,
    machineDefault:
      id === null && defaultId != null
        ? {
            id: defaultId,
            label:
              observation?.directory.users.find((entry) => entry.id === defaultId)?.name ?? null,
          }
        : null,
  };
};

/** The complete safe record remains available through native read; previews never promise unseen authority. */
const fitPreview = (data: FactData): FactData => {
  if (Buffer.byteLength(stableStringify(data), "utf8") <= 16_384) return data;
  const detail = data.detail;
  const safeDetail = {
    requestId: detail.requestId ?? null,
    requestIncarnation: detail.requestIncarnation ?? null,
    presentationRevision: detail.presentationRevision ?? null,
    presentationDigest: detail.presentationDigest ?? null,
    answerable: { via: "ui_only", reason: "incomplete_event_preview" },
  };
  return {
    ...data,
    detail: safeDetail,
    truncatedFields: [...(data.truncatedFields ?? []), "detail"],
  };
};

/** Pure ordered reduction: no projection, current directory, clock or provider lookups. */
export function reduce(input: {
  readonly before: ReducerState;
  readonly sequence: number;
  readonly event: OrchestrationV2DomainEvent;
  readonly environment: { readonly id: string; readonly label: string };
  readonly sourceGeneration: string;
  readonly observation?: FleetUsersObservation;
  readonly snapshot?: { readonly observedAt: DateTime.Utc; readonly transitionOffset: number };
  readonly approvalPresentation?: (
    request: OrchestrationV2RuntimeRequest,
    item: Extract<OrchestrationV2TurnItem, { type: "approval_request" }>,
  ) => Readonly<Record<string, unknown>>;
}): {
  readonly state: ReducerState;
  readonly facts: ReadonlyArray<FactData>;
  readonly observation?: ReturnType<typeof reduceNativeObservation>;
} {
  const { event, before, sequence } = input;
  if (input.snapshot === undefined && sequence <= before.sourceSequence)
    return { state: before, facts: [] };
  let state: ReducerState = { ...before, sourceSequence: sequence };
  const facts: Array<FactData> = [];
  const threadId = event.threadId;
  const keyInput = {
    environmentId: input.environment.id,
    sourceGeneration: input.sourceGeneration,
    threadId,
  };
  const occurredAt = DateTime.formatIso(input.snapshot?.observedAt ?? event.occurredAt);
  const emit = (
    kind: FactData["kind"],
    occurrence: string,
    summary: string,
    detail: Record<string, unknown>,
    runId: string | null = event.runId ?? null,
  ): string => {
    const thread = state.thread;
    if (thread === null) throw new ReducerGap({ threadId, sourceSequence: sequence });
    const run = runId === null ? undefined : lookup(state.runs, runId);
    const data = fitPreview({
      schema: "t3.agent-event/1",
      kind,
      factKey: keyFor(keyInput, kind, occurrence),
      summary: shortened(summary, 280),
      textIsUntrusted: true,
      environment: { id: input.environment.id, label: shortened(input.environment.label, 200) },
      thread: {
        id: thread.id,
        title: shortened(thread.title, 280),
        link: `t3-thread://v2/${input.environment.id}/${thread.id}`,
        webUrl: null,
        projectId: thread.projectId,
        projectName: null,
        parentThreadId: thread.lineage.parentThreadId,
        delegated:
          thread.delegatedFrom !== undefined || thread.lineage.relationshipToParent === "subagent",
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
      run: runId === null ? null : { id: runId, attemptId: run?.activeAttemptId ?? null },
      owner: ownerAt(state, sequence, input.sourceGeneration, input.observation),
      origin: {
        environmentId: input.environment.id,
        sourceGeneration: input.sourceGeneration,
        sourceKind: input.snapshot === undefined ? "orchestration" : "bootstrap",
        sourceSequence: sequence,
        transitionOrdinal: facts.length + (input.snapshot?.transitionOffset ?? 0),
        threadSequence: sequence,
        occurredAt,
      },
      relay: null,
      detail:
        input.snapshot === undefined
          ? detail
          : {
              ...detail,
              bootstrap_snapshot: true,
              observedAtSourceSequence: sequence,
            },
    });
    facts.push(data);
    return factEventId(data.origin, data.factKey);
  };

  if (event.type.startsWith("thread.") && "projectId" in event.payload) {
    const thread = event.payload;
    const assignmentChanged =
      before.thread === null || (before.thread.ownerId ?? null) !== (thread.ownerId ?? null);
    state = {
      ...state,
      thread,
      assignmentRevision: assignmentChanged ? sequence : before.assignmentRevision,
    };
    if (
      (event.type === "thread.created" || event.type === "thread.owner-set") &&
      assignmentChanged
    ) {
      const owner = ownerAt(state, sequence, input.sourceGeneration, input.observation);
      emit("owner_changed", `assignment:${sequence}`, "Task owner changed", {
        previous: before.assignmentOwner,
        current: owner,
        changedBy: "system",
      });
      state = { ...state, assignmentOwner: owner };
    }
    const waiting = thread.limitRecovery;
    if (waiting != null && before.thread?.limitRecovery == null)
      emit(
        "blocked",
        `limit:${sequence}`,
        "Task is waiting for its usage limit to reset",
        {
          reason: "usage_limit",
          message: "The provider usage limit was reached.",
          retryAt: waiting.resetAt,
        },
        waiting.runId,
      );
  } else if (event.type === "run.created" || event.type === "run.updated") {
    const run = event.payload;
    const previous = lookup(before.runs, run.id);
    state = { ...state, runs: { ...state.runs, [run.id]: run } };
    // Preparation can fail before any provider attempt exists.
    if (
      run.activeAttemptId === null &&
      terminalAttempt(run.status) &&
      previous?.status !== run.status
    )
      emit(
        "run_finished",
        `run:${run.id}`,
        "Task run finished",
        {
          status: run.status,
          endedAt: run.completedAt === null ? occurredAt : DateTime.formatIso(run.completedAt),
          resultPreview: lookup(state.results, run.id)?.preview ?? null,
          failure:
            lookup(state.failures, run.id) === undefined
              ? null
              : { message: lookup(state.failures, run.id) },
        },
        run.id,
      );
  } else if (event.type === "run-attempt.created" || event.type === "run-attempt.updated") {
    const attempt = event.payload;
    const previous = lookup(before.attempts, attempt.id);
    state = { ...state, attempts: { ...state.attempts, [attempt.id]: attempt } };
    if (terminalAttempt(attempt.status) && !terminalAttempt(previous?.status ?? "pending")) {
      emit(
        "run_finished",
        `attempt:${attempt.id}`,
        "Task run finished",
        {
          status: attempt.status,
          endedAt:
            attempt.completedAt === null ? occurredAt : DateTime.formatIso(attempt.completedAt),
          resultPreview: lookup(state.results, attempt.runId)?.preview ?? null,
          failure:
            lookup(state.failures, attempt.runId) === undefined
              ? null
              : { message: lookup(state.failures, attempt.runId) },
        },
        attempt.runId,
      );
    }
  } else if (event.type === "message.updated") {
    const message = event.payload;
    if (message.role === "assistant" && message.runId !== null)
      state = {
        ...state,
        results: {
          ...state.results,
          [message.runId]: {
            messageId: message.id,
            preview: shortened(message.text, 1_000),
            sourceSequence: sequence,
          },
        },
      };
  } else if (event.type === "turn-item.updated") {
    const item = event.payload;
    if (item.type === "approval_request" || item.type === "user_input_request")
      state = { ...state, attentionItems: { ...state.attentionItems, [item.requestId]: item } };
    if (item.type === "error" && item.runId !== null)
      state = {
        ...state,
        failures: { ...state.failures, [item.runId]: shortened(item.failure.message, 1_000) },
      };
    if (item.type === "secret_request") {
      const previous = lookup(before.secrets, item.id);
      const pending = item.secretStatus === "pending";
      const incarnation =
        pending && previous?.pending !== true
          ? `secret:${sequence}:${item.id}`
          : (previous?.incarnation ?? `secret:${sequence}:${item.id}`);
      const fingerprint = stableStringify({ name: item.label, pending });
      let latestEventId = previous?.latestEventId ?? null;
      if (pending && fingerprint !== previous?.fingerprint)
        latestEventId = emit(
          "secret",
          incarnation,
          "A secret must be entered in T3",
          {
            requestId: item.id,
            name: item.label,
            answerable: { via: "ui_only", reason: "secrets are entered in T3" },
          },
          item.runId,
        );
      else if (!pending && previous?.pending === true)
        emit(
          "request_closed",
          incarnation,
          "Secret request closed",
          {
            requestId: item.id,
            requestKind: "secret",
            status: item.secretStatus === "cancelled" ? "cancelled" : "resolved",
          },
          item.runId,
        );
      // Reasons, placeholders, delivery paths and entered values never enter fact state.
      state = {
        ...state,
        secrets: {
          ...state.secrets,
          [item.id]: {
            incarnation,
            name: item.label,
            pending,
            fingerprint,
            latestEventId,
          },
        },
      };
    }
  } else if (event.type === "runtime-request.updated") {
    const request = event.payload;
    const previous = lookup(before.requests, request.id);
    const reopened = request.status === "pending" && previous?.request.status !== "pending";
    const replacement =
      previous !== undefined &&
      (request.approval?.requestIncarnation !== previous.request.approval?.requestIncarnation ||
        DateTime.formatIso(request.createdAt) !== DateTime.formatIso(previous.request.createdAt) ||
        request.nodeId !== previous.request.nodeId ||
        request.providerTurnId !== previous.request.providerTurnId);
    const incarnation =
      reopened || replacement || previous === undefined
        ? `request:${sequence}:${request.id}`
        : previous.incarnation;
    let entry: typeof RequestState.Type = {
      request,
      incarnation,
      fingerprint: reopened || replacement ? null : (previous?.fingerprint ?? null),
      latestEventId: reopened || replacement ? null : (previous?.latestEventId ?? null),
      lost: reopened || replacement ? false : (previous?.lost ?? false),
    };
    if (request.status !== "pending" && previous?.request.status === "pending") {
      emit(
        "request_closed",
        previous.incarnation,
        "Request closed",
        {
          requestId: request.id,
          requestKind: request.kind,
          status: request.status,
          resolvedBy: request.resolvedBy ?? null,
          ...(request.decision === undefined ? {} : { decision: request.decision }),
        },
        lookup(state.attentionItems, request.id)?.runId ?? null,
      );
    }
    if (
      ["delivery_failed", "delivery_unknown", "delivery_withheld"].includes(
        request.approvalDelivery ?? "",
      ) &&
      request.approvalDelivery !== previous?.request.approvalDelivery
    )
      emit(
        "blocked",
        `${incarnation}:delivery:${sequence}`,
        "An approval answer needs delivery recovery",
        {
          reason: "answer_not_delivered",
          requestId: request.id,
          requestIncarnation: request.approval?.requestIncarnation ?? incarnation,
          receiptId: request.approvalReceiptId ?? null,
          deliveryState: request.approvalDelivery,
          message: "Inspect the native request and delivery receipt before answering again.",
          retryAt: null,
        },
        lookup(state.attentionItems, request.id)?.runId ?? null,
      );
    const lost =
      request.status === "pending" && request.responseCapability.type === "not_resumable";
    if (lost && !entry.lost)
      emit(
        "blocked",
        `${incarnation}:lost`,
        "A pending request can no longer be answered",
        {
          reason: "request_lost",
          message: "Open T3 to recover this request.",
          retryAt: null,
        },
        lookup(state.attentionItems, request.id)?.runId ?? null,
      );
    entry = { ...entry, lost };
    if (request.status !== "pending") {
      const attentionItems = { ...state.attentionItems };
      delete attentionItems[request.id];
      state = { ...state, attentionItems };
    }
    state = { ...state, requests: { ...state.requests, [request.id]: entry } };
  }

  // Items and runtime requests arrive separately, in either order. Only a complete pending pair emits attention.
  const requestId =
    event.type === "runtime-request.updated"
      ? event.payload.id
      : event.type === "turn-item.updated" &&
          (event.payload.type === "approval_request" || event.payload.type === "user_input_request")
        ? event.payload.requestId
        : undefined;
  const entry = requestId === undefined ? undefined : lookup(state.requests, requestId);
  const item = requestId === undefined ? undefined : lookup(state.attentionItems, requestId);
  if (
    entry?.request.status === "pending" &&
    item !== undefined &&
    (item.type === "approval_request" || item.type === "user_input_request")
  ) {
    const request = entry.request;
    let detail: Record<string, unknown>;
    if (item.type === "approval_request") {
      detail = {
        requestId: request.id,
        requestIncarnation: entry.incarnation,
        requestKind: item.requestKind,
        prompt: item.prompt ?? null,
        reason: item.reason ?? null,
        appName: item.appName ?? null,
        fullAccessOverride: item.fullAccessOverride ?? null,
        options: item.options ?? [],
        createdAt: DateTime.formatIso(request.createdAt),
        answerable: { via: "ui_only", reason: "unsupported_profile" },
        ...input.approvalPresentation?.(request, item),
      };
    } else
      detail = {
        requestId: request.id,
        requestIncarnation: entry.incarnation,
        questions: item.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => option.label),
          required: question.required ?? true,
        })),
        answerable:
          request.responseCapability.type === "not_resumable"
            ? { via: "ui_only", reason: "request_lost" }
            : { via: "t3_pending_request" },
      };
    if (request.responseCapability.type === "not_resumable")
      detail = { ...detail, answerable: { via: "ui_only", reason: "request_lost" } };
    const fingerprint = stableStringify(detail);
    if (entry.fingerprint !== fingerprint) {
      const latestEventId = emit(
        item.type === "approval_request" ? "approval" : "question",
        entry.incarnation,
        item.type === "approval_request" ? "Approval needed" : "A question needs an answer",
        { ...detail, supersedesEventId: entry.latestEventId },
        item.runId,
      );
      state = {
        ...state,
        requests: { ...state.requests, [request.id]: { ...entry, fingerprint, latestEventId } },
      };
    }
  }
  const observation =
    input.snapshot === undefined
      ? reduceNativeObservation({ event, sequence, commandId: null })
      : undefined;
  return { state, facts, ...(observation === undefined ? {} : { observation }) };
}

export type ReducerSnapshot = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "attempts" | "runtimeRequests" | "turnItems" | "messages"
>;

/** A snapshot asserts what was pending at S; it never asserts the original opening time or old completion. */
export function bootstrap(input: {
  readonly snapshot: ReducerSnapshot;
  readonly sequence: number;
  readonly assignmentRevision: number | null;
  readonly environment: { readonly id: string; readonly label: string };
  readonly sourceGeneration: string;
  readonly observation: FleetUsersObservation;
  readonly observedAt: DateTime.Utc;
  readonly transitionOffset?: number;
  readonly approvalPresentation?: Parameters<typeof reduce>[0]["approvalPresentation"];
}): { readonly state: ReducerState; readonly facts: ReadonlyArray<FactData> } {
  const snapshot = input.snapshot;
  let state: ReducerState = {
    ...emptyState(),
    sourceSequence: input.sequence,
    thread: snapshot.thread,
    assignmentRevision: input.assignmentRevision ?? 0,
    runs: Object.fromEntries(snapshot.runs.map((run) => [run.id, run])),
    attempts: Object.fromEntries(snapshot.attempts.map((attempt) => [attempt.id, attempt])),
  };
  state = {
    ...state,
    assignmentOwner: ownerAt(state, input.sequence, input.sourceGeneration, input.observation),
  };
  const results: Record<string, (typeof ReducerState.Type.results)[string]> = {};
  for (const message of [...snapshot.messages].sort(
    (a, b) =>
      a.updatedAt.epochMilliseconds - b.updatedAt.epochMilliseconds ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )) {
    if (message.role === "assistant" && message.runId !== null)
      results[message.runId] = {
        messageId: message.id,
        preview: shortened(message.text, 1_000),
        sourceSequence: input.sequence,
      };
  }
  state = { ...state, results };
  const facts: Array<FactData> = [];
  const consume = (event: OrchestrationV2DomainEvent) => {
    const next = reduce({
      before: state,
      event,
      sequence: input.sequence,
      environment: input.environment,
      sourceGeneration: input.sourceGeneration,
      observation: input.observation,
      snapshot: {
        observedAt: input.observedAt,
        transitionOffset: (input.transitionOffset ?? 0) + facts.length,
      },
      ...(input.approvalPresentation === undefined
        ? {}
        : { approvalPresentation: input.approvalPresentation }),
    });
    state = next.state;
    facts.push(...next.facts);
  };
  const base = {
    id: EventId.make("agent-events-bootstrap"),
    threadId: snapshot.thread.id,
    occurredAt: input.observedAt,
  };
  if (snapshot.thread.limitRecovery != null) {
    state = { ...state, thread: { ...snapshot.thread, limitRecovery: null } };
    consume({ ...base, type: "thread.metadata-updated", payload: snapshot.thread });
  }
  for (const request of [...snapshot.runtimeRequests].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  ))
    consume({ ...base, type: "runtime-request.updated", payload: request });
  for (const item of [...snapshot.turnItems].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    if (
      item.type === "approval_request" ||
      item.type === "user_input_request" ||
      (item.type === "secret_request" && item.secretStatus === "pending")
    )
      consume({ ...base, type: "turn-item.updated", payload: item });
  }
  return { state, facts };
}
