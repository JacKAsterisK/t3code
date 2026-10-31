import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEventJson,
  OrchestrationV2ThreadProjectionJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { FleetUsersObservation } from "../lan/FleetUsers.ts";
import { factEventId } from "./AgentFactStore.ts";
import * as Reducer from "./AgentFactReducer.ts";

const at = "2026-01-01T00:00:00.000Z";
const modelSelection = { instanceId: "codex", model: "fixture" };
const thread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-a",
  projectId: "project-a",
  title: "Task A",
  providerInstanceId: "codex",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-a" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ownerId: "dan",
};
const run = {
  id: "run-a",
  threadId: "thread-a",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection,
  providerThreadId: null,
  userMessageId: "message-user",
  rootNodeId: "node-a",
  activeAttemptId: "attempt-a",
  status: "running",
  requestedAt: at,
  startedAt: at,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const request = (id: string) => ({
  id,
  nodeId: `node-${id}`,
  providerTurnId: "turn-a",
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: at,
  resolvedAt: null,
});
const item = (id: string, prompt = "A") => ({
  id: `item-${id}`,
  threadId: "thread-a",
  runId: "run-a",
  nodeId: `node-${id}`,
  providerThreadId: null,
  providerTurnId: "turn-a",
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "pending",
  title: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
  type: "approval_request",
  requestId: id,
  requestKind: "command",
  prompt,
});
const observation: FleetUsersObservation = {
  status: "fresh",
  observedAt: 100,
  lastGoodObservedAt: 100,
  observationGeneration: "directory-a",
  directoryDigest: "digest-a",
  directory: {
    users: [
      { id: "dan", name: "Dan" },
      { id: "gavin", name: "Gavin" },
    ],
    machineId: "machine-319682d2fc67441f86be9b87",
    defaultOwnerId: "dan",
  },
};
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson);
const event = (sequence: number, type: string, payload: unknown): OrchestrationV2DomainEvent =>
  decodeEvent({
    id: `source-${sequence}`,
    threadId: "thread-a",
    runId: "run-a",
    occurredAt: at,
    type,
    payload,
  });
const apply = (
  before: Reducer.ReducerState,
  sequence: number,
  type: string,
  payload: unknown,
  observed: FleetUsersObservation | undefined = observation,
) =>
  Reducer.reduce({
    before,
    sequence,
    event: event(sequence, type, payload),
    environment: { id: "environment-a", label: "Machine A" },
    sourceGeneration: "source-a",
    ...(observed === undefined ? {} : { observation: observed }),
  });
const created = () => apply(Reducer.emptyState(), 1, "thread.created", thread).state;

describe("AgentFactReducer", () => {
  it("bootstraps one snapshot with distinct pending attention and no old terminal runs", () => {
    const snapshot = decodeProjection({
      thread,
      runs: [{ ...run, status: "completed", completedAt: at }],
      attempts: [],
      runtimeRequests: [request("two"), request("one")],
      turnItems: [item("two"), item("one")],
      messages: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      plans: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: at,
    });
    const input = {
      snapshot,
      sequence: 100,
      assignmentRevision: null,
      environment: { id: "environment-a", label: "Machine A" },
      sourceGeneration: "source-a",
      observation,
      observedAt: DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
    };
    const bootstrapped = Reducer.bootstrap(input);
    assert.deepEqual(
      bootstrapped.facts.map((fact) => fact.kind),
      ["approval", "approval"],
    );
    assert.deepEqual(
      bootstrapped.facts.map((fact) => fact.origin.transitionOrdinal),
      [0, 1],
    );
    assert.notStrictEqual(bootstrapped.facts[0]!.factKey, bootstrapped.facts[1]!.factKey);
    for (const fact of bootstrapped.facts) {
      assert.strictEqual(fact.origin.sourceKind, "bootstrap");
      assert.strictEqual(fact.origin.sourceSequence, 100);
      assert.strictEqual(fact.origin.occurredAt, "2026-02-01T00:00:00.000Z");
      assert.strictEqual(fact.detail.bootstrap_snapshot, true);
      assert.strictEqual(fact.owner!.assignmentRevision, null);
      assert.strictEqual(fact.detail.createdAt, at);
    }
    assert.deepEqual(Reducer.bootstrap(input), bootstrapped);
    assert.deepEqual(apply(bootstrapped.state, 101, "turn-item.updated", item("one")).facts, []);
    assert.deepEqual(
      apply(bootstrapped.state, 101, "run.updated", {
        ...run,
        status: "completed",
        completedAt: at,
      }).facts,
      [],
    );
  });

  it("keeps distinct requests and A → B → A presentations, including a reused request id", () => {
    let state = created();
    const facts = [];
    for (const [sequence, type, payload] of [
      [2, "runtime-request.updated", request("one")],
      [3, "turn-item.updated", item("one")],
      [4, "turn-item.updated", item("two")],
      [5, "runtime-request.updated", request("two")],
      [6, "turn-item.updated", item("one", "B")],
      [7, "turn-item.updated", item("one", "A")],
      [8, "turn-item.updated", item("one", "A")],
      [9, "runtime-request.updated", { ...request("one"), status: "resolved", resolvedAt: at }],
      [10, "runtime-request.updated", request("one")],
      [11, "turn-item.updated", item("one")],
    ] as const) {
      const next = apply(state, sequence, type, payload);
      facts.push(...next.facts);
      state = next.state;
    }
    const approvals = facts.filter((fact) => fact.kind === "approval");
    assert.deepEqual(
      approvals.map((fact) => fact.origin.sourceSequence),
      [3, 5, 6, 7, 11],
    );
    assert.strictEqual(approvals[0]!.factKey, approvals[2]!.factKey);
    assert.strictEqual(approvals[0]!.factKey, approvals[3]!.factKey);
    assert.notStrictEqual(approvals[0]!.factKey, approvals[1]!.factKey);
    assert.notStrictEqual(approvals[0]!.factKey, approvals[4]!.factKey);
    assert.strictEqual(
      approvals[2]!.detail.supersedesEventId,
      factEventId(approvals[0]!.origin, approvals[0]!.factKey),
    );
    assert.strictEqual(
      approvals[3]!.detail.supersedesEventId,
      factEventId(approvals[2]!.origin, approvals[2]!.factKey),
    );
    assert.strictEqual(
      new Set(approvals.map((fact) => factEventId(fact.origin, fact.factKey))).size,
      5,
    );
    assert.deepEqual(
      facts
        .filter((fact) => fact.kind === "request_closed")
        .map((fact) => fact.origin.sourceSequence),
      [9],
    );
    assert.deepEqual(
      Reducer.reduce({
        before: state,
        sequence: 11,
        event: event(11, "turn-item.updated", item("one")),
        sourceGeneration: "source-a",
        environment: { id: "environment-a", label: "A" },
      }).facts,
      [],
    );
  });

  it("uses source-time owner labels, preserves unassigned state and exposes unknown history", () => {
    const first = apply(Reducer.emptyState(), 1, "thread.created", thread);
    const renamed = {
      ...observation,
      observationGeneration: "directory-b",
      directoryDigest: "digest-b",
      directory: {
        ...observation.directory,
        users: [{ id: "dan", name: "Daniel" }, observation.directory.users[1]!],
      },
    };
    const changed = apply(
      first.state,
      2,
      "thread.owner-set",
      { ...thread, ownerId: "gavin" },
      renamed,
    );
    assert.strictEqual(first.facts[0]!.owner!.label, "Dan");
    assert.strictEqual(changed.facts[0]!.owner!.label, "Gavin");
    assert.strictEqual((changed.facts[0]!.detail.previous as Record<string, unknown>).label, "Dan");
    const cleared = apply(
      changed.state,
      3,
      "thread.owner-set",
      { ...thread, ownerId: null },
      renamed,
    );
    assert.strictEqual(cleared.facts[0]!.owner!.state, "unassigned");
    assert.strictEqual(cleared.facts[0]!.owner!.id, null);
    assert.deepEqual(cleared.facts[0]!.owner!.machineDefault, { id: "dan", label: "Daniel" });
    const unknown = Reducer.reduce({
      before: Reducer.emptyState(),
      sequence: 1,
      event: event(1, "thread.created", thread),
      environment: { id: "environment-a", label: "A" },
      sourceGeneration: "source-a",
    });
    assert.strictEqual(unknown.facts[0]!.owner!.state, "unknown_user");
    assert.strictEqual(unknown.facts[0]!.owner!.label, null);
    assert.strictEqual(unknown.facts[0]!.owner!.directoryGeneration, null);
  });

  it("emits separate blocker entries when a limit clears and recurs", () => {
    let state = created();
    const waiting = { ...thread, limitRecovery: { runId: "run-a", resetAt: at, autoResume: true } };
    const facts = [];
    for (const [sequence, payload] of [
      [2, waiting],
      [3, waiting],
      [4, thread],
      [5, waiting],
    ] as const) {
      const next = apply(state, sequence, "thread.metadata-updated", payload);
      state = next.state;
      facts.push(...next.facts);
    }
    assert.deepEqual(
      facts.map((fact) => fact.origin.sourceSequence),
      [2, 5],
    );
    assert.notStrictEqual(facts[0]!.factKey, facts[1]!.factKey);
  });

  it("finishes each attempt once using only messages committed before its terminal transition", () => {
    let state = apply(created(), 2, "run.created", run).state;
    const message = {
      createdBy: "agent",
      creationSource: "provider",
      id: "message-a",
      threadId: "thread-a",
      runId: "run-a",
      nodeId: null,
      role: "assistant",
      text: "Historical result",
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    state = apply(state, 3, "message.updated", message).state;
    const attempt = {
      id: "attempt-a",
      runId: "run-a",
      attemptOrdinal: 1,
      rootNodeId: "node-a",
      providerInstanceId: "codex",
      providerThreadId: "provider-thread-a",
      providerTurnId: "turn-a",
      reason: "initial",
      status: "completed",
      startedAt: at,
      completedAt: at,
    };
    const finished = apply(state, 4, "run-attempt.updated", attempt);
    assert.strictEqual(finished.facts[0]!.detail.resultPreview, "Historical result");
    state = apply(finished.state, 5, "message.updated", {
      ...message,
      text: "Future result",
    }).state;
    assert.deepEqual(apply(state, 6, "run-attempt.updated", attempt).facts, []);
    assert.strictEqual(finished.facts[0]!.detail.resultPreview, "Historical result");
    assert.strictEqual(finished.facts[0]!.origin.sourceSequence, 4);
  });

  it.effect("retains replayable checkpoints while secrets contain only the requested name", () =>
    Effect.gen(function* () {
      const secret = {
        ...item("secret"),
        type: "secret_request",
        label: "API token",
        reason: "sensitive reason",
        placeholder: "sensitive placeholder",
        secretStatus: "pending",
      };
      const opened = apply(created(), 2, "turn-item.updated", secret);
      assert.deepEqual(opened.facts[0]!.detail, {
        requestId: "item-secret",
        name: "API token",
        answerable: { via: "ui_only", reason: "secrets are entered in T3" },
      });
      const encoded = yield* Reducer.encodeState(opened.state);
      assert.notInclude(encoded, "sensitive reason");
      assert.notInclude(encoded, "sensitive placeholder");
      const restored = yield* Reducer.decodeState(encoded);
      const closed = apply(restored, 3, "turn-item.updated", { ...secret, secretStatus: "saved" });
      assert.strictEqual(closed.facts[0]!.kind, "request_closed");
      const reopened = apply(closed.state, 4, "turn-item.updated", secret);
      assert.notStrictEqual(opened.facts[0]!.factKey, reopened.facts[0]!.factKey);
      assert.strictEqual(DateTime.formatIso(restored.thread!.createdAt), at);
    }),
  );

  it("reports missing historical state and bounds oversized approval previews truthfully", () => {
    assert.throws(
      () =>
        apply(Reducer.emptyState(), 8, "turn-item.updated", {
          ...item("secret"),
          type: "secret_request",
          label: "API token",
          reason: "reason",
          secretStatus: "pending",
        }),
      Reducer.ReducerGap,
    );
    const pending = apply(created(), 2, "runtime-request.updated", request("one"));
    const preview = apply(pending.state, 3, "turn-item.updated", item("one", "x".repeat(40_000)))
      .facts[0]!;
    assert.isBelow(Buffer.byteLength(JSON.stringify(preview), "utf8"), 16_384);
    assert.deepEqual(preview.truncatedFields, ["detail"]);
    assert.deepEqual(preview.detail.answerable, {
      via: "ui_only",
      reason: "incomplete_event_preview",
    });
  });
});
