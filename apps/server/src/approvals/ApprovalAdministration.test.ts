import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationApproveScope,
  AuthStandardClientScopes,
  EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as PeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as FleetAccess from "../lan/FleetAccessPolicy.ts";
import * as FleetCredentials from "../lan/FleetCredentialAccess.ts";
import * as FleetContext from "../lan/FleetContext.ts";
import * as FleetVault from "../lan/FleetVault.ts";
import * as FleetPolicy from "../lan/FleetApprovalPolicy.ts";
import { syntheticFleetPeer } from "../lan/FleetDelivery.fixtures.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Delegations from "./ApprovalDelegations.ts";
import * as Admin from "./ApprovalAdministration.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const destination = syntheticFleetPeer("destination");
  const source = syntheticFleetPeer("source");
  const fleetContext = {
    config: {
      version: 1 as const,
      machineId: "destination",
      rosterPath: path.join(root, "roster.json"),
      deliveryDirectory: root,
      autoPickup: false,
      encryptionPrivateKey: destination.encryptionPrivateKey,
      signingPrivateKey: destination.signingPrivateKey,
      peers: [destination.peer, source.peer],
    },
    self: destination.peer,
    deliveryDirectory: root,
    peers: [{ peer: source.peer, connectHost: undefined }],
  };
  let trust = true;
  const raw = PeerAccess.layer.pipe(
    Layer.provideMerge(SessionStore.layer),
    Layer.provideMerge(Gate.layer),
  );
  const capped = FleetCredentials.layerCapServices.pipe(
    Layer.provideMerge(FleetCredentials.layerServices),
    Layer.provideMerge(raw),
    Layer.provideMerge(
      Layer.mock(FleetAccess.FleetAccess)({
        current: Effect.succeed({
          revision: 1,
          defaultAccess: "standard",
          machines: [],
          machineId: "destination",
          peers: [{ machineId: "source", environmentId: source.peer.environmentId }],
        }),
      }),
    ),
  );
  const core = Delegations.layer.pipe(
    Layer.provideMerge(PeerAccess.layerDestination),
    Layer.provideMerge(capped),
  );
  const services = Admin.layer.pipe(
    Layer.provideMerge(FleetPolicy.layer),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(core),
    Layer.provideMerge(
      Layer.succeed(FleetContext.FleetContext, {
        load: Effect.sync(() => (trust ? fleetContext : undefined)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(FleetVault.FleetVault)({
        read: Effect.succeed({
          version: 1,
          fleetId: "fleet",
          machineId: "destination",
          environmentId: destination.peer.environmentId,
          encryptionPrivateKey: destination.encryptionPrivateKey,
          signingPrivateKey: destination.signingPrivateKey,
          rootPublicKey: destination.peer.signingPublicKey,
          lastRevision: 1,
          enabled: true,
          autoPickup: false,
          access: "standard",
        }),
      }),
    ),
  );
  const built = yield* Layer.build(services);
  const admin = Context.get(built, Admin.ApprovalAdministration);
  const auth = Context.get(built, EnvironmentAuth.EnvironmentAuth);
  const peers = Context.get(built, PeerAccess.ApprovalPeerAccess);
  const sessions = Context.get(built, SessionStore.SessionStore);
  const delegations = Context.get(built, Delegations.ApprovalDelegations);
  const cap = Context.get(built, CredentialAttribution.CredentialAccessCap);
  const owner = yield* auth.issueSession({
    scopes: [...AuthStandardClientScopes, AuthAccessReadScope, AuthAccessWriteScope],
  });
  const issue = (peerLink = true, approvals = true) =>
    auth.issueMcpClientSession({
      label: "Identical name",
      applicationId: "same-application",
      access: "full-access",
      peerLink,
      approvals,
      client: { deviceType: "bot" },
    });
  const link = yield* delegations.createLink(owner.sessionId, source.peer.environmentId);
  const change = (input: unknown) => admin.mutate(owner.sessionId, input);
  const snapshot = () => admin.inspect(owner.sessionId);
  const policy = (enabled: boolean, expectedRevision: number) =>
    change({ type: "setLinkPolicy", linkIdentityId: link, enabled, expectedRevision });
  const bind = (sessionId: string, renew?: { sessionId: string; revision: number }) =>
    change({
      type: "bindPeer",
      sessionId,
      linkIdentityId: link,
      approvals: true,
      interactionModeCeiling: "default",
      ...(renew ? { renew } : {}),
    });
  const authenticate = (sessionId: string, initiatingClientId: string) =>
    delegations.authenticate(initiatingClientId).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make(destination.peer.environmentId),
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
        requestNamespace: sessionId,
        thread: undefined,
        linkedEnvironments: true,
        client: { sessionId, label: "peer", access: "full-access", linked: true },
      }),
    );
  return {
    sql,
    admin,
    auth,
    peers,
    sessions,
    delegations,
    cap,
    owner,
    issue,
    link,
    change,
    snapshot,
    policy,
    bind,
    authenticate,
    setTrust: (value: boolean) => {
      trust = value;
    },
  };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Settings.layerTest({ linkedEnvironmentsEnabled: true }),
        Sqlite.layerMemory,
        Secrets.layer,
        ServerEnvironment.layerIdentity,
      ).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-approval-administration-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

it.effect(
  "refuses nonowners, actor spoofing, and retroactive approval grants to old full-access scopes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const readOnly = yield* f.auth.issueSession({ scopes: [AuthAccessReadScope] });
      const agent = yield* f.issue(false);
      for (const sessionId of [readOnly.sessionId, agent.sessionId, "forged-owner"]) {
        assert.equal(
          (yield* f.admin
            .mutate(sessionId, {
              type: "createLink",
              sourceEnvironmentId: "source",
              ownerSessionId: f.owner.sessionId,
            })
            .pipe(Effect.flip)).reason,
          "not_destination_owner",
        );
        assert.equal(
          (yield* f.admin.inspect(sessionId).pipe(Effect.flip)).reason,
          "not_destination_owner",
        );
      }
      assert.equal(
        (yield* f
          .change({
            type: "createLink",
            sourceEnvironmentId: "source",
            ownerSessionId: f.owner.sessionId,
          })
          .pipe(Effect.flip)).reason,
        "invalid_target",
      );
      const old = yield* f.issue(true, false);
      assert.equal((yield* f.bind(old.sessionId).pipe(Effect.flip)).reason, "link_not_approved");
      yield* f.policy(true, 0);
      assert.equal(
        (yield* f.cap.scopes(yield* f.sessions.verify(old.token)))?.includes(
          AuthOrchestrationApproveScope,
        ),
        false,
      );
      const optedIn = yield* f.issue();
      yield* f.bind(optedIn.sessionId);
      const snapshot = yield* f.snapshot();
      assert.equal(snapshot.bindings[0]?.effectiveEnabled, true);
      assert.equal(
        snapshot.clients
          .find((c) => c.sessionId === old.sessionId)
          ?.scopes.includes(AuthOrchestrationApproveScope),
        false,
      );
      const serialized = JSON.stringify(snapshot);
      assert.equal(serialized.includes(optedIn.token), false);
      for (const secret of [
        "signingPrivateKey",
        "encryptionPrivateKey",
        "entry_json",
        "binding_snapshot",
        "authority_snapshot",
      ])
        assert.equal(serialized.includes(secret), false);
    }).pipe(run),
);

it.effect(
  "guards actual RPC calls by write scope and authenticated owner independently of forged payloads",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.approvalAdministrationMutate
          > => tag !== WS_METHODS.approvalAdministrationMutate,
        ),
      );
      const ownerHandler = group.toLayerHandler(WS_METHODS.approvalAdministrationMutate, (input) =>
        f.admin.mutate(f.owner.sessionId, input),
      );
      const readonlyClient = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            ownerHandler,
            RpcAuthorization.layer([AuthAccessReadScope, AuthOrchestrationApproveScope]),
          ),
        ),
      );
      assert.equal(
        (yield* readonlyClient[WS_METHODS.approvalAdministrationMutate]({
          type: "createLink",
          sourceEnvironmentId: "forbidden",
        }).pipe(Effect.flip))._tag,
        "EnvironmentAuthorizationError",
      );
      const agent = yield* f.issue(false);
      const forgedClient = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.approvalAdministrationMutate, (input) =>
              f.admin.mutate(agent.sessionId, input),
            ),
            RpcAuthorization.layer([AuthAccessWriteScope]),
          ),
        ),
      );
      const denied = yield* forgedClient[WS_METHODS.approvalAdministrationMutate]({
        type: "createLink",
        sourceEnvironmentId: "forbidden",
      }).pipe(Effect.flip);
      assert.equal(denied._tag, "ApprovalAdministrationError");
      if (denied._tag === "ApprovalAdministrationError")
        assert.equal(denied.reason, "not_destination_owner");
      assert.equal(
        (yield* f.sql`SELECT link_identity_id FROM agent_approval_destination_links WHERE source_environment_id = 'forbidden'`)
          .length,
        0,
      );
    }).pipe(run),
);

it.effect(
  "delegates only the exact thread/link/client, revokes visibly, and preserves immutable creation history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread', 'project', 'test', 'codex', 'full-access', 'default', 'now', 'now', '{}'), ('other', 'project', 'other', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
      const peer = yield* f.issue();
      yield* f.bind(peer.sessionId);
      yield* f.policy(true, 0);
      const exact = yield* f.authenticate(peer.sessionId, "opaque-client");
      assert.equal(
        (yield* f.delegations.check(exact, "thread").pipe(Effect.flip)).reason,
        "thread_not_delegated",
      );
      yield* f.change({
        type: "grantDelegation",
        threadId: "thread",
        linkIdentityId: f.link,
        initiatingClientId: "opaque-client",
        expectedPolicyRevision: 1,
      });
      assert.equal((yield* f.delegations.check(exact, "thread")).basis, "delegation");
      assert.equal(
        (yield* f.delegations.check(exact, "other").pipe(Effect.flip)).reason,
        "thread_not_delegated",
      );
      const otherClient = yield* f.authenticate(peer.sessionId, "different-client");
      assert.equal(
        (yield* f.delegations.check(otherClient, "thread").pipe(Effect.flip)).reason,
        "thread_not_delegated",
      );
      const snapshot = yield* f.snapshot();
      assert.equal(snapshot.delegations[0]?.effectiveEnabled, true);
      assert.deepEqual(snapshot.sourceClients, [
        { linkIdentityId: f.link, initiatingClientId: "opaque-client" },
      ]);
      const delegationId = snapshot.delegations[0]!.delegationId;
      yield* f.change({ type: "revokeDelegation", delegationId });
      assert.equal((yield* f.snapshot()).delegations[0]?.revoked, true);
      assert.equal(
        (yield* f.delegations.check(exact, "thread").pipe(Effect.flip)).reason,
        "thread_not_delegated",
      );
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_thread_approval_origins`, []);
    }).pipe(run),
);

it.effect(
  "serializes policy revision races and explicitly renews a binding without reviving the old bearer",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const outcomes = yield* Effect.all(
        [f.policy(true, 0).pipe(Effect.result), f.policy(true, 0).pipe(Effect.result)],
        { concurrency: 2 },
      );
      assert.equal(outcomes.filter((r) => r._tag === "Success").length, 1);
      const old = yield* f.issue();
      yield* f.bind(old.sessionId);
      const next = yield* f.issue();
      assert.equal((yield* f.bind(next.sessionId).pipe(Effect.flip)).reason, "authority_changed");
      assert.equal(
        (yield* f
          .bind(next.sessionId, { sessionId: old.sessionId, revision: 99 })
          .pipe(Effect.flip)).reason,
        "authority_changed",
      );
      yield* f.bind(next.sessionId, { sessionId: old.sessionId, revision: 1 });
      yield* f.sessions.verify(old.token).pipe(Effect.flip);
      const snapshot = yield* f.snapshot();
      assert.equal(snapshot.bindings.find((b) => b.sessionId === old.sessionId)?.revoked, true);
      assert.equal(
        snapshot.bindings.find((b) => b.sessionId === next.sessionId)?.effectiveEnabled,
        true,
      );
      yield* f.change({
        type: "revokePeer",
        sessionId: next.sessionId,
        expectedRevision: snapshot.bindings.find((b) => b.sessionId === next.sessionId)!.revision,
      });
      assert.equal(
        (yield* f.snapshot()).bindings.find((b) => b.sessionId === next.sessionId)
          ?.effectiveEnabled,
        false,
      );
    }).pipe(run),
);

it.effect(
  "keeps fresh source identities distinct until exact owner continuation and rejects stale replacement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const previous = yield* f.issue(false);
      const next = yield* f.issue(false);
      let snapshot = yield* f.snapshot();
      const oldClient = snapshot.clients.find((c) => c.sessionId === previous.sessionId)!;
      const newClient = snapshot.clients.find((c) => c.sessionId === next.sessionId)!;
      assert.notEqual(oldClient.initiatingClientId, newClient.initiatingClientId);
      assert.deepEqual(
        yield* f.sql`SELECT authority_snapshot FROM agent_approval_authorizations WHERE session_id IN (${previous.sessionId}, ${next.sessionId})`,
        [{ authority_snapshot: null }, { authority_snapshot: null }],
      );
      assert.equal(
        (yield* f
          .change({
            type: "continueClient",
            sessionId: next.sessionId,
            previousSessionId: previous.sessionId,
            expectedRevision: 99,
          })
          .pipe(Effect.flip)).reason,
        "authority_changed",
      );
      yield* f.change({
        type: "continueClient",
        sessionId: next.sessionId,
        previousSessionId: previous.sessionId,
        expectedRevision: oldClient.revision,
      });
      yield* f.sessions.verify(previous.token).pipe(Effect.flip);
      snapshot = yield* f.snapshot();
      assert.equal(
        snapshot.clients.find((c) => c.sessionId === next.sessionId)?.initiatingClientId,
        oldClient.initiatingClientId,
      );
      assert.equal(
        snapshot.clients.some((c) => c.sessionId === previous.sessionId),
        false,
      );
      assert.equal(
        (yield* f.sql`SELECT initiating_client_id FROM agent_approval_client_continuations`).length,
        1,
      );
      assert.equal(
        (yield* f.sql`SELECT c.previous_session_id FROM agent_approval_client_continuations c
          JOIN agent_approval_authorizations a ON a.session_id = c.previous_session_id
          WHERE a.authority_snapshot = c.authority_snapshot`).length,
        1,
      );
      yield* f.change({ type: "replaceLink", linkIdentityId: f.link, expectedRevision: 1 });
      assert.equal(
        (yield* f
          .change({ type: "replaceLink", linkIdentityId: f.link, expectedRevision: 1 })
          .pipe(Effect.flip)).reason,
        "authority_changed",
      );
      assert.equal((yield* f.snapshot()).links.filter((l) => !l.revoked).length, 1);
    }).pipe(run),
);

it.effect(
  "routes fleet owner publication through signed current destination policy and fails closed after trust loss",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.change({ type: "bindFleetLink", linkIdentityId: f.link, callerMachineId: "source" });
      assert.equal((yield* f.policy(true, 0).pipe(Effect.flip)).reason, "link_not_approved");
      const publication = yield* f.change({
        type: "publishFleetPolicy",
        expectedRevision: 0,
        grants: [{ callerMachineId: "source", enabled: true }],
      });
      assert.equal(publication.distributed, true);
      const snapshot = yield* f.snapshot();
      assert.equal(snapshot.fleet.valid, true);
      yield* f.policy(true, snapshot.links[0]!.policyRevision);
      assert.equal((yield* f.snapshot()).links[0]?.effectiveEnabled, true);
      assert.equal(
        (yield* f
          .change({ type: "publishFleetPolicy", expectedRevision: 0, grants: [] })
          .pipe(Effect.flip)).reason,
        "authority_changed",
      );
      f.setTrust(false);
      assert.equal((yield* f.snapshot()).links[0]?.effectiveEnabled, false);
      assert.equal((yield* f.snapshot()).fleet.available, false);
      assert.equal((yield* f.policy(true, 1).pipe(Effect.flip)).reason, "link_not_approved");
    }).pipe(run),
);
