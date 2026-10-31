import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Authority from "../auth/ApprovalAuthority.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as DateTime from "effect/DateTime";
import { AuthSessionId } from "@t3tools/contracts";
import * as Delegations from "./ApprovalDelegations.ts";

const scopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationApproveScope,
];
const invocation = (access: AuthMcpClientAccess = "full-access", sessionId = "peer") => ({
  environmentId: EnvironmentId.make("destination"),
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  requestNamespace: sessionId,
  thread: undefined,
  linkedEnvironments: true,
  client: { sessionId, label: "Dan", access, linked: true },
});
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>, reason: string) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.instanceOf(error, Delegations.ApprovalDelegationError);
        assert.equal((error as Delegations.ApprovalDelegationError).reason, reason);
      }),
    ),
  );

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`CREATE TABLE test_destination_peers (
    session_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'source',
    revision INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL DEFAULT 100000,
    access TEXT NOT NULL DEFAULT 'full-access', scopes TEXT NOT NULL,
    runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default',
    revoked INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE test_destination_policies (link_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1)`;
  yield* sql`CREATE TABLE test_destination_owners (session_id TEXT PRIMARY KEY, subject TEXT NOT NULL)`;
  yield* sql`CREATE TABLE test_destination_admissions (id TEXT PRIMARY KEY)`;
  yield* sql`INSERT INTO test_destination_owners VALUES ('owner', 'authenticated-destination-owner')`;
  const gate = yield* Semaphore.make(1);
  const port = Delegations.ApprovalDestinationAccess.of({
    withGate: gate.withPermit,
    peer: Effect.fn("DelegationFixture.peer")(
      function* (sessionId: string) {
        const row = (yield* sql<{
          link_id: string;
          source: string;
          revision: number;
          expires_at: number;
          access: AuthMcpClientAccess;
          scopes: string;
          runtime_mode: "full-access";
          interaction_mode: "default";
        }>`SELECT * FROM test_destination_peers WHERE session_id = ${sessionId} AND revoked = 0`)[0];
        return row === undefined
          ? undefined
          : {
              linkIdentityId: row.link_id,
              sourceEnvironmentId: row.source,
              credentialRevision: row.revision,
              expiresAt: row.expires_at,
              access: row.access,
              scopes: JSON.parse(row.scopes),
              runtimeModeCeiling: row.runtime_mode,
              interactionModeCeiling: row.interaction_mode,
            };
      },
      Effect.mapError(
        (cause) =>
          new Delegations.ApprovalDelegationError({ reason: "storage_unavailable", cause }),
      ),
    ),
    policy: Effect.fn("DelegationFixture.policy")(
      function* (linkId: string) {
        const row = (yield* sql<{
          enabled: number;
          revision: number;
        }>`SELECT * FROM test_destination_policies WHERE link_id = ${linkId}`)[0];
        return row === undefined
          ? undefined
          : { enabled: row.enabled === 1, revision: row.revision };
      },
      Effect.mapError(
        (cause) =>
          new Delegations.ApprovalDelegationError({ reason: "storage_unavailable", cause }),
      ),
    ),
    owner: Effect.fn("DelegationFixture.owner")(
      function* (sessionId: string) {
        return (yield* sql<{
          subject: string;
        }>`SELECT subject FROM test_destination_owners WHERE session_id = ${sessionId}`)[0];
      },
      Effect.mapError(
        (cause) =>
          new Delegations.ApprovalDelegationError({ reason: "storage_unavailable", cause }),
      ),
    ),
  });
  const services = yield* Layer.build(
    Delegations.layer.pipe(
      Layer.provide(Layer.succeed(Delegations.ApprovalDestinationAccess, port)),
    ),
  );
  const service = Context.get(services, Delegations.ApprovalDelegations);
  const linkId = yield* service.createLink("owner", "source");
  yield* sql`INSERT INTO test_destination_peers(session_id, link_id, scopes) VALUES ('peer', ${linkId}, ${JSON.stringify(scopes)})`;
  const enablePolicy = (id = linkId) =>
    sql`INSERT INTO test_destination_policies(link_id) VALUES (${id})`;
  const seedThread = Effect.fn("DelegationFixture.seedThread")(function* (
    id: string,
    mode = "full-access",
    linkSession: string | null = "peer",
  ) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, 'project', 'Gavin', 'codex', ${mode}, 'default', 'now', 'now', '{}')`;
    const rows = yield* sql<{
      sequence: number;
    }>`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id,
      stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES (${`event:${id}`}, 'thread', ${id}, 1, 'thread.created', 'now', ${`create:${id}`}, 'user',
        ${JSON.stringify(linkSession === null ? {} : { linkOrigin: { sessionId: linkSession } })}, '{}', 2) RETURNING sequence`;
    return { threadId: id, creationCommandId: `create:${id}`, createdSequence: rows[0]!.sequence };
  });
  const authenticate = (
    clientId = "client-1",
    access: AuthMcpClientAccess = "full-access",
    sessionId = "peer",
  ) =>
    service
      .authenticate(clientId)
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(access, sessionId),
        ),
      );
  return { sql, service, linkId, port, gate, seedThread, authenticate, enablePolicy };
});
const database = Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer);

it.effect.each(["approval-required", "full-access"] as const)(
  "requires exact link/client creation provenance or destination delegation at %s access",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE test_destination_peers SET access = ${mode}, runtime_mode = ${mode}`;
      const created = yield* f.seedThread("created", mode);
      yield* f.seedThread("operator", mode);
      const peer = yield* f.authenticate("client-1", mode);
      yield* f.service.recordOrigin(peer, created);
      yield* refused(f.service.check(peer, "created"), "link_not_approved");
      yield* f.enablePolicy();
      assert.equal((yield* f.service.check(peer, "created")).basis, "origin");
      yield* refused(f.service.check(peer, "operator"), "thread_not_delegated");
      const other = yield* f.authenticate("client-2", mode);
      yield* refused(f.service.check(other, "created"), "thread_not_delegated");
      const grant = yield* f.service.grant("owner", {
        threadId: "operator",
        linkIdentityId: f.linkId,
        initiatingClientId: "client-1",
      });
      const repeated = yield* f.service.grant("owner", {
        threadId: "operator",
        linkIdentityId: f.linkId,
        initiatingClientId: "client-1",
      });
      assert.equal(repeated.delegation_id, grant.delegation_id);
      assert.equal(grant.created_by, "authenticated-destination-owner");
      assert.equal((yield* f.service.check(peer, "operator")).basis, "delegation");
      yield* refused(f.service.check(other, "operator"), "thread_not_delegated");
      yield* refused(
        f.service.grant("peer", {
          threadId: "operator",
          linkIdentityId: f.linkId,
          initiatingClientId: "client-2",
        }),
        "not_destination_owner",
      );
      yield* refused(f.service.revoke("peer", grant.delegation_id), "not_destination_owner");
      assert.equal((yield* f.service.list("owner", "operator")).length, 1);
      assert.equal(
        (yield* f.sql`SELECT * FROM agent_thread_approval_origins WHERE thread_id = 'operator'`)
          .length,
        0,
      );
    }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect("refuses claimed identity and never rewrites immutable creation provenance", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const created = yield* f.seedThread("created");
    yield* f.enablePolicy();
    const peer = yield* f.authenticate();
    yield* refused(
      f.service.check({} as Delegations.AuthenticatedApprovalPeer, "created"),
      "invalid_provenance",
    );
    yield* refused(
      f.service.authenticate("client-1").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation(),
          client: { ...invocation().client, linked: false },
        }),
      ),
      "invalid_provenance",
    );
    yield* refused(
      f.service
        .authenticate("")
        .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation())),
      "invalid_provenance",
    );
    yield* refused(
      f.service.recordOrigin(peer, { ...created, creationCommandId: "wrong-command" }),
      "invalid_provenance",
    );
    yield* refused(
      f.service.recordOrigin(peer, { ...created, createdSequence: created.createdSequence + 1 }),
      "invalid_provenance",
    );
    const operator = yield* f.seedThread("operator-created", "full-access", null);
    yield* refused(f.service.recordOrigin(peer, operator), "invalid_provenance");
    yield* f.service.recordOrigin(peer, created);
    yield* f.service.recordOrigin(peer, created);
    const other = yield* f.authenticate("client-2");
    yield* refused(f.service.recordOrigin(other, created), "provenance_conflict");
    yield* f.service.grant("owner", {
      threadId: "created",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-2",
    });
    assert.equal((yield* f.service.check(other, "created")).basis, "delegation");
    assert.equal(
      (yield* f.sql<{
        initiating_client_id: string;
      }>`SELECT initiating_client_id FROM agent_thread_approval_origins`)[0]!.initiating_client_id,
      "client-1",
    );
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect("retained preparation cannot admit after revoke or regrant", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.seedThread("operator");
    yield* f.enablePolicy();
    const peer = yield* f.authenticate();
    const target = {
      threadId: "operator",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-1",
    };
    const grant = yield* f.service.grant("owner", target);
    const prepared = yield* f.service.check(peer, "operator");
    yield* f.service.revoke("owner", grant.delegation_id);
    const admit = () => f.sql`INSERT INTO test_destination_admissions VALUES ('admitted')`;
    yield* refused(
      f.service.withAdmission(peer, "operator", prepared, admit),
      "thread_not_delegated",
    );
    const replacement = yield* f.service.grant("owner", target);
    assert.notEqual(replacement.delegation_id, grant.delegation_id);
    yield* refused(f.service.withAdmission(peer, "operator", prepared, admit), "authority_changed");
    assert.deepEqual(yield* f.sql`SELECT * FROM test_destination_admissions`, []);
    assert.equal(
      (yield* f.service.list("owner", "operator")).filter((row) => row.revoked_at !== null).length,
      1,
    );
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect(
  "serializes revocation with an admitted local transaction and refuses the next admission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seedThread("operator");
      yield* f.enablePolicy();
      const peer = yield* f.authenticate();
      const grant = yield* f.service.grant("owner", {
        threadId: "operator",
        linkIdentityId: f.linkId,
        initiatingClientId: "client-1",
      });
      const prepared = yield* f.service.check(peer, "operator");
      const admitted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const removalStarted = yield* Deferred.make<void>();
      const removalDone = yield* Deferred.make<void>();
      const admission = yield* f.service
        .withAdmission(peer, "operator", prepared, () =>
          Effect.gen(function* () {
            yield* f.sql`INSERT INTO test_destination_admissions VALUES ('first')`;
            yield* Deferred.succeed(admitted, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(admitted);
      const removal = yield* Effect.gen(function* () {
        yield* Deferred.succeed(removalStarted, undefined);
        yield* f.service.revoke("owner", grant.delegation_id);
        yield* Deferred.succeed(removalDone, undefined);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(removalStarted);
      assert.isFalse(yield* Deferred.isDone(removalDone));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(admission);
      yield* Fiber.join(removal);
      yield* refused(
        f.service.withAdmission(
          peer,
          "operator",
          prepared,
          () => f.sql`INSERT INTO test_destination_admissions VALUES ('second')`,
        ),
        "thread_not_delegated",
      );
      assert.deepEqual(yield* f.sql`SELECT * FROM test_destination_admissions`, [{ id: "first" }]);
    }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect("rolls back failed admission and preserves the callback's typed failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.seedThread("operator");
    yield* f.enablePolicy();
    const peer = yield* f.authenticate();
    yield* f.service.grant("owner", {
      threadId: "operator",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-1",
    });
    const failure = { _tag: "NativeAdmissionRejected" as const };
    const result = yield* f.service
      .withAdmission(peer, "operator", undefined, () =>
        Effect.gen(function* () {
          yield* f.sql`INSERT INTO test_destination_admissions VALUES ('rolled-back')`;
          return yield* Effect.fail(failure);
        }),
      )
      .pipe(Effect.flip);
    assert.strictEqual(result, failure);
    assert.deepEqual(yield* f.sql`SELECT * FROM test_destination_admissions`, []);
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect("credential renewal preserves identity but replacement retires the old incarnation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const created = yield* f.seedThread("created");
    yield* f.seedThread("operator");
    yield* f.enablePolicy();
    const old = yield* f.authenticate();
    yield* f.service.recordOrigin(old, created);
    yield* f.service.grant("owner", {
      threadId: "operator",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-1",
    });
    const before = yield* f.service.check(old, "created");
    yield* f.sql`INSERT INTO test_destination_peers(session_id, link_id, revision, scopes) VALUES ('renewed', ${f.linkId}, 2, ${JSON.stringify(scopes)})`;
    const renewed = yield* f.authenticate("client-1", "full-access", "renewed");
    assert.equal((yield* f.service.check(renewed, "created")).basis, "origin");
    yield* refused(f.service.check(renewed, "created", before), "authority_changed");
    const next = yield* f.service.replaceLink("owner", f.linkId);
    yield* f.enablePolicy(next);
    yield* refused(f.service.check(old, "created"), "link_not_approved");
    yield* f.sql`UPDATE test_destination_peers SET link_id = ${next}, revision = revision + 1 WHERE session_id = 'renewed'`;
    yield* refused(f.service.check(renewed, "created"), "link_not_approved");
    const replacement = yield* f.authenticate("client-1", "full-access", "renewed");
    yield* refused(f.service.check(replacement, "created"), "thread_not_delegated");
    yield* refused(f.service.check(replacement, "operator"), "thread_not_delegated");
    yield* f.service.grant("owner", {
      threadId: "operator",
      linkIdentityId: next,
      initiatingClientId: "client-1",
    });
    assert.equal((yield* f.service.check(replacement, "operator")).basis, "delegation");
    yield* f.service.revokeLink("owner", next);
    yield* refused(f.service.check(replacement, "operator"), "link_not_approved");
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect.each([
  ["read-only", "link_not_approved"],
  ["scope", "link_not_approved"],
  ["cap", "link_not_approved"],
  ["expired", "link_not_approved"],
  ["revoked", "link_not_approved"],
  ["policy-removed", "link_not_approved"],
  ["policy-revision", "thread_not_delegated"],
  ["credential-revision", "authority_changed"],
  ["runtime", "mode_ceiling"],
  ["interaction", "mode_ceiling"],
  ["deleted", "thread_not_delegated"],
] as const)("rechecks %s at admission after preparation", ([change, reason]) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.seedThread("operator");
    yield* f.enablePolicy();
    const peer = yield* f.authenticate();
    yield* f.service.grant("owner", {
      threadId: "operator",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-1",
    });
    const prepared = yield* f.service.check(peer, "operator");
    yield* f.port.withGate(
      Effect.gen(function* () {
        switch (change) {
          case "read-only":
            yield* f.sql`UPDATE test_destination_peers SET access = 'read-only'`;
            break;
          case "scope":
            yield* f.sql`UPDATE test_destination_peers SET scopes = ${JSON.stringify(scopes.filter((scope) => scope !== AuthOrchestrationApproveScope))}`;
            break;
          case "cap":
            yield* f.sql`UPDATE test_destination_peers SET scopes = '[]'`;
            break;
          case "expired":
            yield* f.sql`UPDATE test_destination_peers SET expires_at = 0`;
            break;
          case "revoked":
            yield* f.sql`UPDATE test_destination_peers SET revoked = 1`;
            break;
          case "policy-removed":
            yield* f.sql`UPDATE test_destination_policies SET enabled = 0`;
            break;
          case "policy-revision":
            yield* f.sql`UPDATE test_destination_policies SET revision = 2`;
            break;
          case "credential-revision":
            yield* f.sql`UPDATE test_destination_peers SET revision = 2`;
            break;
          case "runtime":
            yield* f.sql`UPDATE test_destination_peers SET runtime_mode = 'approval-required'`;
            break;
          case "interaction":
            yield* f.sql`UPDATE test_destination_peers SET interaction_mode = 'plan'`;
            break;
          case "deleted":
            yield* f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'now' WHERE thread_id = 'operator'`;
            break;
        }
      }),
    );
    yield* refused(
      f.service.withAdmission(
        peer,
        "operator",
        prepared,
        () => f.sql`INSERT INTO test_destination_admissions VALUES ('forbidden')`,
      ),
      reason,
    );
    assert.deepEqual(yield* f.sql`SELECT * FROM test_destination_admissions`, []);
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect("honors the authenticated request's narrower modes even with full link access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.seedThread("operator");
    yield* f.enablePolicy();
    const peer = yield* f.service.authenticate("client-1").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation(),
        client: {
          ...invocation().client,
          narrowedTo: { runtimeMode: "approval-required", interactionMode: "default" },
        },
      }),
    );
    yield* f.service.grant("owner", {
      threadId: "operator",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-1",
    });
    yield* refused(f.service.check(peer, "operator"), "mode_ceiling");
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect(
  "source launch provenance keeps equal-app/family sign-ins distinct and rechecks revocation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const active = ["sign-in-1", "sign-in-2"].map((sessionId) => ({
        sessionId: AuthSessionId.make(sessionId),
        method: "bearer-access-token" as const,
        subject: "mcp-client:local",
        expiresAt: DateTime.makeUnsafe(100000),
        scopes,
      }));
      const services = yield* Layer.build(
        Authority.layer.pipe(
          Layer.provide(
            Layer.succeed(SessionStore.SessionStore, {
              listActive: () => Effect.succeed(active),
              notifyScopeChange: () => Effect.void,
            } as unknown as SessionStore.SessionStore["Service"]),
          ),
        ),
      );
      const authority = Context.get(services, Authority.ApprovalAuthority);
      for (const session of active)
        yield* authority.register({
          sessionId: session.sessionId,
          applicationId: "same-app",
          grantorSubject: "same-owner",
          enabled: true,
          runtimeModeCeiling: "full-access",
        });
      const source = (sessionId: string) =>
        Delegations.initiatingClientForLaunch().pipe(
          Effect.provideService(Authority.ApprovalAuthority, authority),
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocation("full-access", sessionId),
            client: { ...invocation("full-access", sessionId).client, linked: false },
          }),
        );
      const first = yield* source("sign-in-1");
      const second = yield* source("sign-in-2");
      assert.notEqual(first.initiatingClientId, second.initiatingClientId);
      assert.equal((yield* source("sign-in-1")).initiatingClientId, first.initiatingClientId);
      const rows = yield* f.sql<{
        application_id: string;
        consent_family_id: string;
        initiating_client_id: string;
      }>`SELECT * FROM agent_approval_authorizations ORDER BY session_id`;
      assert.equal(rows[0]!.application_id, rows[1]!.application_id);
      assert.equal(rows[0]!.consent_family_id, rows[1]!.consent_family_id);
      yield* authority.remove("sign-in-1", false);
      assert.equal((yield* source("sign-in-1")).initiatingClientId, first.initiatingClientId);
      yield* authority.check("sign-in-1").pipe(Effect.flip);
      active.splice(0, 1);
      const revoked = yield* source("sign-in-1").pipe(Effect.flip);
      assert.equal(revoked._tag, "ApprovalAuthorityError");
      assert.equal((yield* source("sign-in-2")).initiatingClientId, second.initiatingClientId);
    }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect(
  "reconstructed services retain grants and origins but never accept reconstructed authentication handles",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enablePolicy();
      const created = yield* f.seedThread("created");
      yield* f.seedThread("operator");
      const peer = yield* f.authenticate();
      yield* f.service.recordOrigin(peer, created);
      const delegation = yield* f.service.grant("owner", {
        threadId: "operator",
        linkIdentityId: f.linkId,
        initiatingClientId: "client-1",
      });
      const services = yield* Layer.build(
        Delegations.layer.pipe(
          Layer.provide(Layer.succeed(Delegations.ApprovalDestinationAccess, f.port)),
        ),
      );
      const restarted = Context.get(services, Delegations.ApprovalDelegations);
      yield* refused(restarted.check(peer, "operator"), "invalid_provenance");
      const current = yield* restarted
        .authenticate("client-1")
        .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation()));
      assert.equal((yield* restarted.check(current, "created")).basis, "origin");
      assert.equal(
        (yield* restarted.check(current, "operator")).delegationId,
        delegation.delegation_id,
      );
    }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect("queued admission reads live policy after removal wins the shared gate", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.seedThread("operator");
    yield* f.enablePolicy();
    const peer = yield* f.authenticate();
    yield* f.service.grant("owner", {
      threadId: "operator",
      linkIdentityId: f.linkId,
      initiatingClientId: "client-1",
    });
    const prepared = yield* f.service.check(peer, "operator");
    const removalHoldsGate = yield* Deferred.make<void>();
    const releaseRemoval = yield* Deferred.make<void>();
    const admissionStarted = yield* Deferred.make<void>();
    const removal = yield* f.port
      .withGate(
        Effect.gen(function* () {
          yield* Deferred.succeed(removalHoldsGate, undefined);
          yield* Deferred.await(releaseRemoval);
          yield* f.sql`UPDATE test_destination_policies SET enabled = 0, revision = revision + 1`;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(removalHoldsGate);
    const admission = yield* Effect.gen(function* () {
      yield* Deferred.succeed(admissionStarted, undefined);
      return yield* f.service.withAdmission(
        peer,
        "operator",
        prepared,
        () => f.sql`INSERT INTO test_destination_admissions VALUES ('forbidden')`,
      );
    }).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(admissionStarted);
    yield* Deferred.succeed(releaseRemoval, undefined);
    yield* Fiber.join(removal);
    const result = yield* Fiber.join(admission);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, Delegations.ApprovalDelegationError);
      assert.equal(
        (result.failure as Delegations.ApprovalDelegationError).reason,
        "link_not_approved",
      );
    }
    assert.deepEqual(yield* f.sql`SELECT * FROM test_destination_admissions`, []);
  }).pipe(Effect.provide(database), Effect.scoped),
);

it.effect(
  "equal labels and asserted client IDs never substitute for the authenticated immediate link",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enablePolicy();
      const created = yield* f.seedThread("created");
      const first = yield* f.authenticate();
      yield* f.service.recordOrigin(first, created);
      const otherLink = yield* f.service.createLink("owner", "other-source");
      yield* f.enablePolicy(otherLink);
      yield* f.sql`INSERT INTO test_destination_peers(session_id, link_id, source, scopes)
    VALUES ('other-peer', ${otherLink}, 'other-source', ${JSON.stringify(scopes)})`;
      const other = yield* f.authenticate("client-1", "full-access", "other-peer");
      yield* refused(f.service.check(other, "created"), "thread_not_delegated");
      yield* f.service.grant("owner", {
        threadId: "created",
        linkIdentityId: otherLink,
        initiatingClientId: "client-1",
      });
      const delegated = yield* f.service.check(other, "created");
      assert.equal(delegated.sourceEnvironmentId, "other-source");
      assert.equal(delegated.basis, "delegation");
      yield* f.sql`UPDATE test_destination_peers SET source = 'source' WHERE session_id = 'other-peer'`;
      yield* refused(f.service.check(other, "created"), "link_not_approved");
      assert.equal((yield* f.service.check(first, "created")).basis, "origin");
    }).pipe(Effect.provide(database), Effect.scoped),
);
