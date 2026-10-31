import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "migration 089 preserves policy grants and binds retry witnesses to the exact current head",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      const digest = "a".repeat(64);
      yield* sql`INSERT INTO agent_approval_fleet_policy_heads VALUES ('fleet', 'destination', 1, ${digest}, 'original-bytes', 1)`;
      yield* sql`INSERT INTO agent_approval_fleet_policy_grants VALUES ('fleet', 'destination', 'source', 1)`;
      const heads = yield* sql`SELECT * FROM agent_approval_fleet_policy_heads`;
      const grants = yield* sql`SELECT * FROM agent_approval_fleet_policy_grants`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_fleet_policy_heads`, heads);
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_fleet_policy_grants`, grants);
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_fleet_policy_publications`, []);
      yield* sql`INSERT INTO agent_approval_fleet_policy_publications VALUES ('fleet', 'destination', 1, ${"b".repeat(64)}, 1)`.pipe(
        Effect.flip,
      );
      yield* sql`INSERT INTO agent_approval_fleet_policy_publications VALUES ('fleet', 'destination', 1, ${digest}, 1)`;
      yield* sql`UPDATE agent_approval_fleet_policy_heads SET revision = 2`.pipe(Effect.flip);
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_fleet_policy_heads`, heads);
      yield* sql`DELETE FROM agent_approval_fleet_policy_publications`;
      yield* sql`UPDATE agent_approval_fleet_policy_heads SET revision = 2`;
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_fleet_policy_grants`, grants);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);
