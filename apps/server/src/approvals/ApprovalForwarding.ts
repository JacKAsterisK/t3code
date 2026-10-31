import {
  ApprovalFailureCode,
  ApprovalReceiptResult,
  EnvironmentId,
  OrchestratorMcpFailure,
  type ApprovalToolInput,
} from "@t3tools/contracts";
import * as Wire from "../../../../packages/contracts/src/approvalForwarding.ts";
import {
  approvalOperationDigest,
  canonicalApprovalJson,
} from "@t3tools/shared/approvalPresentation";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Authority from "../auth/ApprovalAuthority.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Receipts from "./ApprovalReceipts.ts";
import { ApprovalTestHooks } from "./ApprovalTestHooks.ts";

interface ForwardRow extends Receipts.ReceiptRow {
  readonly created_at: number;
  readonly principal_id: string;
  readonly client_request_id: string;
  readonly thread_id: string;
  readonly status_json: string | null;
  readonly reconcile_done: number;
  readonly reconcile_failures: number;
  readonly next_reconcile_at: number;
  readonly source_session_id: string;
  readonly source_authority_revision: number;
  readonly target_environment_id: string;
  readonly forwarding_key: string;
  readonly initiating_client_id: string;
  readonly commit_started: number;
  readonly cancelled: number;
  readonly remote_receipt_id: string | null;
  readonly remote_command_id: string | null;
  readonly remote_operation_digest: string;
  readonly proposal_json: string;
}
const decodeProposal = Schema.decodeEffect(Schema.fromJsonString(Wire.ApprovalForwardOperation));
const decodeReply = Schema.decodeUnknownEffect(Wire.LinkApprovalResult);
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "forwarding_unavailable",
    message:
      "The linked approval outcome is unavailable. Reconcile this same operation; do not use a new key.",
  });
const authorityFailure = (error: Authority.ApprovalAuthorityError) =>
  error.reason === "storage_unavailable"
    ? new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Current approval authority is temporarily unavailable.",
      })
    : refused();
const refused = () =>
  new OrchestratorMcpFailure({
    code: "approvals_not_granted",
    message: "Current outside-client approval permission is required.",
  });
const isFailure = Schema.is(OrchestratorMcpFailure);
const isAuthorityError = Schema.is(Authority.ApprovalAuthorityError);
const isApprovalFailure = Schema.is(ApprovalFailureCode);
const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(ApprovalReceiptResult));
const terminalStates = new Set([
  "refused",
  "response_written",
  "provider_acknowledged",
  "delivery_withheld",
  "delivery_failed",
  "delivery_unknown",
]);
const pendingRank = { prepared: 0, committed: 1, delivery_admitted: 2 } as const;
const definiteRefusal = (error: OrchestratorMcpFailure) =>
  isApprovalFailure(error.code) &&
  !["forwarding_unavailable", "request_lost", "provider_unavailable"].includes(error.code);

export class ApprovalForwarding extends Context.Service<
  ApprovalForwarding,
  {
    readonly call: (
      input: ApprovalToolInput,
    ) => Effect.Effect<Schema.Json, OrchestratorMcpFailure, Invocation.McpInvocationContext>;
  }
>()("t3/approvals/ApprovalForwarding") {}

const make = Effect.gen(function* () {
  const hooks = yield* ApprovalTestHooks;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const authority = yield* Authority.ApprovalAuthority;
  const sessions = yield* SessionStore.SessionStore;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const here = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const reconcileGate = yield* Semaphore.make(1);
  const read = Effect.fn("ApprovalForwarding.read")(function* (principal: string, key: string) {
    return (yield* sql<ForwardRow>`SELECT r.*, f.source_session_id, f.source_authority_revision, f.target_environment_id,
      f.forwarding_key, f.initiating_client_id, f.commit_started, f.cancelled, f.remote_receipt_id, f.remote_command_id,
      f.status_json, f.reconcile_done, f.reconcile_failures, f.next_reconcile_at,
      f.operation_digest AS remote_operation_digest, f.operation_json AS proposal_json
      FROM agent_approval_receipts r JOIN agent_approval_forward_operations f ON f.receipt_id = r.receipt_id
      WHERE r.role = 'forwarder' AND r.principal_id = ${principal} AND r.client_request_id = ${key}`)[0];
  });
  const send = Effect.fn("ApprovalForwarding.send")(function* (
    row: ForwardRow,
    operation: "prepare" | "commit" | "status",
    cancel = false,
  ) {
    const proposal = yield* decodeProposal(row.proposal_json);
    const args: Wire.LinkApprovalRequest =
      operation === "prepare"
        ? {
            operation,
            clientRequestId: row.forwarding_key,
            initiatingClientId: row.initiating_client_id,
            forwarderReceiptId: row.receipt_id,
            operationDigest: row.remote_operation_digest,
            proposal,
          }
        : {
            operation,
            clientRequestId: row.forwarding_key,
            initiatingClientId: row.initiating_client_id,
            forwarderReceiptId: row.receipt_id,
            operationDigest: row.remote_operation_digest,
            ...(operation === "commit" && cancel ? { cancel: true } : {}),
          };
    const result = yield* peers
      .call({
        environmentId: EnvironmentId.make(row.target_environment_id),
        tool: "t3_link_approval_request",
        arguments: args,
        limits: proposal.limits,
        writes: operation !== "status" && !cancel,
        ...(operation !== "commit" || cancel
          ? {}
          : {
              beforeSend: authority
                .withGate(
                  Effect.gen(function* () {
                    const current = yield* read(row.principal_id, row.client_request_id);
                    if (
                      current === undefined ||
                      current.cancelled === 1 ||
                      current.reconcile_done === 1
                    )
                      return yield* refused();
                    yield* currentForOperation(current).pipe(Effect.mapError(authorityFailure));
                  }),
                )
                .pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.mapError((cause) => (isFailure(cause) ? cause : unavailable())),
                ),
            }),
        success: Schema.Unknown,
      })
      .pipe(Effect.timeout("10 seconds"));
    const reply = yield* decodeReply(result);
    if (
      reply.environmentId !== row.target_environment_id ||
      reply.forwarderReceiptId !== row.receipt_id ||
      reply.operationDigest !== row.remote_operation_digest
    )
      return yield* unavailable();
    return reply;
  });
  const remember = Effect.fn("ApprovalForwarding.remember")(function* (
    row: ForwardRow,
    reply: Wire.LinkApprovalResult,
  ) {
    const receipt = reply.receipt;
    if (receipt === null) return;
    if (row.decision !== receipt.decision || row.effective_scope !== receipt.effectiveScope)
      return yield* unavailable();
    const now = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* read(row.principal_id, row.client_request_id);
        if (
          current === undefined ||
          (current.remote_receipt_id !== null && current.remote_receipt_id !== receipt.receiptId) ||
          (current.remote_command_id !== null && current.remote_command_id !== receipt.commandId)
        )
          return yield* unavailable();
        if (current.reconcile_done === 1 && current.state === "delivery_unknown") return;
        const previous =
          current.status_json === null ? undefined : yield* decodeStatus(current.status_json);
        if (
          previous !== undefined &&
          ((terminalStates.has(previous.state) &&
            !(
              previous.state === "response_written" && receipt.state === "provider_acknowledged"
            )) ||
            (previous.state in pendingRank &&
              receipt.state in pendingRank &&
              pendingRank[previous.state as keyof typeof pendingRank] >
                pendingRank[receipt.state as keyof typeof pendingRank]))
        )
          return;
        const terminal = terminalStates.has(receipt.state);
        const preserveLocal =
          (current.state === "refused" && receipt.state === "prepared") ||
          (current.commit_started === 1 && receipt.state === "prepared") ||
          (current.cancelled === 1 && receipt.state === "prepared");
        yield* sql`UPDATE agent_approval_forward_operations SET remote_receipt_id = ${receipt.receiptId},
        remote_command_id = ${receipt.commandId}, status_json = ${canonicalApprovalJson(receipt)},
        reconcile_done = ${terminal ? 1 : 0}, reconcile_failures = 0, next_reconcile_at = 0, updated_at = ${now}
        WHERE receipt_id = ${row.receipt_id}`;
        if (preserveLocal) return;
        yield* sql`UPDATE agent_approval_receipts SET state = ${receipt.state}, result_sequence = ${receipt.sequence ?? null},
        failure_code = ${receipt.failureCode ?? null}, delivery_evidence_json = ${receipt.deliveryEvidence === undefined ? null : canonicalApprovalJson(receipt.deliveryEvidence)},
        updated_at = ${now} WHERE role = 'forwarder' AND receipt_id = ${row.receipt_id}`;
      }),
    );
  });
  const currentForOperation = (row: ForwardRow) =>
    authority.currentForOperation({
      sessionId: row.source_session_id,
      authorityRevision: row.source_authority_revision,
      initiatingClientId: row.initiating_client_id,
    });
  const cancel = Effect.fn("ApprovalForwarding.cancel")(function* (row: ForwardRow) {
    const now = yield* Clock.currentTimeMillis;
    const latest = yield* authority.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* read(row.principal_id, row.client_request_id);
          if (current === undefined || current.reconcile_done === 1) return undefined;
          yield* sql`UPDATE agent_approval_forward_operations SET cancelled = 1, updated_at = ${now} WHERE receipt_id = ${row.receipt_id}`;
          if (current.commit_started === 0)
            yield* sql`UPDATE agent_approval_receipts SET state = 'refused', failure_code = 'authority_revoked', updated_at = ${now}
          WHERE receipt_id = ${row.receipt_id} AND role = 'forwarder' AND state = 'prepared'`;
          return current;
        }),
      ),
    );
    if (latest === undefined) return;
    // B refuses only prepared operations; cancellation cannot recall a native admission.
    const reply = yield* send(latest, "commit", true);
    yield* remember(latest, reply);
    if (reply.receipt === null) {
      yield* sql`UPDATE agent_approval_forward_operations SET reconcile_done = 1, updated_at = ${now} WHERE receipt_id = ${row.receipt_id}`;
      yield* sql`UPDATE agent_approval_receipts SET state = 'refused', failure_code = 'authority_revoked', updated_at = ${now}
        WHERE receipt_id = ${row.receipt_id} AND state = 'prepared'
        AND EXISTS (SELECT 1 FROM agent_approval_forward_operations f WHERE f.receipt_id = ${row.receipt_id} AND f.commit_started = 0)`;
    }
  });
  const permittedForOperation = (row: ForwardRow) =>
    currentForOperation(row).pipe(
      Effect.as(true),
      Effect.catchTags({
        ApprovalAuthorityError: (error) =>
          error.reason === "storage_unavailable" ? Effect.fail(error) : Effect.succeed(false),
      }),
    );
  const commitPrepared = Effect.fn("ApprovalForwarding.commitPrepared")(function* (
    row: ForwardRow,
  ) {
    const admission = yield* authority.withGate(
      sql.withTransaction(
        Effect.gen(function* () {
          const latest = yield* read(row.principal_id, row.client_request_id);
          if (
            latest === undefined ||
            latest.reconcile_done === 1 ||
            !["prepared", "delivery_unknown"].includes(latest.state)
          )
            return "observe" as const;
          if (latest.cancelled === 1 || !(yield* permittedForOperation(latest)))
            return "cancel" as const;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE agent_approval_receipts SET state = 'delivery_unknown',
        delivery_evidence_json = ${canonicalApprovalJson({ commandId: latest.command_id, boundary: "delivery_admission" })}, updated_at = ${now}
        WHERE receipt_id = ${latest.receipt_id} AND role = 'forwarder' AND state IN ('prepared', 'delivery_unknown')`;
          yield* sql`UPDATE agent_approval_forward_operations SET commit_started = 1, updated_at = ${now} WHERE receipt_id = ${latest.receipt_id}`;
          return "send" as const;
        }),
      ),
    );
    if (admission === "cancel") yield* cancel(row);
    else if (admission === "send") {
      const committed = yield* send(row, "commit").pipe(Effect.option);
      if (Option.isNone(committed)) return false;
      yield* remember(row, committed.value);
    }
    return true;
  });
  const reconcileOne = Effect.fn("ApprovalForwarding.reconcileOne")(function* (
    row: ForwardRow,
    notice: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (row.cancelled === 1 && row.next_reconcile_at > now) return;
    // Notices recheck local authority without bypassing network backoff.
    const permitted = yield* permittedForOperation(row);
    if (row.cancelled === 1 || !permitted) yield* cancel(row);
    // Keep a cancelled tombstone after the unfinished-work horizon; never prune the audit.
    else if (row.commit_started === 0 && now - row.created_at >= 48 * 60 * 60 * 1000)
      yield* cancel(row);
    else {
      if (notice && row.next_reconcile_at > now) return;
      const reply = yield* send(row, "status");
      yield* remember(row, reply);
      if (reply.receipt === null) {
        if (row.commit_started === 0) return yield* unavailable();
        yield* sql`UPDATE agent_approval_forward_operations SET reconcile_done = 1, updated_at = ${now} WHERE receipt_id = ${row.receipt_id}`;
      } else if (reply.receipt.state === "prepared" && row.commit_started === 1) {
        if (!(yield* commitPrepared(row))) return yield* unavailable();
      }
    }
    yield* sql`UPDATE agent_approval_forward_operations SET next_reconcile_at = ${now + 30_000}, reconcile_failures = 0
      WHERE receipt_id = ${row.receipt_id} AND reconcile_done = 0`;
  });
  const reconcile = Effect.fn("ApprovalForwarding.reconcile")(
    function* (notice: boolean) {
      const now = yield* Clock.currentTimeMillis;
      const keys = yield* sql<{
        principal_id: string;
        client_request_id: string;
      }>`SELECT r.principal_id, r.client_request_id
        FROM agent_approval_receipts r JOIN agent_approval_forward_operations f ON r.receipt_id = f.receipt_id
        WHERE r.role = 'forwarder' AND f.reconcile_done = 0
        AND (r.state IN ('prepared', 'committed', 'delivery_admitted', 'delivery_unknown') OR f.cancelled = 1)
        AND (f.next_reconcile_at <= ${now} OR (${notice ? 1 : 0} = 1 AND f.cancelled = 0))
        ORDER BY r.created_at, r.receipt_id`;
      yield* Effect.forEach(
        keys,
        (key) =>
          Effect.gen(function* () {
            const row = yield* read(key.principal_id, key.client_request_id);
            if (row === undefined) return;
            yield* reconcileOne(row, notice).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const failedAt = yield* Clock.currentTimeMillis;
                  const delay = Math.min(
                    30_000 * 2 ** Math.min(row.reconcile_failures, 7),
                    3_600_000,
                  );
                  yield* sql`UPDATE agent_approval_forward_operations SET reconcile_failures = reconcile_failures + 1,
            next_reconcile_at = ${failedAt + delay} WHERE receipt_id = ${row.receipt_id} AND reconcile_done = 0`;
                  yield* Effect.logWarning("Linked approval reconciliation failed.", {
                    receiptId: row.receipt_id,
                    cause,
                  });
                }),
              ),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Linked approval reconciliation row could not be recovered.", {
                cause,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    },
    (effect) =>
      reconcileGate.withPermit(effect).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.catchCause((cause) =>
          Effect.logWarning("Linked approval reconciliation could not scan.", { cause }),
        ),
        Effect.ensuring(hooks.afterForwardReconcile ?? Effect.void),
      ),
  );
  const notices = yield* Queue.sliding<void>(1);
  yield* Stream.runForEach(sessions.streamChanges, () =>
    Queue.offer(notices, undefined).pipe(Effect.andThen(hooks.afterForwardNotice ?? Effect.void)),
  ).pipe(Effect.forkScoped);
  yield* Stream.runForEach(Stream.fromQueue(notices), () => reconcile(true)).pipe(
    Effect.forkScoped,
  );
  yield* reconcile(false).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);

  const call = Effect.fn("ApprovalForwarding.call")(
    function* (input: ApprovalToolInput) {
      const scope = yield* Invocation.McpInvocationContext;
      const client = scope.client;
      if (client?.linked === true)
        return yield* new OrchestratorMcpFailure({
          code: "forwarding_chain_refused",
          message: "Approval forwarding supports one authenticated hop.",
        });
      if (
        scope.thread !== undefined ||
        client === undefined ||
        client.taskOnly === true ||
        client.grantId !== undefined ||
        scope.linkedEnvironments !== true
      )
        return yield* refused();
      const environmentId = input.environmentId;
      if (environmentId === undefined || environmentId === here) return yield* unavailable();
      const limits = Invocation.clientModeCeiling(client);
      if (input.action === "list" || input.action === "read") {
        const current = yield* authority.identity(client.sessionId, "read").pipe(
          Effect.catchTags({
            ApprovalAuthorityError: (error) =>
              error.reason === "storage_unavailable"
                ? Effect.fail(authorityFailure(error))
                : Effect.void,
          }),
        );
        const permitted =
          current !== undefined &&
          (yield* authority.check(client.sessionId).pipe(
            Effect.as(true),
            Effect.catchTags({
              ApprovalAuthorityError: (error) =>
                error.reason === "storage_unavailable"
                  ? Effect.fail(authorityFailure(error))
                  : Effect.succeed(false),
            }),
          ));
        const { environmentId: _target, ...args } = input;
        const result = yield* peers.call({
          environmentId,
          ...(current === undefined ? {} : { initiatingClientId: current.initiating_client_id }),
          tool: "t3_approval_request",
          arguments: args,
          limits,
          writes: false,
          success: Schema.Json,
        });
        const withSourceAuthority = (value: Schema.Json): Schema.Json => {
          if (permitted || value === null || typeof value !== "object" || Array.isArray(value))
            return value;
          return { ...value, answerable: { via: "ui_only", reason: "approvals_not_granted" } };
        };
        if (
          input.action === "list" &&
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          "requests" in result &&
          Array.isArray(result.requests)
        )
          return { ...result, requests: result.requests.map(withSourceAuthority) };
        return withSourceAuthority(result);
      }
      const current = yield* authority
        .identity(client.sessionId, input.action === "respond" ? "operate" : "read")
        .pipe(Effect.mapError(authorityFailure));
      const principal = `client:${current.initiating_client_id}`;
      let row = yield* read(principal, input.clientRequestId);
      const replayed = row !== undefined;
      if (input.action === "status") {
        if (
          row === undefined ||
          row.target_environment_id !== environmentId ||
          row.thread_id !== input.threadId
        )
          return yield* unavailable();
        const reply = yield* send(row, "status");
        yield* remember(row, reply);
        return {
          ...Receipts.result((yield* read(principal, input.clientRequestId))!, true),
          forwarding: {
            environmentId,
            receiptId: reply.receipt?.receiptId ?? null,
            commandId: reply.receipt?.commandId ?? null,
          },
        };
      }
      const authorization = yield* authority
        .check(client.sessionId)
        .pipe(Effect.mapError(authorityFailure));
      const digest = yield* approvalOperationDigest({
        version: 1,
        input,
        limits,
        initiatingClientId: current.initiating_client_id,
        sourceEnvironmentId: here,
      });
      if (
        row !== undefined &&
        (row.operation_digest !== digest || row.target_environment_id !== environmentId)
      )
        return yield* new OrchestratorMcpFailure({
          code: "idempotency_conflict",
          message: "This retry key already identifies a different approval operation.",
        });
      if (row === undefined) {
        const receiptId = `apf_${yield* crypto.randomUUIDv4()}`;
        const key = `fwd:${yield* approvalOperationDigest(["approval-v1", here, current.initiating_client_id, input.clientRequestId])}`;
        const { environmentId: _target, ...localInput } = input;
        const proposal: Wire.ApprovalForwardOperation = {
          version: 1,
          sourceEnvironmentId: here,
          initiatingClientId: current.initiating_client_id,
          forwarderReceiptId: receiptId,
          initiatingClientLabel: client.label.slice(0, 200),
          input: { ...localInput, clientRequestId: key },
          limits,
        };
        const remoteDigest = yield* approvalOperationDigest(proposal);
        const now = yield* Clock.currentTimeMillis;
        yield* authority.withGate(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* authority.check(client.sessionId, authorization.revision);
              yield* sql`INSERT INTO agent_approval_receipts(receipt_id, role, principal_id, client_request_id,
            operation_digest, operation_json, environment_id, thread_id, request_id, request_incarnation,
            provider_session_id, provider_generation, presentation_digest, decision, effective_scope, grant_digest,
            command_id, state, authority_revision, actor_json, created_at, updated_at)
            VALUES (${receiptId}, 'forwarder', ${principal}, ${input.clientRequestId}, ${digest}, ${canonicalApprovalJson({ input, limits, sourceAuthorization: { sessionId: client.sessionId, revision: authorization.revision, applicationId: authorization.application_id, consentFamilyId: authorization.consent_family_id } })},
              ${environmentId}, ${input.threadId}, ${input.requestId}, ${input.expected.requestIncarnation}, ${input.expected.providerSessionId},
              ${input.expected.providerGeneration}, ${input.expected.presentationDigest}, ${input.decision}, ${input.consent.effectiveScope}, ${input.consent.grantDigest},
              ${`approval-forward:${receiptId}`}, 'prepared', ${authorization.revision}, ${canonicalApprovalJson({ kind: "mcp_client", principalId: principal, label: client.label, applicationId: authorization.application_id, authorityRevision: authorization.revision, assertion: { onBehalfOf: input.consent.onBehalfOf, authorization: input.consent.authorization } })}, ${now}, ${now})
            ON CONFLICT(principal_id, client_request_id, role) DO NOTHING`;
              const inserted = (yield* sql<{
                receipt_id: string;
              }>`SELECT receipt_id FROM agent_approval_receipts WHERE principal_id = ${principal} AND client_request_id = ${input.clientRequestId} AND role = 'forwarder'`)[0]!;
              if (inserted.receipt_id !== receiptId) return;
              yield* sql`INSERT INTO agent_approval_forward_operations(receipt_id, source_session_id, source_authority_revision,
            target_environment_id, forwarding_key, initiating_client_id, operation_digest, operation_json, created_at, updated_at)
            VALUES (${receiptId}, ${client.sessionId}, ${authorization.revision}, ${environmentId}, ${key}, ${current.initiating_client_id}, ${remoteDigest}, ${canonicalApprovalJson(proposal)}, ${now}, ${now})`;
            }),
          ),
        );
        row = (yield* read(principal, input.clientRequestId))!;
        if (row.operation_digest !== digest)
          return yield* new OrchestratorMcpFailure({
            code: "idempotency_conflict",
            message: "A concurrent operation claimed this retry key.",
          });
      }
      let reply = yield* send(row, "status");
      if (
        reply.receipt === null &&
        row.commit_started === 0 &&
        row.cancelled === 0 &&
        row.reconcile_done === 0
      )
        reply = yield* send(row, "prepare").pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!isFailure(error) || !definiteRefusal(error) || !isApprovalFailure(error.code))
                return yield* error;
              const now = yield* Clock.currentTimeMillis;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  const changed =
                    yield* sql`UPDATE agent_approval_receipts SET state = 'refused', failure_code = ${error.code}, updated_at = ${now}
              WHERE receipt_id = ${row.receipt_id} AND state = 'prepared'
              AND EXISTS (SELECT 1 FROM agent_approval_forward_operations f WHERE f.receipt_id = ${row.receipt_id} AND f.commit_started = 0)
              RETURNING receipt_id`;
                  if (changed.length === 1)
                    yield* sql`UPDATE agent_approval_forward_operations SET reconcile_done = 1 WHERE receipt_id = ${row.receipt_id}`;
                }),
              );
              return {
                environmentId: EnvironmentId.make(row.target_environment_id),
                forwarderReceiptId: row.receipt_id,
                operationDigest: row.remote_operation_digest,
                receipt: null,
              };
            }),
          ),
        );
      yield* remember(row, reply);
      if (reply.receipt?.state === "prepared" && row.cancelled === 0) yield* commitPrepared(row);
      const durable = (yield* read(principal, input.clientRequestId))!;
      return {
        ...Receipts.result(durable, replayed),
        forwarding: {
          environmentId,
          receiptId: durable.remote_receipt_id,
          commandId: durable.remote_command_id,
        },
      };
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((cause) =>
          isFailure(cause)
            ? cause
            : isAuthorityError(cause)
              ? authorityFailure(cause)
              : unavailable(),
        ),
      ),
  );
  return ApprovalForwarding.of({ call });
});
export const layer = Layer.effect(ApprovalForwarding, make);
