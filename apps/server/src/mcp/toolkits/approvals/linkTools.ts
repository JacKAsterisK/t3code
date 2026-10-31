import {
  LinkApprovalWireInput,
  LinkApprovalResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Invocation from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

export const LinkApprovalToolkit = Toolkit.make(
  Tool.make("t3_link_approval_request", {
    description:
      "Internal native-link approval preparation, commitment, cancellation and receipt reconciliation. Targets are local; the destination checks the authenticated link and exact initiating client independently.",
    parameters: LinkApprovalWireInput,
    success: LinkApprovalResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, ThreadManagement.ThreadManagementService],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, Invocation.hiddenUnlessLinkedPeer),
);
