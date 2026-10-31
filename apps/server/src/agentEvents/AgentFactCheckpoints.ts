import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";

import * as Facts from "./AgentFactStore.ts";
import * as Reducer from "./AgentFactReducer.ts";

const groups = [
  "requests",
  "attentionItems",
  "secrets",
  "runs",
  "attempts",
  "results",
  "failures",
] as const;
type Group = (typeof groups)[number];
export const rootKey = (threadId: string): string => stableStringify(["thread", threadId]);
const entityKey = (threadId: string, group: Group, id: string): string =>
  stableStringify(["entity", threadId, group, id]);
const lookup = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** Each checkpoint contains one entity. Native streaming never rewrites all old grants or run results. */
export const writes = Effect.fn("AgentFactCheckpoints.writes")(function* (
  threadId: string,
  state: Reducer.ReducerState,
  before?: Reducer.ReducerState,
) {
  const base = { ...Reducer.emptyState(), sourceSequence: state.sourceSequence };
  const root = {
    ...base,
    thread: state.thread,
    assignmentRevision: state.assignmentRevision,
    assignmentOwner: state.assignmentOwner,
  };
  const states: Array<{
    readonly key: string;
    readonly sourceSequence: number;
    readonly json: string;
  }> = [];
  if (
    before === undefined ||
    state.thread !== before.thread ||
    state.assignmentRevision !== before.assignmentRevision ||
    state.assignmentOwner !== before.assignmentOwner
  )
    states.push({
      key: rootKey(threadId),
      sourceSequence: state.sourceSequence,
      json: yield* Reducer.encodeState(root),
    });
  const deleteStateKeys: Array<string> = [];
  for (const group of groups) {
    for (const [id, value] of Object.entries(state[group])) {
      if (before !== undefined && value === lookup<unknown>(before[group], id)) continue;
      const checkpoint = { ...base, [group]: { [id]: value } };
      states.push({
        key: entityKey(threadId, group, id),
        sourceSequence: state.sourceSequence,
        json: yield* Reducer.encodeState(checkpoint),
      });
    }
    if (before !== undefined)
      for (const id of Object.keys(before[group]))
        if (!Object.hasOwn(state[group], id)) deleteStateKeys.push(entityKey(threadId, group, id));
  }
  return { states, deleteStateKeys };
});

/** Read only the thread and entities that this one native transition can use. */
export const load = Effect.fn("AgentFactCheckpoints.load")(function* (
  event: OrchestrationV2DomainEvent,
) {
  const root = yield* Facts.readState(rootKey(event.threadId));
  if (root === undefined) return undefined;
  const state = yield* Reducer.decodeState(root.json);
  const keys = new Set<string>();
  const add = (group: Group, id: string | null | undefined) => {
    if (id != null) keys.add(entityKey(event.threadId, group, id));
  };
  add("runs", event.runId);
  if (event.type === "runtime-request.updated") {
    add("requests", event.payload.id);
    add("attentionItems", event.payload.id);
  } else if (event.type === "turn-item.updated") {
    const item = event.payload;
    add("runs", item.runId);
    if (item.type === "approval_request" || item.type === "user_input_request") {
      add("requests", item.requestId);
      add("attentionItems", item.requestId);
    } else if (item.type === "secret_request") add("secrets", item.id);
    else if (item.type === "error") add("failures", item.runId);
  } else if (event.type === "run.created" || event.type === "run.updated") {
    add("runs", event.payload.id);
    add("results", event.payload.id);
    add("failures", event.payload.id);
  } else if (event.type === "run-attempt.created" || event.type === "run-attempt.updated") {
    add("attempts", event.payload.id);
    add("runs", event.payload.runId);
    add("results", event.payload.runId);
    add("failures", event.payload.runId);
  } else if (event.type === "message.updated") add("results", event.payload.runId);
  else if ("limitRecovery" in event.payload) add("runs", event.payload.limitRecovery?.runId);
  const merge = (part: Reducer.ReducerState) => {
    // Values were schema-decoded above; computed group spreads preserve their per-group types.
    for (const group of groups)
      Object.assign(state, { [group]: { ...state[group], ...part[group] } });
  };
  for (const key of keys) {
    const row = yield* Facts.readState(key);
    if (row !== undefined) merge(yield* Reducer.decodeState(row.json));
  }
  if (event.type === "runtime-request.updated") {
    const item = lookup(state.attentionItems, event.payload.id);
    if (item?.runId != null) {
      const key = entityKey(event.threadId, "runs", item.runId);
      if (!keys.has(key)) {
        const row = yield* Facts.readState(key);
        if (row !== undefined) merge(yield* Reducer.decodeState(row.json));
      }
    }
  }
  return state;
});
