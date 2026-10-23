import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE lan_observation_cursors ADD COLUMN delivery_source_id TEXT`;
  yield* sql`UPDATE lan_observation_cursors SET delivery_source_id = source_id`;
});
