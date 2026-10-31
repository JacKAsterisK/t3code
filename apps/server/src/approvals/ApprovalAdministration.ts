import {
  ApprovalAdministrationError,
  ApprovalAdministrationMutation,
  type ApprovalAdministrationSnapshot,
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as FleetPolicy from "../lan/FleetApprovalPolicy.ts";
import * as FleetContext from "../lan/FleetContext.ts";
import * as FleetVault from "../lan/FleetVault.ts";
import * as Delegations from "./ApprovalDelegations.ts";

export class ApprovalAdministration extends Context.Service<
  ApprovalAdministration,
  {
    readonly inspect: (
      ownerSessionId: string,
    ) => Effect.Effect<ApprovalAdministrationSnapshot, ApprovalAdministrationError>;
    readonly mutate: (
      ownerSessionId: string,
      input: unknown,
    ) => Effect.Effect<{ readonly distributed: boolean | null }, ApprovalAdministrationError>;
  }
>()("t3/approvals/ApprovalAdministration") {}

const decodeMutation = Schema.decodeUnknownEffect(ApprovalAdministrationMutation);
const isAdministrationError = Schema.is(ApprovalAdministrationError);
const isDelegationError = Schema.is(Delegations.ApprovalDelegationError);
const mapError = (cause: unknown): ApprovalAdministrationError => {
  if (isAdministrationError(cause)) return cause;
  if (isDelegationError(cause)) {
    switch (cause.reason) {
      case "not_destination_owner":
      case "authority_changed":
      case "link_not_approved":
        return new ApprovalAdministrationError({ reason: cause.reason });
      case "invalid_provenance":
      case "thread_not_delegated":
        return new ApprovalAdministrationError({ reason: "invalid_target" });
    }
  }
  return new ApprovalAdministrationError({ reason: "unavailable" });
};
const requiredPeerScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationApproveScope,
];
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const peers = yield* PeerAccess.ApprovalPeerAccess;
  const delegations = yield* Delegations.ApprovalDelegations;
  const fleetPolicy = yield* FleetPolicy.FleetApprovalPolicy;
  const fleetContext = yield* FleetContext.FleetContext;
  const fleetVault = yield* FleetVault.FleetVault;
  const sessions = yield* Sessions.SessionStore;
  const cap = yield* CredentialAttribution.CredentialAccessCap;
  const gate = yield* Gate.ApprovalAdmissionGate;
  const requireOwner = Effect.fn("ApprovalAdministration.requireOwner")(function* (
    sessionId: string,
  ) {
    if ((yield* peers.owner(sessionId)) === undefined)
      return yield* new ApprovalAdministrationError({ reason: "not_destination_owner" });
  });
  const inspect = Effect.fn("ApprovalAdministration.inspect")(function* (ownerSessionId: string) {
    yield* requireOwner(ownerSessionId);
    const refreshed = yield* fleetPolicy.refresh.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const loaded = yield* fleetContext.load.pipe(Effect.orElseSucceed(() => undefined));
    const identity = yield* fleetVault.read.pipe(Effect.orElseSucceed(() => undefined));
    const context =
      loaded !== undefined &&
      identity !== undefined &&
      identity.machineId === loaded.self.machineId &&
      identity.environmentId === loaded.self.environmentId &&
      identity.signingPrivateKey === loaded.config.signingPrivateKey
        ? loaded
        : undefined;
    return yield* gate.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* requireOwner(ownerSessionId);
          const active = yield* sessions.listActive();
          const authorizations = yield* sql<{
            session_id: string;
            credential_kind: "local" | "peer";
            initiating_client_id: string;
            revision: number;
            enabled: number;
            runtime_mode_ceiling: ApprovalAdministrationSnapshot["clients"][number]["runtimeModeCeiling"];
          }>`SELECT session_id, credential_kind, initiating_client_id, revision, enabled, runtime_mode_ceiling
        FROM agent_approval_authorizations WHERE credential_kind IN ('local', 'peer') AND replaced_by_session_id IS NULL`;
          const clients: Array<ApprovalAdministrationSnapshot["clients"][number]> = [];
          for (const row of authorizations) {
            const session = active.find((s) => s.sessionId === row.session_id);
            if (session === undefined) continue;
            const scopes = session.permissions ?? session.scopes;
            const effectiveScopes = yield* cap.scopes({
              subject: session.subject,
              sessionId: session.sessionId,
              scopes,
              peerLink: row.credential_kind === "peer",
            });
            clients.push({
              sessionId: session.sessionId,
              label: session.client.label ?? "Agent sign-in",
              kind: row.credential_kind,
              initiatingClientId: row.initiating_client_id,
              revision: row.revision,
              enabled: row.enabled === 1,
              runtimeModeCeiling: row.runtime_mode_ceiling,
              scopes,
              effectiveScopes: (effectiveScopes ?? []).filter(
                (scope) => scope !== AuthOrchestrationApproveScope || row.enabled === 1,
              ),
              expiresAt: session.expiresAt.epochMilliseconds,
            });
          }
          const rows = yield* sql<{
            link_identity_id: string;
            source_environment_id: string;
            revision: number;
            revoked_at: number | null;
            replaced_by_link_identity_id: string | null;
            enabled: number | null;
            policy_revision: number | null;
            caller_machine_id: string | null;
            destination_machine_id: string | null;
            valid: number | null;
            fleet_enabled: number | null;
          }>`SELECT l.link_identity_id, l.source_environment_id, l.revision, l.revoked_at, l.replaced_by_link_identity_id,
        p.enabled, p.revision AS policy_revision, f.caller_machine_id, f.destination_machine_id, h.valid, g.enabled AS fleet_enabled
        FROM agent_approval_destination_links l LEFT JOIN agent_approval_link_policies p ON p.link_identity_id = l.link_identity_id
        LEFT JOIN agent_approval_fleet_links f ON f.link_identity_id = l.link_identity_id
        LEFT JOIN agent_approval_fleet_policy_heads h ON h.fleet_id = f.fleet_id AND h.destination_machine_id = f.destination_machine_id
        LEFT JOIN agent_approval_fleet_policy_grants g ON g.fleet_id = f.fleet_id AND g.destination_machine_id = f.destination_machine_id AND g.caller_machine_id = f.caller_machine_id
        ORDER BY l.created_at DESC`;
          const links: ApprovalAdministrationSnapshot["links"] = rows.map((r) => ({
            linkIdentityId: r.link_identity_id,
            sourceEnvironmentId: r.source_environment_id,
            revision: r.revision,
            revoked: r.revoked_at !== null,
            replacedByLinkIdentityId: r.replaced_by_link_identity_id,
            policyEnabled: r.enabled === 1,
            policyRevision: r.policy_revision ?? 0,
            effectiveEnabled:
              r.revoked_at === null &&
              r.enabled === 1 &&
              (r.caller_machine_id === null ||
                (refreshed && r.valid === 1 && r.fleet_enabled === 1)),
            fleet:
              r.caller_machine_id === null
                ? null
                : {
                    callerMachineId: r.caller_machine_id,
                    destinationMachineId: r.destination_machine_id!,
                    valid: refreshed && r.valid === 1,
                    enabled: r.fleet_enabled === 1,
                  },
          }));
          const bindingRows = yield* sql<{
            session_id: string;
            link_identity_id: string;
            revision: number;
            effective_revision: number;
            approval_enabled: number;
            interaction_mode_ceiling: "plan" | "default";
            revoked_at: number | null;
          }>`SELECT session_id, link_identity_id, revision, effective_revision, approval_enabled, interaction_mode_ceiling, revoked_at FROM agent_approval_peer_bindings ORDER BY created_at DESC`;
          const bindings: ApprovalAdministrationSnapshot["bindings"] = bindingRows.map((r) => {
            const client = clients.find((c) => c.sessionId === r.session_id);
            return {
              sessionId: AuthSessionId.make(r.session_id),
              linkIdentityId: r.link_identity_id,
              revision: r.revision,
              effectiveRevision: r.effective_revision,
              approvals: r.approval_enabled === 1,
              interactionModeCeiling: r.interaction_mode_ceiling,
              active: client !== undefined,
              revoked: r.revoked_at !== null,
              effectiveEnabled:
                r.revoked_at === null &&
                r.approval_enabled === 1 &&
                client?.enabled === true &&
                requiredPeerScopes.every((scope) => client.effectiveScopes.includes(scope)) &&
                links.some((l) => l.linkIdentityId === r.link_identity_id && l.effectiveEnabled),
            };
          });
          const threads = yield* sql<{
            thread_id: string;
            title: string;
          }>`SELECT thread_id, title FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200`;
          const delegationRows =
            yield* sql<Delegations.ApprovalDelegation>`SELECT delegation_id, thread_id, link_identity_id, initiating_client_id, policy_revision, created_by, created_at, revoked_at FROM agent_approval_delegations ORDER BY created_at DESC`;
          const sourceClients = yield* sql<{
            link_identity_id: string;
            initiating_client_id: string;
          }>`SELECT link_identity_id, initiating_client_id FROM agent_thread_approval_origins
        UNION SELECT link_identity_id, initiating_client_id FROM agent_approval_delegations
        UNION SELECT json_extract(actor_json, '$.forwardedBy.linkIdentityId') AS link_identity_id,
          json_extract(actor_json, '$.forwardedBy.initiatingClientId') AS initiating_client_id
        FROM agent_approval_receipts WHERE role = 'receiver'
          AND json_type(actor_json, '$.forwardedBy.linkIdentityId') = 'text'
          AND json_type(actor_json, '$.forwardedBy.initiatingClientId') = 'text'
          AND json_extract(actor_json, '$.forwardedBy.asserted') = 1`;
          const heads =
            context === undefined
              ? []
              : yield* sql<{
                  revision: number;
                  valid: number;
                }>`SELECT revision, valid FROM agent_approval_fleet_policy_heads WHERE fleet_id = ${identity!.fleetId} AND destination_machine_id = ${context.self.machineId}`;
          const grants =
            context === undefined
              ? []
              : yield* sql<{
                  caller_machine_id: string;
                  enabled: number;
                }>`SELECT caller_machine_id, enabled FROM agent_approval_fleet_policy_grants WHERE destination_machine_id = ${context.self.machineId}`;
          return {
            links,
            bindings,
            clients,
            sourceClients: sourceClients.map((r) => ({
              linkIdentityId: r.link_identity_id,
              initiatingClientId: r.initiating_client_id,
            })),
            threads: threads.map((r) => ({ threadId: ThreadId.make(r.thread_id), title: r.title })),
            delegations: delegationRows.map((r) => ({
              delegationId: r.delegation_id,
              threadId: ThreadId.make(r.thread_id),
              linkIdentityId: r.link_identity_id,
              initiatingClientId: r.initiating_client_id,
              policyRevision: r.policy_revision,
              createdAt: r.created_at,
              revoked: r.revoked_at !== null,
              effectiveEnabled:
                r.revoked_at === null &&
                links.some(
                  (l) =>
                    l.linkIdentityId === r.link_identity_id &&
                    l.effectiveEnabled &&
                    l.policyRevision === r.policy_revision,
                ),
            })),
            fleet: {
              available: context !== undefined && refreshed,
              valid: refreshed && heads[0]?.valid === 1,
              revision: heads[0]?.revision ?? 0,
              destinationMachineId: context?.self.machineId ?? null,
              peers:
                context?.peers.map((p) => ({
                  callerMachineId: p.peer.machineId,
                  environmentId: p.peer.environmentId,
                  enabled: grants.some(
                    (g) => g.caller_machine_id === p.peer.machineId && g.enabled === 1,
                  ),
                })) ?? [],
            },
          } satisfies ApprovalAdministrationSnapshot;
        }),
      ),
    );
  }, Effect.mapError(mapError));
  const mutate = Effect.fn("ApprovalAdministration.mutate")(function* (
    ownerSessionId: string,
    raw: unknown,
  ) {
    yield* requireOwner(ownerSessionId);
    const input = yield* decodeMutation(raw, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new ApprovalAdministrationError({ reason: "invalid_target" })),
    );
    if ((input.type === "setLinkPolicy" && input.enabled) || input.type === "grantDelegation")
      yield* fleetPolicy.refresh;
    if (input.type === "publishFleetPolicy") {
      const result = yield* fleetPolicy.publish(
        ownerSessionId,
        input.expectedRevision,
        input.grants,
      );
      return { distributed: result.distributed };
    }
    if (input.type === "bindFleetLink") {
      yield* fleetPolicy.bindLink(ownerSessionId, input.linkIdentityId, input.callerMachineId);
      return { distributed: null };
    }
    yield* gate.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* requireOwner(ownerSessionId);
          switch (input.type) {
            case "createLink":
              yield* delegations.createLink(ownerSessionId, input.sourceEnvironmentId);
              break;
            case "replaceLink":
            case "revokeLink": {
              const rows =
                yield* sql`SELECT link_identity_id FROM agent_approval_destination_links WHERE link_identity_id = ${input.linkIdentityId} AND revision = ${input.expectedRevision} AND revoked_at IS NULL`;
              if (rows.length !== 1)
                return yield* new ApprovalAdministrationError({ reason: "authority_changed" });
              if (input.type === "replaceLink")
                yield* delegations.replaceLink(ownerSessionId, input.linkIdentityId);
              else yield* delegations.revokeLink(ownerSessionId, input.linkIdentityId);
              break;
            }
            case "bindPeer": {
              const session = (yield* sessions.listActive()).find(
                (s) => s.sessionId === input.sessionId,
              );
              if (
                session === undefined ||
                (input.approvals &&
                  !requiredPeerScopes.every((s) =>
                    (session.permissions ?? session.scopes).includes(s),
                  ))
              )
                return yield* new ApprovalAdministrationError({ reason: "link_not_approved" });
              yield* peers.bind(ownerSessionId, {
                sessionId: input.sessionId,
                linkIdentityId: input.linkIdentityId,
                approvals: input.approvals,
                interactionModeCeiling: input.interactionModeCeiling,
                ...(input.renew === undefined ? {} : { renew: input.renew }),
              });
              break;
            }
            case "revokePeer": {
              const rows =
                yield* sql`SELECT session_id FROM agent_approval_peer_bindings WHERE session_id = ${input.sessionId} AND revision = ${input.expectedRevision} AND revoked_at IS NULL`;
              if (rows.length !== 1)
                return yield* new ApprovalAdministrationError({ reason: "authority_changed" });
              yield* peers.revoke(ownerSessionId, input.sessionId);
              break;
            }
            case "setLinkPolicy": {
              if (input.enabled) {
                const invalid =
                  yield* sql`SELECT f.link_identity_id FROM agent_approval_fleet_links f LEFT JOIN agent_approval_fleet_policy_heads h ON h.fleet_id = f.fleet_id AND h.destination_machine_id = f.destination_machine_id LEFT JOIN agent_approval_fleet_policy_grants g ON g.fleet_id = f.fleet_id AND g.destination_machine_id = f.destination_machine_id AND g.caller_machine_id = f.caller_machine_id WHERE f.link_identity_id = ${input.linkIdentityId} AND (COALESCE(h.valid, 0) != 1 OR COALESCE(g.enabled, 0) != 1)`;
                if (invalid.length !== 0)
                  return yield* new ApprovalAdministrationError({ reason: "link_not_approved" });
              }
              yield* peers.setPolicy(
                ownerSessionId,
                input.linkIdentityId,
                input.enabled,
                input.expectedRevision,
              );
              break;
            }
            case "grantDelegation": {
              const policy = yield* peers.policy(input.linkIdentityId);
              if (policy?.revision !== input.expectedPolicyRevision)
                return yield* new ApprovalAdministrationError({ reason: "authority_changed" });
              yield* delegations.grant(ownerSessionId, input);
              break;
            }
            case "revokeDelegation":
              yield* delegations.revoke(ownerSessionId, input.delegationId);
              break;
            case "continueClient":
              yield* peers.continueClientIdentity(
                ownerSessionId,
                input.sessionId,
                input.previousSessionId,
                input.expectedRevision,
              );
              break;
          }
        }),
      ),
    );
    return { distributed: null };
  }, Effect.mapError(mapError));
  return ApprovalAdministration.of({ inspect, mutate });
});
export const layer = Layer.effect(ApprovalAdministration, make);
