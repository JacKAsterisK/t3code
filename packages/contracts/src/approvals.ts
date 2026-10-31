import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";

export const closedApprovalStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const target = Schema.Struct(fields);
  return Schema.StructWithRest(target, [Schema.Record(Schema.String, Schema.Unknown)])
    .check(
      Schema.makeFilter(
        (value) =>
          Object.keys(value).every((key) => Object.hasOwn(fields, key)) || "Unknown approval field",
      ),
    )
    .pipe(Schema.decodeTo(target, SchemaTransformation.passthrough({ strict: false })));
};
const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));
const specialPath = Schema.Union([
  closedApprovalStruct({ kind: Schema.Literals(["root", "minimal", "tmpdir", "slash_tmp"]) }),
  closedApprovalStruct({
    kind: Schema.Literal("project_roots"),
    subpath: optionalNullable(Schema.String),
  }),
  closedApprovalStruct({
    kind: Schema.Literal("unknown"),
    path: Schema.String,
    subpath: optionalNullable(Schema.String),
  }),
]);
const filePath = Schema.Union([
  closedApprovalStruct({ type: Schema.Literal("path"), path: Schema.String }),
  closedApprovalStruct({ type: Schema.Literal("glob_pattern"), pattern: Schema.String }),
  closedApprovalStruct({ type: Schema.Literal("special"), value: specialPath }),
]);
export const CodexApprovalPermissions = closedApprovalStruct({
  network: optionalNullable(closedApprovalStruct({ enabled: optionalNullable(Schema.Boolean) })),
  fileSystem: optionalNullable(
    closedApprovalStruct({
      read: optionalNullable(Schema.Array(Schema.String)),
      write: optionalNullable(Schema.Array(Schema.String)),
      globScanMaxDepth: optionalNullable(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      entries: optionalNullable(
        Schema.Array(
          closedApprovalStruct({
            access: Schema.Literals(["read", "write", "deny"]),
            path: filePath,
          }),
        ),
      ),
    }),
  ),
});
export type CodexApprovalPermissions = typeof CodexApprovalPermissions.Type;
export const CodexApprovalRawRequest = closedApprovalStruct({
  cwd: Schema.String,
  environmentId: optionalNullable(Schema.String),
  itemId: Schema.String,
  permissions: CodexApprovalPermissions,
  reason: optionalNullable(Schema.String),
  startedAtMs: Schema.Int,
  threadId: Schema.String,
  turnId: Schema.String,
});

export const ApprovalGrant = closedApprovalStruct({
  version: Schema.Literal(1),
  profile: Schema.Literal("codex-permissions-687a119f-v1"),
  provider: Schema.Literal("codex"),
  providerVersion: Schema.Literal("0.159.0"),
  nativeMethod: Schema.Literal("item/permissions/requestApproval"),
  nativeDecision: closedApprovalStruct({
    permissions: CodexApprovalPermissions,
    scope: Schema.Literal("turn"),
  }),
  permission: CodexApprovalRawRequest,
  resources: closedApprovalStruct({ cwd: Schema.String, permissions: CodexApprovalPermissions }),
  effectiveScope: Schema.Literal("turn"),
  appliesTo: Schema.String,
  expiresWhen: Schema.String,
  persistence: Schema.Literal("none"),
  supported: Schema.Literal(true),
});
export type ApprovalGrant = typeof ApprovalGrant.Type;

export const ApprovalBinding = closedApprovalStruct({
  requestIncarnation: TrimmedNonEmptyString,
  providerSessionId: TrimmedNonEmptyString,
  providerGeneration: TrimmedNonEmptyString,
  presentationRevision: NonNegativeInt,
  presentationDigest: TrimmedNonEmptyString,
});
export type ApprovalBinding = typeof ApprovalBinding.Type;
export const ApprovalNativeDescriptor = closedApprovalStruct({
  requestIncarnation: TrimmedNonEmptyString,
  providerSessionId: TrimmedNonEmptyString,
  providerGeneration: TrimmedNonEmptyString,
  presentationRevision: NonNegativeInt,
  nativeRequestId: Schema.Union([Schema.String, Schema.Number]),
  grant: ApprovalGrant,
});
export type ApprovalNativeDescriptor = typeof ApprovalNativeDescriptor.Type;

export const ApprovalConsent = closedApprovalStruct({
  effectiveScope: Schema.Literals(["once", "turn"]),
  grantDigest: TrimmedNonEmptyString,
  onBehalfOf: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  authorization: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
});
export type ApprovalConsent = typeof ApprovalConsent.Type;
export const ApprovalReceiptState = Schema.Literals([
  "prepared",
  "committed",
  "delivery_admitted",
  "response_written",
  "provider_acknowledged",
  "refused",
  "delivery_withheld",
  "delivery_failed",
  "delivery_unknown",
]);
export type ApprovalReceiptState = typeof ApprovalReceiptState.Type;
export const ApprovalFailureCode = Schema.Literals([
  "approvals_not_granted",
  "thread_caller_refused",
  "task_only_refused",
  "request_not_found",
  "not_an_approval",
  "not_live",
  "request_changed",
  "presentation_changed",
  "decision_not_offered",
  "scope_consent_required",
  "scope_unsupported",
  "ui_only",
  "idempotency_conflict",
  "already_answered",
  "authority_revoked",
  "forwarding_unavailable",
  "forwarding_chain_refused",
  "link_not_approved",
  "thread_not_delegated",
  "mode_changed",
  "request_lost",
  "native_rejected",
  "provider_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
]);
export type ApprovalFailureCode = typeof ApprovalFailureCode.Type;
export const ApprovalActor = closedApprovalStruct({
  kind: Schema.Literals(["user", "mcp_client"]),
  principalId: Schema.String,
  label: Schema.String,
  applicationId: Schema.optionalKey(Schema.String),
  authorityRevision: Schema.optionalKey(NonNegativeInt),
  forwardedBy: Schema.optionalKey(
    closedApprovalStruct({
      environmentId: Schema.String,
      linkIdentityId: Schema.String,
      initiatingClientId: Schema.String,
      forwarderReceiptId: Schema.String,
      asserted: Schema.Literal(true),
    }),
  ),
  assertion: Schema.optionalKey(
    closedApprovalStruct({ onBehalfOf: Schema.String, authorization: Schema.String }),
  ),
});
export type ApprovalActor = typeof ApprovalActor.Type;
export const ApprovalDeliveryEvidence = closedApprovalStruct({
  commandId: Schema.String,
  effectId: Schema.optionalKey(Schema.String),
  boundary: Schema.Literals([
    "not_started",
    "delivery_admission",
    "node_write_callback",
    "write_interrupted",
    "reconciliation",
  ]),
});
export type ApprovalDeliveryEvidence = typeof ApprovalDeliveryEvidence.Type;
export const ApprovalReceiptResult = closedApprovalStruct({
  receiptId: Schema.String,
  commandId: Schema.String,
  state: ApprovalReceiptState,
  replayed: Schema.Boolean,
  decision: Schema.Literals(["accept", "decline"]),
  effectiveScope: Schema.Literals(["once", "turn"]),
  sequence: Schema.optionalKey(NonNegativeInt),
  failureCode: Schema.optionalKey(ApprovalFailureCode),
  deliveryEvidence: Schema.optionalKey(ApprovalDeliveryEvidence),
  forwarding: Schema.optionalKey(
    closedApprovalStruct({
      environmentId: EnvironmentId,
      receiptId: Schema.NullOr(Schema.String),
      commandId: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ApprovalReceiptResult = typeof ApprovalReceiptResult.Type;
const target = { threadId: ThreadId, environmentId: Schema.optionalKey(EnvironmentId) };
export const ApprovalRespondInput = closedApprovalStruct({
  action: Schema.Literal("respond"),
  ...target,
  requestId: RuntimeRequestId,
  clientRequestId: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)),
  expected: ApprovalBinding,
  decision: Schema.Literals(["accept", "decline"]),
  consent: ApprovalConsent,
});
export type ApprovalRespondInput = typeof ApprovalRespondInput.Type;
export const ApprovalToolInput = Schema.Union([
  closedApprovalStruct({ action: Schema.Literal("list"), ...target }),
  closedApprovalStruct({ action: Schema.Literal("read"), ...target, requestId: RuntimeRequestId }),
  closedApprovalStruct({
    action: Schema.Literal("status"),
    ...target,
    clientRequestId: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)),
  }),
  ApprovalRespondInput,
]);
export type ApprovalToolInput = typeof ApprovalToolInput.Type;
export const ApprovalDestinationAuthority = closedApprovalStruct({
  threadId: Schema.String,
  linkIdentityId: Schema.String,
  sourceEnvironmentId: Schema.String,
  initiatingClientId: Schema.String,
  linkRevision: NonNegativeInt,
  credentialRevision: NonNegativeInt,
  policyRevision: NonNegativeInt,
  basis: Schema.Literals(["origin", "delegation"]),
  delegationId: Schema.NullOr(Schema.String),
});
export type ApprovalDestinationAuthority = typeof ApprovalDestinationAuthority.Type;
export const ApprovalDestinationGuard = closedApprovalStruct({
  authority: ApprovalDestinationAuthority,
  forwarderReceiptId: Schema.String,
  forwardingKey: Schema.String,
  operationDigest: Schema.String,
});
export type ApprovalDestinationGuard = typeof ApprovalDestinationGuard.Type;
export const ApprovalGuard = closedApprovalStruct({
  receiptId: Schema.String,
  principalId: Schema.String,
  sessionId: Schema.String,
  environmentId: EnvironmentId,
  authorityRevision: NonNegativeInt,
  expected: ApprovalBinding,
  grantDigest: Schema.String,
  consent: ApprovalConsent,
  actor: ApprovalActor,
  destination: Schema.optionalKey(ApprovalDestinationGuard),
  runtimeModeCeiling: Schema.String,
  interactionModeCeiling: Schema.String,
});
export type ApprovalGuard = typeof ApprovalGuard.Type;

export const ApprovalToolWireInput = closedApprovalStruct({
  action: Schema.Literals(["list", "read", "respond", "status"]),
  ...target,
  requestId: Schema.optionalKey(RuntimeRequestId),
  clientRequestId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)),
  ),
  expected: Schema.optionalKey(ApprovalBinding),
  decision: Schema.optionalKey(Schema.Literals(["accept", "decline"])),
  consent: Schema.optionalKey(ApprovalConsent),
});
export type ApprovalToolWireInput = typeof ApprovalToolWireInput.Type;

export const ApprovalUnsupportedEvidence = Schema.Struct({
  supported: Schema.Literal(false),
  reason: Schema.String,
  safeRaw: Schema.Json,
  complete: Schema.Boolean,
});
export type ApprovalUnsupportedEvidence = typeof ApprovalUnsupportedEvidence.Type;
