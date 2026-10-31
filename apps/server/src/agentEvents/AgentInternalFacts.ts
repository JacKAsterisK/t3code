import { LanTaskObservation, LanTaskObserveResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Full private snapshots are lossless. Overflow is explicit evidence and never blocks native observe.
export const maxDataBytes = 16 * 1024 * 1024;
const fields = {
  schema: Schema.Literal("t3.agent-internal/1"),
  factKey: Schema.String,
  environment: Schema.Struct({ id: Schema.String }),
  thread: Schema.Struct({ id: Schema.String }),
  origin: Schema.Struct({
    environmentId: Schema.String,
    sourceGeneration: Schema.String,
    sourceKind: Schema.Literal("gateway"),
    sourceSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    transitionOrdinal: Schema.Literal(0),
    occurredAt: Schema.Null,
  }),
  references: Schema.Array(Schema.String),
};
const Snapshot = Schema.Struct({
  ...LanTaskObserveResult.fields,
  events: Schema.Array(Schema.String),
});
export const InternalFact = Schema.Union([
  Schema.Struct({
    ...fields,
    kind: Schema.Literal("gateway_observation"),
    payload: LanTaskObservation,
  }),
  Schema.Struct({ ...fields, kind: Schema.Literal("gateway_snapshot"), payload: Snapshot }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal("gateway_work_inputs"),
    payload: Schema.Unknown,
  }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal("gateway_work_snapshot"),
    payload: Schema.Union([
      Schema.Struct({ inputs: Schema.Unknown, page: Schema.String }),
      Schema.Struct({
        inputsReference: Schema.String,
        inputsMetadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        page: Schema.String,
      }),
    ]),
  }),
]);
export type InternalFact = typeof InternalFact.Type;
export const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(InternalFact));
export const isInternal = (data: { readonly schema: string }): data is InternalFact =>
  data.schema === "t3.agent-internal/1";

// NULL preserves each private slot in mixed scans without decoding or exposing its payload.
export const catalogPayload = (sql: SqlClient.SqlClient) =>
  sql`CASE WHEN source_kind = 'gateway' THEN NULL ELSE data_json END`;

/** Bound work before canonical serialization/hashing, including a single oversized string. */
export const fitsDataBudget = (value: unknown, limit = maxDataBytes - 4096): boolean => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let remaining = limit;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.depth > 128 || --remaining < 0) return false;
    const current = entry.value;
    if (typeof current === "string") {
      if (current.length > remaining) return false;
      remaining -= Buffer.byteLength(JSON.stringify(current), "utf8");
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (key.length > remaining) return false;
        remaining -= Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (remaining < 0 || stack.length >= remaining) return false;
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    } else remaining -= 24;
    if (remaining < 0) return false;
  }
  return true;
};
export const overflowEvidence = {
  status: "unavailable",
  reason: "overflow",
  maxDataBytes,
} as const;
