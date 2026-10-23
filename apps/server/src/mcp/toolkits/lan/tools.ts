import {
  LanEnvironmentSummary,
  LanRoutedResult,
  LanToolParameters,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as EnvironmentRouting from "../../../lan/EnvironmentRouting.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    EnvironmentRouting.EnvironmentRouting,
    ThreadManagementService.ThreadManagementService,
  ],
};

export const LanToolkit = Toolkit.make(
  Tool.make("t3_lan_environments", {
    ...shared,
    description:
      "List environments explicitly approved for this authenticated task client. Configured routes are not a proof of reachability or authentication. Native IDs are always scoped to environmentId.",
    success: Schema.Array(LanEnvironmentSummary),
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_lan_task_launch", {
    ...shared,
    description:
      "Create a native T3 thread/run on one approved environment/project. Requires explicit model and modes. Reuse clientRequestId and identical arguments to reconcile a lost reply. Never retry with a new ID when the outcome is unknown. No wrapper task is created.",
    parameters: LanToolParameters.t3_lan_task_launch,
    success: LanRoutedResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_lan_task_list", {
    ...shared,
    description:
      "List visible native tasks in one approved machine/project. Only explicitly exposed or client-created threads are returned. Continue nextCursor even if a filtered page is empty.",
    parameters: LanToolParameters.t3_lan_task_list,
    success: LanRoutedResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_lan_task_read", {
    ...shared,
    description:
      "Read the bounded native transcript/status of an explicitly exposed or client-created task on its owning machine.",
    parameters: LanToolParameters.t3_lan_task_read,
    success: LanRoutedResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_lan_task_send", {
    ...shared,
    description:
      "Send or queue a message to an authorized native task. Stable clientRequestId is required. Caller, router and destination ceilings all apply.",
    parameters: LanToolParameters.t3_lan_task_send,
    success: LanRoutedResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_lan_task_interrupt", {
    ...shared,
    description:
      "Request native interruption on the selected machine. interrupt_requested is not proof that the task has stopped; observe its terminal event. Reuse clientRequestId for retries.",
    parameters: LanToolParameters.t3_lan_task_interrupt,
    success: LanRoutedResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_lan_task_requests", {
    ...shared,
    description:
      "Read pending question and approval facts for one authorized native task. Approval facts confer no approval authority; their native approval holder remains responsible.",
    parameters: LanToolParameters.t3_lan_task_requests,
    success: LanRoutedResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_lan_task_respond", {
    ...shared,
    description:
      "Answer a fresh native user-input question only. This tool cannot approve provider operations. Existing native request/approval checks remain authoritative.",
    parameters: LanToolParameters.t3_lan_task_respond,
    success: LanRoutedResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_lan_task_observe", {
    ...shared,
    description:
      "Replay bounded committed task events after a durable source cursor, detecting completion, questions and approval requests. Reconnect resumes from persisted state. delivery.events repeats unacknowledged facts; deduplicate by environmentId/sourceId/eventId. reset_required requires explicit reconciliation. Detection does not prove dot can be woken: wakeDelivery is unsupported until a receiving adapter is installed and proven.",
    parameters: LanToolParameters.t3_lan_task_observe,
    success: LanRoutedResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_lan_events_ack", {
    ...shared,
    description:
      "Acknowledge event IDs only after the receiving gateway has durably accepted them. Acknowledgement is scoped to this client, machine and native thread; it is separate from detection and does not assert a wake occurred.",
    parameters: LanToolParameters.t3_lan_events_ack,
    success: LanRoutedResult,
  }).annotate(Tool.Idempotent, true),
);
