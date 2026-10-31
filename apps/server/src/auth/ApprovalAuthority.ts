import {
  AuthSessionId,
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { localAuthoritySnapshot } from "./ApprovalContinuity.ts";
import * as ApprovalAdmissionGate from "./ApprovalAdmissionGate.ts";
import * as SessionStore from "./SessionStore.ts";
import * as CredentialAttribution from "./CredentialAttribution.ts";

export class ApprovalAuthorityError extends Schema.TaggedError<ApprovalAuthorityError>()(
  "ApprovalAuthorityError",
  {
    reason: Schema.Literals(["authority_revoked", "storage_unavailable", "mode_changed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Approval authority could not be established.";
  }
}
const isApprovalAuthorityError = Schema.is(ApprovalAuthorityError);
export interface Authorization {
  readonly session_id: string;
  readonly application_id: string;
  readonly consent_family_id: string;
  readonly initiating_client_id: string;
  readonly runtime_mode_ceiling: string;
  readonly enabled: number;
  readonly revision: number;
  readonly authority_snapshot: string | null;
  readonly replaced_by_session_id: string | null;
  readonly credential_kind: "local" | "peer" | "legacy";
}
export class ApprovalAuthority extends Context.Service<
  ApprovalAuthority,
  {
    readonly withGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly identity: (
      sessionId: string,
      operation?: "read" | "operate",
    ) => Effect.Effect<
      Authorization & {
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        readonly runtimeModeCeiling: string;
      },
      ApprovalAuthorityError
    >;
    readonly check: (
      sessionId: string,
      revision?: number,
    ) => Effect.Effect<
      Authorization & {
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        readonly runtimeModeCeiling: string;
      },
      ApprovalAuthorityError
    >;
    /** Server-internal operation reconciliation; public bearer checks never follow successors. */
    readonly currentForOperation: (input: {
      readonly sessionId: string;
      readonly authorityRevision: number;
      readonly initiatingClientId: string;
    }) => Effect.Effect<
      {
        readonly sessionId: string;
        readonly authorityRevision: number;
        readonly authorization: Authorization & {
          readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
          readonly runtimeModeCeiling: string;
        };
      },
      ApprovalAuthorityError
    >;
    readonly register: (input: {
      readonly sessionId: string;
      readonly applicationId: string;
      readonly grantorSubject: string;
      readonly enabled: boolean;
      readonly peerLink?: boolean;
      readonly runtimeModeCeiling: string;
    }) => Effect.Effect<void, ApprovalAuthorityError>;
    readonly withoutFamilyApproval: <A, E, R>(
      applicationId: string,
      grantorSubject: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ApprovalAuthorityError, R>;
    readonly remove: (
      sessionId: string,
      family: boolean,
    ) => Effect.Effect<void, ApprovalAuthorityError>;
    readonly strip: (
      sessionId: string,
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<ReadonlyArray<AuthEnvironmentScope>, ApprovalAuthorityError>;
  }
>()("t3/auth/ApprovalAuthority") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionStore.SessionStore;
  const crypto = yield* Crypto.Crypto;
  const cap = yield* Effect.serviceOption(CredentialAttribution.CredentialAccessCap);
  const { withGate } = yield* ApprovalAdmissionGate.ApprovalAdmissionGate;
  const read = Effect.fn("ApprovalAuthority.read")(
    function* (sessionId: string) {
      const rows =
        yield* sql<Authorization>`SELECT * FROM agent_approval_authorizations WHERE session_id = ${sessionId}`;
      return rows[0];
    },
    Effect.mapError(
      (cause) => new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
    ),
  );
  const strip = Effect.fn("ApprovalAuthority.strip")(function* (
    sessionId: string,
    scopes: ReadonlyArray<AuthEnvironmentScope>,
  ) {
    if (!scopes.includes(AuthOrchestrationApproveScope)) return scopes;
    const row = yield* read(sessionId);
    return row?.enabled === 1 && row.credential_kind === "local"
      ? scopes
      : scopes.filter((scope) => scope !== AuthOrchestrationApproveScope);
  });
  const identity = Effect.fn("ApprovalAuthority.identity")(function* (
    sessionId: string,
    operation: "read" | "operate" = "operate",
  ) {
    const row = yield* read(sessionId);
    const now = yield* Clock.currentTimeMillis;
    const active = yield* sessions
      .listActive()
      .pipe(
        Effect.mapError(
          (cause) => new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
        ),
      );
    const session = active.find((session) => session.sessionId === sessionId);
    if (
      row?.credential_kind !== "local" ||
      session === undefined ||
      session.method !== "bearer-access-token" ||
      !CredentialAttribution.isMcpClientSubject(session.subject) ||
      session.expiresAt.epochMilliseconds <= now
    )
      return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
    const scopes = Option.isNone(cap)
      ? (session.permissions ?? session.scopes)
      : yield* cap.value
          .scopes({
            sessionId,
            subject: session.subject,
            scopes: session.permissions ?? session.scopes,
          })
          .pipe(
            Effect.mapError(
              (cause) => new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
            ),
          );
    const snapshot = localAuthoritySnapshot({
      enabled: row.enabled,
      scopes: scopes ?? [],
      runtimeModeCeiling: row.runtime_mode_ceiling,
    });
    if (row.authority_snapshot !== snapshot) {
      yield* sql`UPDATE agent_approval_authorizations SET authority_snapshot = ${snapshot},
        revision = revision + ${row.authority_snapshot === null ? 0 : 1} WHERE session_id = ${sessionId}`.pipe(
        Effect.mapError(
          (cause) => new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
        ),
      );
    }
    if (
      scopes === undefined ||
      !(
        operation === "read"
          ? [AuthOrchestrationReadScope]
          : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
      ).every((scope) => scopes.includes(scope))
    )
      return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
    return {
      ...row,
      authority_snapshot: snapshot,
      revision:
        row.revision +
        (row.authority_snapshot !== null && row.authority_snapshot !== snapshot ? 1 : 0),
      scopes,
      runtimeModeCeiling: row.runtime_mode_ceiling,
    };
  }, withGate);
  const check = Effect.fn("ApprovalAuthority.check")(function* (
    sessionId: string,
    revision?: number,
  ) {
    const current = yield* identity(sessionId);
    if (
      current.enabled !== 1 ||
      (revision !== undefined && revision !== current.revision) ||
      !current.scopes.includes(AuthOrchestrationApproveScope)
    )
      return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
    return current;
  });
  const currentForOperation = Effect.fn("ApprovalAuthority.currentForOperation")(
    function* (input: Parameters<ApprovalAuthority["Service"]["currentForOperation"]>[0]) {
      let sessionId = input.sessionId;
      let revision = input.authorityRevision;
      let snapshot: string | undefined;
      const visited = new Set<string>();
      while (!visited.has(sessionId)) {
        visited.add(sessionId);
        const row = yield* read(sessionId);
        if (
          row === undefined ||
          row.credential_kind !== "local" ||
          row.initiating_client_id !== input.initiatingClientId
        )
          return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
        if (row.replaced_by_session_id === null) {
          const authorization = yield* check(sessionId, revision);
          if (snapshot !== undefined && authorization.authority_snapshot !== snapshot)
            return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
          return { sessionId, authorityRevision: authorization.revision, authorization };
        }
        const edge = (yield* sql<{
          next_session_id: string;
          previous_revision: number;
          next_revision: number;
          initiating_client_id: string;
          authority_preserved: number;
          authority_snapshot: string;
        }>`SELECT * FROM agent_approval_client_continuations WHERE previous_session_id = ${sessionId}`)[0];
        if (
          edge === undefined ||
          edge.authority_preserved !== 1 ||
          edge.previous_revision !== revision ||
          row.revision !== revision + 1 ||
          row.enabled !== 0 ||
          row.replaced_by_session_id !== edge.next_session_id ||
          edge.initiating_client_id !== input.initiatingClientId ||
          row.authority_snapshot !== edge.authority_snapshot ||
          (snapshot !== undefined && snapshot !== edge.authority_snapshot)
        )
          return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
        snapshot = edge.authority_snapshot;
        sessionId = edge.next_session_id;
        revision = edge.next_revision;
      }
      return yield* new ApprovalAuthorityError({ reason: "authority_revoked" });
    },
    (effect) =>
      withGate(effect).pipe(
        Effect.mapError((cause) =>
          isApprovalAuthorityError(cause)
            ? cause
            : new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
        ),
      ),
  );
  const register = Effect.fn("ApprovalAuthority.register")(
    function* (input: Parameters<ApprovalAuthority["Service"]["register"]>[0]) {
      const now = yield* Clock.currentTimeMillis;
      const family = CredentialAttribution.attributionRoot(input.grantorSubject) ?? "local-owner";
      const initiating = yield* crypto.randomUUIDv4();
      yield* sql`INSERT INTO agent_approval_authorizations(session_id, application_id, consent_family_id,
        initiating_client_id, enabled, revision, updated_at, runtime_mode_ceiling, credential_kind) VALUES (${input.sessionId}, ${input.applicationId},
        ${family}, ${initiating}, ${input.enabled ? 1 : 0}, 1, ${now}, ${input.runtimeModeCeiling}, ${input.peerLink === true ? "peer" : "local"})`;
    },
    Effect.mapError(
      (cause) => new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
    ),
  );
  const withoutFamilyApproval = <A, E, R>(
    applicationId: string,
    grantorSubject: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ApprovalAuthorityError, R> =>
    withGate(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const family = CredentialAttribution.attributionRoot(grantorSubject) ?? "local-owner";
            const now = yield* Clock.currentTimeMillis;
            const changed = yield* sql<{
              session_id: string;
            }>`SELECT session_id FROM agent_approval_authorizations
        WHERE application_id = ${applicationId} AND consent_family_id = ${family}`;
            yield* sql`UPDATE agent_approval_authorizations SET enabled = 0, revision = revision + 1, updated_at = ${now}
        WHERE application_id = ${applicationId} AND consent_family_id = ${family}`;
            for (const session of changed)
              yield* sql`UPDATE auth_sessions SET scopes = (SELECT json_group_array(value) FROM json_each(auth_sessions.scopes)
        WHERE value != 'orchestration:approve') WHERE session_id = ${session.session_id}`;
            return {
              value: yield* effect.pipe(
                Effect.mapError((error) => ({ _tag: "ConsentActionError" as const, error })),
              ),
              changed,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConsentActionError"
              ? cause.error
              : new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
          ),
          Effect.tap(({ changed }) =>
            Effect.forEach(
              changed,
              (session) => sessions.notifyScopeChange(AuthSessionId.make(session.session_id)),
              { discard: true },
            ),
          ),
          Effect.map(({ value }) => value),
        ),
    );
  const remove = Effect.fn("ApprovalAuthority.remove")(
    function* (sessionId: string, family: boolean) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* read(sessionId);
      if (row === undefined) return [];
      yield* family
        ? sql`UPDATE agent_approval_authorizations SET enabled = 0, revision = revision + 1, updated_at = ${now}
      WHERE application_id = ${row.application_id} AND consent_family_id = ${row.consent_family_id}`
        : sql`UPDATE agent_approval_authorizations SET enabled = 0, revision = revision + 1, updated_at = ${now} WHERE session_id = ${sessionId}`;
      const changed = family
        ? yield* sql<{ session_id: string }>`SELECT session_id FROM agent_approval_authorizations
      WHERE application_id = ${row.application_id} AND consent_family_id = ${row.consent_family_id}`
        : [{ session_id: sessionId }];
      for (const session of changed) {
        yield* sql`UPDATE auth_sessions SET scopes = (SELECT json_group_array(value) FROM json_each(auth_sessions.scopes)
        WHERE value != 'orchestration:approve') WHERE session_id = ${session.session_id}`;
      }
      return changed;
    },
    (effect) =>
      withGate(sql.withTransaction(effect)).pipe(
        Effect.tap((changed) =>
          Effect.forEach(
            changed,
            (session) => sessions.notifyScopeChange(AuthSessionId.make(session.session_id)),
            { discard: true },
          ),
        ),
        Effect.asVoid,
        Effect.mapError((cause) =>
          isApprovalAuthorityError(cause)
            ? cause
            : new ApprovalAuthorityError({ reason: "storage_unavailable", cause }),
        ),
      ),
  );
  return ApprovalAuthority.of({
    withGate,
    identity,
    check,
    register,
    currentForOperation,
    remove,
    strip,
    withoutFamilyApproval,
  });
});
export const layer = Layer.effect(ApprovalAuthority, make).pipe(
  Layer.provideMerge(ApprovalAdmissionGate.layer),
);
