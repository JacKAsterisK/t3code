import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { credentialAccess, fleetCredentialScopes } from "./FleetAccessPolicy.ts";

describe("fleet credential scopes", () => {
  it("let a read-only machine read and observe another's threads but not launch, send, interrupt or respond", () => {
    const readOnly = fleetCredentialScopes("read-only");
    // Sends, interrupts and answers to approvals and questions are all dispatched commands.
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.launchThread,
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
      WS_METHODS.projectsMutate,
    ])
      expect(readOnly).not.toContain(requiredScopeForRpcMethod(method));
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
      ORCHESTRATION_V2_WS_METHODS.searchThreads,
      ORCHESTRATION_V2_WS_METHODS.getTurnItem,
    ])
      expect(readOnly).toContain(requiredScopeForRpcMethod(method));
    expect(credentialAccess({ scopes: readOnly })).toBe("read-only");
    expect(credentialAccess({ scopes: fleetCredentialScopes("standard") })).toBe("standard");
  });
});
