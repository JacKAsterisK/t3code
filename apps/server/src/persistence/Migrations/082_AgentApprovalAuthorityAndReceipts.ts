import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_approval_authorizations (
    session_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, consent_family_id TEXT NOT NULL,
    initiating_client_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
    replaced_by_session_id TEXT, updated_at INTEGER NOT NULL, runtime_mode_ceiling TEXT NOT NULL DEFAULT 'approval-required'
  )`;
  yield* sql`CREATE INDEX idx_agent_approval_family ON agent_approval_authorizations(application_id, consent_family_id)`;
  yield* sql`CREATE TABLE agent_approval_receipts (
    receipt_id TEXT PRIMARY KEY, role TEXT NOT NULL, principal_id TEXT NOT NULL, client_request_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL, operation_json TEXT NOT NULL, environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, request_id TEXT NOT NULL, request_incarnation TEXT NOT NULL,
    provider_session_id TEXT NOT NULL, provider_generation TEXT NOT NULL, presentation_digest TEXT NOT NULL,
    decision TEXT NOT NULL, effective_scope TEXT NOT NULL, grant_digest TEXT NOT NULL,
    command_id TEXT NOT NULL, state TEXT NOT NULL, delivery_evidence_json TEXT, delivery_admitted_revision INTEGER,
    authority_revision INTEGER NOT NULL, actor_json TEXT NOT NULL, via_environment_id TEXT, upstream_receipt_id TEXT,
    result_sequence INTEGER, failure_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX idx_agent_approval_retry ON agent_approval_receipts(principal_id, client_request_id, role)`;
  yield* sql`CREATE UNIQUE INDEX idx_agent_approval_command ON agent_approval_receipts(command_id, role)`;
});
