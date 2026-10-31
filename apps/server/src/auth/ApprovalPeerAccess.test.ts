import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessWriteScope,
  AuthOrchestrationApproveScope,
  AuthStandardClientScopes,
  EnvironmentId,
  ThreadId,
  ApprovalGuard,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Destination from "../approvals/ApprovalDestinationGuard.ts";
import * as Settings from "../serverSettings.ts";
import * as Delegations from "../approvals/ApprovalDelegations.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as FleetAccessPolicy from "../lan/FleetAccessPolicy.ts";
import * as ApprovalSigning from "../lan/FleetApprovalPolicySigning.ts";
import { syntheticFleetPeer } from "../lan/FleetDelivery.fixtures.ts";
import * as FleetCredentialAccess from "../lan/FleetCredentialAccess.ts";
import * as Authority from "./ApprovalAuthority.ts";
import * as Gate from "./ApprovalAdmissionGate.ts";
import * as PeerAccess from "./ApprovalPeerAccess.ts";
import * as CredentialAttribution from "./CredentialAttribution.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const encodeGuard = Schema.encodeEffect(Schema.fromJsonString(ApprovalGuard));
const decodeGuard = Schema.decodeEffect(Schema.fromJsonString(ApprovalGuard));

const destinationIdentity = syntheticFleetPeer("destination");
class TestPolicyState extends Context.Service<
  TestPolicyState,
  Ref.Ref<FleetAccessPolicy.FleetAccessState>
>()("t3/auth/ApprovalPeerAccess.test/TestPolicyState") {}
const policyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<FleetAccessPolicy.FleetAccessState>({
      revision: 1,
      defaultAccess: "standard",
      machines: [],
      machineId: "destination",
      approvalTrust: {
        fleetId: "fleet",
        peers: [
          {
            machineId: "destination",
            environmentId: "destination",
            signingPublicKey: destinationIdentity.peer.signingPublicKey,
          },
        ],
      },
      peers: [{ machineId: "source", environmentId: "source" }],
    });
    return Layer.merge(
      Layer.succeed(TestPolicyState, state),
      Layer.mock(FleetAccessPolicy.FleetAccess)({ current: Ref.get(state) }),
    );
  }),
);
class TestLookupFault extends Context.Service<
  TestLookupFault,
  Ref.Ref<"classification" | "permits" | "fleetIdentity" | undefined>
>()("t3/auth/ApprovalPeerAccess.test/TestLookupFault") {}
const raw = Layer.unwrap(
  Effect.gen(function* () {
    const original = yield* Layer.build(
      PeerAccess.layer.pipe(Layer.provideMerge(SessionStore.layer), Layer.provideMerge(Gate.layer)),
    );
    const actual = Context.get(original, PeerAccess.ApprovalPeerAccess);
    const fault = yield* Ref.make<"classification" | "permits" | "fleetIdentity" | undefined>(
      undefined,
    );
    const unavailable = () =>
      new Delegations.ApprovalDelegationError({ reason: "storage_unavailable" });
    const wrapped = PeerAccess.ApprovalPeerAccess.of({
      ...actual,
      classification: (sessionId) =>
        Ref.get(fault).pipe(
          Effect.flatMap((value) =>
            value === "classification"
              ? Effect.fail(unavailable())
              : actual.classification(sessionId),
          ),
        ),
      permits: (sessionId) =>
        Ref.get(fault).pipe(
          Effect.flatMap((value) =>
            value === "permits" ? Effect.fail(unavailable()) : actual.permits(sessionId),
          ),
        ),
      fleetIdentity: (sessionId) =>
        Ref.get(fault).pipe(
          Effect.flatMap((value) =>
            value === "fleetIdentity"
              ? Effect.fail(unavailable())
              : actual.fleetIdentity(sessionId),
          ),
        ),
    });
    return Layer.merge(
      Layer.succeedContext(Context.add(original, PeerAccess.ApprovalPeerAccess, wrapped)),
      Layer.succeed(TestLookupFault, fault),
    );
  }),
);
const fleet = FleetCredentialAccess.layerServices.pipe(
  Layer.provideMerge(raw),
  Layer.provideMerge(policyLayer),
);
const capLayer = FleetCredentialAccess.layerCapServices.pipe(Layer.provideMerge(fleet));
const destination = PeerAccess.layerDestination.pipe(Layer.provideMerge(capLayer));
const services = Layer.mergeAll(
  EnvironmentAuth.layer,
  Destination.layer.pipe(Layer.provideMerge(Delegations.layer)),
).pipe(
  Layer.provideMerge(destination),
  Layer.provideMerge(Settings.layerTest({ linkedEnvironmentsEnabled: true })),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-approval-peer-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const peers = yield* PeerAccess.ApprovalPeerAccess;
  const access = yield* Delegations.ApprovalDestinationAccess;
  const delegations = yield* Delegations.ApprovalDelegations;
  const authority = yield* Authority.ApprovalAuthority;
  const sessions = yield* SessionStore.SessionStore;
  const cap = yield* CredentialAttribution.CredentialAccessCap;
  const sql = yield* SqlClient.SqlClient;
  const owner = yield* auth.issueSession({
    scopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
  });
  const issue = (approvals = true) =>
    auth.issueMcpClientSession({
      label: "same app and owner",
      applicationId: "same-app",
      access: "full-access",
      peerLink: true,
      approvals,
      client: { deviceType: "bot" },
    });
  const peer = yield* issue();
  const link = yield* delegations.createLink(owner.sessionId, "source");
  const bind = (sessionId: string) =>
    peers.bind(owner.sessionId, {
      sessionId,
      linkIdentityId: link,
      approvals: true,
      interactionModeCeiling: "default",
    });
  const effective = (token = peer.token) =>
    sessions.verify(token).pipe(Effect.flatMap((s) => cap.scopes(s)));
  const authenticate = (sessionId = peer.sessionId) =>
    delegations.authenticate("opaque-source-client").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("destination"),
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
        requestNamespace: sessionId,
        thread: undefined,
        linkedEnvironments: true,
        client: { sessionId, label: "same app and owner", access: "full-access", linked: true },
      }),
    );
  const thread = Effect.gen(function* () {
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread', 'project', 'test', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
    yield* delegations.grant(owner.sessionId, {
      threadId: "thread",
      linkIdentityId: link,
      initiatingClientId: "opaque-source-client",
    });
    return yield* authenticate();
  });
  return {
    auth,
    peers,
    access,
    delegations,
    authority,
    sessions,
    cap,
    sql,
    owner,
    issue,
    peer,
    link,
    bind,
    effective,
    authenticate,
    thread,
  };
});

it.effect(
  "persists actual issuance classification and requires owner binding, credential opt-in and separate policy",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      assert.equal(
        (yield* f.sql<{
          credential_kind: string;
        }>`SELECT credential_kind FROM agent_approval_authorizations WHERE session_id = ${f.peer.sessionId}`)[0]!
          .credential_kind,
        "peer",
      );
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), false);
      assert.equal(yield* f.access.peer(f.peer.sessionId), undefined);
      yield* f.authority.check(f.peer.sessionId).pipe(Effect.flip);
      yield* f.bind(f.peer.sessionId);
      assert.equal((yield* f.access.peer(f.peer.sessionId))!.linkIdentityId, f.link);
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), false);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), true);
      const handle = yield* f.thread;
      const prepared = yield* f.delegations.check(handle, "thread");
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, false, 1);
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), false);
      assert.isDefined(yield* f.access.peer(f.peer.sessionId));
      yield* f.authenticate();
      yield* f.delegations.check(handle, "thread", prepared).pipe(Effect.flip);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 2);
      yield* f.authority.remove(f.peer.sessionId, false);
      assert.isDefined(yield* f.access.peer(f.peer.sessionId));
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), false);
      yield* f.auth.revokeSession(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, false, 3);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 4);
      assert.equal(yield* f.access.peer(f.peer.sessionId), undefined);
      assert.equal(yield* f.sessions.verify(f.peer.token).pipe(Effect.isFailure), true);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "legacy peers and unapproved new credentials cannot inherit approval from labels, policy or continuity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const legacy = yield* f.sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        peerLink: true,
        scopes: [...AuthStandardClientScopes, AuthOrchestrationApproveScope],
      });
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      assert.equal(
        (yield* f.effective(legacy.token))?.includes(AuthOrchestrationApproveScope),
        false,
      );
      yield* f.bind(legacy.sessionId).pipe(Effect.flip);
      const unclassified = yield* f.sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        scopes: [...AuthStandardClientScopes, AuthOrchestrationApproveScope],
      });
      assert.equal(
        (yield* f.effective(unclassified.token))?.includes(AuthOrchestrationApproveScope),
        false,
      );
      const noConsent = yield* f.issue(false);
      yield* f.bind(noConsent.sessionId);
      assert.equal(
        (yield* f.effective(noConsent.token))?.includes(AuthOrchestrationApproveScope),
        false,
      );
      for (const subject of [
        "mcp-client",
        "mcp-client:local",
        "lan-fleet:destination--source",
        "lan-fleet-by:lan-fleet:destination--source",
      ]) {
        const impostor = yield* f.auth.issueSession({
          subject,
          scopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
        });
        assert.equal(yield* f.access.owner(impostor.sessionId), undefined);
        yield* f.peers.setPolicy(impostor.sessionId, f.link, true, 1).pipe(Effect.flip);
      }
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "owner-approved renewal preserves link identity while replacement and explicit removal never inherit grants",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.bind(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      const next = yield* f.issue();
      yield* f.bind(next.sessionId).pipe(Effect.flip);
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: next.sessionId,
        linkIdentityId: f.link,
        approvals: true,
        interactionModeCeiling: "default",
        renew: { sessionId: f.peer.sessionId, revision: 1 },
      });
      assert.equal(yield* f.access.peer(f.peer.sessionId), undefined);
      assert.equal((yield* f.access.peer(next.sessionId))!.linkIdentityId, f.link);
      assert.equal((yield* f.effective(next.token))?.includes(AuthOrchestrationApproveScope), true);
      yield* f.bind(f.peer.sessionId).pipe(Effect.flip);
      const replacement = yield* f.delegations.replaceLink(f.owner.sessionId, f.link);
      assert.equal(yield* f.access.peer(next.sessionId), undefined);
      assert.equal(yield* f.access.policy(replacement), undefined);
      const fresh = yield* f.issue();
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: fresh.sessionId,
        linkIdentityId: replacement,
        approvals: true,
        interactionModeCeiling: "default",
      });
      assert.equal(
        (yield* f.effective(fresh.token))?.includes(AuthOrchestrationApproveScope),
        false,
      );
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "session removal wins paused native admission through the same shared reentrant gate",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const gate = yield* Gate.ApprovalAdmissionGate;
      yield* f.bind(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      const handle = yield* f.thread;
      const expected = yield* f.delegations.check(handle, "thread");
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const removal = yield* gate
        .withGate(
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            yield* f.auth.revokeSession(f.peer.sessionId);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      let admitted = false;
      const admission = yield* Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* f.delegations.withAdmission(handle, "thread", expected, () =>
          Effect.sync(() => {
            admitted = true;
          }),
        );
      }).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(removal);
      assert.equal((yield* Fiber.join(admission))._tag, "Failure");
      assert.equal(admitted, false);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "live credential revisions include scope/mode changes and bound identity survives read-only recovery but not expiry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.bind(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      const first = (yield* f.access.peer(f.peer.sessionId))!;
      yield* f.sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'approval-required' WHERE session_id = ${f.peer.sessionId}`;
      const narrowed = (yield* f.access.peer(f.peer.sessionId))!;
      assert.equal(narrowed.runtimeModeCeiling, "approval-required");
      assert.isAbove(narrowed.credentialRevision, first.credentialRevision);
      yield* f.sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${f.peer.sessionId}`;
      const read = (yield* f.access.peer(f.peer.sessionId))!;
      assert.equal(read.access, "read-only");
      assert.isAbove(read.credentialRevision, narrowed.credentialRevision);
      yield* f.authenticate();
      yield* f.sql`UPDATE auth_sessions SET expires_at = '1970-01-01T00:00:00.000Z' WHERE session_id = ${f.peer.sessionId}`;
      assert.equal(yield* f.access.peer(f.peer.sessionId), undefined);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "only explicit owner continuity carries a local opaque client ID forward without adding approval permission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const local = () =>
        f.auth.issueMcpClientSession({
          label: "same app and owner",
          applicationId: "same-app",
          access: "full-access",
          peerLink: false,
          approvals: false,
          client: { deviceType: "bot" },
        });
      const old = yield* local();
      const next = yield* local();
      const before = yield* f.authority.identity(old.sessionId);
      const fresh = yield* f.authority.identity(next.sessionId);
      assert.notEqual(before.initiating_client_id, fresh.initiating_client_id);
      const original = (yield* f.sql<{
        application_id: string | null;
        consent_family_id: string | null;
        runtime_mode_ceiling: string;
      }>`SELECT application_id, consent_family_id, runtime_mode_ceiling FROM agent_approval_authorizations WHERE session_id = ${next.sessionId}`)[0]!;
      const originalScopes = (yield* f.sql<{
        scopes: string;
      }>`SELECT scopes FROM auth_sessions WHERE session_id = ${next.sessionId}`)[0]!.scopes;
      for (const mismatch of ["application", "family", "scope", "mode"] as const) {
        if (mismatch === "application")
          yield* f.sql`UPDATE agent_approval_authorizations SET application_id = 'different-app' WHERE session_id = ${next.sessionId}`;
        else if (mismatch === "family")
          yield* f.sql`UPDATE agent_approval_authorizations SET consent_family_id = 'different-family' WHERE session_id = ${next.sessionId}`;
        else if (mismatch === "scope")
          yield* f.sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${next.sessionId}`;
        else
          yield* f.sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'approval-required' WHERE session_id = ${next.sessionId}`;
        const refused = yield* f.peers
          .continueClientIdentity(f.owner.sessionId, next.sessionId, old.sessionId, before.revision)
          .pipe(Effect.flip);
        assert.equal(refused.reason, "authority_changed", mismatch);
        const unchanged = (yield* f.sql<{
          initiating_client_id: string;
          revision: number;
        }>`SELECT initiating_client_id, revision FROM agent_approval_authorizations WHERE session_id = ${next.sessionId}`)[0]!;
        assert.equal(unchanged.initiating_client_id, fresh.initiating_client_id, mismatch);
        assert.equal(unchanged.revision, fresh.revision, mismatch);
        assert.equal(yield* f.sessions.verify(old.token).pipe(Effect.isSuccess), true);
        yield* f.sql`UPDATE agent_approval_authorizations SET application_id = ${original.application_id}, consent_family_id = ${original.consent_family_id}, runtime_mode_ceiling = ${original.runtime_mode_ceiling} WHERE session_id = ${next.sessionId}`;
        yield* f.sql`UPDATE auth_sessions SET scopes = ${originalScopes} WHERE session_id = ${next.sessionId}`;
      }
      yield* f.peers
        .continueClientIdentity(f.peer.sessionId, next.sessionId, old.sessionId, before.revision)
        .pipe(Effect.flip);
      yield* f.peers.continueClientIdentity(
        f.owner.sessionId,
        next.sessionId,
        old.sessionId,
        before.revision,
      );
      assert.equal(
        (yield* f.authority.identity(next.sessionId)).initiating_client_id,
        before.initiating_client_id,
      );
      yield* f.authority.check(next.sessionId).pipe(Effect.flip);
      yield* f.authority.identity(old.sessionId).pipe(Effect.flip);
      yield* f.peers
        .continueClientIdentity(f.owner.sessionId, next.sessionId, old.sessionId, before.revision)
        .pipe(Effect.flip);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "fleet approval caps recheck current trust even with a retained full-access token and signed-policy grant",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fleet = yield* FleetCredentialAccess.FleetCredentialAccess;
      yield* f.bind(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      yield* f.sql`INSERT INTO agent_approval_fleet_links VALUES (${f.link}, 'fleet', 'destination', 'source')`;
      const signed = ApprovalSigning.sign(
        {
          version: 1,
          fleetId: "fleet",
          destinationMachineId: "destination",
          revision: 1,
          previousDigest: null,
          createdAt: 1,
          grants: [{ callerMachineId: "source", enabled: true }],
        },
        destinationIdentity.signingPrivateKey,
      );
      yield* f.sql`INSERT INTO agent_approval_fleet_policy_heads VALUES ('fleet', 'destination', 1, 'digest', ${JSON.stringify(signed)}, 1)`;
      yield* f.sql`INSERT INTO agent_approval_fleet_policy_grants VALUES ('fleet', 'destination', 'source', 1)`;
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), true);
      const state = yield* TestPolicyState;
      const gate = yield* Gate.ApprovalAdmissionGate;
      const before = yield* Ref.get(state);
      yield* gate.withGate(
        Ref.set(state, {
          ...before,
          approvalTrust: {
            fleetId: "fleet",
            peers: [
              {
                machineId: "destination",
                environmentId: "destination",
                signingPublicKey: syntheticFleetPeer("destination").peer.signingPublicKey,
              },
            ],
          },
        }),
      );
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), false);
      assert.isDefined(yield* f.access.peer(f.peer.sessionId));
      yield* gate.withGate(Ref.set(state, before));
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), true);
      const externalSet = new Set(["source"]);
      yield* fleet.setTrusted(externalSet);
      externalSet.clear();
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), true);
      yield* fleet.setTrusted(new Set());
      assert.equal((yield* f.effective())?.includes(AuthOrchestrationApproveScope), false);
      assert.isDefined(yield* f.access.peer(f.peer.sessionId));
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "fleet-attributed local OAuth clients retain rightful consent and read status after family removal and read-only downgrade",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = yield* TestPolicyState;
      const gate = yield* Gate.ApprovalAdmissionGate;
      const issue = (approvals: boolean) =>
        f.auth.issueMcpClientSession({
          label: "same app and owner",
          applicationId: "fleet-local-app",
          approvalSubject: "lan-fleet-peer-link:source:owner-consent",
          access: "full-access",
          peerLink: false,
          approvals,
          client: { deviceType: "bot" },
        });
      const first = yield* issue(true);
      const approved = yield* f.authority.check(first.sessionId);
      assert.equal(approved.credential_kind, "local");
      assert.equal(approved.scopes.includes(AuthOrchestrationApproveScope), true);
      const noApproval = yield* issue(false);
      yield* f.authority.check(first.sessionId).pipe(Effect.flip);
      yield* f.authority.check(noApproval.sessionId).pipe(Effect.flip);
      assert.equal(
        (yield* f.authority.identity(first.sessionId)).initiating_client_id,
        approved.initiating_client_id,
      );
      const fresh = yield* issue(true);
      yield* f.authority.check(fresh.sessionId);
      const current = yield* Ref.get(state);
      yield* gate.withGate(
        Ref.set(state, { ...current, machines: [{ machineId: "source", access: "read-only" }] }),
      );
      const read = yield* f.authority.identity(first.sessionId, "read");
      assert.equal(read.initiating_client_id, approved.initiating_client_id);
      assert.equal(read.scopes.includes(AuthOrchestrationApproveScope), false);
      yield* f.authority.identity(first.sessionId).pipe(Effect.flip);
      yield* f.authority.check(fresh.sessionId).pipe(Effect.flip);
      yield* f.authority.identity(f.peer.sessionId, "read").pipe(Effect.flip);
      yield* f.auth.revokeSession(first.sessionId);
      yield* f.authority.identity(first.sessionId, "read").pipe(Effect.flip);
    }).pipe(Effect.provide(services), Effect.scoped),
);

const storedGuard = (
  sessionId: string,
  authority: Delegations.ApprovalDestinationAuthority,
): ApprovalGuard => ({
  receiptId: "receiver",
  principalId: "link-client",
  sessionId,
  environmentId: EnvironmentId.make("destination"),
  authorityRevision: authority.credentialRevision,
  expected: {
    requestIncarnation: "incarnation",
    providerSessionId: "native",
    providerGeneration: "generation",
    presentationRevision: 1,
    presentationDigest: "digest",
  },
  grantDigest: "grant",
  consent: {
    effectiveScope: "turn",
    grantDigest: "grant",
    onBehalfOf: "Dan",
    authorization: "Permit this turn.",
  },
  actor: { kind: "mcp_client", principalId: "link-client", label: "asserted" },
  runtimeModeCeiling: "full-access",
  interactionModeCeiling: "default",
  destination: {
    authority,
    forwarderReceiptId: "forwarder",
    forwardingKey: "same-key",
    operationDigest: "same-operation",
  },
});

it.effect(
  "R1 stored guards survive equivalent renewal before commit and delivery admission with increasing link epochs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const guardService = yield* Destination.ApprovalDestinationGuard;
      yield* f.bind(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      const handle = yield* f.thread;
      const prepared = yield* f.delegations.check(handle, "thread");
      const guard = storedGuard(f.peer.sessionId, prepared);
      const serialized = yield* encodeGuard(guard);
      let priorSession = f.peer.sessionId;
      let priorRevision = prepared.credentialRevision;
      for (const boundary of ["commit", "delivery admission"]) {
        yield* TestClock.adjust(Duration.minutes(1));
        const next = yield* f.issue();
        yield* f.peers.bind(f.owner.sessionId, {
          sessionId: next.sessionId,
          linkIdentityId: f.link,
          approvals: true,
          interactionModeCeiling: "default",
          renew: { sessionId: priorSession, revision: 1 },
        });
        const current = yield* f.delegations.check(yield* f.authenticate(next.sessionId), "thread");
        assert.isAbove(current.credentialRevision, priorRevision, boundary);
        assert.deepEqual({ ...current, credentialRevision: prepared.credentialRevision }, prepared);
        assert.equal(
          (yield* guardService.check(guard, ThreadId.make("thread"))).revision,
          current.credentialRevision,
        );
        assert.equal(yield* f.access.peer(priorSession), undefined);
        yield* f.authority.check(priorSession).pipe(Effect.flip);
        priorSession = next.sessionId;
        priorRevision = current.credentialRevision;
      }
      const restarted = yield* Layer.build(
        Destination.layer.pipe(
          Layer.provideMerge(Delegations.layer),
          Layer.provideMerge(PeerAccess.layerDestination),
          Layer.provideMerge(PeerAccess.layer),
          Layer.fresh,
        ),
      );
      assert.equal(
        (yield* Context.get(restarted, Destination.ApprovalDestinationGuard).check(
          yield* decodeGuard(serialized),
          ThreadId.make("thread"),
        )).revision,
        priorRevision,
      );
    }).pipe(Effect.provide(services), Effect.scoped),
);

const preparedDestination = Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.bind(f.peer.sessionId);
  yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
  const handle = yield* f.thread;
  const prepared = yield* f.delegations.check(handle, "thread");
  const guard = storedGuard(f.peer.sessionId, prepared);
  const service = yield* Destination.ApprovalDestinationGuard;
  return { ...f, handle, prepared, guard, check: service.check(guard, ThreadId.make("thread")) };
});

it.effect.each(["approval opt-in", "access", "runtime mode", "interaction mode"] as const)(
  "stored guard refuses a renewal changing %s",
  (change) =>
    Effect.gen(function* () {
      const f = yield* preparedDestination;
      const next = yield* f.auth.issueMcpClientSession({
        label: "same app and owner",
        applicationId: "same-app",
        peerLink: true,
        access:
          change === "access"
            ? "read-only"
            : change === "runtime mode"
              ? "approval-required"
              : "full-access",
        approvals: change !== "approval opt-in",
        client: { deviceType: "bot" },
      });
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: next.sessionId,
        linkIdentityId: f.link,
        approvals: change !== "approval opt-in",
        interactionModeCeiling: change === "interaction mode" ? "plan" : "default",
        renew: { sessionId: f.peer.sessionId, revision: 1 },
      });
      const failure = yield* f.check.pipe(Effect.flip);
      assert.equal(
        failure.reason,
        change.endsWith("mode") || change === "access" ? "mode_changed" : "authority_revoked",
      );
      assert.equal(yield* f.access.peer(f.peer.sessionId), undefined);
      assert.equal(yield* f.sessions.verify(f.peer.token).pipe(Effect.isFailure), true);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect.each(["policy", "delegation", "credential scope", "credential approval"] as const)(
  "restoring %s never revives a prepared guard through renewal",
  (change) =>
    Effect.gen(function* () {
      const f = yield* preparedDestination;
      if (change === "policy") {
        yield* f.peers.setPolicy(f.owner.sessionId, f.link, false, 1);
        yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 2);
      } else if (change === "delegation") {
        yield* f.delegations.revoke(f.owner.sessionId, f.prepared.delegationId!);
        yield* f.delegations.grant(f.owner.sessionId, {
          threadId: "thread",
          linkIdentityId: f.link,
          initiatingClientId: "opaque-source-client",
        });
      } else if (change === "credential scope") {
        const scopes = (yield* f.sql<{
          scopes: string;
        }>`SELECT scopes FROM auth_sessions WHERE session_id = ${f.peer.sessionId}`)[0]!.scopes;
        yield* f.sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${f.peer.sessionId}`;
        yield* f.access.peer(f.peer.sessionId);
        yield* f.sql`UPDATE auth_sessions SET scopes = ${scopes} WHERE session_id = ${f.peer.sessionId}`;
      } else {
        yield* f.authority.remove(f.peer.sessionId, false);
        yield* f.sql`UPDATE agent_approval_authorizations SET enabled = 1 WHERE session_id = ${f.peer.sessionId}`;
      }
      const next = yield* f.issue();
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: next.sessionId,
        linkIdentityId: f.link,
        approvals: true,
        interactionModeCeiling: "default",
        renew: { sessionId: f.peer.sessionId, revision: 1 },
      });
      yield* f.check.pipe(Effect.flip);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect.each([
  "unproved binding",
  "link replacement",
  "link restoration",
  "retired binding removal",
] as const)("stored guard never follows %s", (change) =>
  Effect.gen(function* () {
    const f = yield* preparedDestination;
    const next = yield* f.issue();
    if (change === "retired binding removal") {
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: next.sessionId,
        linkIdentityId: f.link,
        approvals: true,
        interactionModeCeiling: "default",
        renew: { sessionId: f.peer.sessionId, revision: 1 },
      });
      yield* f.check;
      yield* f.peers.revoke(f.owner.sessionId, f.peer.sessionId);
    } else {
      let link = f.link;
      if (change === "unproved binding") yield* f.peers.revoke(f.owner.sessionId, f.peer.sessionId);
      else if (change === "link replacement")
        link = yield* f.delegations.replaceLink(f.owner.sessionId, f.link);
      else {
        yield* f.delegations.revokeLink(f.owner.sessionId, f.link);
        yield* f.sql`UPDATE agent_approval_destination_links SET revoked_at = NULL WHERE link_identity_id = ${f.link}`;
        yield* f.peers.revoke(f.owner.sessionId, f.peer.sessionId);
      }
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: next.sessionId,
        linkIdentityId: link,
        approvals: true,
        interactionModeCeiling: "default",
      });
    }
    yield* f.check.pipe(Effect.flip);
  }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "renewal wins queued native guard admission under the shared gate without weakening public authentication",
  () =>
    Effect.gen(function* () {
      const f = yield* preparedDestination;
      const gate = yield* Gate.ApprovalAdmissionGate;
      const next = yield* f.issue();
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const renewal = yield* gate
        .withGate(
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            yield* f.peers.bind(f.owner.sessionId, {
              sessionId: next.sessionId,
              linkIdentityId: f.link,
              approvals: true,
              interactionModeCeiling: "default",
              renew: { sessionId: f.peer.sessionId, revision: 1 },
            });
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const admission = yield* Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* f.check;
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(renewal);
      assert.isAbove((yield* Fiber.join(admission)).revision, f.prepared.credentialRevision);
      yield* f.authenticate().pipe(Effect.flip);
      yield* f.delegations.check(f.handle, "thread", f.prepared).pipe(Effect.flip);
      yield* f.auth.revokeSession(next.sessionId);
      yield* f.check.pipe(Effect.flip);
    }).pipe(Effect.provide(services), Effect.scoped),
);

const sourceOperation = Effect.gen(function* () {
  const f = yield* fixture;
  const issueLocal = () =>
    f.auth.issueMcpClientSession({
      label: "same app and owner",
      applicationId: "local-app",
      peerLink: false,
      approvals: true,
      access: "full-access",
      client: { deviceType: "bot" },
    });
  const first = yield* issueLocal();
  const authorization = yield* f.authority.check(first.sessionId);
  const input = {
    sessionId: first.sessionId,
    authorityRevision: authorization.revision,
    initiatingClientId: authorization.initiating_client_id,
  };
  return { ...f, first, authorization, input, issueLocal };
});

it.effect(
  "source operation authority follows only explicit unchanged owner continuations and recovers its lineage",
  () =>
    Effect.gen(function* () {
      const f = yield* sourceOperation;
      assert.equal((yield* f.authority.currentForOperation(f.input)).sessionId, f.first.sessionId);
      const next = yield* f.issueLocal();
      assert.notEqual(
        (yield* f.authority.check(next.sessionId)).initiating_client_id,
        f.input.initiatingClientId,
      );
      yield* f.authority
        .currentForOperation({ ...f.input, sessionId: next.sessionId })
        .pipe(Effect.flip);
      yield* f.peers.continueClientIdentity(
        f.owner.sessionId,
        next.sessionId,
        f.first.sessionId,
        f.input.authorityRevision,
      );
      const continued = yield* f.authority.currentForOperation(f.input);
      assert.equal(continued.sessionId, next.sessionId);
      assert.equal(continued.authorization.runtimeModeCeiling, "full-access");
      assert.equal(continued.authorization.scopes.includes(AuthOrchestrationApproveScope), true);
      const third = yield* f.issueLocal();
      yield* f.peers.continueClientIdentity(
        f.owner.sessionId,
        third.sessionId,
        next.sessionId,
        continued.authorityRevision,
      );
      const restarted = yield* Layer.build(Layer.fresh(Authority.layer));
      assert.equal(
        (yield* Context.get(restarted, Authority.ApprovalAuthority).currentForOperation(f.input))
          .sessionId,
        third.sessionId,
      );
      yield* f.authority.check(f.first.sessionId).pipe(Effect.flip);
      yield* f.authority.check(next.sessionId).pipe(Effect.flip);
      assert.equal(yield* f.sessions.verify(f.first.token).pipe(Effect.isFailure), true);
      assert.equal(yield* f.sessions.verify(next.token).pipe(Effect.isFailure), true);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect.each(["before transfer", "retired session", "current session", "family"] as const)(
  "source removal at %s cannot revive an existing operation",
  (change) =>
    Effect.gen(function* () {
      const f = yield* sourceOperation;
      const next = yield* f.issueLocal();
      if (change === "before transfer") {
        yield* f.authority.remove(f.first.sessionId, false);
        yield* f.peers
          .continueClientIdentity(
            f.owner.sessionId,
            next.sessionId,
            f.first.sessionId,
            f.input.authorityRevision,
          )
          .pipe(Effect.flip);
        const removed = yield* f.authority.identity(f.first.sessionId);
        yield* f.peers
          .continueClientIdentity(
            f.owner.sessionId,
            next.sessionId,
            f.first.sessionId,
            removed.revision,
          )
          .pipe(Effect.flip);
      } else {
        yield* f.peers.continueClientIdentity(
          f.owner.sessionId,
          next.sessionId,
          f.first.sessionId,
          f.input.authorityRevision,
        );
        yield* f.authority.currentForOperation(f.input);
        yield* f.authority.remove(
          change === "retired session" ? f.first.sessionId : next.sessionId,
          change === "family",
        );
      }
      yield* f.authority.currentForOperation(f.input).pipe(Effect.flip);
      yield* f.sql`UPDATE agent_approval_authorizations SET enabled = 1 WHERE session_id = ${next.sessionId}`;
      yield* f.authority.currentForOperation(f.input).pipe(Effect.flip);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect.each(["scope", "mode", "revoked session"] as const)(
  "source %s changes cannot be hidden by explicit continuity or ABA",
  (change) =>
    Effect.gen(function* () {
      const f = yield* sourceOperation;
      const next = yield* f.issueLocal();
      if (change === "revoked session") {
        yield* f.auth.revokeSession(f.first.sessionId);
        yield* f.peers
          .continueClientIdentity(
            f.owner.sessionId,
            next.sessionId,
            f.first.sessionId,
            f.input.authorityRevision,
          )
          .pipe(Effect.flip);
      } else {
        const scopes = (yield* f.sql<{
          scopes: string;
        }>`SELECT scopes FROM auth_sessions WHERE session_id = ${f.first.sessionId}`)[0]!.scopes;
        if (change === "scope")
          yield* f.sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${f.first.sessionId}`;
        else
          yield* f.sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'approval-required' WHERE session_id = ${f.first.sessionId}`;
        const changed = yield* f.authority.identity(f.first.sessionId, "read");
        yield* f.authority.currentForOperation(f.input).pipe(Effect.flip);
        yield* f.sql`UPDATE auth_sessions SET scopes = ${scopes} WHERE session_id = ${f.first.sessionId}`;
        yield* f.sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'full-access' WHERE session_id = ${f.first.sessionId}`;
        yield* f.peers
          .continueClientIdentity(
            f.owner.sessionId,
            next.sessionId,
            f.first.sessionId,
            changed.revision,
          )
          .pipe(Effect.flip);
      }
      yield* f.authority.currentForOperation(f.input).pipe(Effect.flip);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "removing a retired peer authorization breaks its operation lineage even after restoration",
  () =>
    Effect.gen(function* () {
      const f = yield* preparedDestination;
      const next = yield* f.issue();
      yield* f.peers.bind(f.owner.sessionId, {
        sessionId: next.sessionId,
        linkIdentityId: f.link,
        approvals: true,
        interactionModeCeiling: "default",
        renew: { sessionId: f.peer.sessionId, revision: 1 },
      });
      yield* f.check;
      yield* f.authority.remove(f.peer.sessionId, false);
      yield* f.check.pipe(Effect.flip);
      yield* f.sql`UPDATE agent_approval_authorizations SET enabled = 1 WHERE session_id = ${f.peer.sessionId}`;
      yield* f.check.pipe(Effect.flip);
      assert.equal(
        (yield* f.access.peer(next.sessionId))?.scopes.includes(AuthOrchestrationApproveScope),
        true,
      );
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect.each([false, true])(
  "pure mode-ceiling changes remain typed after a public peer precheck (%s)",
  (prechecked) =>
    Effect.gen(function* () {
      const f = yield* preparedDestination;
      yield* f.sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'approval-required' WHERE session_id = ${f.peer.sessionId}`;
      if (prechecked) yield* f.access.peer(f.peer.sessionId);
      assert.equal((yield* f.check.pipe(Effect.flip)).reason, "mode_changed");
      yield* f.sql`UPDATE agent_approval_authorizations SET runtime_mode_ceiling = 'full-access' WHERE session_id = ${f.peer.sessionId}`;
      yield* f.access.peer(f.peer.sessionId);
      assert.equal((yield* f.check.pipe(Effect.flip)).reason, "authority_revoked");
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect("a fully removed credential cap cannot regain prepared authority after restoration", () =>
  Effect.gen(function* () {
    const f = yield* preparedDestination;
    const allowed = yield* Ref.make(true);
    const cap = CredentialAttribution.CredentialAccessCap.of({
      scopes: (credential) =>
        Ref.get(allowed).pipe(Effect.map((enabled) => (enabled ? credential.scopes : undefined))),
      administersFleet: f.cap.administersFleet,
    });
    const rebuilt = yield* Layer.build(
      Destination.layer.pipe(
        Layer.provideMerge(Delegations.layer),
        Layer.provideMerge(
          PeerAccess.layerDestination.pipe(
            Layer.provide(Layer.succeed(CredentialAttribution.CredentialAccessCap, cap)),
          ),
        ),
        Layer.fresh,
      ),
    );
    const access = Context.get(rebuilt, Delegations.ApprovalDestinationAccess);
    const guard = Context.get(rebuilt, Destination.ApprovalDestinationGuard);
    yield* Ref.set(allowed, false);
    assert.equal(yield* access.peer(f.peer.sessionId), undefined);
    yield* Ref.set(allowed, true);
    yield* guard.check(f.guard, ThreadId.make("thread")).pipe(Effect.flip);
  }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "preserves local operation authority across a transient credential-cap lookup fault",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const local = yield* f.auth.issueMcpClientSession({
        label: "cap recovery",
        applicationId: "cap-recovery",
        access: "full-access",
        peerLink: false,
        approvals: true,
        client: { deviceType: "bot" },
      });
      const baseline = yield* f.authority.check(local.sessionId);
      const rows = f.sql`SELECT * FROM agent_approval_authorizations WHERE session_id = ${local.sessionId}`;
      const before = yield* rows;
      const fault = yield* TestLookupFault;
      yield* Ref.set(fault, "classification");
      assert.equal(
        (yield* f.authority.check(local.sessionId, baseline.revision).pipe(Effect.flip)).reason,
        "storage_unavailable",
      );
      assert.deepEqual(yield* rows, before);
      yield* Ref.set(fault, undefined);
      const recovered = yield* f.authority.currentForOperation({
        sessionId: local.sessionId,
        authorityRevision: baseline.revision,
        initiatingClientId: baseline.initiating_client_id,
      });
      assert.equal(recovered.authorityRevision, baseline.revision);
      assert.deepEqual(yield* rows, before);
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect(
  "preserves destination binding epochs across transient credential-cap lookup faults",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.bind(f.peer.sessionId);
      yield* f.peers.setPolicy(f.owner.sessionId, f.link, true, 0);
      const handle = yield* f.thread;
      const evidence = yield* f.delegations.check(handle, "thread");
      const baseline = yield* f.access.peer(f.peer.sessionId);
      const bindings = f.sql`SELECT * FROM agent_approval_peer_bindings WHERE session_id = ${f.peer.sessionId}`;
      const links = f.sql`SELECT * FROM agent_approval_destination_links WHERE link_identity_id = ${f.link}`;
      const beforeBindings = yield* bindings;
      const beforeLinks = yield* links;
      const fault = yield* TestLookupFault;
      for (const method of ["classification", "permits", "fleetIdentity"] as const) {
        yield* Ref.set(fault, method);
        assert.equal(
          (yield* f.access.peer(f.peer.sessionId).pipe(Effect.flip)).reason,
          "storage_unavailable",
          method,
        );
        assert.deepEqual(yield* bindings, beforeBindings, method);
        assert.deepEqual(yield* links, beforeLinks, method);
        yield* Ref.set(fault, undefined);
        assert.equal(
          (yield* f.access.peer(f.peer.sessionId))?.credentialRevision,
          baseline?.credentialRevision,
          method,
        );
        yield* f.delegations.check(handle, "thread", evidence);
      }
    }).pipe(Effect.provide(services), Effect.scoped),
);
