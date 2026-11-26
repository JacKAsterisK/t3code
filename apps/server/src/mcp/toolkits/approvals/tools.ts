import * as ApprovalService from "../../../approvals/ApprovalService.ts";
import * as ApprovalAuthority from "../../../auth/ApprovalAuthority.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ApprovalToolWireInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

const ApprovalRequestTool = Tool.make("t3_approval_request", {
  description:
    "Read provider permissions. Only verified Codex requests can be answered here. Other providers are app-only. Read first, show the full grant and duration, then get exact consent. Acceptance needs explicit turn-wide consent, never 'once'. Your assertion is not proof. Separate approval permission applies even to Full access. Reuse clientRequestId only for identical retries or status. A committed receipt is pending. response_written proves transport, not execution. Never resend delivery_unknown with a new key. Linked calls use one authenticated hop and destination link/client/thread authority. Questions: t3_pending_request.",
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
