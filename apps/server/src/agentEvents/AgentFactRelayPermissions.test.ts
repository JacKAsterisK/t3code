import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, type AuthClientSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Cap from "../auth/CredentialAttribution.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Destination from "../approvals/ApprovalDelegations.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Fleet from "../lan/FleetAccessPolicy.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Outside from "./AgentEventAuthority.ts";
import * as Ports from "./AgentFactRelayAccess.ts";
import * as Relay from "./AgentFactRelay.ts";
import * as Facts from "./AgentFactStore.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as Store from "./AgentEventStore.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Permissions from "./AgentFactRelayPermissions.ts";
import migrate088 from "../persistence/Migrations/088_PeerLinkProvenance.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";

const scope = {
  environmentId: EnvironmentId.make("here"),
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  requestNamespace: "peer",
  thread: undefined,
  linkedEnvironments: true,
  client: { sessionId: "peer", label: "Dan", linked: true, access: "full-access" as const },
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Gate.ApprovalAdmissionGate;
  if (
    !(yield* sql<{ name: string }>`PRAGMA table_info(peer_environment_links)`).some(
      (row) => row.name === "provenance",
    )
  )
    yield* migrate088;
  const peer = yield* Ref.make<Destination.LiveApprovalPeer | undefined>({
    linkIdentityId: "owner-bound-link",
    sourceEnvironmentId: "source",
    credentialRevision: 1,
    expiresAt: 100000,
    access: "full-access",
    scopes: ["orchestration:read", "orchestration:operate"],
    runtimeModeCeiling: "full-access",
    interactionModeCeiling: "default",
  });
  const scopes = yield* Ref.make<readonly ("orchestration:read" | "orchestration:operate")[]>([
    "orchestration:read",
    "orchestration:operate",
  ]);
  const outside = yield* Ref.make(true);
  const policy = yield* Ref.make<Fleet.FleetAccessState>({
    revision: 1,
    defaultAccess: "standard",
    machines: [],
    machineId: undefined,
    peers: [],
  });
  const active = ["peer", "subscriber"].map((id) => ({
    sessionId: AuthSessionId.make(id),
    subject: "mcp-client:local",
    method: "bearer-access-token",
    expiresAt: DateTime.makeUnsafe(100000),
    scopes: ["orchestration:read", "orchestration:operate"],
  })) as unknown as ReadonlyArray<AuthClientSession>;
  yield* sql`INSERT INTO peer_environment_links(environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced, provenance)
    VALUES ('remote', 'opaque-secret-reference', 'Gavin', '[]', 'full-access', '1970-01-01T00:00:00.000Z', '1970-01-01T00:01:40.000Z', 1, 'manual')`;
  const counts = { caps: 0, sessions: 0, incoming: 0 };
  const capFailure = { at: -1 };
  const caps = Layer.succeed(Cap.CredentialAccessCap, {
    scopes: () =>
      Effect.gen(function* () {
        counts.caps++;
        if (counts.caps === capFailure.at)
          return yield* new Cap.CredentialAccessUnavailable({
            cause: new Error("Credential storage unavailable"),
          });
        return yield* Ref.get(scopes);
      }),
    administersFleet: () => Ref.get(outside),
  });
  const sessionStore = Layer.mock(Sessions.SessionStore)({
    cookieName: "fixture",
    legacyCookieName: undefined,
    listActive: () =>
      Effect.sync(() => {
        counts.sessions++;
        return active;
      }),
    streamChanges: Stream.empty,
  });
  const destination = Layer.mock(Destination.ApprovalDestinationAccess)({
    withGate: gate.withGate,
    peer: (id) =>
      Effect.sync(() => {
        counts.incoming++;
      }).pipe(
        Effect.andThen(Ref.get(peer)),
        Effect.map((current) => (id === "peer" ? current : undefined)),
      ),
  });
  const services = yield* Layer.build(
    Permissions.layer.pipe(
      Layer.provideMerge(Outside.layer),
      Layer.provideMerge(Projection.layer),
      Layer.provideMerge(destination),
      Layer.provideMerge(sessionStore),
      Layer.provideMerge(caps),
      Layer.provideMerge(Layer.mock(Fleet.FleetAccess)({ current: Ref.get(policy) })),
      Layer.provideMerge(
        Settings.layerTest({
          linkedEnvironmentsEnabled: true,
          agentEventsEnabled: true,
          fleetLinkedEnvironmentsEnabled: true,
        }),
      ),
      Layer.provide(
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("here")),
        }),
      ),
    ),
  );
  return {
    sql,
    counts,
    capFailure,
    peer,
    scopes,
    outside,
    policy,
    settings: Context.get(services, Settings.ServerSettingsService),
    access: Context.get(services, Ports.AgentFactRelayAccess),
  };
});
const dependencies = Layer.mergeAll(layerDatabase, Gate.layer);

it.effect(
  "incoming relay authority comes from the bound live peer and current outside-sharing cap",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.access.incoming(scope);
      assert.equal(first.verdict, "allowed");
      if (first.verdict !== "allowed") return;
      const renamed = yield* f.access.incoming({
        ...scope,
        client: { ...scope.client, label: "Gavin" },
      });
      assert.deepEqual(renamed, first);
      const narrowed = yield* f.access.incoming({
        ...scope,
        client: {
          ...scope.client,
          narrowedTo: { runtimeMode: "approval-required", interactionMode: "plan" },
        },
      });
      assert.equal(narrowed.verdict, "allowed");
      if (narrowed.verdict === "allowed") {
        assert.equal(narrowed.authorization.generation, first.authorization.generation);
        assert.equal(narrowed.authorization.limits.runtimeMode, "approval-required");
      }
      yield* Ref.set(f.outside, false);
      assert.deepEqual(yield* f.access.incoming(scope), {
        verdict: "refused",
        reason: "outside_sharing_refused",
      });
      yield* Ref.set(f.outside, true);
      yield* Ref.set(f.peer, undefined);
      assert.deepEqual(yield* f.access.incoming(scope), {
        verdict: "refused",
        reason: "session_inactive",
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "outgoing generations fence credential replacement while volatile reachability changes do not",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.access.outgoing("remote");
      assert.equal(first.verdict, "allowed");
      if (first.verdict !== "allowed") return;
      yield* f.sql`UPDATE peer_environment_links SET last_reached_at = 'later', last_error = 'temporary' WHERE environment_id = 'remote'`;
      assert.deepEqual(yield* f.access.outgoing("remote"), first);
      yield* f.sql`UPDATE peer_environment_links SET secret_name = 'renewed-reference' WHERE environment_id = 'remote'`;
      const renewed = yield* f.access.outgoing("remote");
      assert.equal(renewed.verdict, "allowed");
      if (renewed.verdict === "allowed")
        assert.notEqual(renewed.authorization.generation, first.authorization.generation);
      yield* f.sql`UPDATE peer_environment_links SET provenance = 'fleet', fleet_machine_id = 'machine'`;
      yield* Ref.update(f.policy, (state) => ({
        ...state,
        unavailable: true,
        peers: [{ machineId: "machine", environmentId: "remote" }],
      }));
      assert.deepEqual(yield* f.access.outgoing("remote"), { verdict: "unavailable" });
      yield* Ref.update(f.policy, (state) => ({ ...state, unavailable: false, member: false }));
      assert.deepEqual(yield* f.access.outgoing("remote"), {
        verdict: "refused",
        reason: "source_changed",
      });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("requester read and outside-sharing loss apply to a retained cached fact", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const request = {
      sessionId: "subscriber",
      attributionSubject: "mcp-client:local",
      environmentId: "remote",
    };
    assert.equal((yield* f.access.requester(request)).verdict, "allowed");
    yield* Ref.set(f.scopes, []);
    assert.deepEqual(yield* f.access.requester(request), {
      verdict: "refused",
      reason: "read_scope_lost",
    });
    yield* Ref.set(f.scopes, ["orchestration:read", "orchestration:operate"]);
    yield* Ref.set(f.outside, false);
    assert.deepEqual(yield* f.access.requester(request), {
      verdict: "refused",
      reason: "outside_sharing_refused",
    });
    yield* Ref.set(f.outside, true);
    yield* f.settings.updateSettings({ linkedEnvironmentsEnabled: false });
    assert.deepEqual(yield* f.access.requester(request), {
      verdict: "refused",
      reason: "links_disabled",
    });
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "a removed automatic peer never becomes a manual link when the roster or local state disappears",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE peer_environment_links SET provenance = 'fleet', fleet_machine_id = 'machine'`;
      const trusted: Fleet.FleetAccessState = {
        revision: 2,
        defaultAccess: "read-only",
        machines: [],
        machineId: "self",
        member: true,
        peers: [{ machineId: "machine", environmentId: "remote" }],
        approvalTrust: {
          fleetId: "fleet",
          peers: [{ machineId: "machine", environmentId: "remote", signingPublicKey: "verified" }],
        },
      };
      yield* Ref.set(f.policy, trusted);
      assert.equal((yield* f.access.outgoing("remote")).verdict, "allowed");
      yield* Ref.set(f.policy, {
        ...trusted,
        peers: [],
        approvalTrust: { fleetId: "fleet", peers: [] },
      });
      assert.deepEqual(yield* f.access.outgoing("remote"), {
        verdict: "refused",
        reason: "source_changed",
      });
      yield* Ref.set(f.policy, { ...trusted, peers: [], unavailable: true });
      assert.deepEqual(yield* f.access.outgoing("remote"), { verdict: "unavailable" });
      yield* f.sql`UPDATE peer_environment_links SET provenance = 'manual', fleet_machine_id = NULL`;
      assert.equal((yield* f.access.outgoing("remote")).verdict, "allowed");
      yield* f.sql`UPDATE peer_environment_links SET provenance = 'unknown'`;
      assert.deepEqual(yield* f.access.outgoing("remote"), { verdict: "unavailable" });
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "one authenticated page proof bounds incoming work while per-fact visibility and next-page revocation stay current",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const generation = yield* Journal.sourceGeneration();
      for (let index = 1; index <= 100; index++)
        yield* Facts.appendFact({
          recordedAt: 0,
          data: {
            schema: "t3.agent-event/1",
            kind: "source_status",
            factKey: "status-" + index,
            summary: "Current self status",
            textIsUntrusted: true,
            environment: { id: "here", label: "Here" },
            thread: index === 100 ? null : { id: "missing-thread-" + index, delegated: false },
            run: null,
            owner: null,
            relay: null,
            origin: {
              environmentId: "here",
              sourceGeneration: generation,
              sourceKind: "peer_status",
              sourceSequence: index,
              transitionOrdinal: 0,
              threadSequence: null,
              occurredAt: "1970-01-01T00:00:00.000Z",
            },
            detail: { environmentId: "here", status: "following" },
          },
        });
      const relay = yield* Relay.AgentFactRelay.pipe(
        Effect.provide(
          Relay.layer({ id: "here", label: "Here" }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Ports.AgentFactRelayAccess, f.access),
                Layer.mock(Ports.AgentFactRelayTransport)({}),
                Layer.succeed(Ports.AgentFactRelayWake, { wait: () => Effect.void }),
              ),
            ),
          ),
        ),
      );
      const request = { after: { epoch: (yield* Store.logState()).epoch, seq: 0 }, limit: 100 };
      const exported = yield* relay
        .readOrigin(request)
        .pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
      assert.equal(exported.facts.length, 1);
      assert.equal(exported.next.seq, 100);
      assert.isAtMost(f.counts.incoming, 2);
      assert.isAtMost(f.counts.sessions, 2);
      assert.isAtMost(f.counts.caps, 3);
      yield* Ref.set(f.outside, false);
      assert.equal(
        (yield* Effect.flip(
          relay
            .readOrigin(request)
            .pipe(Effect.provideService(Invocation.McpInvocationContext, scope)),
        )).reason,
        "capability_denied",
      );
      yield* Ref.set(f.outside, true);
      assert.equal(
        (yield* relay
          .readOrigin(request)
          .pipe(Effect.provideService(Invocation.McpInvocationContext, scope))).facts.length,
        1,
      );
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "credential-cap storage uncertainty returns unavailable and recovery requires a fresh proof",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const requester = {
        sessionId: "subscriber",
        attributionSubject: "mcp-client:local",
        environmentId: "remote",
      };
      const incoming = yield* f.access.incoming(scope);
      const outgoing = yield* f.access.requester(requester);
      assert.equal(incoming.verdict, "allowed");
      assert.equal(outgoing.verdict, "allowed");
      f.capFailure.at = f.counts.caps + 1;
      assert.deepEqual(yield* f.access.incoming(scope), { verdict: "unavailable" });
      // The first scopes check is Outside.check; the second is the requester's fresh cap check.
      f.capFailure.at = f.counts.caps + 2;
      assert.deepEqual(yield* f.access.requester(requester), { verdict: "unavailable" });
      f.capFailure.at = -1;
      const checks = f.counts.caps;
      assert.deepEqual(yield* f.access.incoming(scope), incoming);
      assert.deepEqual(yield* f.access.requester(requester), outgoing);
      assert.isAbove(f.counts.caps, checks);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
