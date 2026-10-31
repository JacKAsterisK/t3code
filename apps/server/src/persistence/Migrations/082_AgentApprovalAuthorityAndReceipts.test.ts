import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
it.effect.each([0, 80, 81] as const)(
  "additive approval migration upgrades %s without assigning old sessions authority",
  (from) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (from !== 0) yield* runMigrations({ toMigrationInclusive: from });
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_authorizations`, []);
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_receipts`, []);
      const legacy =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lan_owned_threads', 'agent_event_subscriptions', 'auth_sessions')`;
      assert.equal(legacy.length, 3);
      yield* sql`INSERT INTO agent_approval_authorizations(session_id, application_id, consent_family_id, initiating_client_id, updated_at)
      VALUES ('old-session', 'app', 'owner', 'client', 1)`;
      assert.equal(
        (yield* sql<{ enabled: number }>`SELECT enabled FROM agent_approval_authorizations`)[0]!
          .enabled,
        0,
      );
      yield* runMigrations();
      assert.equal((yield* sql`SELECT * FROM agent_approval_authorizations`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);
