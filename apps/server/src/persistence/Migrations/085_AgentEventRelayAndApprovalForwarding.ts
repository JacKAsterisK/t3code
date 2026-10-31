import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_event_relay_imports (
    event_id TEXT PRIMARY KEY,
    origin_environment_id TEXT NOT NULL,
    original_digest TEXT NOT NULL,
    relayed_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_approval_receiver_cancellations (
    principal_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    forwarder_receipt_id TEXT NOT NULL,
    cancelled_at INTEGER NOT NULL,
    PRIMARY KEY (principal_id, client_request_id)
  )`;
  yield* sql`CREATE TABLE agent_approval_forward_operations (
    receipt_id TEXT PRIMARY KEY REFERENCES agent_approval_receipts(receipt_id),
    source_session_id TEXT NOT NULL,
    source_authority_revision INTEGER NOT NULL,
    target_environment_id TEXT NOT NULL,
    forwarding_key TEXT NOT NULL,
    initiating_client_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    operation_json TEXT NOT NULL,
    commit_started INTEGER NOT NULL DEFAULT 0 CHECK (commit_started IN (0, 1)),
    cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
    remote_receipt_id TEXT,
    remote_command_id TEXT,
    status_json TEXT,
    reconcile_done INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_done IN (0, 1)),
    next_reconcile_at INTEGER NOT NULL DEFAULT 0,
    reconcile_failures INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (target_environment_id, forwarding_key)
  )`;
});
