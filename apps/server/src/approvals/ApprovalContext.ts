import type { ApprovalActor } from "@t3tools/contracts";
import * as Context from "effect/Context";
export const ApprovalAuditActor = Context.Reference<ApprovalActor | undefined>(
  "t3/approvals/ApprovalAuditActor",
  { defaultValue: () => undefined },
);
