import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE lan_owned_threads (
    principal_id TEXT NOT NULL, environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    PRIMARY KEY (principal_id, environment_id, thread_id)
  )`;
  yield* sql`CREATE TABLE lan_observation_inbox (
    principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    source_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (principal_id, environment_id, thread_id, source_id, event_id)
  )`;
  yield* sql`CREATE TABLE lan_observation_cursors (
    principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    source_id TEXT NOT NULL, sequence INTEGER NOT NULL, anchor_event_id TEXT,
    PRIMARY KEY (principal_id, environment_id, thread_id)
  )`;
});
