// @effect-diagnostics nodeBuiltinImport:off -- Internal identities hash immutable native coordinates and snapshot inputs.
import * as NodeCrypto from "node:crypto";
import { LanTaskObservation, LanTaskObserveResult } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Facts from "./AgentFactStore.ts";
import * as Internal from "./AgentInternalFacts.ts";

const decodePage = Schema.decodeUnknownEffect(LanTaskObserveResult);
const decodeObservation = Schema.decodeUnknownEffect(LanTaskObservation);
const decodeObservationJson = Schema.decodeUnknownEffect(Schema.fromJsonString(LanTaskObservation));
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(LanTaskObservation));
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...LanTaskObserveResult.fields,
    events: Schema.Array(Schema.String),
  }),
);
export const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");

export class CompatibilityFactConflict extends Schema.TaggedError<CompatibilityFactConflict>()(
  "CompatibilityFactConflict",
  { factId: Schema.String },
) {
  override get message(): string {
    return "An internal gateway fact conflicts with its immutable payload.";
  }
}

const coordinates = (input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly sourceId: string;
  readonly sequence: number;
  readonly kind: Internal.InternalFact["kind"];
  readonly key: string;
  readonly references?: ReadonlyArray<string>;
}) => ({
  schema: "t3.agent-internal/1" as const,
  factKey: stableStringify([input.kind, input.threadId, input.key]),
  environment: { id: input.environmentId },
  thread: { id: input.threadId },
  origin: {
    environmentId: input.environmentId,
    sourceGeneration: input.sourceId,
    sourceKind: "gateway" as const,
    sourceSequence: input.sequence,
    transitionOrdinal: 0 as const,
    occurredAt: null,
  },
  references: input.references ?? [],
});

// A legacy observation has no occurrence time or generation. Its persisted native event ID is
// the immutable source coordinate, including when read before collection activation or relayed.
export const observationData = (
  environmentId: string,
  threadId: string,
  observation: LanTaskObservation,
) => ({
  ...coordinates({
    environmentId,
    threadId,
    sourceId: observation.eventId,
    sequence: observation.sequence,
    kind: "gateway_observation",
    key: observation.eventId,
  }),
  kind: "gateway_observation" as const,
  payload: observation,
});

export const appendPage = Effect.fn("AgentGatewayCompatibilityFacts.appendPage")(function* (
  environmentId: string,
  input: LanTaskObserveResult,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const page = yield* decodePage(input, { onExcessProperty: "error" });
      const now = yield* Clock.currentTimeMillis;
      const observations = yield* Effect.forEach(page.events, (event) =>
        Facts.appendFact({
          data: observationData(environmentId, page.threadId, event),
          recordedAt: now,
        }),
      );
      const observationIds = observations.map((row) => row.eventId);
      const payload = { ...page, events: observationIds };
      const snapshot = yield* Facts.appendFact({
        data: {
          ...coordinates({
            environmentId,
            threadId: page.threadId,
            sourceId: page.sourceId,
            sequence: page.headSequence,
            kind: "gateway_snapshot",
            key: digest(payload),
            references: observationIds,
          }),
          kind: "gateway_snapshot",
          payload,
        },
        recordedAt: now,
      });
      return {
        snapshot: snapshot.eventId,
        snapshotFactId: snapshot.liveFactId ?? null,
        observations: observations.map((row) => ({
          eventId: row.eventId,
          factId: row.liveFactId ?? null,
        })),
      };
    }),
  );
});

const read = Effect.fn("AgentGatewayCompatibilityFacts.read")(function* (
  factId: string,
  kind: Internal.InternalFact["kind"],
) {
  const fact = yield* Facts.readInternalFact(factId).pipe(
    Effect.mapError(() => new CompatibilityFactConflict({ factId })),
  );
  if (fact.kind !== kind) return yield* new CompatibilityFactConflict({ factId });
  return fact;
});
export const readPage = Effect.fn("AgentGatewayCompatibilityFacts.readPage")(function* (
  factId: string,
) {
  const fact = yield* read(factId, "gateway_snapshot");
  const snapshot = yield* decodeSnapshot(fact.payload, { onExcessProperty: "error" });
  const events = yield* Effect.forEach(snapshot.events, (id) =>
    read(id, "gateway_observation").pipe(
      Effect.flatMap((fact) => decodeObservation(fact.payload, { onExcessProperty: "error" })),
    ),
  );
  return { ...snapshot, events } satisfies LanTaskObserveResult;
});

export const captureWorkSnapshot = Effect.fn("AgentGatewayCompatibilityFacts.captureWorkSnapshot")(
  function* (environmentId: string, page: LanTaskObserveResult, inputs: unknown) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const references = yield* appendPage(environmentId, page);
        const complete = Internal.fitsDataBudget(inputs);
        const split =
          inputs !== null &&
          typeof inputs === "object" &&
          "controlsJson" in inputs &&
          typeof inputs.controlsJson === "string"
            ? (inputs as Record<string, unknown> & { controlsJson: string })
            : null;
        const inputContent = split === null ? inputs : { controlsJson: split.controlsJson };
        const inputsMetadata =
          split === null
            ? undefined
            : Object.fromEntries(Object.entries(split).filter(([key]) => key !== "controlsJson"));
        const inputDigest = complete ? digest(inputContent) : null;
        const inputFact =
          inputDigest === null
            ? null
            : yield* Facts.appendFact({
                data: {
                  ...coordinates({
                    environmentId,
                    threadId: page.threadId,
                    sourceId: "work-input:" + inputDigest,
                    sequence: 0,
                    kind: "gateway_work_inputs",
                    key: inputDigest,
                  }),
                  kind: "gateway_work_inputs",
                  payload: inputContent,
                },
                recordedAt: yield* Clock.currentTimeMillis,
              });
        const payload =
          inputFact === null
            ? { inputs: Internal.overflowEvidence, page: references.snapshot }
            : {
                inputsReference: inputFact.eventId,
                ...(inputsMetadata === undefined ? {} : { inputsMetadata }),
                page: references.snapshot,
              };
        const fact = yield* Facts.appendFact({
          data: {
            ...coordinates({
              environmentId,
              threadId: page.threadId,
              sourceId: page.sourceId,
              sequence: page.headSequence,
              kind: "gateway_work_snapshot",
              key: digest(payload),
              references: [references.snapshot, ...(inputFact === null ? [] : [inputFact.eventId])],
            }),
            kind: "gateway_work_snapshot",
            payload,
          },
          recordedAt: yield* Clock.currentTimeMillis,
        });
        const receipt =
          fact.liveFactId == null ? stableStringify(yield* readWorkSnapshot(fact.eventId)) : null;
        yield* sql`INSERT INTO agent_gateway_compatibility_work_snapshots (environment_id, thread_id, fact_id, receipt_json)
      VALUES (${environmentId}, ${page.threadId}, ${fact.liveFactId ?? null}, ${receipt})
      ON CONFLICT(environment_id, thread_id) DO UPDATE SET fact_id = excluded.fact_id, receipt_json = excluded.receipt_json`;
        return page;
      }),
    );
  },
);

/** Only live references root the log; aged snapshots and retired generations become receipts. */
export const firstPinnedSequence = Effect.fn("AgentGatewayCompatibilityFacts.firstPinnedSequence")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    if (
      (yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'agent_gateway_compatibility_state'`)
        .length === 0
    )
      return null;
    return (yield* sql<{ readonly sequence: number | null }>`WITH RECURSIVE pins(event_id) AS (
    SELECT fact_id FROM agent_gateway_compatibility_inbox WHERE acknowledged = 0 AND fact_id IS NOT NULL
    UNION SELECT fact_id FROM agent_gateway_compatibility_snapshots WHERE fact_id IS NOT NULL
    UNION SELECT fact_id FROM agent_gateway_compatibility_work_snapshots WHERE fact_id IS NOT NULL
    UNION SELECT refs.value FROM pins JOIN agent_event_facts fact ON fact.event_id = pins.event_id AND fact.kind IN ('gateway_snapshot', 'gateway_work_snapshot'),
      json_each(fact.data_json, '$.references') AS refs
  ) SELECT MIN(log_seq) AS sequence FROM agent_event_facts WHERE event_id IN (SELECT event_id FROM pins)`)[0]!
      .sequence;
  },
);

export const readWorkSnapshot = Effect.fn("AgentGatewayCompatibilityFacts.readWorkSnapshot")(
  function* (factId: string) {
    const fact = yield* read(factId, "gateway_work_snapshot");
    if (fact.kind !== "gateway_work_snapshot")
      return yield* new CompatibilityFactConflict({ factId });
    const inputs =
      "inputsReference" in fact.payload
        ? (yield* read(fact.payload.inputsReference, "gateway_work_inputs")).payload
        : fact.payload.inputs;
    const metadata = "inputsMetadata" in fact.payload ? fact.payload.inputsMetadata : undefined;
    return {
      inputs:
        metadata === undefined ? inputs : { ...(inputs as Record<string, unknown>), ...metadata },
      page: yield* readPage(fact.payload.page),
    };
  },
);

// Imported receipts already own their issued bytes. Only live references need materialization.
const materializeInbox = Effect.fn("AgentGatewayCompatibilityFacts.materializeInbox")(function* (
  floor: number,
) {
  const sql = yield* SqlClient.SqlClient;
  let after = 0;
  while (true) {
    const rows = yield* sql<{
      id: number;
      legacyJson: string | null;
      factJson: string | null;
    }>`SELECT inbox.rowid AS id,legacy.event_json AS "legacyJson",
      json_extract(fact.data_json,'$.payload') AS "factJson"
      FROM agent_gateway_compatibility_inbox inbox
      LEFT JOIN agent_event_facts fact ON fact.event_id=inbox.fact_id
      LEFT JOIN lan_observation_inbox legacy ON legacy.principal_id=inbox.principal_id
        AND legacy.environment_id=inbox.environment_id AND legacy.thread_id=inbox.thread_id
        AND legacy.source_id=inbox.source_id AND legacy.event_id=inbox.event_id
      WHERE inbox.rowid > ${after} AND inbox.fact_id IS NOT NULL AND (
        fact.log_seq < ${floor} OR
        (SELECT mode FROM agent_gateway_compatibility_state WHERE id=1)='legacy' OR NOT EXISTS (
          SELECT 1 FROM agent_gateway_compatibility_cursors cursor WHERE cursor.principal_id=inbox.principal_id
            AND cursor.environment_id=inbox.environment_id AND cursor.thread_id=inbox.thread_id
            AND cursor.delivery_source_id=inbox.source_id))
      ORDER BY inbox.rowid LIMIT 64`;
    if (rows.length === 0) return;
    for (const row of rows) {
      const encoded =
        row.legacyJson ?? (yield* encodeObservation(yield* decodeObservationJson(row.factJson)));
      yield* sql`UPDATE agent_gateway_compatibility_inbox SET event_json=${encoded},fact_id=NULL WHERE rowid=${row.id}`;
    }
    after = rows.at(-1)!.id;
  }
});

/** Retired receipts keep issued bytes/ACK bits, without pinning the canonical source log. */
export const materializeRetired = Effect.fn("AgentGatewayCompatibilityFacts.materializeRetired")(
  function* () {
    yield* materializeInbox(0);
  },
);

/** Latest snapshots are replaceable consumer receipts, not permanent retention roots. */
export const releaseBefore = Effect.fn("AgentGatewayCompatibilityFacts.releaseBefore")(function* (
  floor: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (
    (yield* sql`SELECT 1 FROM sqlite_master WHERE name='agent_gateway_compatibility_state'`)
      .length === 0
  )
    return;
  yield* materializeInbox(floor);
  for (const table of [
    "agent_gateway_compatibility_snapshots",
    "agent_gateway_compatibility_work_snapshots",
  ] as const) {
    let after = 0;
    while (true) {
      const rows = yield* sql<{
        id: number;
        factId: string;
      }>`SELECT rowid AS id, fact_id AS "factId" FROM ${sql(table)}
        WHERE rowid > ${after} AND fact_id IS NOT NULL ORDER BY rowid LIMIT 64`;
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.id;
        const crosses =
          (yield* sql`WITH RECURSIVE refs(id) AS (
          SELECT ${row.factId} UNION SELECT ref.value FROM refs JOIN agent_event_facts fact ON fact.event_id=refs.id AND fact.kind IN ('gateway_snapshot', 'gateway_work_snapshot'),
            json_each(fact.data_json, '$.references') ref)
          SELECT 1 FROM agent_event_facts WHERE event_id IN (SELECT id FROM refs) AND log_seq < ${floor} LIMIT 1`)
            .length > 0;
        if (!crosses) continue;
        const receipt =
          table === "agent_gateway_compatibility_snapshots"
            ? yield* readPage(row.factId)
            : yield* readWorkSnapshot(row.factId);
        yield* sql`UPDATE ${sql(table)} SET receipt_json=${stableStringify(receipt)}, fact_id=NULL WHERE rowid=${row.id}`;
      }
    }
  }
});
