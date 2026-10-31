import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([0, 80, 81, 83, 84, 85] as const)(
  "additive 086 preserves pending payload bytes, ACK bits, generations, anchors and nonwork rows from %s",
  (from) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (from !== 0) yield* runMigrations({ toMigrationInclusive: from });
      yield* runMigrations({ toMigrationInclusive: 85 });
      const payload =
        ' { "eventId": "native:issued", "sequence": 9, "kind": "run_state", "runId": null, "requestId": null, "status": "running" } ';
      yield* sql`INSERT INTO lan_owned_threads VALUES ('principal:one', 'environment:one', 'project:one', 'thread:one')`;
      for (const [principal, generation, acknowledged] of [
        ["principal:one", "delivery:retired", 1],
        ["principal:one", "delivery:active", 0],
        ["principal:two", "delivery:active", 1],
      ] as const)
        yield* sql`INSERT INTO lan_observation_inbox
        (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged)
        VALUES (${principal}, 'environment:one', 'thread:one', ${generation}, 'native:issued', 9, ${payload}, ${acknowledged})`;
      yield* sql`INSERT INTO lan_observation_cursors VALUES ('principal:one', 'environment:one', 'thread:one', 'native:source', 9, 'native:issued', 'delivery:active')`;
      yield* sql`CREATE TABLE retained_nonwork_probe (id TEXT PRIMARY KEY, payload BLOB, secret_ref TEXT)`;
      yield* sql`INSERT INTO retained_nonwork_probe VALUES ('one', X'00017fff', 'secret:retained')`;
      const before = {
        inbox: yield* sql`SELECT * FROM lan_observation_inbox ORDER BY principal_id, source_id`,
        cursors: yield* sql`SELECT * FROM lan_observation_cursors`,
        ownership: yield* sql`SELECT * FROM lan_owned_threads`,
        nonwork: yield* sql`SELECT * FROM retained_nonwork_probe`,
        facts: yield* sql`SELECT * FROM agent_event_facts`,
        subscriptions: yield* sql`SELECT * FROM agent_event_subscriptions`,
        receipts: yield* sql`SELECT * FROM agent_approval_receipts`,
      };
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged
      FROM agent_gateway_compatibility_inbox ORDER BY principal_id, source_id`,
        before.inbox,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM agent_gateway_compatibility_cursors`,
        before.cursors,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM lan_observation_inbox ORDER BY principal_id, source_id`,
        before.inbox,
      );
      assert.deepEqual(yield* sql`SELECT * FROM lan_observation_cursors`, before.cursors);
      assert.deepEqual(yield* sql`SELECT * FROM lan_owned_threads`, before.ownership);
      assert.deepEqual(yield* sql`SELECT * FROM retained_nonwork_probe`, before.nonwork);
      assert.deepEqual(yield* sql`SELECT * FROM agent_event_facts`, before.facts);
      assert.deepEqual(yield* sql`SELECT * FROM agent_event_subscriptions`, before.subscriptions);
      assert.deepEqual(yield* sql`SELECT * FROM agent_approval_receipts`, before.receipts);
      assert.deepEqual(yield* sql`SELECT * FROM agent_gateway_compatibility_facts`, []);
      assert.deepEqual(yield* sql`SELECT mode, generation FROM agent_gateway_compatibility_state`, [
        { mode: "legacy", generation: 0 },
      ]);
      process.stdout.write(
        JSON.stringify({
          proof: "gateway_compatibility",
          scenario: "additive_import",
          from,
          exactPayloadBytes: true,
          ackBits: [1, 0, 1],
          nativeSourceId: "native:source",
          deliveryGeneration: "delivery:active",
          anchorEventId: "native:issued",
          ownershipRetained: true,
          nonworkPayloadAndSecretReference: true,
        }) + "\n",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);
