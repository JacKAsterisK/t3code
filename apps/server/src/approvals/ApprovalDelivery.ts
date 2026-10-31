import * as NativeUpdateGate from "../lan/NativeUpdateGate.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";
import { ApprovalTestHooks } from "./ApprovalTestHooks.ts";
import {
  ApprovalRespondInput,
  ApprovalGuard as ApprovalGuardSchema,
  ProviderSessionId,
  CommandId,
  type ApprovalNativeDescriptor,
  type ApprovalDeliveryEvidence,
  type ApprovalFailureCode,
  type ApprovalReceiptState,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { canonicalApprovalJson } from "@t3tools/shared/approvalPresentation";
import * as ApprovalAuthority from "../auth/ApprovalAuthority.ts";
import * as ApprovalDestinationGuard from "./ApprovalDestinationGuard.ts";
import * as ApprovalReceipts from "./ApprovalReceipts.ts";
import * as ApprovalPresentation from "./ApprovalPresentation.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Crypto from "effect/Crypto";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import type { RuntimeRequestServiceV2Shape } from "../orchestration-v2/RuntimeRequestService.ts";

const decodeRuntimeMode = Schema.decodeUnknownEffect(RuntimeMode);
const decodeInteractionMode = Schema.decodeUnknownEffect(ProviderInteractionMode);
const decodeStoredOperation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ input: ApprovalRespondInput, guard: ApprovalGuardSchema })),
);
export class ApprovalDelivery extends Context.Service<
  ApprovalDelivery,
  {
    readonly respond: (
      input: Parameters<RuntimeRequestServiceV2Shape["respond"]>[0],
    ) => Effect.Effect<void>;
  }
>()("t3/approvals/ApprovalDelivery") {}
const make = Effect.gen(function* () {
  const admission = yield* NativeUpdateGate.captureAdmission();
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const threadGate = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const native = yield* Orchestrator.OrchestratorV2;
  const authority = yield* Effect.serviceOption(ApprovalAuthority.ApprovalAuthority);
  const destinationGuard = yield* Effect.serviceOption(
    ApprovalDestinationGuard.ApprovalDestinationGuard,
  );
  const results = yield* Queue.unbounded<{
    readonly input: Parameters<RuntimeRequestServiceV2Shape["respond"]>[0];
    readonly commandId: string;
    readonly state: ApprovalReceiptState;
    readonly evidence: ApprovalDeliveryEvidence;
    readonly failureCode?: ApprovalFailureCode;
    readonly recover?: ApprovalNativeDescriptor;
  }>();
  yield* Stream.fromQueue(results).pipe(
    Stream.runForEach(
      Effect.fn("RuntimeRequestService.recordApprovalDelivery")(
        function* (result) {
          const changed = yield* ApprovalReceipts.transition(
            result.commandId,
            result.state,
            result.evidence,
            result.failureCode,
          );
          if (!changed) {
            const durable = yield* ApprovalReceipts.byCommand(result.commandId);
            if (durable?.state !== result.state) return;
          }
          yield* native.dispatch({
            type: "approval.delivery.record",
            commandId: CommandId.make(`${result.commandId}:delivery:${result.state}`),
            threadId: result.input.threadId,
            requestId: result.input.requestId,
            receiptId: result.input.approvalGuard!.receiptId,
            state: result.state,
            ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
            ...(result.recover === undefined ? {} : { recover: result.recover }),
          });
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) =>
              Effect.logError("Could not persist native approval delivery evidence.", { cause }),
            ),
          ),
      ),
    ),
    Effect.forkScoped,
  );

  const guarded = Effect.fn("RuntimeRequestService.respondGuarded")(
    function* (input: Parameters<RuntimeRequestServiceV2Shape["respond"]>[0]) {
      const guard = input.approvalGuard!;
      const commandId = input.commandId!;
      let failureCode: ApprovalFailureCode | undefined;
      const report = (
        state: "response_written" | "delivery_failed" | "delivery_unknown" | "delivery_withheld",
        evidence: ApprovalDeliveryEvidence,
        recover?: ApprovalNativeDescriptor,
      ) =>
        Queue.offer(results, {
          input,
          commandId,
          state,
          evidence: {
            commandId: evidence.commandId,
            boundary: evidence.boundary,
            ...(input.effectId === undefined ? {} : { effectId: input.effectId }),
          },
          ...(failureCode === undefined ? {} : { failureCode }),
          ...(recover === undefined ? {} : { recover }),
        }).pipe(Effect.asVoid);
      const row = yield* ApprovalReceipts.byCommand(commandId);
      if (row === undefined || !["committed", "delivery_admitted"].includes(row.state)) return;
      // Live duplicates observe admission; startup reconciliation handles a lost writer.
      if (row.state === "delivery_admitted") return;
      const hooks = yield* ApprovalTestHooks;
      yield* hooks.beforeDeliveryAdmission ?? Effect.void;
      yield* threadGate.withLock(
        input.threadId,
        Effect.gen(function* () {
          const context = yield* projections.getRuntimeResponseContext(
            input.threadId,
            input.requestId,
          );
          const descriptor = context.request?.approval;
          if (
            context.session?.driver !== "codex" ||
            descriptor === undefined ||
            context.item?.type !== "approval_request" ||
            context.request?.approvalReceiptId !== guard.receiptId
          ) {
            failureCode = "request_changed";
            yield* report("delivery_withheld", { commandId, boundary: "not_started" });
            return;
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            failureCode = "request_lost";
            yield* report("delivery_failed", { commandId, boundary: "not_started" });
            return;
          }
          yield* session.value.respondToRuntimeRequest({
            requestId: input.requestId,
            ...(input.decision === undefined ? {} : { decision: input.decision }),
            guardedResponse: {
              commandId,
              descriptor,
              onResult: report,
              admit: (handoff) =>
                Option.isNone(authority)
                  ? Effect.succeed(false)
                  : authority.value.withGate(
                      Effect.gen(function* () {
                        const durable = yield* ApprovalReceipts.byCommand(commandId);
                        if (durable?.state !== "committed") return false;
                        const allowed = yield* (
                          guard.destination === undefined
                            ? authority.value.check(guard.sessionId, guard.authorityRevision)
                            : Option.isSome(destinationGuard)
                              ? destinationGuard.value.check(guard, input.threadId)
                              : Effect.fail(
                                  new ApprovalAuthority.ApprovalAuthorityError({
                                    reason: "authority_revoked",
                                  }),
                                )
                        ).pipe(
                          Effect.tapError((error) =>
                            Effect.sync(() => {
                              failureCode =
                                error.reason === "storage_unavailable"
                                  ? undefined
                                  : error.reason === "mode_changed"
                                    ? "mode_changed"
                                    : "authority_revoked";
                            }),
                          ),
                          Effect.option,
                        );
                        if (Option.isNone(allowed)) return false;
                        const thread = yield* projections.getThread(input.threadId);
                        const currentSettings = yield* settings.getSettings;
                        if (
                          !resolveProjectProviderInstanceEnabled(
                            currentSettings,
                            thread.projectId,
                            thread.providerInstanceId,
                          )
                        ) {
                          failureCode = "provider_unavailable";
                          return false;
                        }
                        const current = yield* projections.getRuntimeResponseContext(
                          input.threadId,
                          input.requestId,
                        );
                        if (
                          current.request?.status !== "resolved" ||
                          current.request.approvalReceiptId !== guard.receiptId ||
                          canonicalApprovalJson(current.request.approval) !==
                            canonicalApprovalJson(descriptor) ||
                          current.item?.type !== "approval_request"
                        ) {
                          failureCode = "request_changed";
                          return false;
                        }
                        const ceiling = {
                          runtimeMode: yield* decodeRuntimeMode(guard.runtimeModeCeiling),
                          interactionMode: yield* decodeInteractionMode(
                            guard.interactionModeCeiling,
                          ),
                        };
                        const credentialCeiling = yield* decodeRuntimeMode(
                          allowed.value.runtimeModeCeiling,
                        );
                        if (
                          exceededDispatchModeLimit(ceiling, thread) !== undefined ||
                          exceededDispatchModeLimit(
                            { ...ceiling, runtimeMode: credentialCeiling },
                            thread,
                          ) !== undefined
                        ) {
                          failureCode = "mode_changed";
                          return false;
                        }
                        const shown = yield* ApprovalPresentation.presentation({
                          environmentId: guard.environmentId,
                          threadId: input.threadId,
                          request: current.request,
                          item: current.item,
                        });
                        if (
                          shown === undefined ||
                          canonicalApprovalJson(shown.expected) !==
                            canonicalApprovalJson(guard.expected) ||
                          shown.grantDigest !== guard.grantDigest
                        ) {
                          failureCode = "request_changed";
                          return false;
                        }
                        yield* sql.withTransaction(
                          Effect.gen(function* () {
                            yield* ApprovalReceipts.transition(commandId, "delivery_admitted", {
                              commandId,
                              boundary: "delivery_admission",
                            });
                            yield* sql`UPDATE agent_approval_receipts SET delivery_admitted_revision = ${allowed.value.revision} WHERE command_id = ${commandId}`;
                          }),
                        );
                        return yield* handoff;
                      }).pipe(
                        Effect.provideService(Crypto.Crypto, crypto),
                        Effect.provideService(SqlClient.SqlClient, sql),
                        Effect.catchCause(() => {
                          failureCode = undefined;
                          return Effect.succeed(false);
                        }),
                      ),
                    ),
            },
          });
        }),
      );
    },
    (effect, input) =>
      admission.withAdmission(effect).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchCause(() =>
          Effect.gen(function* () {
            const row = yield* ApprovalReceipts.byCommand(input.commandId!).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            if (row?.state !== "committed" && row?.state !== "delivery_admitted") return;
            yield* Queue.offer(results, {
              input,
              commandId: input.commandId!,
              state: row.state === "committed" ? "delivery_failed" : "delivery_unknown",
              evidence: {
                commandId: input.commandId!,
                boundary: row.state === "committed" ? "not_started" : "reconciliation",
              },
              failureCode: "request_lost",
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not reconcile approval delivery failure.", { cause }),
            ),
          ),
        ),
      ),
  );

  yield* ApprovalReceipts.reconcileNativeRejections().pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  const interrupted = yield* sql<{
    command_id: string;
    operation_json: string;
    state: ApprovalReceiptState;
    failure_code: ApprovalFailureCode | null;
  }>`SELECT receipt.command_id, receipt.operation_json, receipt.state, receipt.failure_code
    FROM agent_approval_receipts AS receipt LEFT JOIN orchestration_v2_projection_runtime_requests AS request
      ON request.runtime_request_id = receipt.request_id AND request.thread_id = receipt.thread_id
    WHERE receipt.state IN ('delivery_admitted', 'response_written', 'delivery_unknown', 'delivery_withheld', 'delivery_failed')
      AND receipt.role IN ('local', 'receiver') AND (receipt.state = 'delivery_admitted' OR (
        json_extract(request.payload_json, '$.approvalReceiptId') = receipt.receipt_id
        AND COALESCE(json_extract(request.payload_json, '$.approvalDelivery'), '') <> receipt.state))`;
  for (const row of interrupted) {
    const operation = yield* decodeStoredOperation(row.operation_json).pipe(Effect.option);
    if (Option.isNone(operation)) {
      yield* ApprovalReceipts.transition(row.command_id, "delivery_unknown", {
        commandId: row.command_id,
        boundary: "reconciliation",
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      continue;
    }
    yield* Queue.offer(results, {
      commandId: row.command_id,
      input: {
        ...operation.value.input,
        providerSessionId: ProviderSessionId.make(operation.value.guard.expected.providerSessionId),
        approvalGuard: operation.value.guard,
        commandId: row.command_id,
      },
      state: row.state === "delivery_admitted" ? "delivery_unknown" : row.state,
      evidence: { commandId: row.command_id, boundary: "reconciliation" },
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    });
  }
  return ApprovalDelivery.of({ respond: guarded });
});
export const layer = Layer.effect(ApprovalDelivery, make);
