import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE UNIQUE INDEX agent_approval_fleet_policy_head_identity
    ON agent_approval_fleet_policy_heads(fleet_id, destination_machine_id, revision, digest)`;
  yield* sql`CREATE TABLE agent_approval_fleet_policy_publications (
    fleet_id TEXT NOT NULL,
    destination_machine_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (fleet_id, destination_machine_id),
    FOREIGN KEY (fleet_id, destination_machine_id, revision, digest)
      REFERENCES agent_approval_fleet_policy_heads(fleet_id, destination_machine_id, revision, digest)
      ON DELETE CASCADE
  )`;
});
