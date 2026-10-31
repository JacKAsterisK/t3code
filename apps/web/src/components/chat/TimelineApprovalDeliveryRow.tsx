import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { approvalDeliveryText } from "@t3tools/shared/approvalPresentation";
import { ShieldIcon } from "lucide-react";
import { WorkLogRow } from "./WorkLog";

export function TimelineApprovalDeliveryRow({
  item,
}: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;
}) {
  return (
    <WorkLogRow
      icon={<ShieldIcon className="size-4 text-icon-muted" />}
      label={approvalDeliveryText(item.approvalDelivery!)}
      wrapLabel
    >
      <div className="ms-7 space-y-1 py-1 text-xs">
        {item.approval ? (
          <>
            <p>Permission scope: this provider turn. {item.approval.grant.expiresWhen}.</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap select-text">
              {JSON.stringify(item.approval.grant.permission, null, 2)}
            </pre>
          </>
        ) : null}
        {item.resolvedBy ? (
          <p>
            Response submitted by {item.resolvedBy.label} (
            {item.resolvedBy.kind === "mcp_client"
              ? "authenticated agent session"
              : "authenticated user session"}
            ).
          </p>
        ) : null}
        {item.resolvedBy?.assertion ? (
          <p>
            Agent assertion: for {item.resolvedBy.assertion.onBehalfOf}.{" "}
            {item.resolvedBy.assertion.authorization}
          </p>
        ) : null}
      </div>
    </WorkLogRow>
  );
}
