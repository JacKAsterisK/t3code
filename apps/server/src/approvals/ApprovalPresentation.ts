import type {
  ApprovalBinding,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ThreadId,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  approvalGrantDigest,
  approvalPresentationDigest,
} from "@t3tools/shared/approvalPresentation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export const presentation = Effect.fn("ApprovalPresentation.read")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
}) {
  const { request, item } = input;
  if (
    item.type !== "approval_request" ||
    request.approval === undefined ||
    item.fullAccessOverride === "ask_rule"
  )
    return undefined;
  const descriptor = request.approval;
  const digest = yield* approvalPresentationDigest({
    environmentId: input.environmentId,
    threadId: input.threadId,
    runId: item.runId,
    requestId: request.id,
    ...descriptor,
    createdAt: DateTime.formatIso(request.createdAt),
    options: item.options ?? [],
    prompt: item.prompt ?? null,
    reason: item.reason ?? null,
    appName: item.appName ?? null,
    fullAccessOverride: item.fullAccessOverride ?? null,
  });
  return {
    grant: descriptor.grant,
    grantDigest: yield* approvalGrantDigest(descriptor.grant),
    expected: {
      requestIncarnation: descriptor.requestIncarnation,
      providerSessionId: descriptor.providerSessionId,
      providerGeneration: descriptor.providerGeneration,
      presentationRevision: descriptor.presentationRevision,
      presentationDigest: digest,
    } satisfies ApprovalBinding,
  };
});
