import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeSubagentChildThread, subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});

it("does not inherit its parent's Full access launch audit", () => {
  const parentId = ThreadId.make("parent");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const parentThread = {
    id: parentId,
    runtimeMode: "full-access",
    lineage: { rootThreadId: parentId },
    runtimeModeEscalation: {
      actor: {
        environmentId: EnvironmentId.make("local"),
        threadId: ThreadId.make("starter"),
        title: "Starter",
      },
      from: "auto",
      to: "full-access",
      reason: "explicit-launch-under-owner-policy",
    },
  } as OrchestrationV2AppThread;
  const child = makeSubagentChildThread({
    parentThread,
    childThreadId: ThreadId.make("child"),
    parentNodeId: NodeId.make("node:child"),
    activeProviderThreadId: null,
    providerInstanceId,
    modelSelection,
    title: "Child",
    now: DateTime.makeUnsafe(0),
    createdBy: "agent",
    creationSource: "mcp",
  });
  expect(child.runtimeMode).toBe("full-access");
  expect(child.runtimeModeEscalation).toBeUndefined();
});
