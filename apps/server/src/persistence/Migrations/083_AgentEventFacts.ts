import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Phase 2 extends 081's log and leaves all state empty until first use.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_event_log_state
    ADD COLUMN derived_through_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE agent_event_subscriptions
    ADD COLUMN matched_through_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE agent_event_source_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation TEXT NOT NULL,
    origin_environment_id TEXT,
    bootstrap_sequence INTEGER,
    bootstrap_event_id TEXT,
    rebuild_sequence INTEGER,
    rebuild_event_id TEXT,
    activated_at INTEGER,
    last_event_id TEXT,
    gap_sequence INTEGER,
    gap_at INTEGER
  )`;
  yield* sql`CREATE TABLE agent_event_owner_assignments (
    thread_id TEXT PRIMARY KEY,
    source_generation TEXT NOT NULL,
    assignment_revision INTEGER NOT NULL,
    owner_id TEXT
  )`;
  yield* sql`CREATE TABLE agent_event_facts (
    log_seq INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    fact_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    origin_environment_id TEXT NOT NULL,
    origin_generation TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    transition_ordinal INTEGER NOT NULL,
    thread_id TEXT,
    occurred_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    relayed_from TEXT,
    data_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_agent_event_facts_origin
    ON agent_event_facts(origin_environment_id, origin_generation, source_sequence, transition_ordinal)`;
  yield* sql`CREATE INDEX idx_agent_event_facts_thread
    ON agent_event_facts(thread_id, log_seq)`;
  yield* sql`CREATE TABLE agent_event_derivation_state (
    state_key TEXT PRIMARY KEY,
    source_sequence INTEGER NOT NULL,
    state_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_event_reducer_history (
    source_generation TEXT NOT NULL,
    state_key TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    state_json TEXT,
    PRIMARY KEY (source_generation, state_key, source_sequence)
  )`;
  yield* sql`CREATE TABLE agent_event_occurrences (
    event_id TEXT PRIMARY KEY,
    log_seq INTEGER NOT NULL UNIQUE,
    origin_environment_id TEXT NOT NULL,
    source_generation TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    data_digest TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    bootstrap_json TEXT
  )`;
  yield* sql`CREATE INDEX idx_agent_event_occurrences_source
    ON agent_event_occurrences(origin_environment_id, source_generation, source_sequence)`;
  yield* sql`CREATE TABLE agent_event_directories (
    generation TEXT PRIMARY KEY,
    content_digest TEXT,
    status TEXT NOT NULL,
    observed_at INTEGER,
    last_good_observed_at INTEGER,
    directory_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_event_source_directories (
    source_generation TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    directory_generation TEXT NOT NULL REFERENCES agent_event_directories(generation),
    PRIMARY KEY (source_generation, source_sequence)
  )`;
  yield* sql`CREATE INDEX idx_agent_event_source_directories_directory
    ON agent_event_source_directories(directory_generation)`;
  yield* sql`CREATE TABLE agent_event_peer_cursors (
    environment_id TEXT PRIMARY KEY,
    peer_epoch TEXT NOT NULL,
    peer_seq INTEGER NOT NULL,
    status TEXT NOT NULL,
    status_transition INTEGER NOT NULL,
    authorization_generation TEXT,
    updated_at INTEGER NOT NULL,
    detail TEXT
  )`;
});
