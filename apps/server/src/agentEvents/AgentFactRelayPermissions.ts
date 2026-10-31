// @effect-diagnostics nodeBuiltinImport:off -- Authorization generations hash server-owned metadata, never credentials.
import * as NodeCrypto from "node:crypto";
import { AuthMcpClientAccess, ThreadId, type AgentFactRelayRefusal } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Cap from "../auth/CredentialAttribution.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Destination from "../approvals/ApprovalDelegations.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Fleet from "../lan/FleetAccessPolicy.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { recoverLegacyFleetPointers } from "../peer/PeerLinkProvenance.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Outside from "./AgentEventAuthority.ts";
import * as Ports from "./AgentFactRelayAccess.ts";

const unavailable = { verdict: "unavailable" } as const;
const refuse = (reason: AgentFactRelayRefusal) => ({ verdict: "refused", reason }) as const;
const generation = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
const isAccess = Schema.is(AuthMcpClientAccess);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* recoverLegacyFleetPointers();
  const { withGate } = yield* Gate.ApprovalAdmissionGate;
  const destination = yield* Destination.ApprovalDestinationAccess;
  const sessions = yield* Sessions.SessionStore;
  const cap = yield* Cap.CredentialAccessCap;
  const outside = yield* Outside.AgentEventAuthority;
  const settings = yield* Settings.ServerSettingsService;
  const fleet = yield* Fleet.FleetAccess;
  const projection = yield* Projection.ProjectionStoreV2;
  const here = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const outsideDecision = (verdict: Outside.AuthorityVerdict) =>
    verdict._tag === "Unavailable"
      ? unavailable
      : verdict._tag === "Allowed"
        ? undefined
        : refuse(
            verdict.reason === "read_scope_lost" || verdict.reason === "session_inactive"
              ? verdict.reason
              : "outside_sharing_refused",
          );
  const incoming: Ports.AgentFactRelayAccess["Service"]["incoming"] = Effect.fn(
    "AgentFactRelayPermissions.incoming",
  )(
    function* (scope: Invocation.McpInvocationScope) {
      const current = yield* (
        settings.getAdmissionSettings ?? Effect.die("Missing settings admission view")
      );
      if (!current.linkedEnvironmentsEnabled || !current.agentEventsEnabled)
        return refuse("links_disabled");
      if (
        scope.environmentId !== here ||
        scope.thread !== undefined ||
        scope.client?.linked !== true ||
        scope.client.taskOnly === true ||
        scope.client.grantId !== undefined
      )
        return refuse("session_inactive");
      const peer = yield* destination.peer(scope.client.sessionId);
      if (peer === undefined) return refuse("session_inactive");
      if (!peer.scopes.includes("orchestration:read")) return refuse("read_scope_lost");
      const decision = outsideDecision(yield* outside.check({ sessionId: scope.client.sessionId }));
      if (decision !== undefined) return decision;
      return {
        verdict: "allowed",
        authorization: {
          peerEnvironmentId: peer.sourceEnvironmentId,
          generation: generation({
            here,
            settingsGeneration: current.generation,
            fleet: yield* fleet.current,
            sessionId: scope.client.sessionId,
            link: peer.linkIdentityId,
            revision: peer.credentialRevision,
            expiresAt: peer.expiresAt,
            scopes: peer.scopes.toSorted(),
            runtimeMode: peer.runtimeModeCeiling,
            interactionMode: peer.interactionModeCeiling,
          }),
          limits: Invocation.clientModeCeiling({ ...scope.client, access: peer.access }),
        },
      } as const;
    },
    (effect) => withGate(effect).pipe(Effect.catchCause(() => Effect.succeed(unavailable))),
  );
  const outgoing: Ports.AgentFactRelayAccess["Service"]["outgoing"] = Effect.fn(
    "AgentFactRelayPermissions.outgoing",
  )(
    function* (environmentId: string) {
      const current = yield* (
        settings.getAdmissionSettings ?? Effect.die("Missing settings admission view")
      );
      if (!current.linkedEnvironmentsEnabled || !current.agentEventsEnabled)
        return refuse("links_disabled");
      const row = (yield* sql<{
        secret_name: string;
        access: string;
        linked_at: string;
        expires_at: string;
        urls_json: string;
        fenced: number;
        provenance: string;
        fleet_machine_id: string | null;
      }>`SELECT secret_name, access, linked_at, expires_at, urls_json, fenced, provenance, fleet_machine_id FROM peer_environment_links WHERE environment_id = ${environmentId}`)[0];
      if (row === undefined) return refuse("source_changed");
      const expiry = Option.getOrUndefined(DateTime.make(row.expires_at))?.epochMilliseconds;
      if (
        row.fenced !== 1 ||
        expiry === undefined ||
        expiry <= (yield* Clock.currentTimeMillis) ||
        !isAccess(row.access)
      )
        return refuse("credential_changed");
      const state = yield* fleet.current;
      if (row.provenance === "unknown") return unavailable;
      if (row.provenance !== "manual" && row.provenance !== "fleet") return unavailable;
      if (row.provenance === "fleet") {
        if (!current.fleetLinkedEnvironmentsEnabled) return refuse("links_disabled");
        if (state.unavailable === true) return unavailable;
        if (state.member === false) return refuse("source_changed");
        if (state.approvalTrust === undefined || state.member !== true || state.revision === 0)
          return unavailable;
        if (
          !state.approvalTrust.peers.some(
            (peer) =>
              peer.machineId === row.fleet_machine_id && peer.environmentId === environmentId,
          )
        )
          return refuse("source_changed");
      }
      return {
        verdict: "allowed",
        authorization: {
          peerEnvironmentId: environmentId,
          generation: generation({
            environmentId,
            link: row,
            settingsGeneration: current.generation,
            fleet:
              row.provenance === "manual"
                ? null
                : {
                    machineId: state.machineId,
                    revision: state.revision,
                    member: state.member ?? null,
                    unavailable: state.unavailable ?? null,
                    peers: state.peers,
                    approvalTrust: state.approvalTrust ?? null,
                    machines: state.machines,
                    defaultAccess: state.defaultAccess,
                    pairs: state.pairs ?? [],
                  },
          }),
          limits: Invocation.clientModeCeiling({
            sessionId: "outgoing-link",
            label: "",
            access: row.access,
          }),
        },
      } as const;
    },
    (effect) => withGate(effect).pipe(Effect.catchCause(() => Effect.succeed(unavailable))),
  );
  // A failed cap lookup (including typed CredentialAccessUnavailable) is uncertainty, never scope loss.
  const requester: Ports.AgentFactRelayAccess["Service"]["requester"] = Effect.fn(
    "AgentFactRelayPermissions.requester",
  )(
    function* (input) {
      const verdict = yield* outside.check(input);
      const decision = outsideDecision(verdict);
      if (decision !== undefined) return decision;
      const session = (yield* sessions.listActive()).find(
        (s) => s.sessionId === input.sessionId && s.subject === input.attributionSubject,
      );
      if (
        session === undefined ||
        session.expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis)
      )
        return refuse("session_inactive");
      const scopes = yield* cap.scopes({
        sessionId: input.sessionId,
        subject: session.subject,
        scopes: session.permissions ?? session.scopes,
      });
      if (scopes === undefined || !scopes.includes("orchestration:read"))
        return refuse("read_scope_lost");
      const link = yield* outgoing(input.environmentId);
      if (link.verdict !== "allowed") return link;
      const authorization = (yield* sql<{
        runtime_mode_ceiling: string;
        revision: number;
        credential_kind: string;
      }>`SELECT runtime_mode_ceiling, revision, credential_kind
        FROM agent_approval_authorizations WHERE session_id = ${input.sessionId}`)[0];
      const access =
        authorization !== undefined && isAccess(authorization.runtime_mode_ceiling)
          ? authorization.runtime_mode_ceiling
          : "read-only";
      return {
        verdict: "allowed",
        authorization: {
          peerEnvironmentId: input.environmentId,
          generation: generation({
            sessionId: input.sessionId,
            subject: session.subject,
            expiresAt: session.expiresAt.epochMilliseconds,
            scopes: scopes.toSorted(),
            authorization: authorization ?? null,
            outgoing: link.authorization.generation,
            fleet: yield* fleet.current,
          }),
          limits: Invocation.clientModeCeiling({ sessionId: input.sessionId, label: "", access }),
        },
      } as const;
    },
    (effect) => withGate(effect).pipe(Effect.catchCause(() => Effect.succeed(unavailable))),
  );
  const originFact: Ports.AgentFactRelayAccess["Service"]["originFact"] = Effect.fn(
    "AgentFactRelayPermissions.originFact",
  )(
    function* (input) {
      // The relay authenticated incoming once in this same shared gate and SQL transaction.
      // Only per-fact source/thread visibility changes within the page; never retain this proof across calls.
      const source = (yield* sql<{
        generation: string;
      }>`SELECT generation FROM agent_event_source_state WHERE id = 1`)[0];
      if (source === undefined) return unavailable;
      if (
        source.generation !== input.data.origin.sourceGeneration ||
        input.data.origin.environmentId !== here
      )
        return refuse("source_changed");
      if (input.data.thread === null) return { verdict: "allowed" } as const;
      const id = input.data.thread.id;
      if (typeof id !== "string") return refuse("thread_unreadable");
      const records = yield* projection.getThreadRecords(ThreadId.make(id), []);
      return records.thread.deletedAt === null
        ? ({ verdict: "allowed" } as const)
        : refuse("thread_unreadable");
    },
    (effect) =>
      withGate(effect).pipe(
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed(refuse("thread_unreadable")),
        }),
        Effect.catchCause(() => Effect.succeed(unavailable)),
      ),
  );
  return Ports.AgentFactRelayAccess.of({ withGate, incoming, outgoing, requester, originFact });
});
export const layer = Layer.effect(Ports.AgentFactRelayAccess, make);
