import {
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ApprovalAuthority from "../auth/ApprovalAuthority.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export class ApprovalDelegationError extends Schema.TaggedError<ApprovalDelegationError>()(
  "ApprovalDelegationError",
  {
    reason: Schema.Literals([
      "link_not_approved",
      "thread_not_delegated",
      "authority_changed",
      "mode_ceiling",
      "not_destination_owner",
      "invalid_provenance",
      "provenance_conflict",
      "storage_unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Destination approval refused: ${this.reason}.`;
  }
}

export interface LiveApprovalPeer {
  readonly linkIdentityId: string;
  readonly sourceEnvironmentId: string;
  /** Live revision covering credential binding, access, scopes, caps and modes. */
  readonly credentialRevision: number;
  readonly expiresAt: number;
  readonly access: AuthMcpClientAccess;
  /** Effective scopes after current credential caps, never the token's original scopes. */
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly runtimeModeCeiling: RuntimeMode;
  readonly interactionModeCeiling: ProviderInteractionMode;
}

/** Trusted adapter: all peer/session/cap/policy removals must share this gate with native admission. */
export class ApprovalDestinationAccess extends Context.Service<
  ApprovalDestinationAccess,
  {
    /** Reentrant; acquire before SQL. Auth, cap, link and policy removal use the same gate. */
    readonly withGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly peer: (
      sessionId: string,
    ) => Effect.Effect<LiveApprovalPeer | undefined, ApprovalDelegationError>;
    /** Only trusted persisted guards may follow explicit, unchanged-authority renewal edges. */
    readonly currentBinding?: (
      linkIdentityId: string,
      preparedSessionId: string,
      preparedRevision?: number,
    ) => Effect.Effect<
      | {
          readonly sessionId: string;
          readonly preparedRevision: number;
          readonly peer: LiveApprovalPeer;
        }
      | undefined,
      ApprovalDelegationError
    >;
    /** Live destination policy; invalid, conflicting or rollback state must grant nothing. */
    readonly policy: (
      linkIdentityId: string,
    ) => Effect.Effect<
      { readonly enabled: boolean; readonly revision: number } | undefined,
      ApprovalDelegationError
    >;
    /** Destination owner/admin authorization, independent of broad fleet write or owner labels. */
    readonly owner: (
      sessionId: string,
    ) => Effect.Effect<{ readonly subject: string } | undefined, ApprovalDelegationError>;
  }
>()("t3/approvals/ApprovalDelegations/ApprovalDestinationAccess") {}

declare const authenticatedPeer: unique symbol;
export interface AuthenticatedApprovalPeer {
  readonly [authenticatedPeer]: true;
}
interface PeerIdentity {
  readonly sessionId: string;
  readonly linkIdentityId: string;
  readonly sourceEnvironmentId: string;
  /** Asserted by the authenticated immediate peer, not an independently authenticated client at B. */
  readonly initiatingClientId: string;
  readonly limits: McpInvocationContext.ClientModes;
}
export interface ApprovalDestinationAuthority {
  readonly threadId: string;
  readonly linkIdentityId: string;
  readonly sourceEnvironmentId: string;
  readonly initiatingClientId: string;
  readonly linkRevision: number;
  /** Live revision covering credential binding, access, scopes, caps and modes. */
  readonly credentialRevision: number;
  readonly policyRevision: number;
  readonly basis: "origin" | "delegation";
  readonly delegationId: string | null;
}
interface LinkRow {
  readonly link_identity_id: string;
  readonly source_environment_id: string;
  readonly revision: number;
  readonly revoked_at: number | null;
}
interface OriginRow {
  readonly thread_id: string;
  readonly source_environment_id: string;
  readonly link_identity_id: string;
  readonly initiating_client_id: string;
  readonly creation_command_id: string;
  readonly created_sequence: number;
}
export interface ApprovalDelegation {
  readonly delegation_id: string;
  readonly thread_id: string;
  readonly link_identity_id: string;
  readonly initiating_client_id: string;
  readonly policy_revision: number;
  readonly created_by: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
}
export interface ApprovalOriginInput {
  readonly threadId: string;
  readonly creationCommandId: string;
  readonly createdSequence: number;
}
export interface ApprovalDelegationTarget {
  readonly threadId: string;
  readonly linkIdentityId: string;
  readonly initiatingClientId: string;
}

export class ApprovalDelegations extends Context.Service<
  ApprovalDelegations,
  {
    readonly createLink: (
      ownerSessionId: string,
      sourceEnvironmentId: string,
    ) => Effect.Effect<string, ApprovalDelegationError>;
    readonly replaceLink: (
      ownerSessionId: string,
      linkIdentityId: string,
    ) => Effect.Effect<string, ApprovalDelegationError>;
    readonly revokeLink: (
      ownerSessionId: string,
      linkIdentityId: string,
    ) => Effect.Effect<void, ApprovalDelegationError>;
    readonly authenticate: (
      assertedInitiatingClientId: string,
    ) => Effect.Effect<
      AuthenticatedApprovalPeer,
      ApprovalDelegationError,
      McpInvocationContext.McpInvocationContext
    >;
    /** Call in the creation event/projection transaction, with server-built launch metadata. */
    readonly recordOrigin: (
      peer: AuthenticatedApprovalPeer,
      input: ApprovalOriginInput,
    ) => Effect.Effect<void, ApprovalDelegationError>;
    readonly grant: (
      ownerSessionId: string,
      target: ApprovalDelegationTarget,
    ) => Effect.Effect<ApprovalDelegation, ApprovalDelegationError>;
    readonly revoke: (
      ownerSessionId: string,
      delegationId: string,
    ) => Effect.Effect<void, ApprovalDelegationError>;
    readonly list: (
      ownerSessionId: string,
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<ApprovalDelegation>, ApprovalDelegationError>;
    /** Evidence only; continuing authority always requires withAdmission. */
    readonly check: (
      peer: AuthenticatedApprovalPeer,
      threadId: string,
      expected?: ApprovalDestinationAuthority,
    ) => Effect.Effect<ApprovalDestinationAuthority, ApprovalDelegationError>;
    /** The callback commits local admission in this transaction; it must not dispatch or send remotely. */
    readonly withAdmission: <A, E, R>(
      peer: AuthenticatedApprovalPeer,
      threadId: string,
      expected: ApprovalDestinationAuthority | undefined,
      admit: (authority: ApprovalDestinationAuthority) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ApprovalDelegationError, R>;
  }
>()("t3/approvals/ApprovalDelegations") {}

const isDelegationError = Schema.is(ApprovalDelegationError);
const storageError = (cause: unknown) =>
  isDelegationError(cause)
    ? cause
    : new ApprovalDelegationError({ reason: "storage_unavailable", cause });
const runtimeRanks: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const isRuntimeMode = Schema.is(
  Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
);
const isInteractionMode = Schema.is(Schema.Literals(["plan", "default"]));

/** Source-only construction: never derive continuity from app, name, family, or wire fields. */
export const initiatingClientForLaunch = Effect.fn("ApprovalDelegations.initiatingClientForLaunch")(
  function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const client = scope.client;
    if (
      scope.thread !== undefined ||
      client === undefined ||
      client.linked === true ||
      client.taskOnly === true ||
      client.grantId !== undefined
    )
      return yield* new ApprovalDelegationError({ reason: "invalid_provenance" });
    const authority = yield* ApprovalAuthority.ApprovalAuthority;
    const current = yield* authority.identity(client.sessionId);
    return {
      initiatingClientId: current.initiating_client_id,
      authorityRevision: current.revision,
    };
  },
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const access = yield* ApprovalDestinationAccess;
  const identities = new WeakMap<AuthenticatedApprovalPeer, PeerIdentity>();
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    access
      .withGate(
        sql.withTransaction(
          effect.pipe(Effect.mapError((error) => ({ _tag: "AdmissionError" as const, error }))),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "AdmissionError" ? cause.error : storageError(cause),
        ),
      );
  const owner = Effect.fn("ApprovalDelegations.owner")(function* (sessionId: string) {
    const actor = yield* access.owner(sessionId);
    if (actor === undefined)
      return yield* new ApprovalDelegationError({ reason: "not_destination_owner" });
    return actor.subject;
  });
  const readLink = Effect.fn("ApprovalDelegations.readLink")(function* (linkIdentityId: string) {
    const row =
      (yield* sql<LinkRow>`SELECT * FROM agent_approval_destination_links WHERE link_identity_id = ${linkIdentityId}`)[0];
    if (row === undefined || row.revoked_at !== null)
      return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
    return row;
  }, Effect.mapError(storageError));
  const livePeer = Effect.fn("ApprovalDelegations.livePeer")(function* (identity: PeerIdentity) {
    const peer = yield* access.peer(identity.sessionId);
    const now = yield* Clock.currentTimeMillis;
    const link = yield* readLink(identity.linkIdentityId);
    if (
      peer === undefined ||
      peer.expiresAt <= now ||
      !Number.isFinite(peer.expiresAt) ||
      peer.linkIdentityId !== identity.linkIdentityId ||
      peer.sourceEnvironmentId !== identity.sourceEnvironmentId ||
      link.source_environment_id !== identity.sourceEnvironmentId ||
      !Number.isSafeInteger(peer.credentialRevision) ||
      peer.credentialRevision < 1
    )
      return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
    return { peer, link };
  });
  const identityOf = (peer: AuthenticatedApprovalPeer) => {
    const identity = identities.get(peer);
    return identity === undefined
      ? Effect.fail(new ApprovalDelegationError({ reason: "invalid_provenance" }))
      : Effect.succeed(identity);
  };
  const createLink = Effect.fn("ApprovalDelegations.createLink")(
    function* (ownerSessionId: string, sourceEnvironmentId: string) {
      const subject = yield* owner(ownerSessionId);
      if (sourceEnvironmentId.trim().length === 0)
        return yield* new ApprovalDelegationError({ reason: "invalid_provenance" });
      const id = `apl_${yield* crypto.randomUUIDv4()}`;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO agent_approval_destination_links(link_identity_id, source_environment_id, created_by, created_at)
      VALUES (${id}, ${sourceEnvironmentId}, ${subject}, ${now})`;
      return id;
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const replaceLink = Effect.fn("ApprovalDelegations.replaceLink")(
    function* (ownerSessionId: string, linkIdentityId: string) {
      const subject = yield* owner(ownerSessionId);
      const old = yield* readLink(linkIdentityId);
      const id = `apl_${yield* crypto.randomUUIDv4()}`;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO agent_approval_destination_links(link_identity_id, source_environment_id, created_by, created_at)
      VALUES (${id}, ${old.source_environment_id}, ${subject}, ${now})`;
      yield* sql`UPDATE agent_approval_destination_links SET revoked_at = ${now}, revision = revision + 1,
      replaced_by_link_identity_id = ${id} WHERE link_identity_id = ${linkIdentityId}`;
      yield* sql`UPDATE agent_approval_delegations SET revoked_at = ${now} WHERE link_identity_id = ${linkIdentityId} AND revoked_at IS NULL`;
      return id;
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const revokeLink = Effect.fn("ApprovalDelegations.revokeLink")(
    function* (ownerSessionId: string, linkIdentityId: string) {
      yield* owner(ownerSessionId);
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE agent_approval_destination_links SET revoked_at = ${now}, revision = revision + 1
      WHERE link_identity_id = ${linkIdentityId} AND revoked_at IS NULL`;
      yield* sql`UPDATE agent_approval_delegations SET revoked_at = ${now} WHERE link_identity_id = ${linkIdentityId} AND revoked_at IS NULL`;
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const authenticate = Effect.fn("ApprovalDelegations.authenticate")(
    function* (assertedInitiatingClientId: string) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const client = scope.client;
      if (
        scope.linkedEnvironments !== true ||
        scope.thread !== undefined ||
        client?.linked !== true ||
        client.taskOnly === true ||
        client.grantId !== undefined ||
        assertedInitiatingClientId.trim().length === 0
      )
        return yield* new ApprovalDelegationError({ reason: "invalid_provenance" });
      const live = yield* access.peer(client.sessionId);
      if (live === undefined)
        return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
      const identity: PeerIdentity = {
        sessionId: client.sessionId,
        linkIdentityId: live.linkIdentityId,
        sourceEnvironmentId: live.sourceEnvironmentId,
        initiatingClientId: assertedInitiatingClientId,
        limits: McpInvocationContext.clientModeCeiling(client),
      };
      yield* livePeer(identity);
      const handle = Object.freeze({}) as AuthenticatedApprovalPeer;
      identities.set(handle, identity);
      return handle;
    },
    (effect) => transaction(effect),
  );
  const recordOrigin = Effect.fn("ApprovalDelegations.recordOrigin")(
    function* (handle: AuthenticatedApprovalPeer, input: ApprovalOriginInput) {
      const identity = yield* identityOf(handle);
      yield* livePeer(identity);
      const created = yield* sql`SELECT sequence FROM orchestration_events
      WHERE sequence = ${input.createdSequence} AND stream_id = ${input.threadId}
        AND aggregate_kind = 'thread' AND application_event_version = 2
        AND event_type = 'thread.created' AND command_id = ${input.creationCommandId}
        AND json_extract(payload_json, '$.linkOrigin.sessionId') = ${identity.sessionId}`;
      if (created.length !== 1)
        return yield* new ApprovalDelegationError({ reason: "invalid_provenance" });
      yield* sql`INSERT INTO agent_thread_approval_origins(thread_id, source_environment_id, link_identity_id,
      initiating_client_id, creation_command_id, created_sequence)
      VALUES (${input.threadId}, ${identity.sourceEnvironmentId}, ${identity.linkIdentityId},
        ${identity.initiatingClientId}, ${input.creationCommandId}, ${input.createdSequence}) ON CONFLICT(thread_id) DO NOTHING`;
      const row =
        (yield* sql<OriginRow>`SELECT * FROM agent_thread_approval_origins WHERE thread_id = ${input.threadId}`)[0]!;
      if (
        row.source_environment_id !== identity.sourceEnvironmentId ||
        row.link_identity_id !== identity.linkIdentityId ||
        row.initiating_client_id !== identity.initiatingClientId ||
        row.creation_command_id !== input.creationCommandId ||
        row.created_sequence !== input.createdSequence
      )
        return yield* new ApprovalDelegationError({ reason: "provenance_conflict" });
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const policy = Effect.fn("ApprovalDelegations.policy")(function* (linkIdentityId: string) {
    const current = yield* access.policy(linkIdentityId);
    if (
      current?.enabled !== true ||
      !Number.isSafeInteger(current.revision) ||
      current.revision < 1
    )
      return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
    return current;
  });
  const grant = Effect.fn("ApprovalDelegations.grant")(
    function* (ownerSessionId: string, target: ApprovalDelegationTarget) {
      const subject = yield* owner(ownerSessionId);
      yield* readLink(target.linkIdentityId);
      const current = yield* policy(target.linkIdentityId);
      if (target.initiatingClientId.trim().length === 0)
        return yield* new ApprovalDelegationError({ reason: "invalid_provenance" });
      const thread =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${target.threadId} AND deleted_at IS NULL`;
      if (thread.length !== 1)
        return yield* new ApprovalDelegationError({ reason: "thread_not_delegated" });
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE agent_approval_delegations SET revoked_at = ${now}
      WHERE thread_id = ${target.threadId} AND link_identity_id = ${target.linkIdentityId}
        AND initiating_client_id = ${target.initiatingClientId} AND revoked_at IS NULL AND policy_revision != ${current.revision}`;
      const id = `apd_${yield* crypto.randomUUIDv4()}`;
      yield* sql`INSERT INTO agent_approval_delegations(delegation_id, thread_id, link_identity_id,
      initiating_client_id, policy_revision, created_by, created_at)
      VALUES (${id}, ${target.threadId}, ${target.linkIdentityId}, ${target.initiatingClientId}, ${current.revision}, ${subject}, ${now})
      ON CONFLICT DO NOTHING`;
      return (yield* sql<ApprovalDelegation>`SELECT * FROM agent_approval_delegations WHERE thread_id = ${target.threadId}
      AND link_identity_id = ${target.linkIdentityId} AND initiating_client_id = ${target.initiatingClientId} AND revoked_at IS NULL`)[0]!;
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const revoke = Effect.fn("ApprovalDelegations.revoke")(
    function* (ownerSessionId: string, delegationId: string) {
      yield* owner(ownerSessionId);
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        link_identity_id: string;
      }>`UPDATE agent_approval_delegations SET revoked_at = ${now}
      WHERE delegation_id = ${delegationId} AND revoked_at IS NULL RETURNING link_identity_id`;
      for (const row of rows)
        yield* sql`UPDATE agent_approval_destination_links SET revision = revision + 1 WHERE link_identity_id = ${row.link_identity_id}`;
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const list = Effect.fn("ApprovalDelegations.list")(
    function* (ownerSessionId: string, threadId: string) {
      yield* owner(ownerSessionId);
      return yield* sql<ApprovalDelegation>`SELECT * FROM agent_approval_delegations WHERE thread_id = ${threadId} ORDER BY created_at, delegation_id`;
    },
    (effect) => transaction(effect).pipe(Effect.mapError(storageError)),
  );
  const evaluate = Effect.fn("ApprovalDelegations.evaluate")(function* (
    handle: AuthenticatedApprovalPeer,
    threadId: string,
    expected?: ApprovalDestinationAuthority,
  ) {
    const identity = yield* identityOf(handle);
    const { peer, link } = yield* livePeer(identity);
    const current = yield* policy(identity.linkIdentityId);
    if (
      peer.access === "read-only" ||
      ![
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
        AuthOrchestrationApproveScope,
      ].every((scope) => peer.scopes.includes(scope))
    )
      return yield* new ApprovalDelegationError({ reason: "link_not_approved" });
    const thread = (yield* sql<{
      runtime_mode: string;
      interaction_mode: string;
    }>`SELECT runtime_mode, interaction_mode
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`)[0];
    if (thread === undefined)
      return yield* new ApprovalDelegationError({ reason: "thread_not_delegated" });
    if (
      !isRuntimeMode(thread.runtime_mode) ||
      !isInteractionMode(thread.interaction_mode) ||
      !isRuntimeMode(peer.runtimeModeCeiling) ||
      !isInteractionMode(peer.interactionModeCeiling) ||
      runtimeRanks[thread.runtime_mode] > runtimeRanks[peer.runtimeModeCeiling] ||
      runtimeRanks[thread.runtime_mode] > runtimeRanks[peer.access] ||
      runtimeRanks[thread.runtime_mode] > runtimeRanks[identity.limits.runtimeMode] ||
      (thread.interaction_mode === "default" &&
        (peer.interactionModeCeiling === "plan" || identity.limits.interactionMode === "plan"))
    )
      return yield* new ApprovalDelegationError({ reason: "mode_ceiling" });
    const origin =
      yield* sql`SELECT thread_id FROM agent_thread_approval_origins WHERE thread_id = ${threadId}
      AND link_identity_id = ${identity.linkIdentityId} AND source_environment_id = ${identity.sourceEnvironmentId}
      AND initiating_client_id = ${identity.initiatingClientId}`;
    const delegated =
      origin.length === 1
        ? undefined
        : (yield* sql<ApprovalDelegation>`SELECT * FROM agent_approval_delegations
      WHERE thread_id = ${threadId} AND link_identity_id = ${identity.linkIdentityId}
        AND initiating_client_id = ${identity.initiatingClientId} AND revoked_at IS NULL AND policy_revision = ${current.revision}`)[0];
    if (origin.length !== 1 && delegated === undefined)
      return yield* new ApprovalDelegationError({ reason: "thread_not_delegated" });
    const result: ApprovalDestinationAuthority = {
      threadId,
      linkIdentityId: identity.linkIdentityId,
      sourceEnvironmentId: identity.sourceEnvironmentId,
      initiatingClientId: identity.initiatingClientId,
      linkRevision: link.revision,
      credentialRevision: peer.credentialRevision,
      policyRevision: current.revision,
      basis: origin.length === 1 ? "origin" : "delegation",
      delegationId: delegated?.delegation_id ?? null,
    };
    if (
      expected !== undefined &&
      (Object.keys(result) as Array<keyof ApprovalDestinationAuthority>).some(
        (key) => result[key] !== expected[key],
      )
    )
      return yield* new ApprovalDelegationError({ reason: "authority_changed" });
    return result;
  }, Effect.mapError(storageError));
  const check = Effect.fn("ApprovalDelegations.check")(
    (peer: AuthenticatedApprovalPeer, threadId: string, expected?: ApprovalDestinationAuthority) =>
      transaction(evaluate(peer, threadId, expected)),
  );
  const withAdmission: ApprovalDelegations["Service"]["withAdmission"] = Effect.fn(
    "ApprovalDelegations.withAdmission",
  )((peer, threadId, expected, admit) =>
    transaction(Effect.flatMap(evaluate(peer, threadId, expected), admit)),
  );
  return ApprovalDelegations.of({
    createLink,
    replaceLink,
    revokeLink,
    authenticate,
    recordOrigin,
    grant,
    revoke,
    list,
    check,
    withAdmission,
  });
});
export const layer = Layer.effect(ApprovalDelegations, make);
