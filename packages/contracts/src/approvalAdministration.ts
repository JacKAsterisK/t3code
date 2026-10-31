import * as Schema from "effect/Schema";
import { AuthEnvironmentScope, AuthMcpClientAccess } from "./auth.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";
import { AuthSessionId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const LinkTarget = { linkIdentityId: Identity, expectedRevision: Revision };
export const ApprovalAdministrationMutation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("createLink"), sourceEnvironmentId: Identity }),
  Schema.Struct({ type: Schema.Literal("replaceLink"), ...LinkTarget }),
  Schema.Struct({ type: Schema.Literal("revokeLink"), ...LinkTarget }),
  Schema.Struct({
    type: Schema.Literal("bindPeer"),
    sessionId: AuthSessionId,
    linkIdentityId: Identity,
    approvals: Schema.Boolean,
    interactionModeCeiling: ProviderInteractionMode,
    renew: Schema.optional(Schema.Struct({ sessionId: AuthSessionId, revision: Revision })),
  }),
  Schema.Struct({
    type: Schema.Literal("revokePeer"),
    sessionId: AuthSessionId,
    expectedRevision: Revision,
  }),
  Schema.Struct({ type: Schema.Literal("setLinkPolicy"), ...LinkTarget, enabled: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("grantDelegation"),
    threadId: ThreadId,
    linkIdentityId: Identity,
    initiatingClientId: Identity,
    expectedPolicyRevision: Revision,
  }),
  Schema.Struct({ type: Schema.Literal("revokeDelegation"), delegationId: Identity }),
  Schema.Struct({
    type: Schema.Literal("continueClient"),
    sessionId: AuthSessionId,
    previousSessionId: AuthSessionId,
    expectedRevision: Revision,
  }),
  Schema.Struct({
    type: Schema.Literal("bindFleetLink"),
    linkIdentityId: Identity,
    callerMachineId: Identity,
  }),
  Schema.Struct({
    type: Schema.Literal("publishFleetPolicy"),
    expectedRevision: Revision,
    grants: Schema.Array(
      Schema.Struct({ callerMachineId: Identity, enabled: Schema.Boolean }),
    ).check(Schema.isMaxLength(100)),
  }),
]);
export type ApprovalAdministrationMutation = typeof ApprovalAdministrationMutation.Type;

export const ApprovalAdministrationSnapshot = Schema.Struct({
  links: Schema.Array(
    Schema.Struct({
      linkIdentityId: Identity,
      sourceEnvironmentId: Identity,
      revision: Revision,
      revoked: Schema.Boolean,
      replacedByLinkIdentityId: Schema.NullOr(Identity),
      policyEnabled: Schema.Boolean,
      policyRevision: Revision,
      effectiveEnabled: Schema.Boolean,
      fleet: Schema.NullOr(
        Schema.Struct({
          callerMachineId: Identity,
          destinationMachineId: Identity,
          valid: Schema.Boolean,
          enabled: Schema.Boolean,
        }),
      ),
    }),
  ),
  bindings: Schema.Array(
    Schema.Struct({
      sessionId: AuthSessionId,
      linkIdentityId: Identity,
      revision: Revision,
      effectiveRevision: Revision,
      approvals: Schema.Boolean,
      interactionModeCeiling: ProviderInteractionMode,
      active: Schema.Boolean,
      revoked: Schema.Boolean,
      effectiveEnabled: Schema.Boolean,
    }),
  ),
  clients: Schema.Array(
    Schema.Struct({
      sessionId: AuthSessionId,
      label: Schema.String,
      kind: Schema.Literals(["local", "peer"]),
      initiatingClientId: Identity,
      revision: Revision,
      enabled: Schema.Boolean,
      runtimeModeCeiling: AuthMcpClientAccess,
      scopes: Schema.Array(AuthEnvironmentScope),
      effectiveScopes: Schema.Array(AuthEnvironmentScope),
      expiresAt: Schema.Number,
    }),
  ),
  sourceClients: Schema.Array(
    Schema.Struct({ linkIdentityId: Identity, initiatingClientId: Identity }),
  ),
  threads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  delegations: Schema.Array(
    Schema.Struct({
      delegationId: Identity,
      threadId: ThreadId,
      linkIdentityId: Identity,
      initiatingClientId: Identity,
      policyRevision: Revision,
      createdAt: Schema.Number,
      revoked: Schema.Boolean,
      effectiveEnabled: Schema.Boolean,
    }),
  ),
  fleet: Schema.Struct({
    available: Schema.Boolean,
    valid: Schema.Boolean,
    revision: Revision,
    destinationMachineId: Schema.NullOr(Identity),
    peers: Schema.Array(
      Schema.Struct({
        callerMachineId: Identity,
        environmentId: Identity,
        enabled: Schema.Boolean,
      }),
    ),
  }),
});
export type ApprovalAdministrationSnapshot = typeof ApprovalAdministrationSnapshot.Type;
export class ApprovalAdministrationError extends Schema.TaggedError<ApprovalAdministrationError>()(
  "ApprovalAdministrationError",
  {
    reason: Schema.Literals([
      "not_destination_owner",
      "authority_changed",
      "link_not_approved",
      "invalid_target",
      "unavailable",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not_destination_owner":
        return "Only this environment's signed-in owner can manage approval access.";
      case "authority_changed":
        return "Approval access changed. Refresh and select the current identity again.";
      case "link_not_approved":
        return "Approval access requires a current opted-in credential and trusted destination policy.";
      case "invalid_target":
        return "Select the exact current thread, link and client identity.";
      case "unavailable":
        return "Approval access could not be checked. No permission was granted.";
    }
  }
}
