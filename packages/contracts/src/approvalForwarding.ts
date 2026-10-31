import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { ApprovalRespondInput, ApprovalReceiptResult, closedApprovalStruct } from "./approvals.ts";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const reference = {
  clientRequestId: Identifier,
  initiatingClientId: Identifier,
  forwarderReceiptId: Identifier,
  operationDigest: Identifier,
};
export const ApprovalForwardOperation = closedApprovalStruct({
  version: Schema.Literal(1),
  sourceEnvironmentId: EnvironmentId,
  initiatingClientId: Identifier,
  forwarderReceiptId: Identifier,
  initiatingClientLabel: Schema.String.check(Schema.isMaxLength(200)),
  input: ApprovalRespondInput.check(
    Schema.makeFilter(
      (input) => input.environmentId === undefined || "Receiver targets must be local",
    ),
  ),
  limits: closedApprovalStruct({
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
});
export type ApprovalForwardOperation = typeof ApprovalForwardOperation.Type;
export const LinkApprovalRequest = Schema.Union([
  closedApprovalStruct({
    operation: Schema.Literal("prepare"),
    ...reference,
    proposal: ApprovalForwardOperation,
  }),
  closedApprovalStruct({
    operation: Schema.Literal("commit"),
    ...reference,
    cancel: Schema.optionalKey(Schema.Boolean),
  }),
  closedApprovalStruct({ operation: Schema.Literal("status"), ...reference }),
]);
export type LinkApprovalRequest = typeof LinkApprovalRequest.Type;
export const LinkApprovalWireInput = closedApprovalStruct({
  operation: Schema.Literals(["prepare", "commit", "status"]),
  ...reference,
  proposal: Schema.optionalKey(ApprovalForwardOperation),
  cancel: Schema.optionalKey(Schema.Boolean),
});
export type LinkApprovalWireInput = typeof LinkApprovalWireInput.Type;
export const LinkApprovalResult = closedApprovalStruct({
  environmentId: EnvironmentId,
  forwarderReceiptId: Identifier,
  operationDigest: Identifier,
  receipt: Schema.NullOr(ApprovalReceiptResult),
});
export type LinkApprovalResult = typeof LinkApprovalResult.Type;
