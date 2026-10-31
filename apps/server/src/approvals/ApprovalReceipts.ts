import type {
  ApprovalReceiptResult,
  ApprovalGuard,
  ApprovalFailureCode,
  ApprovalDeliveryEvidence,
  ApprovalReceiptState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";
import { canonicalApprovalJson } from "@t3tools/shared/approvalPresentation";

export class ApprovalReceiptConflict extends Schema.TaggedError<ApprovalReceiptConflict>()(
  "ApprovalReceiptConflict",
  {
    receiptId: Schema.String,
    approvalCode: Schema.Literal("authority_revoked"),
  },
) {}

export interface ReceiptRow {
  readonly receipt_id: string;
  readonly command_id: string;
  readonly state: ApprovalReceiptState;
  readonly operation_digest: string;
  readonly operation_json: string;
  readonly actor_json: string;
  readonly authority_revision: number;
  readonly decision: "accept" | "decline";
  readonly effective_scope: "once" | "turn";
  readonly result_sequence: number | null;
  readonly failure_code: ApprovalFailureCode | null;
  readonly delivery_evidence_json: string | null;
}
export const find = Effect.fn("ApprovalReceipts.find")(function* (
  principal: string,
  key: string,
  role: "local" | "receiver" = "local",
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<ReceiptRow>`SELECT * FROM agent_approval_receipts WHERE principal_id = ${principal} AND client_request_id = ${key} AND role = ${role}`)[0];
});
export const byCommand = Effect.fn("ApprovalReceipts.byCommand")(function* (commandId: string) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<ReceiptRow>`SELECT * FROM agent_approval_receipts WHERE command_id = ${commandId} AND role IN ('local', 'receiver')`)[0];
});
export const commit = Effect.fn("ApprovalReceipts.commit")(function* (
  guard: ApprovalGuard,
  commandId: string,
  sequence: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows =
    yield* sql`UPDATE agent_approval_receipts SET state = 'committed', result_sequence = ${sequence}, updated_at = ${now}
    WHERE receipt_id = ${guard.receiptId} AND command_id = ${commandId} AND principal_id = ${guard.principalId}
      AND authority_revision = ${guard.authorityRevision} AND state = 'prepared' RETURNING receipt_id`;
  if (rows.length !== 1)
    return yield* new ApprovalReceiptConflict({
      receiptId: guard.receiptId,
      approvalCode: "authority_revoked",
    });
});
const predecessors: Readonly<Record<ApprovalReceiptState, ReadonlyArray<ApprovalReceiptState>>> = {
  prepared: [],
  committed: [],
  refused: ["prepared"],
  delivery_admitted: ["committed"],
  delivery_withheld: ["committed"],
  delivery_failed: ["committed", "delivery_admitted"],
  delivery_unknown: ["committed", "delivery_admitted"],
  response_written: ["delivery_admitted"],
  provider_acknowledged: ["response_written"],
};

export const transition = Effect.fn("ApprovalReceipts.transition")(function* (
  commandId: string,
  state: ApprovalReceiptState,
  evidence: ApprovalDeliveryEvidence,
  failureCode?: ApprovalFailureCode,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const changed =
    yield* sql`UPDATE agent_approval_receipts SET state = ${state}, delivery_evidence_json = ${canonicalApprovalJson(evidence)},
    failure_code = ${failureCode ?? null}, updated_at = ${now} WHERE command_id = ${commandId} AND role IN ('local', 'receiver')
    AND ${sql.in("state", predecessors[state])} RETURNING receipt_id`;
  return changed.length === 1;
});
/** Recover older prepared/rejected crash pairs without retrying the native response. */
export const reconcileNativeRejections = Effect.fn("ApprovalReceipts.reconcileNativeRejections")(
  function* (commandId?: string) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly commandId: string;
        }>`SELECT approval.command_id AS "commandId"
      FROM agent_approval_receipts approval JOIN orchestration_command_receipts native
        ON native.command_id = approval.command_id
      WHERE approval.role IN ('local', 'receiver') AND approval.state = 'prepared' AND native.status = 'rejected'
        AND ${commandId === undefined ? sql`1 = 1` : sql`approval.command_id = ${commandId}`}`;
        for (const row of rows)
          yield* transition(
            row.commandId,
            "refused",
            { commandId: row.commandId, boundary: "reconciliation" },
            "native_rejected",
          );
      }),
    );
  },
);

export function result(row: ReceiptRow, replayed: boolean): ApprovalReceiptResult {
  return {
    receiptId: row.receipt_id,
    commandId: row.command_id,
    state: row.state,
    replayed,
    decision: row.decision,
    effectiveScope: row.effective_scope,
    ...(row.result_sequence === null ? {} : { sequence: row.result_sequence }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.delivery_evidence_json === null
      ? {}
      : { deliveryEvidence: JSON.parse(row.delivery_evidence_json) as ApprovalDeliveryEvidence }),
  };
}
