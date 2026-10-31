// @effect-diagnostics nodeBuiltinImport:off -- Tests use only disposable SQLite files and read-only backup connections.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  EventId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type LanTaskObserveResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as CompatibilityFacts from "../agentEvents/AgentGatewayCompatibilityFacts.ts";
import * as Retention from "../agentEvents/AgentFactRetention.ts";
import * as EventLog from "../agentEvents/AgentEventStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration from "../persistence/Migrations/086_AgentGatewayCompatibility.ts";
import * as Compatibility from "./GatewayCompatibility.ts";
import * as CatalogFacts from "../agentEvents/AgentFactStore.ts";
import * as Store from "./RoutingStore.ts";

const environmentId = EnvironmentId.make("environment:compatibility");
const threadId = ThreadId.make("thread:compatibility");
const sourceId = EventId.make("native:thread-created");
const runId = RunId.make("run:compatibility");
const target = { principal: "grant:one", environmentId, threadId };
const page: LanTaskObserveResult = {
  threadId,
  sourceId,
  status: "ok",
  resetReason: null,
  events: [
    {
      eventId: EventId.make("native:queued"),
      sequence: 1,
      kind: "run_state",
      status: "queued",
      runId,
      requestId: null,
    },
    {
      eventId: EventId.make("native:running"),
      sequence: 2,
      kind: "run_state",
      status: "running",
      runId,
      requestId: null,
    },
    {
      eventId: EventId.make("native:approval"),
      sequence: 3,
      kind: "approval",
      status: "pending",
      runId,
      requestId: RuntimeRequestId.make("request:approval"),
    },
    {
      eventId: EventId.make("native:question"),
      sequence: 4,
      kind: "question",
      status: "pending",
      runId,
      requestId: RuntimeRequestId.make("request:question"),
    },
    {
      eventId: EventId.make("native:closed"),
      sequence: 5,
      kind: "request_state",
      status: "resolved",
      runId,
      requestId: RuntimeRequestId.make("request:question"),
    },
    {
      eventId: EventId.make("native:terminal"),
      sequence: 6,
      kind: "run_terminal",
      status: "completed",
      runId,
      requestId: null,
    },
  ],
  nextCursor: { sourceId, sequence: 6, anchorEventId: EventId.make("native:terminal") },
  headSequence: 6,
  hasMore: false,
  taskWorkState: "result_available",
  taskResultRunId: runId,
  taskResultStatus: "completed",
};
const reset: LanTaskObserveResult = {
  ...page,
  status: "reset_required",
  resetReason: "source_changed",
  events: [],
  nextCursor: { sourceId, sequence: 0 },
  taskWorkState: "working",
  taskResultRunId: null,
  taskResultStatus: null,
};
const state0 = { mode: "legacy" as const, generation: 0 };
const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  if (
    (yield* sql`SELECT 1 FROM sqlite_master WHERE name='agent_gateway_compatibility_state'`)
      .length === 0
  )
    yield* Migration;
});
const layer = (filename = ":memory:") =>
  Store.layer.pipe(
    Layer.provideMerge(
      Layer.effectDiscard(setup).pipe(
        Layer.provideMerge(
          NodeSqliteClient.layer({ filename, readerWorker: false, checkpointWorker: false }),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
  );
const temporary = Effect.acquireRelease(
  Effect.sync(() =>
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gateway-compatibility-")),
  ),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);
const prove = (scenario: string, detail: Record<string, unknown>) =>
  Effect.sync(() => {
    process.stdout.write(
      JSON.stringify({ proof: "gateway_compatibility", scenario, ...detail }) + "\n",
    );
  });
const backup = Effect.fn("test.compatibilityBackup")(function* (
  directory: string,
  expected: Parameters<Compatibility.GatewayCompatibility["Service"]["startShadow"]>[0],
  name: string,
) {
  const compatibility = yield* Compatibility.GatewayCompatibility;
  const evidence = yield* compatibility.evidence;
  const receipt = yield* compatibility.createValidatedBackup({
    expected,
    destination: NodePath.join(directory, name),
    shadowDigest: evidence.state!.shadow_digest!,
  });
  return {
    expected,
    backupId: receipt.backupId,
    manifestDigest: receipt.manifestDigest,
    shadowDigest: evidence.state!.shadow_digest!,
  };
});

it.effect(
  "shadows every observation and snapshot/reset from immutable facts, with independent consumer generations",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.RoutingStore;
      const compatibility = yield* Compatibility.GatewayCompatibility;
      const shadow = yield* compatibility.startShadow(state0);
      yield* store.observe(target.principal, environmentId, page, {
        expectedDeliverySourceId: null,
      });
      const first = yield* store.admission(target);
      for (const taskWorkState of [
        "working",
        "waiting_for_children",
        "result_available",
      ] as const) {
        const snapshot = { ...page, events: [], taskWorkState };
        const read = yield* store.observe(target.principal, environmentId, snapshot, {
          expectedDeliverySourceId: sourceId,
          admission: first,
        });
        assert.deepEqual(read.page, snapshot);
        assert.deepEqual(read.pending, page.events);
      }
      for (const resetReason of [
        "source_changed",
        "cursor_ahead",
        "history_unavailable",
      ] as const) {
        const snapshot = { ...reset, resetReason };
        const read = yield* store.observe(target.principal, environmentId, snapshot, {
          expectedDeliverySourceId: sourceId,
        });
        assert.deepEqual(read.page, snapshot);
        assert.deepEqual(read.pending, []);
        assert.deepEqual(
          yield* store.checkpoint(target.principal, environmentId, threadId),
          first.checkpoint,
        );
      }
      const otherDelivery = yield* store.ingest("grant:two", environmentId, page, {
        reset: true,
        expectedDeliverySourceId: null,
      });
      assert.notEqual(otherDelivery, sourceId);
      yield* store.acknowledge(
        target.principal,
        environmentId,
        threadId,
        [page.events[0]!.eventId],
        sourceId,
      );
      yield* store.acknowledge(
        target.principal,
        EnvironmentId.make("environment:other"),
        threadId,
        [page.events[1]!.eventId],
        sourceId,
      );
      yield* store.acknowledge(
        target.principal,
        environmentId,
        ThreadId.make("thread:other"),
        [page.events[1]!.eventId],
        sourceId,
      );
      assert.deepEqual(yield* store.pending("grant:two", environmentId, threadId), page.events);
      assert.deepEqual(
        yield* store.pending(target.principal, environmentId, threadId),
        page.events.slice(1),
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM agent_event_facts WHERE kind='gateway_observation'`)[0]!
          .count,
        page.events.length,
      );
      const kinds = yield* sql<{
        kind: string;
        count: number;
      }>`SELECT kind, COUNT(*) AS count FROM agent_event_facts WHERE source_kind='gateway' GROUP BY kind ORDER BY kind`;
      assert.equal(
        kinds.find((entry) => entry.kind === "gateway_observation")!.count,
        page.events.length,
      );
      assert.equal((yield* compatibility.evidence).shadows, 8);
      assert.deepEqual(yield* compatibility.status, shadow);
      yield* prove("full_parity", {
        kinds: page.events.map((event) => event.kind),
        workStates: 3,
        resets: 3,
        shadowReads: 8,
        sharedObservationFacts: page.events.length,
        ownershipFences: true,
      });
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "cuts over, restarts, rejects stale admission and merges post-cutover ACKs on rollback without resurrection",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const filename = NodePath.join(directory, "state.sqlite");
      const activated = yield* Effect.gen(function* () {
        const store = yield* Store.RoutingStore;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        const shadow = yield* compatibility.startShadow(state0);
        yield* store.ingest(target.principal, environmentId, page, {
          expectedDeliverySourceId: null,
        });
        yield* store.acknowledge(
          target.principal,
          environmentId,
          threadId,
          [page.events[0]!.eventId],
          sourceId,
        );
        const stale = yield* store.admission(target);
        const request = yield* backup(directory, shadow, "cutover.sqlite");
        const active = yield* compatibility.cutover(request);
        const error = yield* compatibility.cutover(request).pipe(Effect.flip);
        assert.equal(error.reason, "expected_current");
        const staleError = yield* store
          .observe(target.principal, environmentId, page, {
            expectedDeliverySourceId: sourceId,
            admission: stale,
          })
          .pipe(Effect.flip);
        assert.equal(staleError.code, "orchestration_error");
        yield* store.acknowledge(
          target.principal,
          environmentId,
          threadId,
          [page.events[1]!.eventId],
          sourceId,
        );
        return active;
      }).pipe(Effect.provide(layer(filename)));
      yield* Effect.gen(function* () {
        const store = yield* Store.RoutingStore;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        assert.deepEqual(yield* compatibility.status, activated);
        assert.deepEqual(
          yield* store.pending(target.principal, environmentId, threadId),
          page.events.slice(2),
        );
        const generation = yield* store.ingest(
          target.principal,
          environmentId,
          { ...page, events: [page.events[0]!] },
          { reset: true, expectedDeliverySourceId: sourceId },
        );
        yield* store.acknowledge(
          target.principal,
          environmentId,
          threadId,
          [page.events[0]!.eventId],
          sourceId,
        );
        assert.deepEqual(yield* store.pending(target.principal, environmentId, threadId), [
          page.events[0]!,
        ]);
        yield* store.acknowledge(
          target.principal,
          environmentId,
          threadId,
          [page.events[0]!.eventId],
          generation,
        );
        const rolledBack = yield* compatibility.rollback(activated);
        assert.deepEqual(yield* store.pending(target.principal, environmentId, threadId), []);
        const sql = yield* SqlClient.SqlClient;
        const bits = yield* sql<{
          source_id: string;
          event_id: string;
          acknowledged: number;
        }>`SELECT source_id, event_id, acknowledged FROM lan_observation_inbox WHERE event_id IN (${page.events[0]!.eventId}, ${page.events[1]!.eventId}) ORDER BY source_id, event_id`;
        assert.equal(bits.length, 3);
        assert.ok(bits.every((row) => row.acknowledged === 1));
        assert.equal((yield* sql`SELECT * FROM lan_owned_threads`).length, 0);
        assert.deepEqual(yield* compatibility.status, rolledBack);
        yield* prove("restart_rollback_ack_merge", {
          adapterGeneration: activated.generation,
          rollbackGeneration: rolledBack.generation,
          nativeSourceId: sourceId,
          deliveryGeneration: generation,
          staleAdmissionRefused: true,
          staleAckIgnored: true,
          acknowledgedRows: bits.length,
          resurrected: 0,
        });
      }).pipe(Effect.provide(layer(filename)));
    }).pipe(Effect.scoped),
);

it.effect(
  "rolls back an interrupted cutover transaction and retries the exact validated backup after restart",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const filename = NodePath.join(directory, "state.sqlite");
      const request = yield* Effect.gen(function* () {
        const store = yield* Store.RoutingStore;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        const sql = yield* SqlClient.SqlClient;
        const shadow = yield* compatibility.startShadow(state0);
        yield* store.ingest(target.principal, environmentId, page, {
          expectedDeliverySourceId: null,
        });
        yield* sql`CREATE TRIGGER interrupt_compatibility_cutover BEFORE UPDATE OF mode ON agent_gateway_compatibility_state WHEN NEW.mode='adapter'
        BEGIN SELECT RAISE(ABORT, 'injected_crash'); END`;
        const request = yield* backup(directory, shadow, "backup.sqlite");
        const failure = yield* compatibility.cutover(request).pipe(Effect.flip);
        assert.equal(failure.reason, "persistence");
        assert.deepEqual(yield* compatibility.status, shadow);
        assert.deepEqual(
          yield* store.pending(target.principal, environmentId, threadId),
          page.events,
        );
        return request;
      }).pipe(Effect.provide(layer(filename)));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER interrupt_compatibility_cutover`;
        const crashed = NodeChildProcess.spawnSync(
          process.execPath,
          [
            "-e",
            `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec("BEGIN IMMEDIATE; UPDATE agent_gateway_compatibility_state SET mode='adapter', generation=generation+1 WHERE id=1");
        process.exit(73);
      `,
            filename,
          ],
          { windowsHide: true, stdio: "pipe" },
        );
        assert.equal(crashed.status, 73);
        assert.equal(
          (yield* sql<{ mode: string }>`SELECT mode FROM agent_gateway_compatibility_state`)[0]!
            .mode,
          "shadow",
        );
        const compatibility = yield* Compatibility.GatewayCompatibility;
        const active = yield* compatibility.cutover(request);
        assert.equal(active.mode, "adapter");
        yield* prove("crash_during_cutover", {
          failedTransactionRolledBack: true,
          crashedPid: crashed.pid,
          crashExitCode: crashed.status,
          uncommittedActivationRecovered: true,
          restartReconciled: true,
          adapterGeneration: active.generation,
        });
      }).pipe(Effect.provide(layer(filename)));
    }).pipe(Effect.scoped),
);

it.effect(
  "validates exact nonwork payloads, secrets, facts and work generations, refusing changed data and backup tampering",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      yield* Effect.gen(function* () {
        const store = yield* Store.RoutingStore;
        const sql = yield* SqlClient.SqlClient;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        yield* sql`CREATE TABLE nonwork_compatibility_probe (id TEXT PRIMARY KEY, payload TEXT, secret_ref TEXT)`;
        yield* sql`CREATE TABLE orchestration_compatibility_probe (id TEXT PRIMARY KEY, generation TEXT, payload TEXT)`;
        yield* sql`INSERT INTO nonwork_compatibility_probe VALUES ('one', 'retained payload', 'secret:test-reference')`;
        yield* sql`INSERT INTO orchestration_compatibility_probe VALUES ('one', 'work:original', 'work payload')`;
        const catalogFact = yield* CatalogFacts.appendFact({
          recordedAt: 1,
          data: {
            schema: "t3.agent-event/1",
            kind: "source_status",
            factKey: "retained:catalog",
            summary: "Retained source status",
            textIsUntrusted: true,
            environment: { id: environmentId, label: "Fixture" },
            thread: null,
            run: null,
            owner: null,
            origin: {
              environmentId,
              sourceGeneration: "source:catalog",
              sourceKind: "peer_status",
              sourceSequence: 1,
              transitionOrdinal: 0,
              threadSequence: null,
              occurredAt: "2026-01-01T00:00:00.000Z",
            },
            relay: null,
            detail: { status: "unavailable" },
          },
        });
        yield* sql`INSERT INTO agent_event_subscriptions
          (subscription_id, principal_id, session_id, attribution_subject, client_label, event_name, arguments_json, callback_url, secret_ref,
           previous_secret_ref, previous_secret_until, state, expires_at, log_epoch, watermark_seq, created_at, updated_at)
          VALUES ('retained-subscription', 'principal:fixture', 'session:fixture', 'client:fixture', 'Fixture', 't3.task_activity', '{}',
            'https://callback.invalid', 'secret:catalog', 'secret:previous', 2, 'expired', 1, 'catalog:epoch', 0, 1, 1)`;
        const operationJson = '{"decision":"decline"}';
        yield* sql`INSERT INTO agent_approval_receipts
          (receipt_id, role, principal_id, client_request_id, operation_digest, operation_json, environment_id, thread_id, request_id, request_incarnation,
           provider_session_id, provider_generation, presentation_digest, decision, effective_scope, grant_digest, command_id, state, authority_revision, actor_json, created_at, updated_at)
          VALUES ('retained-receipt', 'local', 'principal:fixture', 'retry:fixture', 'operation:fixture', ${operationJson}, ${environmentId}, ${threadId},
            'request:fixture', 'incarnation:fixture', 'session:fixture', 'generation:fixture', 'presentation:fixture', 'decline', 'once', 'grant:fixture',
            'command:fixture', 'prepared', 1, '{}', 1, 1)`;
        const shadow = yield* compatibility.startShadow(state0);
        yield* store.ingest(target.principal, environmentId, page, {
          expectedDeliverySourceId: null,
        });
        const request = yield* backup(directory, shadow, "backup.sqlite");
        const snapshot = new NodeSqlite.DatabaseSync(NodePath.join(directory, "backup.sqlite"), {
          readOnly: true,
        });
        try {
          assert.equal(
            snapshot.prepare("SELECT payload FROM nonwork_compatibility_probe").get()!.payload,
            "retained payload",
          );
          assert.throws(() =>
            snapshot.exec("UPDATE nonwork_compatibility_probe SET payload='must fail'"),
          );
        } finally {
          snapshot.close();
        }
        const originalCatalogFact = (yield* sql<{
          data_json: string;
        }>`SELECT data_json FROM agent_event_facts WHERE event_id=${catalogFact.eventId}`)[0]!
          .data_json;
        const originalFact = (yield* sql<{
          payload_json: string;
        }>`SELECT data_json AS payload_json FROM agent_event_facts WHERE origin_generation=${page.events[0]!.eventId}`)[0]!
          .payload_json;
        for (const [change, restore] of [
          [
            sql`UPDATE agent_event_subscriptions SET secret_ref='secret:changed'`,
            sql`UPDATE agent_event_subscriptions SET secret_ref='secret:catalog'`,
          ],
          [
            sql`UPDATE agent_approval_receipts SET operation_json='{}'`,
            sql`UPDATE agent_approval_receipts SET operation_json=${operationJson}`,
          ],
          [
            sql`UPDATE agent_event_facts SET data_json='{}' WHERE event_id=${catalogFact.eventId}`,
            sql`UPDATE agent_event_facts SET data_json=${originalCatalogFact} WHERE event_id=${catalogFact.eventId}`,
          ],
          [
            sql`UPDATE nonwork_compatibility_probe SET payload='changed'`,
            sql`UPDATE nonwork_compatibility_probe SET payload='retained payload'`,
          ],
          [
            sql`UPDATE nonwork_compatibility_probe SET secret_ref='secret:replaced'`,
            sql`UPDATE nonwork_compatibility_probe SET secret_ref='secret:test-reference'`,
          ],
          [
            sql`UPDATE orchestration_compatibility_probe SET generation='work:changed'`,
            sql`UPDATE orchestration_compatibility_probe SET generation='work:original'`,
          ],
          [
            sql`UPDATE agent_event_facts SET data_json='{}' WHERE origin_generation=${page.events[0]!.eventId}`,
            sql`UPDATE agent_event_facts SET data_json=${originalFact} WHERE origin_generation=${page.events[0]!.eventId}`,
          ],
        ]) {
          yield* change!;
          assert.equal(
            (yield* compatibility.cutover(request).pipe(Effect.flip)).reason,
            "backup_stale",
          );
          yield* restore!;
        }
        const tampered = new NodeSqlite.DatabaseSync(NodePath.join(directory, "backup.sqlite"));
        try {
          tampered.exec("UPDATE nonwork_compatibility_probe SET payload='tampered'");
        } finally {
          tampered.close();
        }
        assert.equal(
          (yield* compatibility.cutover(request).pipe(Effect.flip)).reason,
          "backup_stale",
        );
        const evidence = yield* sql<{
          manifest_json: string;
        }>`SELECT manifest_json FROM agent_gateway_compatibility_backups`;
        assert.ok(evidence[0]!.manifest_json.includes('"secretReferences"'));
        yield* prove("backup_payload_invariants", {
          readonlySnapshot: true,
          nonworkPayloadChecked: true,
          secretReferenceChecked: true,
          workGenerationChecked: true,
          factPayloadChecked: true,
          retainedCatalogFactChecked: true,
          retainedSubscriptionChecked: true,
          retainedReceiptChecked: true,
          tamperingRefused: true,
        });
      }).pipe(Effect.provide(layer(NodePath.join(directory, "state.sqlite"))));
    }).pipe(Effect.scoped),
);

it.effect(
  "orders transition/ingest/ACK admission with a reentrant fiber-owned gate before SQL",
  () =>
    Effect.gen(function* () {
      const compatibility = yield* Compatibility.GatewayCompatibility;
      const store = yield* Store.RoutingStore;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attempted = yield* Deferred.make<void>();
      const held = yield* compatibility
        .withGate(
          Effect.gen(function* () {
            yield* compatibility.withGate(Effect.void);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* compatibility.startShadow(state0);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const ingest = yield* Effect.gen(function* () {
        yield* Deferred.succeed(attempted, undefined);
        return yield* store.ingest(target.principal, environmentId, page, {
          expectedDeliverySourceId: null,
        });
      }).pipe(Effect.forkChild);
      yield* Deferred.await(attempted);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(held)).mode, "shadow");
      assert.equal(yield* Fiber.join(ingest), sourceId);
      const failed = yield* compatibility.startShadow(state0).pipe(Effect.flip);
      assert.equal(failed.reason, "expected_current");
      assert.deepEqual(
        yield* store.pending(target.principal, environmentId, threadId),
        page.events,
      );
      yield* prove("serialized_admission", {
        deferredBarriers: true,
        reentrantSameFiber: true,
        staleTransitionRefused: true,
      });
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "keeps imported pending and ACK bits byte-for-byte through active adapter delivery and rollback",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      yield* Effect.gen(function* () {
        const store = yield* Store.RoutingStore;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        const sql = yield* SqlClient.SqlClient;
        const payloads = page.events.slice(0, 2).map((event) => ` ${JSON.stringify(event)} `);
        for (const [index, payload] of payloads.entries())
          yield* sql`INSERT INTO lan_observation_inbox
          (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged)
          VALUES (${target.principal}, ${environmentId}, ${threadId}, ${sourceId}, ${page.events[index]!.eventId}, ${page.events[index]!.sequence}, ${payload}, ${index === 0 ? 1 : 0})`;
        yield* sql`INSERT INTO lan_observation_cursors VALUES (${target.principal}, ${environmentId}, ${threadId}, ${sourceId}, 2, ${page.events[1]!.eventId}, ${sourceId})`;
        const shadow = yield* compatibility.startShadow(state0);
        const importedPage = {
          ...page,
          events: page.events.slice(0, 2),
          headSequence: 2,
          nextCursor: { sourceId, sequence: 2, anchorEventId: page.events[1]!.eventId },
        };
        yield* store.ingest(target.principal, environmentId, importedPage, {
          expectedDeliverySourceId: sourceId,
        });
        const active = yield* compatibility.cutover(
          yield* backup(directory, shadow, "import.sqlite"),
        );
        assert.deepEqual(yield* store.pending(target.principal, environmentId, threadId), [
          page.events[1]!,
        ]);
        const imports = yield* sql<{
          event_json: string;
          fact_id: string | null;
          acknowledged: number;
        }>`SELECT event_json, fact_id, acknowledged FROM agent_gateway_compatibility_inbox ORDER BY sequence`;
        assert.deepEqual(
          imports.map((row) => row.event_json),
          payloads,
        );
        assert.deepEqual(
          imports.map((row) => row.fact_id),
          [null, null],
        );
        assert.deepEqual(
          imports.map((row) => row.acknowledged),
          [1, 0],
        );
        yield* store.acknowledge(
          target.principal,
          environmentId,
          threadId,
          [page.events[1]!.eventId],
          sourceId,
        );
        yield* compatibility.rollback(active);
        assert.deepEqual(yield* store.pending(target.principal, environmentId, threadId), []);
        assert.deepEqual(
          (yield* sql<{
            event_json: string;
          }>`SELECT event_json FROM lan_observation_inbox ORDER BY sequence`).map(
            (row) => row.event_json,
          ),
          payloads,
        );
        yield* prove("imported_pending_ack_bits", {
          exactBytesRetained: true,
          translatedImports: 0,
          importedAckBits: [1, 0],
          activePending: 1,
          rollbackPending: 0,
        });
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.scoped),
);

it.effect(
  "rejects an actual shadow read divergence with equal row counts and rolls back its facts and cursor",
  () =>
    Effect.gen(function* () {
      const compatibility = yield* Compatibility.GatewayCompatibility;
      const store = yield* Store.RoutingStore;
      const sql = yield* SqlClient.SqlClient;
      yield* compatibility.startShadow(state0);
      yield* store.ingest(target.principal, environmentId, page, {
        expectedDeliverySourceId: null,
      });
      const evidence = yield* compatibility.evidence;
      const fact = (yield* sql<{
        fact_id: string;
      }>`SELECT fact_id FROM agent_gateway_compatibility_inbox WHERE event_id=${page.events[1]!.eventId}`)[0]!
        .fact_id;
      yield* sql`UPDATE agent_gateway_compatibility_inbox SET fact_id=${fact} WHERE event_id=${page.events[0]!.eventId}`;
      const failure = yield* store
        .observe(
          target.principal,
          environmentId,
          {
            ...page,
            events: [],
            headSequence: 7,
            nextCursor: { sourceId, sequence: 7, anchorEventId: EventId.make("native:after") },
          },
          { expectedDeliverySourceId: sourceId },
        )
        .pipe(Effect.flip);
      assert.equal(failure.code, "orchestration_error");
      assert.deepEqual(
        yield* store.cursor(target.principal, environmentId, threadId),
        page.nextCursor,
      );
      assert.deepEqual(yield* compatibility.evidence, evidence);
      yield* prove("real_shadow_divergence", {
        equalRowCounts: true,
        differentPayloadRefused: true,
        cursorAndFactWriteRolledBack: true,
      });
    }).pipe(Effect.provide(layer())),
);

it.effect("does not inherit admission permission into a child fiber", () =>
  Effect.gen(function* () {
    const compatibility = yield* Compatibility.GatewayCompatibility;
    const attempted = yield* Deferred.make<void>();
    const passed = yield* Deferred.make<void>();
    const child = yield* compatibility.withGate(
      Effect.gen(function* () {
        const child = yield* Effect.gen(function* () {
          yield* Deferred.succeed(attempted, undefined);
          yield* compatibility.withGate(Deferred.succeed(passed, undefined));
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(attempted);
        assert.equal(yield* Deferred.isDone(passed), false);
        return child;
      }),
    );
    yield* Fiber.join(child);
    assert.equal(yield* Deferred.isDone(passed), true);
    yield* prove("fiber_owned_gate", { childInheritedContextCannotBypass: true });
  }).pipe(Effect.provide(layer()), Effect.scoped),
);

it.effect("checks and rolls back every imported receipt across bounded inbox pages", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const gateway = yield* Compatibility.GatewayCompatibility;
      const payload = " " + JSON.stringify(page.events[0]) + " ";
      for (let index = 0; index < 130; index++)
        yield* sql`INSERT INTO lan_observation_inbox(principal_id,environment_id,thread_id,source_id,event_id,sequence,event_json,acknowledged)
          VALUES (${target.principal},${environmentId},${threadId},${"retired:" + String(index).padStart(3, "0")},${page.events[0]!.eventId},1,${payload},${index % 2})`;
      const shadow = yield* gateway.startShadow(state0);
      yield* gateway.observe(target, page, { expectedDeliverySourceId: null });
      yield* sql`UPDATE agent_gateway_compatibility_inbox SET event_json=${payload + " "} WHERE source_id='retired:100'`;
      const evidence = yield* gateway.evidence;
      const rejected = yield* gateway
        .createValidatedBackup({
          expected: shadow,
          destination: NodePath.join(directory, "refused.sqlite"),
          shadowDigest: evidence.state!.shadow_digest!,
        })
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "shadow_mismatch");
      assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "refused.sqlite")));
      yield* sql`UPDATE agent_gateway_compatibility_inbox SET event_json=${payload} WHERE source_id='retired:100'`;
      const active = yield* gateway.cutover(yield* backup(directory, shadow, "paged.sqlite"));
      // Prove the last page also flows from the adapter during rollback.
      yield* sql`UPDATE agent_gateway_compatibility_inbox SET acknowledged=1 WHERE source_id='retired:128'`;
      yield* gateway.rollback(active);
      const rows = yield* sql<{
        event_json: string;
        acknowledged: number;
        source_id: string;
      }>`SELECT event_json,acknowledged,source_id
        FROM lan_observation_inbox WHERE source_id LIKE 'retired:%' ORDER BY source_id`;
      assert.equal(rows.length, 130);
      assert.ok(rows.every((row) => row.event_json === payload));
      assert.equal(rows[128]!.acknowledged, 1);
      assert.equal(rows[129]!.acknowledged, 1);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(layer()));
  }).pipe(Effect.scoped),
);

it.effect.each(["legacy", "shadow", "adapter"] as const)(
  "keeps aged unchanged-page receipts out of live %s pointers across restart and reset",
  (mode) =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const filename = NodePath.join(directory, "aged.sqlite");
      const original = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        yield* sql`UPDATE agent_gateway_compatibility_state SET mode=${mode}`;
        yield* TestClock.setTime(0);
        yield* CompatibilityFacts.captureWorkSnapshot(environmentId, page, {
          controlsJson: "initial",
        });
        yield* compatibility.observe(target, page, { expectedDeliverySourceId: null });
        for (let day = 1; day <= 16; day++) {
          yield* TestClock.setTime(day * 86_400_000);
          yield* CompatibilityFacts.captureWorkSnapshot(environmentId, page, {
            controlsJson: "controls:" + day,
            currentSequence: day,
            pendingRestart: day % 2 === 0,
          });
          yield* Retention.pruneLog(day * 86_400_000);
        }
        const occurrences =
          yield* sql`SELECT event_id,log_seq,data_digest FROM agent_event_occurrences WHERE source_kind='gateway' ORDER BY log_seq`;
        assert.isAbove((yield* EventLog.logState()).floorSeq, 1);
        const observed = yield* compatibility.observe(target, page, {
          expectedDeliverySourceId: sourceId,
        });
        assert.deepEqual(observed.page, page);
        assert.deepEqual(observed.pending, page.events);
        const pointer = (yield* sql<{
          fact_id: string | null;
          receipt_json: string;
        }>`SELECT fact_id,receipt_json FROM agent_gateway_compatibility_snapshots`)[0]!;
        assert.isNull(pointer.fact_id);
        assert.deepEqual(JSON.parse(pointer.receipt_json), page);
        const head = (yield* EventLog.logState()).headSeq;
        yield* CompatibilityFacts.captureWorkSnapshot(environmentId, page, {
          controlsJson: "controls:16",
          currentSequence: 16,
          pendingRestart: true,
        });
        const workPointer = (yield* sql<{
          fact_id: string | null;
          receipt_json: string;
        }>`SELECT fact_id,receipt_json FROM agent_gateway_compatibility_work_snapshots`)[0]!;
        assert.isOk(workPointer.fact_id ?? workPointer.receipt_json);
        assert.equal((yield* EventLog.logState()).headSeq, head);
        const late = { ...target, principal: "grant:late" };
        const lateRead = yield* compatibility.observe(late, page, {
          expectedDeliverySourceId: null,
        });
        assert.deepEqual(lateRead.pending, page.events);
        const reset = yield* compatibility.observe(target, page, {
          expectedDeliverySourceId: sourceId,
          reset: true,
        });
        yield* compatibility.acknowledge(target, [page.events[0]!.eventId], sourceId);
        assert.deepEqual(yield* compatibility.pending(target), page.events);
        assert.deepEqual(
          yield* sql`SELECT event_id,log_seq,data_digest FROM agent_event_occurrences WHERE source_kind='gateway' ORDER BY log_seq`,
          occurrences,
        );
        if (mode === "shadow") {
          const active = yield* compatibility.cutover(
            yield* backup(directory, { mode, generation: 0 }, "aged-backup.sqlite"),
          );
          yield* compatibility.rollback(active);
          assert.deepEqual(yield* compatibility.pending(target), page.events);
        }
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        return reset.deliverySourceId;
      }).pipe(Effect.provide(layer(filename)));
      yield* Effect.gen(function* () {
        const compatibility = yield* Compatibility.GatewayCompatibility;
        assert.deepEqual(yield* compatibility.pending(target), page.events);
        assert.equal((yield* compatibility.checkpoint(target))!.deliverySourceId, original);
        yield* compatibility.acknowledge(target, [page.events[0]!.eventId], original);
        assert.deepEqual(yield* compatibility.pending(target), page.events.slice(1));
      }).pipe(Effect.provide(layer(filename)));
    }).pipe(Effect.scoped),
);

it.effect(
  "preserves issued bytes through shadow reset, validated backup, cutover and adapter rollback",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const compatibility = yield* Compatibility.GatewayCompatibility;
        const shadow = yield* compatibility.startShadow(state0);
        yield* compatibility.observe(target, page, { expectedDeliverySourceId: null });
        const issued =
          yield* sql`SELECT event_id,event_json FROM lan_observation_inbox ORDER BY event_id`;
        const reset = yield* compatibility.observe(target, page, {
          expectedDeliverySourceId: sourceId,
          reset: true,
        });
        assert.deepEqual(
          yield* sql`SELECT event_id,event_json FROM agent_gateway_compatibility_inbox WHERE source_id=${sourceId} ORDER BY event_id`,
          issued,
        );
        const request = yield* backup(directory, shadow, "reset-backup.sqlite");
        const active = yield* compatibility.cutover(request);
        const replay = yield* compatibility.observe(target, page, {
          expectedDeliverySourceId: reset.deliverySourceId,
          reset: true,
        });
        yield* compatibility.acknowledge(target, [page.events[0]!.eventId], reset.deliverySourceId);
        assert.deepEqual(yield* compatibility.pending(target), page.events);
        yield* compatibility.acknowledge(
          target,
          [page.events[0]!.eventId],
          replay.deliverySourceId,
        );
        yield* compatibility.rollback(active);
        assert.deepEqual(
          yield* sql`SELECT event_id,event_json FROM lan_observation_inbox WHERE source_id=${sourceId} ORDER BY event_id`,
          issued,
        );
        assert.deepEqual(
          yield* sql`SELECT event_id,event_json FROM lan_observation_inbox WHERE source_id=${reset.deliverySourceId} ORDER BY event_id`,
          issued,
        );
        assert.deepEqual(yield* compatibility.pending(target), page.events.slice(1));
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(layer(NodePath.join(directory, "reset.sqlite"))));
    }).pipe(Effect.scoped),
);
