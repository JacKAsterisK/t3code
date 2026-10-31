import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
export const ApprovalTestHooks = Context.Reference<{
  readonly afterForwardReconcile?: Effect.Effect<void>;
  readonly afterForwardNotice?: Effect.Effect<void>;
  readonly afterPrepare?: Effect.Effect<void>;
  readonly beforeDeliveryAdmission?: Effect.Effect<void>;
}>("t3/approvals/ApprovalTestHooks", { defaultValue: () => ({}) });
