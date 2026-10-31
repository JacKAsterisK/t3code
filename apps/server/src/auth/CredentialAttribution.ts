import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SessionStore from "./SessionStore.ts";

/**
 * The fleet machine a credential acts for lives in subjects this server sets, never in client data.
 * A fleet credential or peer-link code is a root; what it mints or approves inherits it as
 * `lan-fleet-by:<root>` or `mcp-client:<root>`. Other MCP approvals are `mcp-client:local`.
 */
const FLEET_ROOT = /^lan-fleet(?:-peer-link)?:/u;
const DERIVED_PREFIX = "lan-fleet-by:";
export const MCP_CLIENT_SUBJECT = "mcp-client";
const MCP_PREFIX = `${MCP_CLIENT_SUBJECT}:`;

/** The fleet credential a subject was ultimately issued under, if any. */
export const attributionRoot = (subject: string): string | undefined => {
  const inner = subject.startsWith(MCP_PREFIX) ? subject.slice(MCP_PREFIX.length) : subject;
  const root = inner.startsWith(DERIVED_PREFIX) ? inner.slice(DERIVED_PREFIX.length) : inner;
  return FLEET_ROOT.test(root) ? root : undefined;
};

/** The subject for a pairing code a principal mints; undefined keeps the default. */
export const derivedSubject = (principalSubject: string): string | undefined => {
  const root = attributionRoot(principalSubject);
  return root === undefined ? undefined : `${DERIVED_PREFIX}${root}`;
};

/** The subject for an MCP session or task grant approved by `approvalSubject`. */
export const mcpClientSubject = (approvalSubject: string): string =>
  `${MCP_PREFIX}${attributionRoot(approvalSubject) ?? "local"}`;

export const isMcpClientSubject = (subject: string) =>
  subject === MCP_CLIENT_SUBJECT || subject.startsWith(MCP_PREFIX);

export class CredentialAccessUnavailable extends Schema.TaggedError<CredentialAccessUnavailable>()(
  "CredentialAccessUnavailable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Current credential access could not be checked.";
  }
}

/**
 * Optional: limits a credential, each time it is used, to what the fleet machine it is attributed
 * to may do now. Without it every credential keeps the scopes it was issued with.
 */
export class CredentialAccessCap extends Context.Service<
  CredentialAccessCap,
  {
    /** The scopes usable right now; undefined when the credential may not be used at all. */
    readonly scopes: (credential: {
      readonly subject: string;
      /** Authenticated store/token context, never a client assertion. */
      readonly sessionId?: string;
      readonly peerLink?: boolean;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      /** An MCP task grant, which a plain `mcp-client` subject cannot attribute. */
      readonly taskGrant?: boolean;
    }) => Effect.Effect<
      ReadonlyArray<AuthEnvironmentScope> | undefined,
      CredentialAccessUnavailable
    >;
    /**
     * Whether the credential may administer the fleet from here now, or hand access outside it
     * (guest shares, webhook URLs, T3 Connect linking), which outlives an exception: a fleet
     * machine needs standard access of its own, never an exception's. True for a credential no
     * fleet machine is behind.
     */
    readonly administersFleet: (credential: {
      readonly subject: string;
      readonly taskGrant?: boolean;
    }) => Effect.Effect<boolean>;
  }
>()("t3/auth/CredentialAttribution/CredentialAccessCap") {}

/**
 * Optional: attributes a task grant from before grants recorded their approver, at its next
 * refresh, to the fleet machine holding it. The holder proves who it is by signing for that one
 * grant with its own fleet key, so it can only ever name itself.
 */
export class McpGrantAttribution extends Context.Service<
  McpGrantAttribution,
  {
    /** The grant an assertion is for and the subject it attributes it to; undefined if invalid. */
    readonly verify: (
      assertion: string,
    ) => Effect.Effect<{ readonly grantId: string; readonly subject: string } | undefined>;
  }
>()("t3/auth/CredentialAttribution/McpGrantAttribution") {}

/** A session store whose verified sessions carry only the scopes the cap allows now. */
export const cappedSessionStore = (
  sessions: SessionStore.SessionStore["Service"],
  cap: Option.Option<CredentialAccessCap["Service"]>,
): SessionStore.SessionStore["Service"] => {
  if (Option.isNone(cap)) return sessions;
  const limit = <S extends SessionStore.VerifiedSession>(session: S) =>
    cap.value.scopes(session).pipe(
      Effect.mapError(
        (cause) =>
          new SessionStore.SessionCredentialVerificationError({
            sessionId: session.sessionId,
            cause,
          }),
      ),
      Effect.flatMap((scopes) =>
        scopes === undefined
          ? DateTime.now.pipe(
              Effect.flatMap((revokedAt) =>
                Effect.fail(
                  new SessionStore.SessionTokenRevokedError({
                    sessionId: session.sessionId,
                    revokedAt,
                  }),
                ),
              ),
            )
          : Effect.succeed({ ...session, scopes }),
      ),
    );
  return {
    ...sessions,
    verify: (token) => sessions.verify(token).pipe(Effect.flatMap(limit)),
    verifyWebSocketToken: (token) =>
      sessions.verifyWebSocketToken(token).pipe(Effect.flatMap(limit)),
  };
};
