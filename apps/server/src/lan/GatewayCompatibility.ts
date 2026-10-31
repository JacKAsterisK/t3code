// @effect-diagnostics nodeBuiltinImport:off -- Backup destinations use file URIs with SQLite's explicit read-only mode.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  type EnvironmentId,
  EventId,
  LanTaskEventCursor,
  LanTaskObservation,
  type LanTaskObserveResult,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Facts from "../agentEvents/AgentGatewayCompatibilityFacts.ts";
import { manifest } from "./GatewayCompatibilityManifest.ts";

const Expected = Schema.Struct({
  mode: Schema.Literals(["legacy", "shadow", "adapter"]),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type Expected = typeof Expected.Type;
type Checkpoint = {
  readonly cursor: typeof LanTaskEventCursor.Type;
  readonly deliverySourceId: EventId;
};
type Target = {
  readonly principal: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
};
type Admission = {
  readonly checkpoint: Checkpoint | undefined;
  readonly adapter: Expected | undefined;
};
type IngestOptions = {
  readonly reset?: boolean;
  readonly expectedDeliverySourceId: EventId | null;
  readonly admission?: Admission;
};
type Read = {
  readonly page: LanTaskObserveResult;
  readonly deliverySourceId: EventId;
  readonly pending: ReadonlyArray<typeof LanTaskObservation.Type>;
};
type ControlRow = Expected & {
  readonly shadow_reads: number;
  readonly shadow_digest: string | null;
  readonly backup_id: string | null;
};
type InboxRow = {
  principal_id: string;
  environment_id: string;
  thread_id: string;
  source_id: string;
  event_id: string;
  sequence: number;
  event_json: string;
  acknowledged: number;
};
const decodeCursor = Schema.decodeUnknownEffect(LanTaskEventCursor);
const decodeId = Schema.decodeUnknownEffect(EventId);
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(LanTaskObservation));
const decodeObservation = Schema.decodeUnknownEffect(Schema.fromJsonString(LanTaskObservation));

export class GatewayCompatibilityError extends Schema.TaggedError<GatewayCompatibilityError>()(
  "GatewayCompatibilityError",
  {
    reason: Schema.Literals([
      "schema_unavailable",
      "expected_current",
      "invalid_page",
      "payload_changed",
      "shadow_mismatch",
      "backup_required",
      "backup_stale",
      "persistence",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Gateway compatibility refused (${this.reason}).`;
  }
}
const isError = Schema.is(GatewayCompatibilityError);
const persistenceError = (cause: unknown) =>
  isError(cause) ? cause : new GatewayCompatibilityError({ reason: "persistence", cause });

export class GatewayCompatibility extends Context.Service<
  GatewayCompatibility,
  {
    readonly status: Effect.Effect<Expected | undefined, GatewayCompatibilityError>;
    readonly admission: (target: Target) => Effect.Effect<Admission, GatewayCompatibilityError>;
    readonly checkpoint: (
      target: Target,
    ) => Effect.Effect<Checkpoint | undefined, GatewayCompatibilityError>;
    readonly pending: (
      target: Target,
      expectedSourceId?: EventId,
    ) => Effect.Effect<Read["pending"], GatewayCompatibilityError>;
    readonly ingest: (
      target: Target,
      page: LanTaskObserveResult,
      options: IngestOptions,
    ) => Effect.Effect<EventId, GatewayCompatibilityError>;
    readonly observe: (
      target: Target,
      page: LanTaskObserveResult,
      options: IngestOptions,
    ) => Effect.Effect<Read, GatewayCompatibilityError>;
    readonly acknowledge: (
      target: Target,
      ids: ReadonlyArray<string>,
      sourceId: EventId,
    ) => Effect.Effect<void, GatewayCompatibilityError>;
    readonly startShadow: (
      expected: Expected,
    ) => Effect.Effect<Expected, GatewayCompatibilityError>;
    readonly createValidatedBackup: (input: {
      readonly expected: Expected;
      readonly destination: string;
      readonly shadowDigest: string;
    }) => Effect.Effect<
      { readonly backupId: string; readonly manifestDigest: string },
      GatewayCompatibilityError
    >;
    readonly cutover: (input: {
      readonly expected: Expected;
      readonly backupId: string;
      readonly manifestDigest: string;
      readonly shadowDigest: string;
    }) => Effect.Effect<Expected, GatewayCompatibilityError>;
    readonly rollback: (expected: Expected) => Effect.Effect<Expected, GatewayCompatibilityError>;
    readonly evidence: Effect.Effect<
      { readonly state: ControlRow | undefined; readonly facts: number; readonly shadows: number },
      GatewayCompatibilityError
    >;
    readonly withGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/lan/GatewayCompatibility") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const gate = yield* Semaphore.make(1);
  const owner = Context.Reference<number | null>("t3/lan/GatewayCompatibility/gateOwner", {
    defaultValue: () => null,
  });
  const withGate: GatewayCompatibility["Service"]["withGate"] = (effect) =>
    Effect.withFiber((fiber) =>
      Effect.flatMap(owner, (held) =>
        held === fiber.id
          ? effect
          : gate.withPermit(effect.pipe(Effect.provideService(owner, fiber.id))),
      ),
    );
  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withGate(effect.pipe(Effect.provideService(SqlClient.SqlClient, sql))).pipe(
      Effect.mapError(persistenceError),
    );
  // These helpers run only inside the outer admission gate/transaction span.
  const control = Effect.fnUntraced(function* () {
    const present =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_gateway_compatibility_state'`;
    if (present.length === 0) return undefined;
    const row =
      (yield* sql<ControlRow>`SELECT mode, generation, shadow_reads, shadow_digest, backup_id FROM agent_gateway_compatibility_state WHERE id=1`)[0];
    if (row === undefined)
      return yield* new GatewayCompatibilityError({ reason: "schema_unavailable" });
    return row;
  });
  const expect = Effect.fnUntraced(function* (expected: Expected) {
    const current = yield* control();
    if (current === undefined)
      return yield* new GatewayCompatibilityError({ reason: "schema_unavailable" });
    if (current.mode !== expected.mode || current.generation !== expected.generation)
      return yield* new GatewayCompatibilityError({ reason: "expected_current" });
    return current;
  });
  const token = (current: ControlRow | undefined): Expected | undefined =>
    current === undefined ? undefined : { mode: current.mode, generation: current.generation };
  const table = (adapter: boolean, kind: "inbox" | "cursors") =>
    sql(adapter ? `agent_gateway_compatibility_${kind}` : `lan_observation_${kind}`);
  const checkpointFrom = Effect.fnUntraced(function* (target: Target, adapter: boolean) {
    const row = (yield* sql<{
      source_id: string;
      sequence: number;
      anchor_event_id: string | null;
      delivery_source_id: string;
    }>`
      SELECT source_id, sequence, anchor_event_id, delivery_source_id FROM ${table(adapter, "cursors")}
      WHERE principal_id=${target.principal} AND environment_id=${target.environmentId} AND thread_id=${target.threadId}`)[0];
    return row === undefined
      ? undefined
      : {
          cursor: yield* decodeCursor({
            sourceId: row.source_id,
            sequence: row.sequence,
            ...(row.anchor_event_id === null ? {} : { anchorEventId: row.anchor_event_id }),
          }),
          deliverySourceId: yield* decodeId(row.delivery_source_id),
        };
  });
  const pendingFrom = Effect.fnUntraced(function* (
    target: Target,
    adapter: boolean,
    expectedSourceId?: EventId,
  ) {
    const current = yield* checkpointFrom(target, adapter);
    if (expectedSourceId !== undefined && current?.deliverySourceId !== expectedSourceId)
      return yield* new GatewayCompatibilityError({ reason: "expected_current" });
    if (current === undefined) return [];
    const rows = adapter
      ? yield* sql<{
          event_json: string;
        }>`SELECT COALESCE(inbox.event_json, json_extract(fact.data_json, '$.payload')) AS event_json
          FROM agent_gateway_compatibility_inbox inbox LEFT JOIN agent_event_facts fact ON fact.event_id=inbox.fact_id
          WHERE inbox.principal_id=${target.principal} AND inbox.environment_id=${target.environmentId} AND inbox.thread_id=${target.threadId}
            AND source_id=${current.deliverySourceId} AND acknowledged=0 ORDER BY inbox.sequence, inbox.event_id LIMIT 101`
      : yield* sql<{ event_json: string }>`SELECT event_json FROM lan_observation_inbox inbox
          WHERE principal_id=${target.principal} AND environment_id=${target.environmentId} AND thread_id=${target.threadId}
            AND source_id=${current.deliverySourceId} AND acknowledged=0 ORDER BY sequence, event_id LIMIT 101`;
    return yield* Effect.forEach(rows, (row) => decodeObservation(row.event_json));
  });
  const admission = Effect.fn("GatewayCompatibility.admission")(function* (target: Target) {
    const current = yield* control();
    return {
      checkpoint: yield* checkpointFrom(target, current?.mode === "adapter"),
      adapter: token(current),
    };
  }, guarded);
  const checkpoint = Effect.fn("GatewayCompatibility.checkpoint")(function* (target: Target) {
    return (yield* admission(target)).checkpoint;
  });
  const pending = Effect.fn("GatewayCompatibility.pending")(
    function* (target: Target, expectedSourceId?: EventId) {
      const current = yield* control();
      return yield* pendingFrom(target, current?.mode === "adapter", expectedSourceId);
    },
    (effect) => guarded(sql.withTransaction(effect)),
  );

  const project = Effect.fnUntraced(function* (
    target: Target,
    page: LanTaskObserveResult,
    generation: EventId,
    adapter: boolean,
    observationFacts: ReadonlyArray<{ readonly factId: string | null }>,
    reset: boolean,
  ) {
    if (page.status !== "ok") return;
    for (const [index, event] of page.events.entries()) {
      const encoded = yield* encodeObservation(event);
      const existing = adapter
        ? (yield* sql<{
            event_json: string;
            sequence: number;
          }>`SELECT COALESCE(inbox.event_json, json_extract(fact.data_json, '$.payload')) AS event_json, inbox.sequence
            FROM agent_gateway_compatibility_inbox inbox LEFT JOIN agent_event_facts fact ON fact.event_id=inbox.fact_id
            WHERE inbox.principal_id=${target.principal} AND inbox.environment_id=${target.environmentId} AND inbox.thread_id=${target.threadId}
              AND source_id=${generation} AND inbox.event_id=${event.eventId}`)[0]
        : (yield* sql<{
            event_json: string;
            sequence: number;
          }>`SELECT event_json, sequence FROM lan_observation_inbox inbox
            WHERE principal_id=${target.principal} AND environment_id=${target.environmentId} AND thread_id=${target.threadId}
              AND source_id=${generation} AND inbox.event_id=${event.eventId}`)[0];
      if (existing !== undefined) {
        if (
          existing.sequence !== event.sequence ||
          stableStringify(yield* decodeObservation(existing.event_json)) !== stableStringify(event)
        )
          return yield* new GatewayCompatibilityError({ reason: "payload_changed" });
        continue;
      }
      if (adapter) {
        yield* sql`INSERT INTO agent_gateway_compatibility_inbox
          (principal_id, environment_id, thread_id, source_id, event_id, sequence, fact_id, event_json)
          VALUES (${target.principal}, ${target.environmentId}, ${target.threadId}, ${generation}, ${event.eventId}, ${event.sequence}, ${observationFacts[index]!.factId}, ${observationFacts[index]!.factId === null ? encoded : null})`;
      } else {
        yield* sql`INSERT INTO lan_observation_inbox (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json)
          VALUES (${target.principal}, ${target.environmentId}, ${target.threadId}, ${generation}, ${event.eventId}, ${event.sequence}, ${encoded})`;
      }
    }
    yield* sql`INSERT INTO ${table(adapter, "cursors")}
      (principal_id, environment_id, thread_id, source_id, sequence, anchor_event_id, delivery_source_id)
      VALUES (${target.principal}, ${target.environmentId}, ${target.threadId}, ${page.sourceId}, ${page.nextCursor.sequence}, ${page.nextCursor.anchorEventId ?? null}, ${generation})
      ON CONFLICT(principal_id, environment_id, thread_id) DO UPDATE SET
        source_id=excluded.source_id, sequence=excluded.sequence, anchor_event_id=excluded.anchor_event_id, delivery_source_id=excluded.delivery_source_id
      WHERE (source_id=excluded.source_id AND sequence<=excluded.sequence) OR ${reset ? 1 : 0}`;
  });
  const compare = Effect.fnUntraced(function* (
    target: Target,
    legacyPage: LanTaskObserveResult,
    factId: string,
    current: ControlRow,
  ) {
    const adapterPage = yield* Facts.readPage(factId);
    const legacy = {
      page: legacyPage,
      checkpoint: yield* checkpointFrom(target, false),
      pending: legacyPage.status === "ok" ? yield* pendingFrom(target, false) : [],
    };
    const adapter = {
      page: adapterPage,
      checkpoint: yield* checkpointFrom(target, true),
      pending: adapterPage.status === "ok" ? yield* pendingFrom(target, true) : [],
    };
    const legacyDigest = Facts.digest(legacy);
    const adapterDigest = Facts.digest(adapter);
    if (legacyDigest !== adapterDigest)
      return yield* new GatewayCompatibilityError({ reason: "shadow_mismatch" });
    yield* sql`INSERT INTO agent_gateway_compatibility_shadows (generation, input_fact_id, legacy_digest, adapter_digest)
      VALUES (${current.generation}, ${factId}, ${legacyDigest}, ${adapterDigest})`;
    yield* sql`UPDATE agent_gateway_compatibility_state SET shadow_reads=shadow_reads+1, shadow_digest=${Facts.digest([current.shadow_digest, factId, legacyDigest])}, backup_id=NULL WHERE id=1`;
  });
  const observe = Effect.fn("GatewayCompatibility.observe")(
    function* (target: Target, page: LanTaskObserveResult, options: IngestOptions) {
      const current = yield* control();
      const adapter = current?.mode === "adapter";
      const prior = yield* checkpointFrom(target, adapter);
      if (
        page.threadId !== target.threadId ||
        (prior?.deliverySourceId ?? null) !== options.expectedDeliverySourceId ||
        (options.admission !== undefined &&
          (stableStringify(options.admission.adapter) !== stableStringify(token(current)) ||
            stableStringify(options.admission.checkpoint) !== stableStringify(prior)))
      )
        return yield* new GatewayCompatibilityError({ reason: "expected_current" });
      if (
        page.status === "ok" &&
        (page.nextCursor.sourceId !== page.sourceId ||
          page.nextCursor.sequence > page.headSequence ||
          page.events.length > 100 ||
          (prior !== undefined && !options.reset && prior.cursor.sourceId !== page.sourceId))
      )
        return yield* new GatewayCompatibilityError({ reason: "invalid_page" });
      let previous = -1;
      const ids = new Set<string>();
      for (const event of page.events) {
        if (
          event.sequence <= previous ||
          event.sequence > page.nextCursor.sequence ||
          ids.has(event.eventId)
        )
          return yield* new GatewayCompatibilityError({ reason: "invalid_page" });
        previous = event.sequence;
        ids.add(event.eventId);
      }
      const generation =
        page.status !== "ok"
          ? page.sourceId
          : options.reset
            ? EventId.make(yield* crypto.randomUUIDv4())
            : (prior?.deliverySourceId ?? page.sourceId);
      const facts =
        current !== undefined ? yield* Facts.appendPage(target.environmentId, page) : undefined;
      const immutablePage = facts === undefined ? page : yield* Facts.readPage(facts.snapshot);
      if (current?.mode === "shadow") {
        yield* project(target, page, generation, false, [], options.reset === true);
        yield* project(
          target,
          immutablePage,
          generation,
          true,
          facts!.observations,
          options.reset === true,
        );
        yield* compare(target, page, facts!.snapshot, current);
      } else {
        yield* project(
          target,
          immutablePage,
          generation,
          adapter,
          facts?.observations ?? [],
          options.reset === true,
        );
      }
      if (facts !== undefined)
        yield* sql`INSERT INTO agent_gateway_compatibility_snapshots (principal_id, environment_id, thread_id, fact_id, receipt_json)
        VALUES (${target.principal}, ${target.environmentId}, ${target.threadId}, ${facts.snapshotFactId}, ${facts.snapshotFactId === null ? stableStringify(immutablePage) : null})
        ON CONFLICT(principal_id, environment_id, thread_id) DO UPDATE SET fact_id=excluded.fact_id, receipt_json=excluded.receipt_json`;
      if (current !== undefined && options.reset) yield* Facts.materializeRetired();
      return {
        page: immutablePage,
        deliverySourceId: generation,
        pending: page.status === "ok" ? yield* pendingFrom(target, adapter) : [],
      };
    },
    (effect) => guarded(sql.withTransaction(effect)),
  );
  const ingest = Effect.fn("GatewayCompatibility.ingest")(function* (
    target: Target,
    page: LanTaskObserveResult,
    options: IngestOptions,
  ) {
    if (page.status !== "ok")
      return yield* new GatewayCompatibilityError({ reason: "invalid_page" });
    return (yield* observe(target, page, options)).deliverySourceId;
  });
  const acknowledge = Effect.fn("GatewayCompatibility.acknowledge")(
    function* (target: Target, ids: ReadonlyArray<string>, sourceId: EventId) {
      const current = yield* control();
      const adapter = current?.mode === "adapter";
      const active = yield* checkpointFrom(target, adapter);
      // Legacy ACKs are idempotent, including obsolete generations; they never touch the active one.
      if (ids.length === 0 || active?.deliverySourceId !== sourceId) return;
      yield* sql`UPDATE ${table(adapter, "inbox")} SET acknowledged=1 WHERE principal_id=${target.principal}
      AND environment_id=${target.environmentId} AND thread_id=${target.threadId} AND source_id=${sourceId} AND ${sql.in("event_id", ids)}`;
      if (current !== undefined) {
        const receipts = yield* sql<{
          readonly event_id: string;
          readonly event_json: string;
        }>`SELECT inbox.event_id,
          json_extract(fact.data_json, '$.payload') AS event_json FROM agent_gateway_compatibility_inbox inbox
          JOIN agent_event_facts fact ON fact.event_id = inbox.fact_id
          WHERE inbox.principal_id=${target.principal} AND inbox.environment_id=${target.environmentId} AND inbox.thread_id=${target.threadId}
            AND source_id=${sourceId} AND ${sql.in("inbox.event_id", ids)}`;
        for (const receipt of receipts) {
          const encoded = yield* encodeObservation(yield* decodeObservation(receipt.event_json));
          yield* sql`UPDATE agent_gateway_compatibility_inbox SET event_json=${encoded}, fact_id=NULL, acknowledged=1
            WHERE principal_id=${target.principal} AND environment_id=${target.environmentId} AND thread_id=${target.threadId}
              AND source_id=${sourceId} AND event_id=${receipt.event_id}`;
        }
      }
      if (current !== undefined) {
        yield* sql`UPDATE agent_gateway_compatibility_inbox SET acknowledged=1 WHERE principal_id=${target.principal}
        AND environment_id=${target.environmentId} AND thread_id=${target.threadId} AND source_id=${sourceId} AND ${sql.in("event_id", ids)}`;
      }
      if (current?.mode === "shadow") {
        const legacy = yield* pendingFrom(target, false);
        const adapted = yield* pendingFrom(target, true);
        if (Facts.digest(legacy) !== Facts.digest(adapted))
          return yield* new GatewayCompatibilityError({ reason: "shadow_mismatch" });
        yield* sql`UPDATE agent_gateway_compatibility_state SET backup_id=NULL WHERE id=1`;
      }
    },
    (effect) => guarded(sql.withTransaction(effect)),
  );

  const inboxRows = Effect.fnUntraced(function* (adapter: boolean, after?: InboxRow) {
    const continuation =
      after === undefined
        ? sql``
        : sql`WHERE (inbox.principal_id,inbox.environment_id,inbox.thread_id,inbox.source_id,inbox.event_id) > (${after.principal_id},${after.environment_id},${after.thread_id},${after.source_id},${after.event_id})`;
    if (!adapter)
      return yield* sql<InboxRow>`SELECT * FROM lan_observation_inbox inbox ${continuation} ORDER BY principal_id, environment_id, thread_id, source_id, event_id LIMIT 64`;
    const rows = yield* sql<
      InboxRow & { imported_json: string | null }
    >`SELECT inbox.principal_id, inbox.environment_id, inbox.thread_id, inbox.source_id, inbox.event_id,
      inbox.sequence, inbox.event_json AS imported_json, COALESCE(inbox.event_json, json_extract(fact.data_json, '$.payload')) AS event_json, inbox.acknowledged
      FROM agent_gateway_compatibility_inbox inbox LEFT JOIN agent_event_facts fact ON fact.event_id=inbox.fact_id
      ${continuation} ORDER BY inbox.principal_id, inbox.environment_id, inbox.thread_id, inbox.source_id, inbox.event_id LIMIT 64`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const { imported_json, ...data } = row;
        return {
          ...data,
          event_json:
            imported_json ?? (yield* encodeObservation(yield* decodeObservation(data.event_json))),
        };
      }),
    );
  });
  const inboxDigest = Effect.fnUntraced(function* (adapter: boolean) {
    let after: InboxRow | undefined;
    let digest = Facts.digest([]);
    while (true) {
      const rows = yield* inboxRows(adapter, after);
      if (rows.length === 0) return digest;
      for (const row of rows) digest = Facts.digest([digest, row]);
      after = rows.at(-1)!;
    }
  });
  const verifyCopies = Effect.fnUntraced(function* () {
    // Exact encoded imports, ACK bits and every retired generation matter, not only pending rows.
    if ((yield* inboxDigest(false)) !== (yield* inboxDigest(true)))
      return yield* new GatewayCompatibilityError({ reason: "shadow_mismatch" });
    for (const [left, right] of [
      ["lan_observation_cursors", "agent_gateway_compatibility_cursors"],
      ["agent_gateway_compatibility_cursors", "lan_observation_cursors"],
    ] as const) {
      const difference = yield* sql`SELECT 1 FROM ${sql(left)} a WHERE NOT EXISTS (
        SELECT 1 FROM ${sql(right)} b WHERE a.principal_id=b.principal_id AND a.environment_id=b.environment_id
          AND a.thread_id=b.thread_id AND a.source_id=b.source_id AND a.sequence=b.sequence
          AND a.anchor_event_id IS b.anchor_event_id AND a.delivery_source_id=b.delivery_source_id) LIMIT 1`;
      if (difference.length > 0)
        return yield* new GatewayCompatibilityError({ reason: "shadow_mismatch" });
    }
  });
  const startShadow = Effect.fn("GatewayCompatibility.startShadow")(
    function* (expected: Expected) {
      yield* expect(expected);
      if (expected.mode !== "legacy")
        return yield* new GatewayCompatibilityError({ reason: "expected_current" });
      yield* sql`INSERT INTO agent_gateway_compatibility_inbox
      (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged)
      SELECT principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged FROM lan_observation_inbox inbox WHERE 1
      ON CONFLICT(principal_id, environment_id, thread_id, source_id, event_id) DO UPDATE SET
        sequence=excluded.sequence, event_json=excluded.event_json, fact_id=NULL, acknowledged=MAX(acknowledged, excluded.acknowledged)`;
      yield* sql`INSERT INTO agent_gateway_compatibility_cursors SELECT * FROM lan_observation_cursors WHERE 1
      ON CONFLICT(principal_id, environment_id, thread_id) DO UPDATE SET source_id=excluded.source_id,
        sequence=excluded.sequence, anchor_event_id=excluded.anchor_event_id, delivery_source_id=excluded.delivery_source_id`;
      yield* verifyCopies();
      yield* sql`UPDATE agent_gateway_compatibility_state SET mode='shadow', generation=generation+1, shadow_reads=0, shadow_digest=NULL, backup_id=NULL WHERE id=1`;
      return { mode: "shadow" as const, generation: expected.generation + 1 };
    },
    (effect) => guarded(sql.withTransaction(effect)),
  );

  const createValidatedBackup = Effect.fn("GatewayCompatibility.createValidatedBackup")(
    function* (input: {
      readonly expected: Expected;
      readonly destination: string;
      readonly shadowDigest: string;
    }) {
      const current = yield* expect(input.expected);
      if (
        current.mode !== "shadow" ||
        current.shadow_reads < 1 ||
        current.shadow_digest === null ||
        current.shadow_digest !== input.shadowDigest ||
        !NodePath.isAbsolute(input.destination)
      )
        return yield* new GatewayCompatibilityError({ reason: "backup_required" });
      yield* verifyCopies();
      // VACUUM refuses existing files; it cannot overwrite an installed database.
      yield* sql`VACUUM main INTO ${input.destination}`;
      const uri = NodeURL.pathToFileURL(input.destination);
      uri.searchParams.set("mode", "ro");
      const result = yield* Effect.acquireUseRelease(
        sql`ATTACH DATABASE ${uri.href} AS gateway_compatibility_backup`,
        () =>
          sql.withTransaction(
            Effect.gen(function* () {
              const validatedCurrent = yield* expect(input.expected);
              if (validatedCurrent.shadow_digest !== current.shadow_digest)
                return yield* new GatewayCompatibilityError({ reason: "backup_stale" });
              const integrity = yield* sql<{
                integrity_check: string;
              }>`PRAGMA gateway_compatibility_backup.integrity_check`;
              const backup = yield* manifest("gateway_compatibility_backup");
              const live = yield* manifest("main");
              if (
                integrity.length !== 1 ||
                integrity[0]?.integrity_check !== "ok" ||
                Facts.digest(backup) !== Facts.digest(live)
              )
                return yield* new GatewayCompatibilityError({ reason: "backup_stale" });
              const backupId = `gateway-backup:${yield* crypto.randomUUIDv4()}`;
              const manifestDigest = Facts.digest(live);
              yield* sql`INSERT INTO agent_gateway_compatibility_backups (backup_id, generation, destination, manifest_json, manifest_digest, shadow_digest)
        VALUES (${backupId}, ${current.generation}, ${input.destination}, ${stableStringify(live)}, ${manifestDigest}, ${current.shadow_digest})`;
              yield* sql`UPDATE agent_gateway_compatibility_state SET backup_id=${backupId} WHERE id=1`;
              return { backupId, manifestDigest };
            }),
          ),
        () => sql`DETACH DATABASE gateway_compatibility_backup`.pipe(Effect.orDie),
      );
      return result;
    },
    guarded,
  );
  const cutover = Effect.fn("GatewayCompatibility.cutover")(function* (input: {
    readonly expected: Expected;
    readonly backupId: string;
    readonly manifestDigest: string;
    readonly shadowDigest: string;
  }) {
    yield* expect(input.expected);
    const backup = (yield* sql<{
      generation: number;
      destination: string;
      manifest_digest: string;
      shadow_digest: string;
    }>`SELECT generation, destination, manifest_digest, shadow_digest FROM agent_gateway_compatibility_backups WHERE backup_id=${input.backupId}`)[0];
    if (backup === undefined)
      return yield* new GatewayCompatibilityError({ reason: "backup_required" });
    const uri = NodeURL.pathToFileURL(backup.destination);
    uri.searchParams.set("mode", "ro");
    return yield* Effect.acquireUseRelease(
      sql`ATTACH DATABASE ${uri.href} AS gateway_compatibility_backup`,
      () =>
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* expect(input.expected);
            if (
              current.mode !== "shadow" ||
              current.shadow_reads < 1 ||
              current.backup_id !== input.backupId ||
              current.shadow_digest !== input.shadowDigest
            )
              return yield* new GatewayCompatibilityError({ reason: "backup_required" });
            const live = Facts.digest(yield* manifest("main"));
            const retained = Facts.digest(yield* manifest("gateway_compatibility_backup"));
            if (
              backup.generation !== current.generation ||
              backup.shadow_digest !== current.shadow_digest ||
              backup.manifest_digest !== input.manifestDigest ||
              backup.manifest_digest !== live ||
              retained !== live
            )
              return yield* new GatewayCompatibilityError({ reason: "backup_stale" });
            yield* verifyCopies();
            yield* sql`UPDATE agent_gateway_compatibility_state SET mode='adapter', generation=generation+1 WHERE id=1`;
            return { mode: "adapter" as const, generation: current.generation + 1 };
          }),
        ),
      () => sql`DETACH DATABASE gateway_compatibility_backup`.pipe(Effect.orDie),
    );
  }, guarded);
  const rollback = Effect.fn("GatewayCompatibility.rollback")(
    function* (expected: Expected) {
      yield* expect(expected);
      if (expected.mode !== "adapter")
        return yield* new GatewayCompatibilityError({ reason: "expected_current" });
      let after: InboxRow | undefined;
      while (true) {
        const rows = yield* inboxRows(true, after);
        if (rows.length === 0) break;
        for (const row of rows) {
          yield* sql`INSERT INTO lan_observation_inbox
        (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json, acknowledged)
        VALUES (${row.principal_id}, ${row.environment_id}, ${row.thread_id}, ${row.source_id}, ${row.event_id}, ${row.sequence}, ${row.event_json}, ${row.acknowledged})
        ON CONFLICT(principal_id, environment_id, thread_id, source_id, event_id) DO UPDATE SET
          event_json=excluded.event_json, sequence=excluded.sequence, acknowledged=MAX(acknowledged, excluded.acknowledged)`;
        }
        after = rows.at(-1)!;
      }
      yield* sql`INSERT INTO lan_observation_cursors SELECT * FROM agent_gateway_compatibility_cursors WHERE 1
      ON CONFLICT(principal_id, environment_id, thread_id) DO UPDATE SET source_id=excluded.source_id,
        sequence=excluded.sequence, anchor_event_id=excluded.anchor_event_id, delivery_source_id=excluded.delivery_source_id`;
      yield* verifyCopies();
      yield* sql`UPDATE agent_gateway_compatibility_state SET mode='legacy', generation=generation+1, backup_id=NULL WHERE id=1`;
      yield* Facts.materializeRetired();
      return { mode: "legacy" as const, generation: expected.generation + 1 };
    },
    (effect) => guarded(sql.withTransaction(effect)),
  );
  const status = guarded(Effect.map(control(), token));
  const evidence = guarded(
    Effect.gen(function* () {
      const state = yield* control();
      if (state === undefined) return { state, facts: 0, shadows: 0 };
      return {
        state,
        facts: (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM agent_event_facts WHERE source_kind='gateway'`)[0]!.count,
        shadows: (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM agent_gateway_compatibility_shadows`)[0]!.count,
      };
    }),
  );
  return GatewayCompatibility.of({
    status,
    admission,
    checkpoint,
    pending,
    ingest,
    observe,
    acknowledge,
    startShadow,
    createValidatedBackup,
    cutover,
    rollback,
    evidence,
    withGate,
  });
});
export const layer = Layer.effect(GatewayCompatibility, make);
