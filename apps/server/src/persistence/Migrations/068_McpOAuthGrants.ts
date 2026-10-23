import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE auth_mcp_grants (
    grant_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE REFERENCES auth_sessions(session_id),
    access TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    renewable INTEGER NOT NULL,
    revoked_at INTEGER
  )`;
  yield* sql`CREATE TABLE auth_mcp_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES auth_mcp_grants(grant_id) ON DELETE CASCADE,
    spent INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX idx_auth_mcp_refresh_grant ON auth_mcp_refresh_tokens(grant_id)`;
  yield* sql`CREATE TABLE auth_mcp_grant_sessions (
    session_id TEXT PRIMARY KEY REFERENCES auth_sessions(session_id),
    grant_id TEXT NOT NULL REFERENCES auth_mcp_grants(grant_id) ON DELETE CASCADE
  )`;
});
