import {
  ApprovalFailureCode,
  ApprovalGuard,
  ApprovalRespondInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Wire from "../../../../packages/contracts/src/approvalForwarding.ts";
import { approvalOperationDigest } from "@t3tools/shared/approvalPresentation";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Delegations from "./ApprovalDelegations.ts";
import * as Receipts from "./ApprovalReceipts.ts";
import * as Service from "./ApprovalService.ts";

const refuse = (
  code:
    | "link_not_approved"
    | "thread_not_delegated"
    | "idempotency_conflict"
    | "invalid_request"
    | "request_not_found"
    | "authority_revoked",
) => new OrchestratorMcpFailure({ code, message: `Linked approval refused: ${code}.` });
const decodeOperation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ input: ApprovalRespondInput, guard: ApprovalGuard })),
);
const isFailure = Schema.is(OrchestratorMcpFailure);
const isApprovalFailure = Schema.is(ApprovalFailureCode);
const isDelegationError = Schema.is(Delegations.ApprovalDelegationError);
export class ApprovalReceiver extends Context.Service<
  ApprovalReceiver,
  {
    readonly receive: (
      input: Wire.LinkApprovalRequest,
    ) => Effect.Effect<
      Wire.LinkApprovalResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/approvals/ApprovalReceiver") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const access = yield* Delegations.ApprovalDestinationAccess;
  const delegations = yield* Delegations.ApprovalDelegations;
  const service = yield* Service.ApprovalService;
  const here = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const receive = Effect.fn("ApprovalReceiver.receive")(
    function* (input: Wire.LinkApprovalRequest) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const client = scope.client;
      if (
        scope.environmentId !== here ||
        scope.linkedEnvironments !== true ||
        scope.thread !== undefined ||
        client?.linked !== true ||
        client.taskOnly === true ||
        client.grantId !== undefined
      )
        return yield* refuse("link_not_approved");
      const live = yield* access.peer(client.sessionId);
      if (live === undefined || !live.scopes.includes("orchestration:read"))
        return yield* refuse("link_not_approved");
      const handle = yield* delegations.authenticate(input.initiatingClientId);
      const principal = `link:${live.linkIdentityId}:client:${input.initiatingClientId}`;
      const answer = (
        receipt: ReturnType<typeof Receipts.result> | null,
      ): Wire.LinkApprovalResult => ({
        environmentId: here,
        forwarderReceiptId: input.forwarderReceiptId,
        operationDigest: input.operationDigest,
        receipt,
      });
      const checkedRow = Effect.fn("ApprovalReceiver.checkedRow")(function* () {
        let row = yield* Receipts.find(principal, input.clientRequestId, "receiver");
        if (row === undefined) return undefined;
        if (row.state === "prepared") {
          yield* Receipts.reconcileNativeRejections(row.command_id);
          row = (yield* Receipts.find(principal, input.clientRequestId, "receiver"))!;
        }
        const stored = yield* decodeOperation(row.operation_json);
        const destination = stored.guard.destination;
        if (
          destination === undefined ||
          destination.operationDigest !== input.operationDigest ||
          destination.forwarderReceiptId !== input.forwarderReceiptId ||
          destination.forwardingKey !== input.clientRequestId ||
          destination.authority.linkIdentityId !== live.linkIdentityId ||
          destination.authority.sourceEnvironmentId !== live.sourceEnvironmentId ||
          destination.authority.initiatingClientId !== input.initiatingClientId
        )
          return yield* refuse("idempotency_conflict");
        return { row, stored, destination };
      });
      const cancellation = Effect.fn("ApprovalReceiver.cancellation")(function* () {
        const rows = yield* sql<{
          operation_digest: string;
          forwarder_receipt_id: string;
        }>`SELECT operation_digest, forwarder_receipt_id
          FROM agent_approval_receiver_cancellations WHERE principal_id = ${principal} AND client_request_id = ${input.clientRequestId}`;
        const cancelled = rows[0];
        if (
          cancelled !== undefined &&
          (cancelled.operation_digest !== input.operationDigest ||
            cancelled.forwarder_receipt_id !== input.forwarderReceiptId)
        )
          return yield* refuse("idempotency_conflict");
        return cancelled !== undefined;
      });
      if (input.operation === "commit" && input.cancel === true)
        return yield* access.withGate(
          sql.withTransaction(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* cancellation();
              const current = yield* checkedRow();
              yield* sql`INSERT INTO agent_approval_receiver_cancellations(principal_id, client_request_id, operation_digest, forwarder_receipt_id, cancelled_at)
            VALUES (${principal}, ${input.clientRequestId}, ${input.operationDigest}, ${input.forwarderReceiptId}, ${now}) ON CONFLICT DO NOTHING`;
              if (current === undefined) return answer(null);
              yield* Receipts.transition(
                current.row.command_id,
                "refused",
                { commandId: current.row.command_id, boundary: "not_started" },
                "authority_revoked",
              );
              return answer(
                Receipts.result(
                  (yield* Receipts.find(principal, input.clientRequestId, "receiver"))!,
                  true,
                ),
              );
            }),
          ),
        );
      const found = yield* checkedRow();
      if (found !== undefined) {
        const { row, stored, destination } = found;
        if (row.state !== "prepared") return answer(Receipts.result(row, true));
        if (input.operation === "prepare") {
          if (
            input.proposal.sourceEnvironmentId !== live.sourceEnvironmentId ||
            input.proposal.input.clientRequestId !== input.clientRequestId ||
            input.proposal.initiatingClientId !== input.initiatingClientId ||
            input.proposal.forwarderReceiptId !== input.forwarderReceiptId ||
            (yield* approvalOperationDigest(input.proposal)) !== input.operationDigest
          )
            return yield* refuse("idempotency_conflict");
          return answer(Receipts.result(row, true));
        }
        const cancelled = yield* access.withGate(
          sql.withTransaction(
            Effect.gen(function* () {
              if (!(yield* cancellation())) return false;
              yield* Receipts.transition(
                row.command_id,
                "refused",
                { commandId: row.command_id, boundary: "not_started" },
                "authority_revoked",
              );
              return true;
            }),
          ),
        );
        if (cancelled)
          return answer(
            Receipts.result(
              (yield* Receipts.find(principal, input.clientRequestId, "receiver"))!,
              true,
            ),
          );
        const execute =
          input.operation === "status" ? service.prepareForwarded : service.commitForwarded;
        const result = yield* execute(
          stored.input,
          {
            sessionId: client.sessionId,
            label: stored.guard.actor.label,
            ...McpInvocationContext.clientModeCeiling(client),
          },
          destination,
        ).pipe(
          Effect.catchIf(
            (error): error is OrchestratorMcpFailure & { readonly code: ApprovalFailureCode } =>
              isApprovalFailure(error.code) &&
              !["forwarding_unavailable", "provider_unavailable", "request_lost"].includes(
                error.code,
              ),
            (error) =>
              access
                .withGate(
                  Receipts.transition(
                    row.command_id,
                    "refused",
                    { commandId: row.command_id, boundary: "not_started" },
                    error.code,
                  ),
                )
                .pipe(
                  Effect.andThen(Receipts.find(principal, input.clientRequestId, "receiver")),
                  Effect.map((current) => Receipts.result(current!, true)),
                ),
          ),
        );
        return answer(result);
      }
      const cancelled = yield* cancellation();
      if (input.operation === "status") return answer(null);
      if (cancelled) return yield* refuse("authority_revoked");
      if (input.operation !== "prepare") return yield* refuse("request_not_found");
      const proposal = input.proposal;
      if (
        proposal.sourceEnvironmentId !== live.sourceEnvironmentId ||
        proposal.initiatingClientId !== input.initiatingClientId ||
        proposal.forwarderReceiptId !== input.forwarderReceiptId ||
        proposal.input.clientRequestId !== input.clientRequestId ||
        (yield* approvalOperationDigest(proposal)) !== input.operationDigest
      )
        return yield* refuse("idempotency_conflict");
      const authority = yield* delegations.check(handle, proposal.input.threadId);
      return answer(
        yield* access.withGate(
          sql.withTransaction(
            Effect.gen(function* () {
              const cancelled =
                yield* sql`SELECT principal_id FROM agent_approval_receiver_cancellations
          WHERE principal_id = ${principal} AND client_request_id = ${input.clientRequestId}`;
              if (cancelled.length !== 0) return yield* refuse("authority_revoked");
              return yield* service.prepareForwarded(
                proposal.input,
                {
                  sessionId: client.sessionId,
                  label: `${proposal.initiatingClientLabel} (asserted by ${client.label})`,
                  ...McpInvocationContext.clientModeCeiling(client),
                },
                {
                  authority,
                  forwarderReceiptId: input.forwarderReceiptId,
                  forwardingKey: input.clientRequestId,
                  operationDigest: input.operationDigest,
                },
              );
            }),
          ),
        ),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((cause) =>
          isFailure(cause)
            ? cause
            : new OrchestratorMcpFailure({
                code: isDelegationError(cause)
                  ? cause.reason === "thread_not_delegated"
                    ? "thread_not_delegated"
                    : cause.reason === "mode_ceiling"
                      ? "mode_changed"
                      : cause.reason === "storage_unavailable"
                        ? "orchestration_error"
                        : "link_not_approved"
                  : "orchestration_error",
                message:
                  "The linked approval could not establish or save current destination authority.",
              }),
        ),
      ),
  );
  return ApprovalReceiver.of({ receive });
});
export const layer = Layer.effect(ApprovalReceiver, make);
