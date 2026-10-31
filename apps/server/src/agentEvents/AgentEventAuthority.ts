import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as SessionStore from "../auth/SessionStore.ts";

export type AuthorityRefusal =
  /** Revoked, expired, or never an outside client's session. */
  | "session_inactive"
  | "read_scope_lost"
  /** A fleet machine's credential below operate (read-only) can never share outside. */
  | "fleet_read_only"
  /** The fleet machine behind it is here only through an exception, or may not share outside. */
  | "outside_sharing_refused";

export type AuthorityVerdict =
  | {
      readonly _tag: "Allowed";
      readonly sessionExpiresAt: number;
      /** The fleet attribution of the credential, stored apart from the principal. */
      readonly subject: string;
    }
  | { readonly _tag: "Refused"; readonly reason: AuthorityRefusal }
  /** Authority could not be established now; nothing is delivered until it can be. */
  | { readonly _tag: "Unavailable" };

/**
 * May this session hand T3 events to a callback outside the fleet? Asked at subscribe, before each
 * attempt and by the sweep, from the session store. Same bar as `ws.ts` `sharingOutside`:
 * `CredentialAccessCap.administersFleet` (true when no fleet machine is behind the credential).
 */
export class AgentEventAuthority extends Context.Service<
  AgentEventAuthority,
  {
    readonly check: (input: {
      readonly sessionId: string;
      /** The subject the subscription was made under; a different one is not the same grant. */
      readonly attributionSubject?: string;
    }) => Effect.Effect<AuthorityVerdict>;
  }
>()("t3/agentEvents/AgentEventAuthority") {}

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const cap = yield* Effect.serviceOption(CredentialAttribution.CredentialAccessCap);
  const check: AgentEventAuthority["Service"]["check"] = Effect.fn("AgentEventAuthority.check")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const active = yield* sessions.listActive().pipe(Effect.option);
      if (Option.isNone(active)) return { _tag: "Unavailable" } as const;
      const session = active.value.find((candidate) => candidate.sessionId === input.sessionId);
      if (
        session === undefined ||
        session.method !== "bearer-access-token" ||
        !CredentialAttribution.isMcpClientSubject(session.subject) ||
        (input.attributionSubject !== undefined && session.subject !== input.attributionSubject) ||
        session.expiresAt.epochMilliseconds <= now
      )
        return { _tag: "Refused", reason: "session_inactive" } as const;
      const scopes = Option.isNone(cap)
        ? session.scopes
        : yield* cap.value.scopes({ subject: session.subject, scopes: session.scopes });
      if (scopes === undefined) return { _tag: "Refused", reason: "session_inactive" } as const;
      if (!scopes.includes(AuthOrchestrationReadScope))
        return { _tag: "Refused", reason: "read_scope_lost" } as const;
      if (
        CredentialAttribution.attributionRoot(session.subject) !== undefined &&
        !scopes.includes(AuthOrchestrationOperateScope)
      )
        return { _tag: "Refused", reason: "fleet_read_only" } as const;
      const sharesOutside = Option.isNone(cap)
        ? true
        : yield* cap.value.administersFleet({ subject: session.subject });
      if (!sharesOutside) return { _tag: "Refused", reason: "outside_sharing_refused" } as const;
      return {
        _tag: "Allowed",
        sessionExpiresAt: session.expiresAt.epochMilliseconds,
        subject: session.subject,
      } as const;
    },
    // Fail closed: a check that cannot finish never allows delivery.
    Effect.catchCause(() => Effect.succeed({ _tag: "Unavailable" } as const)),
  );
  return AgentEventAuthority.of({ check });
});

export const layer = Layer.effect(AgentEventAuthority, make);
