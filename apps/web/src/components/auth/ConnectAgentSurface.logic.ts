import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  type AuthMcpClientAccess,
  isRuntimeModeAbove,
  parseMcpApprovalCode,
} from "@t3tools/contracts";

/**
 * The picker's access, lowered to a managed ceiling: the user's choice, else Auto for a typed
 * code, else Read only, since approving without a code says nothing about what the user wants.
 */
export function resolveMcpAccess(
  requested: AuthMcpClientAccess | null,
  ceiling: AuthMcpApprovalDetails["runtimeModeCeiling"],
  hasCode: boolean,
): AuthMcpClientAccess {
  const access = requested ?? (hasCode ? "auto" : "read-only");
  return access !== "read-only" &&
    ceiling !== undefined &&
    isRuntimeModeAbove(access, ceiling.maxRuntimeMode)
    ? ceiling.maxRuntimeMode
    : access;
}

/**
 * What Approve sends. A typed code is always checked as a code, even when the browser's
 * session could approve, and a level-bound code sends its own level. Null: nothing to send.
 */
export function resolveApprovalDecision(input: {
  readonly code: string;
  readonly access: AuthMcpClientAccess;
  readonly details: AuthMcpApprovalDetails;
  /** T3 Code LAN: also ask for permission-approval authority. */
  readonly approvals?: boolean;
}): Exclude<AuthMcpApprovalDecision, { readonly _tag: "deny" }> | null {
  const approvals = input.approvals === true;
  const code = input.code.trim();
  if (code.length > 0) {
    return {
      _tag: "pairing-code",
      access: parseMcpApprovalCode(code)?.access ?? input.access,
      code,
      ...(approvals ? { approvals } : {}),
    };
  }
  const { csrfToken, oneClickAccess, canGrantApprovals } = input.details;
  // Sessions can grant only scopes they hold.
  return csrfToken !== undefined &&
    (oneClickAccess ?? []).includes(input.access) &&
    (!approvals || canGrantApprovals === true)
    ? {
        _tag: "browser-session",
        access: input.access,
        csrfToken,
        ...(approvals ? { approvals } : {}),
      }
    : null;
}
