import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_approval_authorizations ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'legacy'
    CHECK (credential_kind IN ('legacy', 'local', 'peer'))`;
  yield* sql`ALTER TABLE agent_approval_authorizations ADD COLUMN authority_snapshot TEXT`;
  yield* sql`CREATE TABLE agent_approval_peer_bindings (
    session_id TEXT PRIMARY KEY REFERENCES agent_approval_authorizations(session_id),
    link_identity_id TEXT NOT NULL REFERENCES agent_approval_destination_links(link_identity_id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    authorization_snapshot TEXT,
    security_snapshot TEXT,
    mode_changed_from_revision INTEGER CHECK (mode_changed_from_revision > 0),
    binding_snapshot TEXT NOT NULL,
    revocation_reason TEXT CHECK (revocation_reason IN ('renewal', 'explicit')),
    effective_revision INTEGER NOT NULL DEFAULT 1 CHECK (effective_revision > 0),
    approval_enabled INTEGER NOT NULL CHECK (approval_enabled IN (0, 1)),
    interaction_mode_ceiling TEXT NOT NULL CHECK (interaction_mode_ceiling IN ('plan', 'default')),
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
  )`;
  yield* sql`CREATE TABLE agent_approval_link_policies (
    link_identity_id TEXT PRIMARY KEY REFERENCES agent_approval_destination_links(link_identity_id),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_approval_fleet_policy_heads (
    fleet_id TEXT NOT NULL, destination_machine_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), digest TEXT NOT NULL,
    entry_json TEXT NOT NULL, valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
    PRIMARY KEY (fleet_id, destination_machine_id)
  )`;
  yield* sql`CREATE TABLE agent_approval_fleet_links (
    link_identity_id TEXT PRIMARY KEY REFERENCES agent_approval_destination_links(link_identity_id),
    fleet_id TEXT NOT NULL, destination_machine_id TEXT NOT NULL, caller_machine_id TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_approval_fleet_policy_grants (
    fleet_id TEXT NOT NULL, destination_machine_id TEXT NOT NULL, caller_machine_id TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    PRIMARY KEY (fleet_id, destination_machine_id, caller_machine_id),
    FOREIGN KEY (fleet_id, destination_machine_id) REFERENCES agent_approval_fleet_policy_heads(fleet_id, destination_machine_id)
  )`;
  yield* sql`CREATE TABLE agent_approval_destination_links (
    link_identity_id TEXT PRIMARY KEY,
    source_environment_id TEXT NOT NULL,
    credential_epoch INTEGER NOT NULL DEFAULT 0 CHECK (credential_epoch >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    replaced_by_link_identity_id TEXT REFERENCES agent_approval_destination_links(link_identity_id),
    UNIQUE (link_identity_id, source_environment_id)
  )`;
  yield* sql`CREATE TABLE agent_approval_peer_renewals (
    previous_session_id TEXT PRIMARY KEY REFERENCES agent_approval_peer_bindings(session_id),
    next_session_id TEXT NOT NULL UNIQUE REFERENCES agent_approval_peer_bindings(session_id),
    link_identity_id TEXT NOT NULL REFERENCES agent_approval_destination_links(link_identity_id),
    previous_binding_revision INTEGER NOT NULL CHECK (previous_binding_revision > 0),
    previous_revision INTEGER NOT NULL CHECK (previous_revision > 0),
    next_revision INTEGER NOT NULL CHECK (next_revision > previous_revision),
    authority_preserved INTEGER NOT NULL CHECK (authority_preserved IN (0, 1)),
    change_reason TEXT NOT NULL CHECK (change_reason IN ('authority_changed', 'mode_ceiling')),
    security_snapshot TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    CHECK (previous_session_id != next_session_id)
  )`;
  yield* sql`CREATE TABLE agent_approval_client_continuations (
    previous_session_id TEXT PRIMARY KEY REFERENCES agent_approval_authorizations(session_id),
    next_session_id TEXT NOT NULL UNIQUE REFERENCES agent_approval_authorizations(session_id),
    initiating_client_id TEXT NOT NULL,
    previous_revision INTEGER NOT NULL CHECK (previous_revision > 0),
    next_revision INTEGER NOT NULL CHECK (next_revision > 0),
    authority_preserved INTEGER NOT NULL CHECK (authority_preserved IN (0, 1)),
    authority_snapshot TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    CHECK (previous_session_id != next_session_id)
  )`;
  for (const table of ["agent_approval_peer_renewals", "agent_approval_client_continuations"]) {
    yield* sql`CREATE TRIGGER ${sql(table + "_immutable_update")} BEFORE UPDATE ON ${sql(table)} BEGIN
      SELECT RAISE(ABORT, 'approval continuity is immutable'); END`;
    yield* sql`CREATE TRIGGER ${sql(table + "_immutable_delete")} BEFORE DELETE ON ${sql(table)} BEGIN
      SELECT RAISE(ABORT, 'approval continuity is immutable'); END`;
  }
  yield* sql`CREATE TABLE agent_thread_approval_origins (
    thread_id TEXT PRIMARY KEY REFERENCES orchestration_v2_projection_threads(thread_id),
    source_environment_id TEXT NOT NULL,
    link_identity_id TEXT NOT NULL,
    initiating_client_id TEXT NOT NULL CHECK (length(initiating_client_id) > 0),
    creation_command_id TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE REFERENCES orchestration_events(sequence),
    FOREIGN KEY (link_identity_id, source_environment_id)
      REFERENCES agent_approval_destination_links(link_identity_id, source_environment_id)
  )`;
  yield* sql`CREATE TRIGGER agent_thread_approval_origins_immutable
    BEFORE UPDATE ON agent_thread_approval_origins BEGIN
      SELECT RAISE(ABORT, 'approval creation provenance is immutable');
    END`;
  yield* sql`CREATE TABLE agent_approval_delegations (
    delegation_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES orchestration_v2_projection_threads(thread_id),
    link_identity_id TEXT NOT NULL REFERENCES agent_approval_destination_links(link_identity_id),
    initiating_client_id TEXT NOT NULL CHECK (length(initiating_client_id) > 0),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`;
  yield* sql`CREATE UNIQUE INDEX agent_approval_delegations_live_target
    ON agent_approval_delegations(thread_id, link_identity_id, initiating_client_id)
    WHERE revoked_at IS NULL`;
  yield* sql`CREATE INDEX agent_approval_delegations_link ON agent_approval_delegations(link_identity_id)`;
});
