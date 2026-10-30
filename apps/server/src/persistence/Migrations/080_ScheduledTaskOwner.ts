import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // T3 Code LAN: the fleet user a scheduled task's threads belong to. Null leaves each run's thread
  // to the machine's default owner, as every task saved before this did.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN owner_id TEXT`;
});
