import * as Schema from "effect/Schema";
import { ApprovalToolInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import type { ApprovalToolWireInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Forwarding from "../../../approvals/ApprovalForwarding.ts";
import * as ApprovalService from "../../../approvals/ApprovalService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { ApprovalToolkit } from "./tools.ts";

const handle = Effect.fn("mcp.approvalRequest")(function* (
  input: ApprovalToolInput,
  forwarding: Option.Option<Forwarding.ApprovalForwarding["Service"]>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (input.environmentId !== undefined && input.environmentId !== scope.environmentId)
    return yield* Option.isSome(forwarding)
      ? forwarding.value.call(input)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "forwarding_unavailable",
            message: "Linked approval forwarding is unavailable.",
          }),
        );
  if (scope.thread !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_caller_refused",
      message: "Use the app for in-app permission requests.",
    });
  if (scope.client?.taskOnly === true)
    return yield* new OrchestratorMcpFailure({
      code: "task_only_refused",
      message: "Task-only clients cannot use permission approvals.",
    });
  yield* readThread(input.threadId, ["runtimeRequests"]);
  const service = yield* ApprovalService.ApprovalService;
  if (input.action === "status") {
    if (scope.client === undefined || scope.client.linked === true)
      return yield* new OrchestratorMcpFailure({
        code: "approvals_not_granted",
        message: "Use the originating client to read its receipt.",
      });
    return yield* service.status(input, scope.client.sessionId);
  }
  if (input.action !== "respond") return yield* service.read(input, scope.client?.sessionId);
  if (scope.client === undefined || scope.client.linked === true)
    return yield* new OrchestratorMcpFailure({
      code: "approvals_not_granted",
      message: "Local approval permission is required.",
    });
  return yield* service.respond(input, {
    sessionId: scope.client.sessionId,
    label: scope.client.label,
    ...McpInvocationContext.clientModeCeiling(scope.client),
  });
});
const decodeApprovalInput = Schema.decodeUnknownEffect(ApprovalToolInput);
const checked = (
  input: ApprovalToolWireInput,
  forwarding: Option.Option<Forwarding.ApprovalForwarding["Service"]>,
) =>
  decodeApprovalInput(input).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Read needs requestId. Respond also needs clientRequestId, expected, decision and consent. List accepts only its thread and environment.",
        }),
    ),
    Effect.flatMap((decoded) => handle(decoded, forwarding)),
  );
export const layer = McpToolAccess.toLayer(
  ApprovalToolkit,
  Effect.gen(function* () {
    const forwarding = yield* Effect.serviceOption(Forwarding.ApprovalForwarding);
    const call = (input: ApprovalToolWireInput) => checked(input, forwarding);
    return {
      t3_approval_request: McpToolAccess.either(
        (input) => input.action !== "respond",
        McpToolAccess.reads(call),
        McpToolAccess.approves((input: ApprovalToolWireInput) => [input.threadId], call),
      ),
    };
  }),
);
