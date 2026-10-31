import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing pointers cannot prove whether a fleet link crashed before its JSON receipt.
  yield* sql`ALTER TABLE peer_environment_links ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unknown'
    CHECK (provenance IN ('unknown', 'manual', 'fleet'))`;
  yield* sql`ALTER TABLE peer_environment_links ADD COLUMN fleet_machine_id TEXT`;
});
