import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ApprovalToolInput, ApprovalRespondInput } from "./approvals.ts";
import { mcpClientScopes, AuthStandardClientScopes, sessionGrantsScope } from "./auth.ts";
import { OrchestrationV2Command } from "./orchestrationV2.ts";
const isApprovalRespond = Schema.is(ApprovalRespondInput);
const decodeToolInput = Schema.decodeUnknownSync(ApprovalToolInput);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
it("keeps approval authority independent of access level, ordinary codes and legacy scopes", () => {
  for (const access of [
    "read-only",
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ] as const)
    assert.notInclude(mcpClientScopes(access), "orchestration:approve");
  assert.notInclude(AuthStandardClientScopes, "orchestration:approve");
  assert.notInclude(mcpClientScopes("read-only", { approvals: true }), "orchestration:approve");
  assert.include(mcpClientScopes("full-access", { approvals: true }), "orchestration:approve");
  assert.isFalse(
    sessionGrantsScope(
      { authenticated: true, scopes: ["orchestration:operate"] },
      "orchestration:approve",
    ),
  );
});
it("rejects forged actor/attestation fields, persistent decisions and incomplete actions", () => {
  const input = {
    action: "respond",
    threadId: "thread",
    requestId: "request",
    clientRequestId: "retry-key-one",
    expected: {
      requestIncarnation: "incarnation",
      providerSessionId: "session",
      providerGeneration: "generation",
      presentationRevision: 1,
      presentationDigest: "digest",
    },
    decision: "accept",
    consent: {
      effectiveScope: "turn",
      grantDigest: "grant",
      onBehalfOf: "Person",
      authorization: "Allow these permissions for this turn.",
    },
  };
  assert.isTrue(isApprovalRespond(input));
  for (const extra of [
    { attestation: {} },
    { destination: {} },
    { approvalGuard: { destination: {} } },
    { resolvedBy: { kind: "user" } },
    { decision: "acceptForSession" },
    { decision: "acceptAlways" },
    { consent: { ...input.consent, effectiveScope: "session" } },
  ])
    assert.throws(() => decodeToolInput({ ...input, ...extra }));
  assert.throws(() => decodeToolInput({ action: "read", threadId: "thread" }));
  assert.throws(() =>
    decodeCommand({
      type: "runtime-request.respond",
      commandId: "one",
      threadId: "thread",
      requestId: "request",
      decision: "accept",
      resolvedBy: { kind: "user" },
    }),
  );
});
