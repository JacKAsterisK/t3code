import {
  ProviderRequestKind,
  type LanTaskObservation,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isTerminalRunStatus } from "../orchestration-v2/ThreadManagementService.ts";

const isApproval = Schema.is(ProviderRequestKind);
export function reduceNativeObservation(
  stored: OrchestrationV2StoredEvent,
): LanTaskObservation | undefined {
  const { event, sequence } = stored;
  const common = { eventId: event.id, sequence, runId: event.runId ?? null };
  if (event.type === "run.updated" || event.type === "run.created") {
    // A terminal run can still have queued work or a pending restart continuation.
    return {
      ...common,
      runId: event.payload.id,
      requestId: null,
      status: event.payload.status,
      kind: isTerminalRunStatus(event.payload.status) ? "run_terminal" : "run_state",
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
