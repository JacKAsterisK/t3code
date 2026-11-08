import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { McpSchema } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { LanToolkit } from "./toolkits/lan/tools.ts";

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "pull-requests",
      threadId: invocation.thread?.threadId,
    });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("refuses thread-owned capabilities to a caller signed in from outside a thread", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
    capabilities: new Set(["preview", "orchestration"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({ capability: "preview", environmentId: "environment-1" });
    expect(error.threadId).toBeUndefined();
  });
});

it.effect("shows the LAN task tools to outside clients but never to an in-app thread", () => {
  const base = {
    environmentId: EnvironmentId.make("environment-1"),
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 1,
  };
  const thread: McpInvocationContext.McpInvocationScope = {
    ...base,
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("claude"),
    },
    client: undefined,
  };
  const taskClient: McpInvocationContext.McpInvocationScope = {
    ...base,
    requestNamespace: "client:grant-1",
    thread: undefined,
    client: {
      sessionId: "session-1",
      grantId: "grant-1",
      taskOnly: true,
      label: "Gateway",
      access: "auto",
    },
  };
  const visible = (scope: McpInvocationContext.McpInvocationScope) =>
    Effect.sync(() =>
      Object.values(LanToolkit.tools).filter(
        (tool) =>
          Context.getOrUndefined(
            tool.annotations,
            McpSchema.EnabledWhen,
          )?.({
            protocolVersion: "2025-06-18",
            capabilities: {},
          }) === true,
      ),
    ).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

  return Effect.gen(function* () {
    expect(yield* visible(thread)).toEqual([]);
    expect(yield* visible(taskClient)).toHaveLength(Object.keys(LanToolkit.tools).length);
  });
});

// Outside clients see these tools beside the native ones but get no in-app system text, so the
// LAN descriptions carry the route choice themselves.
it("sends ordinary machine reads to linked environments without inviting a route around a refusal", () => {
  const { t3_lan_environments, t3_lan_task_list, t3_lan_task_read } = LanToolkit.tools;
  const environments = t3_lan_environments.description ?? "";
  expect(environments).toContain(
    "Optional route for an administrator-configured, scoped LAN task client",
  );
  expect(environments).toContain(
    "a general-access client lists linked machines with `t3_environment_links`",
  );
  expect(environments).toContain("not a reachability result for any machine");
  expect(environments).toContain("report it, and never retry it through another tool");
  expect(environments).toContain(
    "Task-only credentials use only these tools and the projects their grant names",
  );
  expect(t3_lan_task_list.description).toContain("`t3_thread_list`");
  expect(t3_lan_task_read.description).toContain("`t3_thread_read`");
});

it("acts at an administrator's ceiling for a client approved above it", () => {
  const scope = (
    access: McpInvocationContext.McpClientCaller["access"],
    narrowedTo?: McpInvocationContext.ClientModes,
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access, narrowedTo },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const modes = (invocation: McpInvocationContext.McpInvocationScope, ceiling?: "auto") =>
    McpInvocationContext.clientModeCeiling(
      McpInvocationContext.withRuntimeModeCeiling(invocation, ceiling).client,
    );

  expect(modes(scope("full-access"), "auto")).toEqual({
    runtimeMode: "auto",
    interactionMode: "default",
  });
  // A narrower request and the approved mode still win below the ceiling.
  expect(
    modes(
      scope("full-access", { runtimeMode: "approval-required", interactionMode: "plan" }),
      "auto",
    ),
  ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  expect(modes(scope("auto-accept-edits"), "auto").runtimeMode).toBe("auto-accept-edits");
  expect(modes(scope("full-access")).runtimeMode).toBe("full-access");
});
