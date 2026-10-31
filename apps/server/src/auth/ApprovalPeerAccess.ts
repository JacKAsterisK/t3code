import {
  AuthAccessWriteScope,
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  RuntimeMode,
  AuthSessionId,
  AuthEnvironmentScope,
  AuthMcpClientAccess,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { FleetApprovalPolicy as SignedPolicy } from "../../../../packages/contracts/src/fleetApprovalPolicy.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Delegations from "../approvals/ApprovalDelegations.ts";
import { localAuthoritySnapshot } from "./ApprovalContinuity.ts";
import type { Authorization } from "./ApprovalAuthority.ts";
import * as Gate from "./ApprovalAdmissionGate.ts";
import * as CredentialAttribution from "./CredentialAttribution.ts";
import * as SessionStore from "./SessionStore.ts";

export class ApprovalPeerAccess extends Context.Service<
  ApprovalPeerAccess,
  {
    readonly classification: (
      sessionId: string,
    ) => Effect.Effect<
      "local" | "peer" | "legacy" | undefined,
      Delegations.ApprovalDelegationError
    >;
    readonly owner: Delegations.ApprovalDestinationAccess["Service"]["owner"];
    readonly rawPeer: Delegations.ApprovalDestinationAccess["Service"]["peer"];
    readonly policy: Delegations.ApprovalDestinationAccess["Service"]["policy"];
    readonly fleetIdentity: (sessionId: string) => Effect.Effect<
      | {
          readonly destinationMachineId: string;
          readonly fleetId: string;
          readonly signedPolicy: SignedPolicy;
          readonly callerMachineId: string;
          readonly sourceEnvironmentId: string;
        }
      | undefined,
      Delegations.ApprovalDelegationError
    >;
    readonly continueClientIdentity: (
      ownerSessionId: string,
      sessionId: string,
      previousSessionId: string,
      expectedRevision: number,
    ) => Effect.Effect<void, Delegations.ApprovalDelegationError>;
    readonly permits: (
      sessionId: string,
    ) => Effect.Effect<boolean, Delegations.ApprovalDelegationError>;
    readonly bind: (
      ownerSessionId: string,
      input: {
        readonly sessionId: string;
        readonly linkIdentityId: string;
        readonly approvals: boolean;
        readonly interactionModeCeiling: ProviderInteractionMode;
        readonly renew?: { readonly sessionId: string; readonly revision: number };
      },
    ) => Effect.Effect<void, Delegations.ApprovalDelegationError>;
    readonly revoke: (
      ownerSessionId: string,
      sessionId: string,
    ) => Effect.Effect<void, Delegations.ApprovalDelegationError>;
    readonly setPolicy: (
      ownerSessionId: string,
      linkIdentityId: string,
      enabled: boolean,
      expectedRevision: number,
    ) => Effect.Effect<
      { readonly enabled: boolean; readonly revision: number },
      Delegations.ApprovalDelegationError
    >;
  }
>()("t3/auth/ApprovalPeerAccess") {}

const decodeSignedPolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(SignedPolicy));
const isRuntimeMode = Schema.is(RuntimeMode);
const encodeSnapshot = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.Number,
      Schema.Array(AuthEnvironmentScope),
      AuthMcpClientAccess,
      RuntimeMode,
      ProviderInteractionMode,
    ]),
  ),
);
const encodeBindingSnapshot = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.String,
      Schema.Number,
      Schema.String,
      Schema.Boolean,
      ProviderInteractionMode,
    ]),
  ),
);
const securitySnapshot = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Array(AuthEnvironmentScope),
    AuthMcpClientAccess,
    RuntimeMode,
    ProviderInteractionMode,
    Schema.Number,
    Schema.Number,
  ]),
);
const encodeSecuritySnapshot = Schema.encodeSync(securitySnapshot);
const decodeSecuritySnapshot = Schema.decodeEffect(securitySnapshot);
const isError = Schema.is(Delegations.ApprovalDelegationError);
const storageError = (cause: unknown) =>
  isError(cause)
    ? cause
    : new Delegations.ApprovalDelegationError({ reason: "storage_unavailable", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionStore.SessionStore;
  const gate = yield* Gate.ApprovalAdmissionGate;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    gate.withGate(sql.withTransaction(effect)).pipe(Effect.mapError(storageError));
  const classification = Effect.fn("ApprovalPeerAccess.classification")(function* (
    sessionId: string,
  ) {
    return (yield* sql<{
      credential_kind: "local" | "peer" | "legacy";
    }>`SELECT credential_kind FROM agent_approval_authorizations WHERE session_id = ${sessionId}`)[0]
      ?.credential_kind;
  }, Effect.mapError(storageError));
  const active = Effect.fn("ApprovalPeerAccess.active")(function* (sessionId: string) {
    const now = yield* Clock.currentTimeMillis;
    return (yield* sessions.listActive()).find(
      (s) => s.sessionId === sessionId && s.expiresAt.epochMilliseconds > now,
    );
  }, Effect.mapError(storageError));
  const owner = Effect.fn("ApprovalPeerAccess.owner")(function* (sessionId: string) {
    const session = yield* active(sessionId);
    if (
      session === undefined ||
      CredentialAttribution.isMcpClientSubject(session.subject) ||
      CredentialAttribution.attributionRoot(session.subject) !== undefined ||
      !(session.permissions ?? session.scopes).includes(AuthAccessWriteScope)
    )
      return undefined;
    const classified =
      yield* sql`SELECT session_id FROM agent_approval_authorizations WHERE session_id = ${sessionId}`;
    const task =
      yield* sql`SELECT session_id FROM auth_mcp_grant_sessions WHERE session_id = ${sessionId}`;
    return classified.length === 0 && task.length === 0 ? { subject: session.subject } : undefined;
  }, Effect.mapError(storageError));
  const requireOwner = Effect.fn("ApprovalPeerAccess.requireOwner")(function* (sessionId: string) {
    const actor = yield* owner(sessionId);
    if (actor === undefined)
      return yield* new Delegations.ApprovalDelegationError({ reason: "not_destination_owner" });
    return actor.subject;
  });
  const rawPeer = Effect.fn("ApprovalPeerAccess.rawPeer")(function* (sessionId: string) {
    const session = yield* active(sessionId);
    if (
      session === undefined ||
      session.method !== "bearer-access-token" ||
      !CredentialAttribution.isMcpClientSubject(session.subject)
    )
      return undefined;
    const row = (yield* sql<{
      link_identity_id: string;
      source_environment_id: string;
      revision: number;
      runtime_mode_ceiling: string;
      interaction_mode_ceiling: ProviderInteractionMode;
    }>`SELECT b.link_identity_id, l.source_environment_id, b.revision, a.runtime_mode_ceiling, b.interaction_mode_ceiling
      FROM agent_approval_peer_bindings b JOIN agent_approval_authorizations a ON a.session_id = b.session_id
      JOIN agent_approval_destination_links l ON l.link_identity_id = b.link_identity_id
      WHERE b.session_id = ${sessionId} AND b.revoked_at IS NULL AND l.revoked_at IS NULL AND a.credential_kind = 'peer'`)[0];
    if (row === undefined) return undefined;
    const runtimeMode =
      row.runtime_mode_ceiling === "read-only" ? "approval-required" : row.runtime_mode_ceiling;
    if (!isRuntimeMode(runtimeMode)) return undefined;
    const scopes = session.permissions ?? session.scopes;
    return {
      linkIdentityId: row.link_identity_id,
      sourceEnvironmentId: row.source_environment_id,
      credentialRevision: row.revision,
      expiresAt: session.expiresAt.epochMilliseconds,
      access: scopes.includes(AuthOrchestrationOperateScope) ? runtimeMode : ("read-only" as const),
      scopes,
      runtimeModeCeiling: runtimeMode,
      interactionModeCeiling: row.interaction_mode_ceiling,
    };
  }, Effect.mapError(storageError));
  const policy = Effect.fn("ApprovalPeerAccess.policy")(function* (linkIdentityId: string) {
    const row = (yield* sql<{
      enabled: number;
      revision: number;
    }>`SELECT p.enabled, p.revision FROM agent_approval_link_policies p
      JOIN agent_approval_destination_links l ON l.link_identity_id = p.link_identity_id
      WHERE p.link_identity_id = ${linkIdentityId} AND l.revoked_at IS NULL`)[0];
    if (row === undefined) return undefined;
    const fleet = (yield* sql<{
      enabled: number;
      valid: number;
    }>`SELECT COALESCE(g.enabled, 0) AS enabled, h.valid FROM agent_approval_fleet_links f
      LEFT JOIN agent_approval_fleet_policy_heads h ON h.fleet_id = f.fleet_id AND h.destination_machine_id = f.destination_machine_id
      LEFT JOIN agent_approval_fleet_policy_grants g ON g.fleet_id = f.fleet_id AND g.destination_machine_id = f.destination_machine_id AND g.caller_machine_id = f.caller_machine_id
      WHERE f.link_identity_id = ${linkIdentityId}`)[0];
    return {
      enabled:
        row.enabled === 1 && (fleet === undefined || (fleet.valid === 1 && fleet.enabled === 1)),
      revision: row.revision,
    };
  }, Effect.mapError(storageError));
  const fleetIdentity = Effect.fn("ApprovalPeerAccess.fleetIdentity")(function* (
    sessionId: string,
  ) {
    const row = (yield* sql<{
      destination_machine_id: string;
      fleet_id: string;
      entry_json: string | null;
      caller_machine_id: string;
      source_environment_id: string;
    }>`SELECT f.fleet_id, h.entry_json, f.destination_machine_id, f.caller_machine_id, l.source_environment_id FROM agent_approval_peer_bindings b
      JOIN agent_approval_fleet_links f ON f.link_identity_id = b.link_identity_id LEFT JOIN agent_approval_fleet_policy_heads h ON h.fleet_id = f.fleet_id AND h.destination_machine_id = f.destination_machine_id JOIN agent_approval_destination_links l ON l.link_identity_id = b.link_identity_id WHERE b.session_id = ${sessionId} AND b.revoked_at IS NULL AND l.revoked_at IS NULL`)[0];
    if (row === undefined) return undefined;
    const signedPolicy = yield* decodeSignedPolicy(row.entry_json, { onExcessProperty: "error" });
    return {
      fleetId: row.fleet_id,
      signedPolicy,
      destinationMachineId: row.destination_machine_id,
      callerMachineId: row.caller_machine_id,
      sourceEnvironmentId: row.source_environment_id,
    };
  }, Effect.mapError(storageError));
  const continueClientIdentity = Effect.fn("ApprovalPeerAccess.continueClientIdentity")(
    function* (
      ownerSessionId: string,
      sessionId: string,
      previousSessionId: string,
      expectedRevision: number,
    ) {
      const actor = yield* requireOwner(ownerSessionId);
      const session = yield* active(sessionId);
      const previousSession = yield* active(previousSessionId);
      const old =
        (yield* sql<Authorization>`SELECT * FROM agent_approval_authorizations WHERE session_id = ${previousSessionId} AND credential_kind = 'local' AND revision = ${expectedRevision} AND replaced_by_session_id IS NULL`)[0];
      const current =
        (yield* sql<Authorization>`SELECT * FROM agent_approval_authorizations WHERE session_id = ${sessionId} AND credential_kind = 'local' AND revision = 1 AND replaced_by_session_id IS NULL`)[0];
      if (
        session === undefined ||
        previousSession === undefined ||
        sessionId === previousSessionId ||
        old === undefined ||
        current === undefined
      )
        return yield* new Delegations.ApprovalDelegationError({ reason: "authority_changed" });
      const snapshot = localAuthoritySnapshot({
        enabled: old.enabled,
        scopes: previousSession.permissions ?? previousSession.scopes,
        runtimeModeCeiling: old.runtime_mode_ceiling,
      });
      const nextSnapshot = localAuthoritySnapshot({
        enabled: current.enabled,
        scopes: session.permissions ?? session.scopes,
        runtimeModeCeiling: current.runtime_mode_ceiling,
      });
      const preserved =
        (old.authority_snapshot === null || old.authority_snapshot === snapshot) &&
        snapshot === nextSnapshot &&
        old.application_id === current.application_id &&
        old.consent_family_id === current.consent_family_id &&
        previousSession.subject === session.subject;
      if (!preserved)
        return yield* new Delegations.ApprovalDelegationError({ reason: "authority_changed" });
      const now = yield* Clock.currentTimeMillis;
      const nextRevision = current.revision + 1;
      yield* sql`INSERT INTO agent_approval_client_continuations(previous_session_id, next_session_id, initiating_client_id, previous_revision, next_revision, authority_preserved, authority_snapshot, created_by, created_at)
        VALUES (${previousSessionId}, ${sessionId}, ${old.initiating_client_id}, ${expectedRevision}, ${nextRevision}, ${preserved ? 1 : 0}, ${snapshot}, ${actor}, ${now})`;
      yield* sql`UPDATE agent_approval_authorizations SET initiating_client_id = ${old.initiating_client_id}, revision = ${nextRevision}, authority_snapshot = ${nextSnapshot}, updated_at = ${now} WHERE session_id = ${sessionId}`;
      yield* sql`UPDATE agent_approval_authorizations SET replaced_by_session_id = ${sessionId}, authority_snapshot = ${snapshot}, enabled = 0, revision = revision + 1, updated_at = ${now} WHERE session_id = ${previousSessionId}`;
      yield* sessions.revoke(AuthSessionId.make(previousSessionId));
    },
    (effect) => transaction(effect),
  );
  const permits = Effect.fn("ApprovalPeerAccess.permits")(function* (sessionId: string) {
    const peer = yield* rawPeer(sessionId);
    if (
      peer === undefined ||
      peer.access === "read-only" ||
      ![
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
        AuthOrchestrationApproveScope,
      ].every((s) => peer.scopes.includes(s))
    )
      return false;
    const row =
      (yield* sql`SELECT b.session_id FROM agent_approval_peer_bindings b JOIN agent_approval_authorizations a ON a.session_id = b.session_id
      WHERE b.session_id = ${sessionId} AND b.approval_enabled = 1 AND b.revoked_at IS NULL AND a.enabled = 1`)[0];
    const session = yield* active(sessionId);
    if (
      session === undefined ||
      (CredentialAttribution.attributionRoot(session.subject) !== undefined &&
        (yield* fleetIdentity(sessionId)) === undefined)
    )
      return false;
    return row !== undefined && (yield* policy(peer.linkIdentityId))?.enabled === true;
  }, Effect.mapError(storageError));
  const bindingSnapshot = Effect.fn("ApprovalPeerAccess.bindingSnapshot")(function* (
    sessionId: string,
    approvals: boolean,
    interactionModeCeiling: ProviderInteractionMode,
  ) {
    const session = yield* active(sessionId);
    const row =
      (yield* sql<Authorization>`SELECT * FROM agent_approval_authorizations WHERE session_id = ${sessionId}`)[0];
    if (session === undefined || row === undefined) return undefined;
    return encodeBindingSnapshot([
      row.application_id,
      row.consent_family_id,
      session.subject,
      row.revision,
      localAuthoritySnapshot({
        enabled: row.enabled,
        scopes: session.permissions ?? session.scopes,
        runtimeModeCeiling: row.runtime_mode_ceiling,
      }),
      approvals,
      interactionModeCeiling,
    ]);
  });
  const bind = Effect.fn("ApprovalPeerAccess.bind")(
    function* (
      ownerSessionId: string,
      input: Parameters<ApprovalPeerAccess["Service"]["bind"]>[1],
    ) {
      const actor = yield* requireOwner(ownerSessionId);
      const session = yield* active(input.sessionId);
      const credential = (yield* sql<{
        credential_kind: string;
      }>`SELECT credential_kind FROM agent_approval_authorizations WHERE session_id = ${input.sessionId}`)[0];
      const link =
        yield* sql`SELECT link_identity_id FROM agent_approval_destination_links WHERE link_identity_id = ${input.linkIdentityId} AND revoked_at IS NULL`;
      const previous =
        yield* sql`SELECT session_id FROM agent_approval_peer_bindings WHERE session_id = ${input.sessionId}`;
      if (
        session === undefined ||
        session.method !== "bearer-access-token" ||
        !CredentialAttribution.isMcpClientSubject(session.subject) ||
        credential?.credential_kind !== "peer" ||
        link.length !== 1 ||
        previous.length !== 0
      )
        return yield* new Delegations.ApprovalDelegationError({ reason: "link_not_approved" });
      const now = yield* Clock.currentTimeMillis;
      const snapshot = yield* bindingSnapshot(
        input.sessionId,
        input.approvals,
        input.interactionModeCeiling,
      );
      if (snapshot === undefined)
        return yield* new Delegations.ApprovalDelegationError({ reason: "authority_changed" });
      const old =
        input.renew === undefined
          ? undefined
          : (yield* sql<{
              session_id: string;
              revision: number;
              effective_revision: number;
              binding_snapshot: string;
              security_snapshot: string | null;
              approval_enabled: number;
              interaction_mode_ceiling: ProviderInteractionMode;
            }>`SELECT * FROM agent_approval_peer_bindings WHERE session_id = ${input.renew.sessionId}
        AND link_identity_id = ${input.linkIdentityId} AND revision = ${input.renew.revision} AND revoked_at IS NULL`)[0];
      if (
        input.renew !== undefined &&
        (old === undefined || (yield* active(input.renew.sessionId)) === undefined)
      )
        return yield* new Delegations.ApprovalDelegationError({ reason: "authority_changed" });
      if (
        input.renew === undefined &&
        (yield* sql`SELECT session_id FROM agent_approval_peer_bindings WHERE link_identity_id = ${input.linkIdentityId} AND revoked_at IS NULL`)
          .length !== 0
      )
        return yield* new Delegations.ApprovalDelegationError({ reason: "authority_changed" });
      const oldSnapshot =
        old === undefined
          ? undefined
          : yield* bindingSnapshot(
              old.session_id,
              old.approval_enabled === 1,
              old.interaction_mode_ceiling,
            );
      const preserved =
        old !== undefined && old.binding_snapshot === oldSnapshot && oldSnapshot === snapshot;
      const epoch = (yield* sql<{
        credential_epoch: number;
      }>`UPDATE agent_approval_destination_links SET credential_epoch = credential_epoch + 1,
        revision = revision + ${old !== undefined && !preserved ? 1 : 0} WHERE link_identity_id = ${input.linkIdentityId} RETURNING credential_epoch`)[0]!
        .credential_epoch;
      yield* sql`INSERT INTO agent_approval_peer_bindings(session_id, link_identity_id, effective_revision, binding_snapshot, security_snapshot, approval_enabled, interaction_mode_ceiling, created_by, created_at)
        VALUES (${input.sessionId}, ${input.linkIdentityId}, ${epoch}, ${snapshot}, ${preserved ? (old?.security_snapshot ?? null) : null}, ${input.approvals ? 1 : 0}, ${input.interactionModeCeiling}, ${actor}, ${now})`;
      if (old !== undefined) {
        const oldMode = (yield* sql<{
          runtime_mode_ceiling: string;
        }>`SELECT runtime_mode_ceiling FROM agent_approval_authorizations WHERE session_id = ${old.session_id}`)[0]!;
        const nextMode = (yield* sql<{
          runtime_mode_ceiling: string;
        }>`SELECT runtime_mode_ceiling FROM agent_approval_authorizations WHERE session_id = ${input.sessionId}`)[0]!;
        yield* sql`INSERT INTO agent_approval_peer_renewals(previous_session_id, next_session_id, link_identity_id, previous_binding_revision, previous_revision, next_revision, authority_preserved, change_reason, security_snapshot, created_by, created_at)
          VALUES (${old.session_id}, ${input.sessionId}, ${input.linkIdentityId}, ${old.revision}, ${old.effective_revision}, ${epoch}, ${preserved ? 1 : 0},
          ${old.interaction_mode_ceiling !== input.interactionModeCeiling || oldMode.runtime_mode_ceiling !== nextMode.runtime_mode_ceiling ? "mode_ceiling" : "authority_changed"}, ${old.security_snapshot}, ${actor}, ${now})`;
        yield* sql`UPDATE agent_approval_peer_bindings SET revoked_at = ${now}, revocation_reason = 'renewal', revision = revision + 1 WHERE session_id = ${old.session_id}`;
        yield* sessions.revoke(AuthSessionId.make(old.session_id));
      }
    },
    (effect) => transaction(effect),
  );
  const revoke = Effect.fn("ApprovalPeerAccess.revoke")(
    function* (ownerSessionId: string, sessionId: string) {
      yield* requireOwner(ownerSessionId);
      const now = yield* Clock.currentTimeMillis;
      const changed = yield* sql<{
        link_identity_id: string;
      }>`UPDATE agent_approval_peer_bindings SET revoked_at = ${now}, revocation_reason = 'explicit', revision = revision + 1 WHERE session_id = ${sessionId} AND revocation_reason IS NOT 'explicit' RETURNING link_identity_id`;
      for (const row of changed) {
        const epoch = (yield* sql<{
          credential_epoch: number;
        }>`UPDATE agent_approval_destination_links SET credential_epoch = credential_epoch + 1 WHERE link_identity_id = ${row.link_identity_id} RETURNING credential_epoch`)[0]!
          .credential_epoch;
        yield* sql`UPDATE agent_approval_peer_bindings SET effective_revision = ${epoch}, mode_changed_from_revision = NULL WHERE session_id = ${sessionId}`;
      }
    },
    (effect) => transaction(effect),
  );
  const setPolicy = Effect.fn("ApprovalPeerAccess.setPolicy")(
    function* (
      ownerSessionId: string,
      linkIdentityId: string,
      enabled: boolean,
      expectedRevision: number,
    ) {
      const actor = yield* requireOwner(ownerSessionId);
      if (
        (yield* sql`SELECT link_identity_id FROM agent_approval_destination_links WHERE link_identity_id = ${linkIdentityId} AND revoked_at IS NULL`)
          .length !== 1
      )
        return yield* new Delegations.ApprovalDelegationError({ reason: "link_not_approved" });
      const old = (yield* sql<{
        revision: number;
      }>`SELECT revision FROM agent_approval_link_policies WHERE link_identity_id = ${linkIdentityId}`)[0];
      if ((old?.revision ?? 0) !== expectedRevision)
        return yield* new Delegations.ApprovalDelegationError({ reason: "authority_changed" });
      const revision = expectedRevision + 1;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO agent_approval_link_policies VALUES (${linkIdentityId}, ${enabled ? 1 : 0}, ${revision}, ${actor}, ${now})
      ON CONFLICT(link_identity_id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision, updated_by = excluded.updated_by, updated_at = excluded.updated_at`;
      return { enabled, revision };
    },
    (effect) => transaction(effect),
  );
  return ApprovalPeerAccess.of({
    classification,
    owner,
    rawPeer,
    policy,
    fleetIdentity,
    continueClientIdentity,
    permits,
    bind,
    revoke,
    setPolicy,
  });
});
export const layer = Layer.effect(ApprovalPeerAccess, make);

export const layerDestination = Layer.effect(
  Delegations.ApprovalDestinationAccess,
  Effect.gen(function* () {
    const access = yield* ApprovalPeerAccess;
    const sessions = yield* SessionStore.SessionStore;
    const gate = yield* Gate.ApprovalAdmissionGate;
    const cap = yield* CredentialAttribution.CredentialAccessCap;
    const sql = yield* SqlClient.SqlClient;
    const peer = Effect.fn("ApprovalDestinationAccess.peer")(
      function* (sessionId: string) {
        const peer = yield* access.rawPeer(sessionId);
        if (peer === undefined) return undefined;
        const session = (yield* sessions.listActive()).find((s) => s.sessionId === sessionId);
        if (session === undefined) return undefined;
        const capped = yield* cap.scopes({
          sessionId,
          peerLink: true,
          subject: session.subject,
          scopes: peer.scopes,
        });
        const scopes = capped ?? [];
        const allowed = yield* access.permits(sessionId);
        const effective = {
          ...peer,
          scopes: allowed ? scopes : scopes.filter((s) => s !== AuthOrchestrationApproveScope),
          access: scopes.includes(AuthOrchestrationOperateScope)
            ? peer.access
            : ("read-only" as const),
        };
        const snapshot = encodeSnapshot([
          effective.expiresAt,
          effective.scopes.toSorted(),
          effective.access,
          effective.runtimeModeCeiling,
          effective.interactionModeCeiling,
        ]);
        const previous = (yield* sql<{
          effective_revision: number;
          mode_changed_from_revision: number | null;
          authorization_snapshot: string | null;
          security_snapshot: string | null;
          revision: number;
          enabled: number;
        }>`SELECT b.effective_revision, b.mode_changed_from_revision, b.authorization_snapshot, b.security_snapshot, a.revision, a.enabled
            FROM agent_approval_peer_bindings b JOIN agent_approval_authorizations a ON a.session_id = b.session_id WHERE b.session_id = ${sessionId}`)[0];
        if (previous === undefined) return undefined;
        const security = encodeSecuritySnapshot([
          effective.scopes.toSorted(),
          effective.access,
          effective.runtimeModeCeiling,
          effective.interactionModeCeiling,
          previous.revision,
          previous.enabled,
        ]);
        const securityChanged =
          previous.security_snapshot !== null && previous.security_snapshot !== security;
        let revision = previous.effective_revision;
        let modeChangedFrom = previous.mode_changed_from_revision;
        if (
          securityChanged ||
          (previous.authorization_snapshot !== null && previous.authorization_snapshot !== snapshot)
        ) {
          const prior =
            previous.security_snapshot === null
              ? undefined
              : yield* decodeSecuritySnapshot(previous.security_snapshot);
          const modeOnly =
            prior !== undefined &&
            prior[0].toSorted().join("\n") === effective.scopes.toSorted().join("\n") &&
            prior[4] === previous.revision &&
            prior[5] === previous.enabled &&
            prior[1] !== "read-only" &&
            effective.access !== "read-only" &&
            (prior[2] !== effective.runtimeModeCeiling ||
              prior[3] !== effective.interactionModeCeiling);
          modeChangedFrom = modeOnly ? previous.effective_revision : null;
          revision = (yield* sql<{
            credential_epoch: number;
          }>`UPDATE agent_approval_destination_links
              SET credential_epoch = credential_epoch + 1, revision = revision + ${securityChanged ? 1 : 0}
              WHERE link_identity_id = ${effective.linkIdentityId} RETURNING credential_epoch`)[0]!
            .credential_epoch;
        }
        yield* sql`UPDATE agent_approval_peer_bindings SET effective_revision = ${revision}, mode_changed_from_revision = ${modeChangedFrom}, authorization_snapshot = ${snapshot}, security_snapshot = ${security} WHERE session_id = ${sessionId}`;
        return !scopes.includes(AuthOrchestrationReadScope)
          ? undefined
          : { ...effective, credentialRevision: revision };
      },
      (effect) => gate.withGate(effect).pipe(Effect.mapError(storageError)),
    );
    const currentBinding = Effect.fn("ApprovalDestinationAccess.currentBinding")(
      function* (linkIdentityId: string, preparedSessionId: string, originalRevision?: number) {
        let sessionId = preparedSessionId;
        let expectedRevision = originalRevision;
        let preparedRevision: number | undefined;
        const visited = new Set<string>();
        while (!visited.has(sessionId)) {
          visited.add(sessionId);
          const row = (yield* sql<{
            revision: number;
            effective_revision: number;
            mode_changed_from_revision: number | null;
            revoked_at: number | null;
            revocation_reason: string | null;
            security_snapshot: string | null;
            authorization_revision: number;
            enabled: number;
            runtime_mode_ceiling: string;
            interaction_mode_ceiling: string;
            approval_enabled: number;
            credential_kind: string;
          }>`SELECT b.*, a.revision AS authorization_revision, a.enabled, a.runtime_mode_ceiling, a.credential_kind FROM agent_approval_peer_bindings b JOIN agent_approval_authorizations a ON a.session_id = b.session_id WHERE b.session_id = ${sessionId} AND b.link_identity_id = ${linkIdentityId}`)[0];
          if (row === undefined) return undefined;
          preparedRevision ??= row.effective_revision;
          if (row.revoked_at === null) {
            const live = yield* peer(sessionId);
            if (live === undefined || live.linkIdentityId !== linkIdentityId) return undefined;
            const requiredRevision = expectedRevision ?? row.effective_revision;
            if (live.credentialRevision !== requiredRevision) {
              const changed = (yield* sql<{
                mode_changed_from_revision: number | null;
              }>`SELECT mode_changed_from_revision FROM agent_approval_peer_bindings WHERE session_id = ${sessionId}`)[0];
              if (changed?.mode_changed_from_revision === requiredRevision)
                return yield* new Delegations.ApprovalDelegationError({ reason: "mode_ceiling" });
              return undefined;
            }
            return { sessionId, preparedRevision, peer: live };
          }
          if (expectedRevision !== undefined && row.effective_revision !== expectedRevision)
            return undefined;
          const edge = (yield* sql<{
            next_session_id: string;
            previous_binding_revision: number;
            previous_revision: number;
            next_revision: number;
            authority_preserved: number;
            security_snapshot: string | null;
            change_reason: "authority_changed" | "mode_ceiling";
          }>`SELECT * FROM agent_approval_peer_renewals WHERE previous_session_id = ${sessionId} AND link_identity_id = ${linkIdentityId}`)[0];
          if (
            row.revocation_reason !== "renewal" ||
            edge === undefined ||
            row.revision !== edge.previous_binding_revision + 1 ||
            row.effective_revision !== edge.previous_revision ||
            row.security_snapshot === null ||
            row.security_snapshot !== edge.security_snapshot
          )
            return undefined;
          if (edge.authority_preserved !== 1)
            return yield* new Delegations.ApprovalDelegationError({ reason: edge.change_reason });
          const security = yield* decodeSecuritySnapshot(row.security_snapshot);
          if (
            row.credential_kind !== "peer" ||
            row.authorization_revision !== security[4] ||
            row.enabled !== security[5] ||
            row.runtime_mode_ceiling !== security[2] ||
            row.interaction_mode_ceiling !== security[3] ||
            row.approval_enabled !== 1
          )
            return undefined;
          sessionId = edge.next_session_id;
          expectedRevision = edge.next_revision;
        }
        return undefined;
      },
      (effect) => gate.withGate(effect).pipe(Effect.mapError(storageError)),
    );
    return Delegations.ApprovalDestinationAccess.of({
      withGate: gate.withGate,
      owner: access.owner,
      policy: access.policy,
      peer,
      currentBinding,
    });
  }),
);
