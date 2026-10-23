import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Retain keys with native receipts: deleting them would permit changed-payload retries.
  yield* sql`CREATE TABLE lan_task_mutations (
    command_id TEXT PRIMARY KEY,
    payload_fingerprint TEXT NOT NULL
  )`;
});
