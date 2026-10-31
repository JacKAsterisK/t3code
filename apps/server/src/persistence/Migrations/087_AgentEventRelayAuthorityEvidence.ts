import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_event_fact_authority_checks (
    check_id INTEGER PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('prepare', 'dispatch')),
    checked_at INTEGER NOT NULL,
    origin_checked_at TEXT NOT NULL,
    requester_generation TEXT NOT NULL,
    origin_authorization_generation TEXT NOT NULL,
    FOREIGN KEY (subscription_id, event_id) REFERENCES agent_event_deliveries(subscription_id, event_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX agent_event_fact_authority_checks_delivery ON agent_event_fact_authority_checks(subscription_id, event_id, check_id)`;
});
