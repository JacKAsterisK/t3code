import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * T3 Code LAN: MCP Events phase 0 (docs/maintenance/agent-events-and-approvals.md). Delivery
 * state, not work: NativeMaintenance's work generation leaves these tables out, and no row is
 * written here, so a fresh home's database is unchanged by it. Webhook secrets are never stored
 * here, only the ServerSecretStore names that hold them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The event log's identity. `head_seq` numbers every event the log holds, probes now and
  // phase 2's facts later, so a cursor stays meaningful when facts arrive. Written on first use.
  yield* sql`
    CREATE TABLE agent_event_log_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      head_seq INTEGER NOT NULL,
      floor_seq INTEGER NOT NULL
    )
  `;
  // Who receives what. The principal is the authorization that subscribed (see AgentEventIdentity),
  // kept apart from the fleet attribution and the client's display label.
  yield* sql`
    CREATE TABLE agent_event_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attribution_subject TEXT NOT NULL,
      client_label TEXT NOT NULL,
      event_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      previous_secret_ref TEXT,
      previous_secret_until INTEGER,
      state TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      log_epoch TEXT NOT NULL,
      watermark_seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      ended_reason TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_agent_event_subscriptions_session
    ON agent_event_subscriptions(session_id)
  `;
  // Operator probes, the only events phase 0 logs. Each targets one subscription. The body is
  // fixed when the probe is made, so a retry or a restart sends the same event.
  yield* sql`
    CREATE TABLE agent_event_probes (
      log_seq INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      subscription_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_agent_event_probes_subscription
    ON agent_event_probes(subscription_id, log_seq)
  `;
  // One row per event per subscription: its delivery progress. The payload stays in the log.
  yield* sql`
    CREATE TABLE agent_event_deliveries (
      subscription_id TEXT NOT NULL
        REFERENCES agent_event_subscriptions(subscription_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      log_seq INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      last_status INTEGER,
      last_error TEXT,
      finished_at INTEGER,
      PRIMARY KEY (subscription_id, event_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_agent_event_deliveries_due
    ON agent_event_deliveries(state, next_attempt_at)
  `;
  yield* sql`
    CREATE INDEX idx_agent_event_deliveries_subscription
    ON agent_event_deliveries(subscription_id, log_seq)
  `;
  yield* sql`
    CREATE TABLE agent_event_callback_verifications (
      principal_id TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, callback_url)
    )
  `;
});
