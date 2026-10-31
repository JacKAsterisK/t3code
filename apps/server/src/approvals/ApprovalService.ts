import * as AgentEventOwners from "../agentEvents/AgentEventOwners.ts";
import { ApprovalTestHooks } from "./ApprovalTestHooks.ts";
import {
  ApprovalGuard as ApprovalGuardSchema,
  ApprovalFailureCode,
  CommandId,
  OrchestratorMcpFailure,
  RuntimeMode as RuntimeModeSchema,
  ProviderInteractionMode as InteractionModeSchema,
} from "@t3tools/contracts";
import type {
  ApprovalGuard,
  ApprovalDestinationGuard,
  ApprovalRespondInput,
  ApprovalToolInput,
  ApprovalReceiptResult,
  EnvironmentId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  canonicalApprovalJson,
  approvalOperationDigest,
} from "@t3tools/shared/approvalPresentation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ApprovalAuthority from "../auth/ApprovalAuthority.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Presentation from "./ApprovalPresentation.ts";
import * as Receipts from "./ApprovalReceipts.ts";
import * as DestinationGuard from "./ApprovalDestinationGuard.ts";
import * as Delegations from "./ApprovalDelegations.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const isApprovalFailureCode = Schema.is(ApprovalFailureCode);
const decodeStoredGuard = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      guard: ApprovalGuardSchema,
      limits: Schema.Struct({
        runtimeMode: RuntimeModeSchema,
        interactionMode: InteractionModeSchema,
      }),
    }),
  ),
);
export interface ApprovalCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}
const refuse = (code: ApprovalFailureCode) =>
  new OrchestratorMcpFailure({ code, message: `Approval response refused: ${code}.` });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Approval state could not be read or saved.",
  });
export class ApprovalService extends Context.Service<
  ApprovalService,
  {
    readonly read: (
      input: Extract<ApprovalToolInput, { action: "list" | "read" }>,
      sessionId?: string,
    ) => Effect.Effect<Schema.Json, OrchestratorMcpFailure>;
    readonly status: (
      input: Extract<ApprovalToolInput, { action: "status" }>,
      sessionId: string,
    ) => Effect.Effect<ApprovalReceiptResult, OrchestratorMcpFailure>;
    readonly respond: (
      input: ApprovalRespondInput,
      caller: ApprovalCaller,
    ) => Effect.Effect<ApprovalReceiptResult, OrchestratorMcpFailure>;
    readonly prepareForwarded: (
      input: ApprovalRespondInput,
      caller: ApprovalCaller,
      destination: ApprovalDestinationGuard,
    ) => Effect.Effect<ApprovalReceiptResult, OrchestratorMcpFailure>;
    readonly commitForwarded: (
      input: ApprovalRespondInput,
      caller: ApprovalCaller,
      destination: ApprovalDestinationGuard,
    ) => Effect.Effect<ApprovalReceiptResult, OrchestratorMcpFailure>;
  }
>()("t3/approvals/ApprovalService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const authority = yield* ApprovalAuthority.ApprovalAuthority;
  const destinationGuard = yield* Effect.serviceOption(DestinationGuard.ApprovalDestinationGuard);
  const delegations = yield* Effect.serviceOption(Delegations.ApprovalDelegations);
  const access = yield* Effect.serviceOption(Delegations.ApprovalDestinationAccess);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const owners = yield* Effect.serviceOption(AgentEventOwners.AgentEventOwners);
  const native = yield* Orchestrator.OrchestratorV2;
  const commands = yield* CommandReceipts.CommandReceiptStoreV2;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const here = yield* identity.getEnvironmentId;
  const local = (environmentId: EnvironmentId | undefined) =>
    environmentId === undefined || environmentId === here
      ? Effect.void
      : Effect.fail(refuse("forwarding_unavailable"));
  const read: ApprovalService["Service"]["read"] = Effect.fn("ApprovalService.read")(
    function* (input, sessionId) {
      yield* local(input.environmentId);
      const invocation = yield* Effect.serviceOption(Invocation.McpInvocationContext);
      const client = Option.getOrUndefined(invocation)?.client;
      const linked = client?.linked === true;
      let principalId = sessionId === undefined ? undefined : `session:${sessionId}`;
      let role: "local" | "receiver" = "local";
      let permitted = false;
      if (linked) {
        principalId = undefined;
        role = "receiver";
        if (sessionId !== client.sessionId || Option.isNone(access) || Option.isNone(delegations))
          return yield* refuse("link_not_approved");
        const peer = yield* access.value.peer(sessionId);
        if (peer === undefined || !peer.scopes.includes("orchestration:read"))
          return yield* refuse("link_not_approved");
        if (client.assertedInitiatingClientId !== undefined) {
          const handle = yield* delegations.value
            .authenticate(client.assertedInitiatingClientId)
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, Option.getOrThrow(invocation)),
            );
          principalId = `link:${peer.linkIdentityId}:client:${client.assertedInitiatingClientId}`;
          permitted = yield* delegations.value.check(handle, input.threadId).pipe(
            Effect.as(true),
            Effect.catchTags({
              ApprovalDelegationError: (error) =>
                error.reason === "storage_unavailable"
                  ? Effect.fail(unavailable())
                  : Effect.succeed(false),
            }),
          );
        }
      } else if (sessionId !== undefined) {
        permitted = yield* authority.check(sessionId).pipe(
          Effect.as(true),
          Effect.catchTags({
            ApprovalAuthorityError: (error) =>
              error.reason === "storage_unavailable"
                ? Effect.fail(unavailable())
                : Effect.succeed(false),
          }),
        );
      }
      const projection = yield* projections
        .getThreadProjection(input.threadId)
        .pipe(Effect.mapError(unavailable));
      if (projection === null) return yield* refuse("request_not_found");
      const ownerCoordinates = Option.isSome(owners)
        ? yield* owners.value.read(input.threadId).pipe(Effect.mapError(unavailable))
        : null;
      const describe = Effect.fn("ApprovalService.describe")(function* (requestId: string) {
        const request = projection.runtimeRequests.find((request) => request.id === requestId);
        const item = projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === requestId,
        );
        if (request === undefined) return yield* refuse("request_not_found");
        if (item === undefined) return yield* refuse("not_an_approval");
        const shown = yield* Presentation.presentation({
          environmentId: here,
          threadId: input.threadId,
          request,
          item,
        });
        const receipts =
          principalId === undefined
            ? []
            : yield* sql<Receipts.ReceiptRow>`SELECT * FROM agent_approval_receipts
          WHERE role = ${role} AND principal_id = ${principalId} AND thread_id = ${input.threadId} AND request_id = ${request.id}
          ORDER BY created_at DESC LIMIT 20`;
        return {
          requestId: request.id,
          status: request.status,
          receipts: receipts.map((receipt) => Receipts.result(receipt, true)),
          unsupportedEvidence: request.approvalUnsupported ?? null,
          ownerId: projection.thread.ownerId ?? null,
          ownerCoordinates,
          ...(shown === undefined ? {} : shown),
          answerable: !permitted
            ? { via: "ui_only", reason: "approvals_not_granted" }
            : request.status !== "pending"
              ? { via: "ui_only", reason: "already_answered" }
              : shown === undefined || request.responseCapability.type !== "live"
                ? { via: "ui_only", reason: "unverified_profile_or_incomplete_grant" }
                : {
                    via: "t3_approval_request",
                    decisions: ["accept", "decline"],
                    requiredConsentScope: "turn",
                  },
          resolvedBy: request.resolvedBy ?? null,
          deliveryState: request.approvalDelivery ?? null,
        };
      });
      return input.action === "read"
        ? yield* describe(input.requestId)
        : {
            requests: yield* Effect.forEach(
              projection.runtimeRequests.filter(
                (request) =>
                  request.status === "pending" &&
                  projection.turnItems.some(
                    (item) => item.type === "approval_request" && item.requestId === request.id,
                  ),
              ),
              (request) => describe(request.id),
            ),
          };
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) => (isMcpFailure(error) ? error : unavailable())),
      ),
  );

  const execute = Effect.fn("ApprovalService.execute")(
    function* (
      input: ApprovalRespondInput,
      caller: ApprovalCaller,
      destination: ApprovalDestinationGuard | undefined,
      prepareOnly: boolean,
    ) {
      yield* local(input.environmentId);
      const role = destination === undefined ? "local" : "receiver";
      const principalId =
        destination === undefined
          ? `session:${caller.sessionId}`
          : `link:${destination.authority.linkIdentityId}:client:${destination.authority.initiatingClientId}`;
      let row = yield* Receipts.find(principalId, input.clientRequestId, role);
      const saved = row === undefined ? undefined : yield* decodeStoredGuard(row.operation_json);
      const forwardedActor =
        destination === undefined
          ? {}
          : {
              forwardedBy: {
                environmentId: destination.authority.sourceEnvironmentId,
                linkIdentityId: destination.authority.linkIdentityId,
                initiatingClientId: destination.authority.initiatingClientId,
                forwarderReceiptId: destination.forwarderReceiptId,
                asserted: true as const,
              },
            };
      const authorization =
        destination === undefined
          ? yield* authority
              .check(caller.sessionId)
              .pipe(
                Effect.mapError((error) =>
                  error.reason === "storage_unavailable"
                    ? unavailable()
                    : refuse("approvals_not_granted"),
                ),
              )
          : {
              application_id: `peer-link:${destination.authority.linkIdentityId}`,
              ...(yield* (
                Option.isSome(destinationGuard)
                  ? destinationGuard.value.check(
                      saved?.guard ?? {
                        receiptId: "preparation",
                        principalId,
                        sessionId: caller.sessionId,
                        environmentId: here,
                        authorityRevision: destination.authority.credentialRevision,
                        expected: input.expected,
                        grantDigest: input.consent.grantDigest,
                        consent: input.consent,
                        actor: {
                          kind: "mcp_client",
                          principalId,
                          label: caller.label,
                          ...forwardedActor,
                        },
                        runtimeModeCeiling: caller.runtimeMode,
                        interactionModeCeiling: caller.interactionMode,
                        destination,
                      },
                      input.threadId,
                    )
                  : Effect.fail(
                      new ApprovalAuthority.ApprovalAuthorityError({ reason: "authority_revoked" }),
                    )
              ).pipe(
                Effect.mapError((cause) =>
                  cause.reason === "storage_unavailable"
                    ? unavailable()
                    : refuse(
                        cause.reason === "mode_changed" ? "mode_changed" : "authority_revoked",
                      ),
                ),
              )),
            };
      const operation = {
        version: 1,
        principalId,
        environmentId: here,
        input,
        limits:
          destination !== undefined && saved !== undefined
            ? saved.limits
            : { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
        ...(destination === undefined
          ? {}
          : {
              forwarding: {
                sourceEnvironmentId: destination.authority.sourceEnvironmentId,
                initiatingClientId: destination.authority.initiatingClientId,
                forwarderReceiptId: destination.forwarderReceiptId,
                forwardingKey: destination.forwardingKey,
                operationDigest: destination.operationDigest,
              },
            }),
      };
      const operationDigest = yield* approvalOperationDigest(operation);
      const replayed = row !== undefined;
      if (row !== undefined && row.operation_digest !== operationDigest)
        return yield* refuse("idempotency_conflict");
      if (row !== undefined) {
        // The command receipt and approval receipt commit together; inspect it before pending state.
        const receipt = yield* commands.getByCommandId(CommandId.make(row.command_id));
        if (
          row.state === "prepared" &&
          Option.isSome(receipt) &&
          receipt.value.status === "rejected"
        ) {
          yield* Receipts.reconcileNativeRejections(row.command_id);
          row = (yield* Receipts.find(principalId, input.clientRequestId, role))!;
        }
        if (row.state !== "prepared" || Option.isSome(receipt)) return Receipts.result(row, true);
      }
      const refusePrepared = Effect.fn("ApprovalService.refusePrepared")(function* (
        code: ApprovalFailureCode,
      ) {
        if (row?.state !== "prepared") return yield* refuse(code);
        yield* Receipts.transition(
          row.command_id,
          "refused",
          { commandId: row.command_id, boundary: "not_started" },
          code,
        );
        const current = yield* Receipts.byCommand(row.command_id);
        if (current === undefined) return yield* unavailable();
        return Receipts.result(current, true);
      });
      const context = yield* projections.getRuntimeResponseContext(input.threadId, input.requestId);
      if (context.request === undefined) return yield* refusePrepared("request_not_found");
      if (context.item?.type !== "approval_request")
        return yield* refusePrepared("not_an_approval");
      if (context.request.status !== "pending") return yield* refusePrepared("already_answered");
      if (context.request.responseCapability.type !== "live" || context.session === undefined)
        return yield* refusePrepared("not_live");
      if (context.session.driver !== "codex") return yield* refusePrepared("ui_only");
      const shown = yield* Presentation.presentation({
        environmentId: here,
        threadId: input.threadId,
        request: context.request,
        item: context.item,
      });
      if (shown === undefined) return yield* refusePrepared("ui_only");
      if (
        input.expected.requestIncarnation !== shown.expected.requestIncarnation ||
        input.expected.providerSessionId !== shown.expected.providerSessionId ||
        input.expected.providerGeneration !== shown.expected.providerGeneration
      )
        return yield* refusePrepared("request_changed");
      if (
        canonicalApprovalJson(input.expected) !== canonicalApprovalJson(shown.expected) ||
        input.consent.grantDigest !== shown.grantDigest
      )
        return yield* refusePrepared("presentation_changed");
      if (!context.item.options?.some((option) => option.decision === input.decision))
        return yield* refusePrepared("decision_not_offered");
      if (input.decision === "accept" && input.consent.effectiveScope !== "turn")
        return yield* refusePrepared("scope_consent_required");
      const receiptId = row?.receipt_id ?? `apr_${yield* crypto.randomUUIDv4()}`;
      const commandId = CommandId.make(row?.command_id ?? `approval:${receiptId}`);
      const freshGuard: ApprovalGuard = {
        receiptId,
        principalId,
        sessionId: caller.sessionId,
        environmentId: here,
        authorityRevision: authorization.revision,
        expected: input.expected,
        grantDigest: shown.grantDigest,
        consent: input.consent,
        runtimeModeCeiling: caller.runtimeMode,
        interactionModeCeiling: caller.interactionMode,
        ...(destination === undefined ? {} : { destination }),
        actor: {
          ...forwardedActor,
          kind: "mcp_client",
          principalId,
          label: caller.label,
          applicationId: authorization.application_id,
          authorityRevision: authorization.revision,
          assertion: {
            onBehalfOf: input.consent.onBehalfOf,
            authorization: input.consent.authorization,
          },
        },
      };
      const guard = row === undefined ? freshGuard : saved!.guard;
      if (row === undefined) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO agent_approval_receipts(receipt_id, role, principal_id, client_request_id,
        operation_digest, operation_json, environment_id, thread_id, request_id, request_incarnation,
        provider_session_id, provider_generation, presentation_digest, decision, effective_scope, grant_digest,
        command_id, state, authority_revision, actor_json, created_at, updated_at)
        VALUES (${receiptId}, ${role}, ${principalId}, ${input.clientRequestId}, ${operationDigest}, ${canonicalApprovalJson({ ...operation, guard })},
          ${here}, ${input.threadId}, ${input.requestId}, ${input.expected.requestIncarnation}, ${input.expected.providerSessionId},
          ${input.expected.providerGeneration}, ${input.expected.presentationDigest}, ${input.decision}, ${input.consent.effectiveScope},
          ${shown.grantDigest}, ${commandId}, 'prepared', ${authorization.revision}, ${canonicalApprovalJson(guard.actor)}, ${now}, ${now})
        ON CONFLICT(principal_id, client_request_id, role) DO NOTHING`;
        row = yield* Receipts.find(principalId, input.clientRequestId, role);
        if (row?.operation_digest !== operationDigest || row.command_id !== commandId) {
          if (row?.operation_digest !== operationDigest)
            return yield* refuse("idempotency_conflict");
          return Receipts.result(row, true);
        }
      }
      if (prepareOnly) return Receipts.result(row!, replayed);
      const hooks = yield* ApprovalTestHooks;
      yield* hooks.afterPrepare ?? Effect.void;
      yield* native
        .dispatch({
          type: "runtime-request.respond",
          commandId,
          threadId: input.threadId,
          requestId: input.requestId,
          decision: input.decision,
          approvalGuard: guard,
        })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: caller.runtimeMode,
            interactionMode: caller.interactionMode,
          }),
          Effect.catch((error) => {
            const code =
              error._tag === "OrchestratorThreadAboveModeLimitError"
                ? destination !== undefined
                  ? "mode_changed"
                  : error.mode === "runtime"
                    ? "runtime_mode_escalation_denied"
                    : "interaction_mode_escalation_denied"
                : typeof error === "object" &&
                    error !== null &&
                    "cause" in error &&
                    typeof error.cause === "object" &&
                    error.cause !== null &&
                    "approvalCode" in error.cause &&
                    isApprovalFailureCode(error.cause.approvalCode)
                  ? error.cause.approvalCode
                  : undefined;
            // Storage/transport failures can occur after commit. Keep the stable prepared
            // operation recoverable; its exact retry consults the native command receipt.
            if (code === undefined)
              return Receipts.find(principalId, input.clientRequestId, role).pipe(
                Effect.mapError(unavailable),
                Effect.flatMap((current) =>
                  current !== undefined && current.state !== "prepared"
                    ? Effect.void
                    : Effect.fail(unavailable()),
                ),
              );
            return Receipts.transition(
              commandId,
              "refused",
              { commandId, boundary: "not_started" },
              code,
            ).pipe(Effect.mapError(unavailable), Effect.asVoid);
          }),
        );
      row = yield* Receipts.find(principalId, input.clientRequestId, role);
      if (row === undefined) return yield* unavailable();
      return Receipts.result(row, replayed);
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) => (isMcpFailure(error) ? error : unavailable())),
      ),
  );
  const status = Effect.fn("ApprovalService.status")(
    function* (input: Extract<ApprovalToolInput, { action: "status" }>, sessionId: string) {
      yield* local(input.environmentId);
      const row =
        (yield* sql<Receipts.ReceiptRow>`SELECT * FROM agent_approval_receipts WHERE role = 'local'
        AND principal_id = ${`session:${sessionId}`} AND client_request_id = ${input.clientRequestId} AND thread_id = ${input.threadId}`)[0];
      if (row === undefined) return yield* refuse("request_not_found");
      return Receipts.result(row, true);
    },
    (effect) =>
      effect.pipe(Effect.mapError((error) => (isMcpFailure(error) ? error : unavailable()))),
  );
  return ApprovalService.of({
    read,
    status,
    respond: Effect.fn("ApprovalService.respond")(
      (input: ApprovalRespondInput, caller: ApprovalCaller) =>
        execute(input, caller, undefined, false),
    ),
    prepareForwarded: Effect.fn("ApprovalService.prepareForwarded")(
      (
        input: ApprovalRespondInput,
        caller: ApprovalCaller,
        destination: ApprovalDestinationGuard,
      ) => execute(input, caller, destination, true),
    ),
    commitForwarded: Effect.fn("ApprovalService.commitForwarded")(
      (
        input: ApprovalRespondInput,
        caller: ApprovalCaller,
        destination: ApprovalDestinationGuard,
      ) => execute(input, caller, destination, false),
    ),
  });
});
export const layer = Layer.effect(ApprovalService, make);
