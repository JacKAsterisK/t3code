import * as ApprovalService from "../../../approvals/ApprovalService.ts";
import * as ApprovalAuthority from "../../../auth/ApprovalAuthority.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ApprovalToolWireInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

const ApprovalRequestTool = Tool.make("t3_approval_request", {
  description:
    "Read local provider permission requests or respond with explicit consent. Only the verified Codex permissions profile is supported; all others are app-only. Read first, present the full permission and duration, then obtain consent for that exact grant. Accept requires explicit turn-wide consent, never 'once'. Human words are your assertion, not proof. Respond needs separate approval permission, even with Full access. Reuse clientRequestId only for the identical operation. A committed receipt is pending; response_written proves transport write, not tool execution. delivery_unknown must not be resent with a new key. Linked environments use one authenticated hop with destination link/client/thread authority. Status reconciles the same clientRequestId after interruption. Questions use t3_pending_request.",
  dependencies: [
    ApprovalService.ApprovalService,
    ApprovalAuthority.ApprovalAuthority,
    ThreadManagementService.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
  parameters: ApprovalToolWireInput,
  success: Schema.Json,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);
export const ApprovalToolkit = Toolkit.make(ApprovalRequestTool);
