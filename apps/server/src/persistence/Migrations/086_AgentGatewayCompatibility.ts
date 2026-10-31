import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_gateway_compatibility_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('legacy', 'shadow', 'adapter')),
    generation INTEGER NOT NULL, shadow_reads INTEGER NOT NULL DEFAULT 0,
    shadow_digest TEXT, backup_id TEXT
  )`;
  yield* sql`INSERT INTO agent_gateway_compatibility_state (id, mode, generation) VALUES (1, 'legacy', 0)`;
  // Retain the old partition schema; all new payloads live in agent_event_facts.
  yield* sql`CREATE TABLE agent_gateway_compatibility_facts (
    fact_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('observation', 'snapshot')),
    environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, native_source_id TEXT NOT NULL,
    native_event_id TEXT, sequence INTEGER NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_gateway_compatibility_inbox (
    principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    source_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_json TEXT, fact_id TEXT REFERENCES agent_event_facts(event_id) DEFERRABLE INITIALLY DEFERRED,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
    CHECK ((event_json IS NULL) <> (fact_id IS NULL)),
    PRIMARY KEY (principal_id, environment_id, thread_id, source_id, event_id)
  )`;
  yield* sql`CREATE INDEX idx_agent_gateway_compatibility_inbox_fact
    ON agent_gateway_compatibility_inbox(fact_id) WHERE fact_id IS NOT NULL`;
  yield* sql`CREATE TABLE agent_gateway_compatibility_cursors (
    principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    source_id TEXT NOT NULL, sequence INTEGER NOT NULL, anchor_event_id TEXT,
    delivery_source_id TEXT NOT NULL,
    PRIMARY KEY (principal_id, environment_id, thread_id)
  )`;
  yield* sql`CREATE TABLE agent_gateway_compatibility_snapshots (
    principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    fact_id TEXT REFERENCES agent_event_facts(event_id) DEFERRABLE INITIALLY DEFERRED,
    receipt_json TEXT,
    CHECK ((receipt_json IS NULL) <> (fact_id IS NULL)),
    PRIMARY KEY (principal_id, environment_id, thread_id)
  )`;
  yield* sql`CREATE TABLE agent_gateway_compatibility_work_snapshots (
    environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    fact_id TEXT REFERENCES agent_event_facts(event_id) DEFERRABLE INITIALLY DEFERRED,
    receipt_json TEXT,
    CHECK ((receipt_json IS NULL) <> (fact_id IS NULL)),
    PRIMARY KEY (environment_id, thread_id)
  )`;
  yield* sql`CREATE TABLE agent_gateway_compatibility_shadows (
    id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, input_fact_id TEXT NOT NULL,
    legacy_digest TEXT NOT NULL, adapter_digest TEXT NOT NULL,
    CHECK (legacy_digest = adapter_digest)
  )`;
  yield* sql`CREATE TABLE agent_gateway_compatibility_backups (
    backup_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, destination TEXT NOT NULL,
    manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL, shadow_digest TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO agent_gateway_compatibility_inbox
    (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged)
    SELECT principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged
    FROM lan_observation_inbox`;
  yield* sql`INSERT INTO agent_gateway_compatibility_cursors
    SELECT principal_id, environment_id, thread_id, source_id, sequence, anchor_event_id, delivery_source_id
    FROM lan_observation_cursors`;
});
