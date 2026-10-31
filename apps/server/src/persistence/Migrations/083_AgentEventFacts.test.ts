import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([0, 80, 81, 82] as const)(
  "facts migration upgrades %s with empty state and preserves the shared log",
  (from) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (from !== 0) yield* runMigrations({ toMigrationInclusive: from });
      if (from >= 81)
        yield* sql`INSERT INTO agent_event_log_state (id, epoch, head_seq, floor_seq) VALUES (1, 'existing', 7, 2)`;
      yield* runMigrations();
      for (const table of [
        "agent_event_facts",
        "agent_event_source_state",
        "agent_event_derivation_state",
        "agent_event_directories",
        "agent_event_source_directories",
        "agent_event_peer_cursors",
        "agent_event_owner_assignments",
        "agent_event_reducer_history",
        "agent_event_occurrences",
      ])
        assert.deepEqual(yield* sql`SELECT * FROM ${sql(table)}`, []);
      if (from >= 81)
        assert.deepEqual(
          (yield* sql`SELECT epoch, head_seq, floor_seq, derived_through_sequence FROM agent_event_log_state`)[0],
          { epoch: "existing", head_seq: 7, floor_seq: 2, derived_through_sequence: 0 },
        );
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_authorizations`, []);
      yield* runMigrations();
      const history = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 83`;
      assert.strictEqual(history[0]!.name, "AgentEventFacts");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);
