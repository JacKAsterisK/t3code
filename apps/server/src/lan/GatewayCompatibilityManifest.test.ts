import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { manifest } from "./GatewayCompatibilityManifest.ts";

it.effect(
  "digests all composite-key rows, duplicate payloads, secret coordinates and exact BLOBs with bounded keyset reads",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE retained_rows (payload BLOB, credential_ref TEXT, __gateway_key_0 TEXT)`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<130)
      INSERT INTO retained_rows SELECT X'0001FF80','secret:one','must be hashed' FROM n`;
      yield* sql`CREATE TABLE retained_keys (a TEXT,b BLOB,payload TEXT,secret_ref TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID`;
      for (const a of ["a", "b"])
        for (const bytes of [new Uint8Array([0]), new Uint8Array([0, 1]), new Uint8Array([255])])
          yield* sql`INSERT INTO retained_keys VALUES (${a},${bytes},'same payload','secret:two')`;
      const before = yield* sql.withTransaction(manifest("main"));
      assert.deepEqual(
        before.tables.map((row) => [row.table, row.rowCount]),
        [
          ["retained_keys", 6],
          ["retained_rows", 130],
        ],
      );
      assert.equal(before.secretReferences.count, 136);
      for (const mutate of [
        sql`UPDATE retained_rows SET payload=X'0001FF81' WHERE rowid=65`,
        sql`UPDATE retained_rows SET __gateway_key_0='changed' WHERE rowid=1`,
        sql`UPDATE retained_keys SET secret_ref='secret:changed' WHERE a='b' AND b=X'FF'`,
      ]) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* mutate;
              const after = yield* manifest("main");
              assert.notDeepEqual(after, before);
              assert.deepEqual(
                after.tables.map((row) => row.rowCount),
                [6, 130],
              );
              // Roll back each disposable mutation while retaining the assertion's result.
              return yield* Effect.fail("rollback" as const);
            }),
          )
          .pipe(
            Effect.catchIf(
              (error) => error === "rollback",
              () => Effect.void,
            ),
          );
        assert.deepEqual(yield* sql.withTransaction(manifest("main")), before);
      }
      yield* sql`DELETE FROM retained_rows WHERE rowid=130`;
      const after = yield* sql.withTransaction(manifest("main"));
      assert.equal(after.tables[1]!.rowCount, 129);
      assert.notEqual(after.tables[1]!.payloadDigest, before.tables[1]!.payloadDigest);
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: ":memory:",
          readerWorker: false,
          checkpointWorker: false,
        }),
      ),
    ),
);
