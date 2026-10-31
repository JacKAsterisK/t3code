import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([0, 81, 82, 83] as const)(
  "migration 084 upgrades %s additively with no inferred grants or provenance",
  (from) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (from !== 0) yield* runMigrations({ toMigrationInclusive: from });
      yield* runMigrations({ toMigrationInclusive: 83 });
      yield* sql`INSERT INTO agent_approval_authorizations(session_id, application_id, consent_family_id, initiating_client_id, updated_at)
      VALUES ('existing', 'same-app', 'same-family', 'existing-client', 1)`;
      yield* sql`INSERT INTO peer_environment_links(environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
      VALUES ('source', 'test-only-no-secret', 'Dan', '[]', 'full-access', 'now', 'later')`;
      const before = yield* sql`SELECT * FROM agent_approval_authorizations`;
      const linksBefore = yield* sql`SELECT * FROM peer_environment_links`;
      yield* runMigrations({ toMigrationInclusive: 84 });
      for (const table of [
        "agent_approval_destination_links",
        "agent_thread_approval_origins",
        "agent_approval_delegations",
        "agent_approval_peer_bindings",
        "agent_approval_link_policies",
        "agent_approval_fleet_policy_heads",
        "agent_approval_fleet_links",
        "agent_approval_fleet_policy_grants",
        "agent_approval_peer_renewals",
        "agent_approval_client_continuations",
      ])
        assert.deepEqual(yield* sql`SELECT * FROM ${sql(table)}`, []);
      assert.deepEqual(
        yield* sql`SELECT * FROM agent_approval_authorizations`,
        before.map((row) => ({ ...row, credential_kind: "legacy", authority_snapshot: null })),
      );
      assert.deepEqual(yield* sql`SELECT * FROM peer_environment_links`, linksBefore);
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_sessions', 'lan_owned_threads', 'agent_event_subscriptions', 'agent_event_facts', 'agent_approval_receipts')`)
          .length,
        5,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);

it.effect("enforces destination foreign keys, active grant uniqueness and immutable origins", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode,
    interaction_mode, created_at, updated_at, payload_json) VALUES ('thread', 'project', 'Dan', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
    const created = (yield* sql<{
      sequence: number;
    }>`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version,
    event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES ('event', 'thread', 'thread', 1, 'thread.created', 'now', 'create', 'user', '{}', '{}', 2) RETURNING sequence`)[0]!
      .sequence;
    yield* sql`INSERT INTO agent_approval_destination_links(link_identity_id, source_environment_id, created_by, created_at)
    VALUES ('link', 'source', 'destination-owner', 1)`;
    yield* sql`INSERT INTO agent_thread_approval_origins VALUES ('thread', 'source', 'link', 'client', 'create', ${created})`;
    yield* sql`INSERT INTO agent_approval_delegations VALUES ('grant', 'thread', 'link', 'client', 1, 'destination-owner', 1, NULL)`;
    yield* sql`INSERT INTO agent_approval_delegations VALUES ('wrong-thread', 'missing', 'link', 'client', 1, 'owner', 1, NULL)`.pipe(
      Effect.flip,
    );
    yield* sql`INSERT INTO agent_approval_delegations VALUES ('wrong-link', 'thread', 'missing', 'client', 1, 'owner', 1, NULL)`.pipe(
      Effect.flip,
    );
    yield* sql`INSERT INTO agent_approval_delegations VALUES ('duplicate', 'thread', 'link', 'client', 1, 'owner', 1, NULL)`.pipe(
      Effect.flip,
    );
    yield* sql`INSERT INTO agent_approval_delegations VALUES ('bad-revision', 'thread', 'link', 'other', 0, 'owner', 1, NULL)`.pipe(
      Effect.flip,
    );
    yield* sql`UPDATE agent_thread_approval_origins SET initiating_client_id = 'someone-else'`.pipe(
      Effect.flip,
    );
    yield* sql`DELETE FROM agent_approval_destination_links WHERE link_identity_id = 'link'`.pipe(
      Effect.flip,
    );
    yield* sql`UPDATE agent_approval_delegations SET revoked_at = 2 WHERE delegation_id = 'grant'`;
    yield* sql`INSERT INTO agent_approval_delegations VALUES ('new-grant', 'thread', 'link', 'client', 1, 'destination-owner', 3, NULL)`;
    assert.equal((yield* sql`SELECT * FROM agent_approval_delegations`).length, 2);
    assert.equal(
      (yield* sql<{
        initiating_client_id: string;
      }>`SELECT initiating_client_id FROM agent_thread_approval_origins`)[0]!.initiating_client_id,
      "client",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);

it.effect(
  "continuity records enforce immutable, unique owner-approved edges and positive epochs",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO agent_approval_destination_links(link_identity_id, source_environment_id, created_by, created_at) VALUES ('link', 'source', 'owner', 1)`;
      for (const id of ["old", "next", "other"]) {
        yield* sql`INSERT INTO agent_approval_authorizations(session_id, application_id, consent_family_id, initiating_client_id, updated_at) VALUES (${id}, 'app', 'owner', 'opaque', 1)`;
        yield* sql`INSERT INTO agent_approval_peer_bindings(session_id, link_identity_id, binding_snapshot, approval_enabled, interaction_mode_ceiling, created_by, created_at)
        VALUES (${id}, 'link', 'original', 1, 'default', 'owner', 1)`;
      }
      yield* sql`INSERT INTO agent_approval_peer_renewals VALUES ('old', 'next', 'link', 1, 1, 2, 1, 'authority_changed', 'security', 'owner', 2)`;
      yield* sql`INSERT INTO agent_approval_client_continuations VALUES ('old', 'next', 'opaque', 1, 2, 1, 'authority', 'owner', 2)`;
      for (const table of ["agent_approval_peer_renewals", "agent_approval_client_continuations"]) {
        yield* sql`UPDATE ${sql(table)} SET authority_preserved = 0`.pipe(Effect.flip);
        yield* sql`UPDATE ${sql(table)} SET created_by = 'new-owner'`.pipe(Effect.flip);
        yield* sql`DELETE FROM ${sql(table)}`.pipe(Effect.flip);
      }
      yield* sql`INSERT INTO agent_approval_peer_renewals VALUES ('other', 'next', 'link', 1, 2, 3, 1, 'authority_changed', 'security', 'owner', 3)`.pipe(
        Effect.flip,
      );
      yield* sql`INSERT INTO agent_approval_peer_renewals VALUES ('next', 'other', 'link', 1, 2, 2, 1, 'authority_changed', 'security', 'owner', 3)`.pipe(
        Effect.flip,
      );
      yield* sql`INSERT INTO agent_approval_client_continuations VALUES ('other', 'next', 'opaque', 1, 2, 1, 'authority', 'owner', 3)`.pipe(
        Effect.flip,
      );
      yield* sql`UPDATE agent_approval_destination_links SET credential_epoch = -1`.pipe(
        Effect.flip,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);
