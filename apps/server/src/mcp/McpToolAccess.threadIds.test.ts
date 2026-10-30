import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { THREAD_ID_INPUT_FORMS } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const uuid = "5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04";
const unknownUuid = "0c4f2a91-7b3e-4d65-8a12-9e5f3c7b1d20";
const providerId = "thread:provider:codex:3f2b";
const here = EnvironmentId.make("env-here");
const box = EnvironmentId.make("env-box");

const live = (id: string) => liveThreadShell(ThreadId.make(id));
const fixtureShells = new Map<string, OrchestrationV2ThreadShell>([
  [uuid, live(uuid)],
  [providerId, live(providerId)],
  // Non-uuid ids whose `thread_` form names another thread, or none.
  ["legacy", live("legacy")],
  ["kept", live("kept")],
  ["thread_kept", live("thread_kept")],
  ["deleted", { ...live("deleted"), deletedAt: live("deleted").updatedAt }],
]);
const fixtureThreads = {
  getThreadShell: (threadId: ThreadId) => Effect.succeed(fixtureShells.get(threadId) ?? null),
};

const caller: McpInvocationContext.McpInvocationScope = {
  environmentId: here,
  requestNamespace: "client:thread-ids",
  thread: undefined,
  client: { sessionId: "thread-ids", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-ids", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-ids", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The thread id a call reached its handler with, or its failure. */
const outcome = (result: McpSchema.CallToolResult) => {
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const { _tag, ...rest } = JSON.parse(text) as Record<string, unknown>;
  return rest;
};

const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const probe = {
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    targetThreadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ThreadIdProbeToolkit = Toolkit.make(
  Tool.make("reads_thread", probe),
  Tool.make("writes_thread", probe),
  Tool.make("local_thread", { ...probe, parameters: Schema.Struct({ threadId: ThreadId }) }),
);
const echo = (params: {
  readonly threadId?: ThreadId | undefined;
  readonly targetThreadId?: ThreadId | undefined;
}) =>
  Effect.succeed({
    ran: [params.threadId, params.targetThreadId].filter((id) => id !== undefined).join(" > "),
  });

const probeServer = McpHttpServer.toolkitRegistration(
  ThreadIdProbeToolkit,
  McpToolAccess.toLayer(ThreadIdProbeToolkit, {
    reads_thread: McpToolAccess.reads(echo),
    writes_thread: McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      echo,
    ),
    local_thread: McpToolAccess.reads(echo),
  }),
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(Layer.mock(ThreadManagement.ThreadManagementService)(fixtureThreads)),
  // Stands in for a linked environment, answering with where the call went and what it carried.
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId, params) =>
        Effect.succeed({
          ran: `${tool.name} in ${environmentId}: ${(params as { threadId: string }).threadId}`,
        } as never),
    }),
  ),
);

const contextHref = (id: string) => `t3-context://v1/thread/${id}`;
const v2 = (environmentId: string, id: string) => `t3-thread://v2/${environmentId}/${id}`;

it.effect.each([
  // Every form T3 shows an agent names the same thread, for reads and writes alike.
  ["reads_thread", { threadId: uuid }, uuid],
  ["reads_thread", { threadId: `thread_${uuid}` }, uuid],
  ["reads_thread", { threadId: contextHref(`thread_${uuid}`) }, uuid],
  ["reads_thread", { threadId: v2(here, uuid) }, uuid],
  ["reads_thread", { threadId: `t3-thread://v1/${uuid}` }, uuid],
  ["writes_thread", { threadId: `thread_${uuid}` }, uuid],
  ["writes_thread", { threadId: contextHref(`thread_${uuid}`) }, uuid],
  [
    "writes_thread",
    { threadId: v2(here, uuid), targetThreadId: `thread_${uuid}` },
    uuid + " > " + uuid,
  ],
  // A uuid's context id loses `thread_` even when no thread has it, so the miss names the uuid.
  ["reads_thread", { threadId: `thread_${unknownUuid}` }, unknownUuid],
  // Ids that are not uuids lose `thread_` only for a thread that has the rest.
  ["reads_thread", { threadId: providerId }, providerId],
  ["reads_thread", { threadId: "thread_legacy" }, "legacy"],
  ["reads_thread", { threadId: "thread_kept" }, "thread_kept"],
  ["reads_thread", { threadId: "thread_nowhere" }, "thread_nowhere"],
  // A link holds the id as written, or percent-encoded.
  ["reads_thread", { threadId: v2(here, encodeURIComponent(providerId)) }, providerId],
  ["reads_thread", { threadId: v2(here, providerId) }, providerId],
  // A v2 link's environment is the call's, and a matching one is fine.
  ["reads_thread", { threadId: v2(box, uuid) }, `reads_thread in ${box}: ${uuid}`],
  ["reads_thread", { environmentId: here, threadId: v2(here, uuid) }, uuid],
  ["writes_thread", { threadId: v2(box, uuid) }, `writes_thread in ${box}: ${uuid}`],
  // A linked environment looks its own threads up, so only a uuid's prefix goes before it.
  [
    "reads_thread",
    { environmentId: box, threadId: `thread_${uuid}` },
    `reads_thread in ${box}: ${uuid}`,
  ],
  [
    "reads_thread",
    { environmentId: box, threadId: "thread_legacy" },
    `reads_thread in ${box}: thread_legacy`,
  ],
  ["local_thread", { threadId: v2(here, uuid) }, uuid],
] as const)("%s %o reaches %s", ([tool, args, expected]) =>
  callTool(tool, args).pipe(
    Effect.map((result) => expect(outcome(result)).toEqual({ ran: expected })),
    Effect.provide(probeServer),
  ),
);

it.effect.each([
  [
    "reads_thread",
    { environmentId: box, threadId: v2(here, uuid) },
    `The thread link names environment ${here}, but environmentId is ${box}. Omit one or make them match.`,
  ],
  [
    "writes_thread",
    { threadId: v2(here, uuid), targetThreadId: v2(box, uuid) },
    "The thread links name different environments.",
  ],
  [
    "local_thread",
    { threadId: v2(box, uuid) },
    `The thread link names environment ${box}; this tool acts only in this environment.`,
  ],
  [
    "reads_thread",
    { threadId: "t3-context://v1/file/file_notes" },
    `\`t3-context://v1/file/file_notes\` names no thread. ${THREAD_ID_INPUT_FORMS}`,
  ],
  [
    "writes_thread",
    { threadId: `t3-thread://v3/${uuid}` },
    `\`t3-thread://v3/${uuid}\` names no thread. ${THREAD_ID_INPUT_FORMS}`,
  ],
] as const)("%s %o is refused", ([tool, args, message]) =>
  callTool(tool, args).pipe(
    Effect.map((result) => expect(outcome(result)).toEqual({ code: "invalid_request", message })),
    Effect.provide(probeServer),
  ),
);

const orchestratorServer = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      ...fixtureThreads,
      getProjectThreadRecords: ({ threadId }) =>
        Effect.succeed(idleThreadProjection(fixtureShells.get(threadId)!) as never),
      getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false } as never),
      sendToThread: (input) =>
        Effect.succeed({
          run: { id: RunId.make(`run:${input.threadId}`), status: "queued" },
          delivery: "queued",
        } as never),
    }),
  ),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
  Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
);

const acceptedForms = [
  uuid,
  `thread_${uuid}`,
  contextHref(`thread_${uuid}`),
  v2(here, uuid),
] as const;

it.effect.each(acceptedForms)("t3_thread_read and t3_thread_send take %s", (threadId) =>
  Effect.gen(function* () {
    const read = outcome(yield* callTool("t3_thread_read", { threadId }));
    expect(read).toMatchObject({ thread: { threadId: uuid } });
    const sent = outcome(yield* callTool("t3_thread_send", { threadId, message: "hello" }));
    expect(sent).toMatchObject({ threadId: uuid, runId: `run:${uuid}` });
  }).pipe(Effect.provide(orchestratorServer)),
);

it.effect("t3_thread_read tells an unknown id from a deleted thread", () =>
  Effect.gen(function* () {
    expect(
      outcome(yield* callTool("t3_thread_read", { threadId: `thread_${unknownUuid}` })),
    ).toEqual({
      code: "thread_not_found",
      message: `No thread ${unknownUuid} exists here. ${THREAD_ID_INPUT_FORMS}`,
    });
    expect(outcome(yield* callTool("t3_thread_read", { threadId: "deleted" }))).toEqual({
      code: "thread_not_found",
      message: "Thread deleted was deleted and is no longer available.",
    });
    expect(
      outcome(yield* callTool("t3_thread_send", { threadId: "deleted", message: "hi" })),
    ).toEqual({
      code: "thread_not_found",
      message: "Thread deleted was deleted and is no longer available.",
    });
  }).pipe(Effect.provide(orchestratorServer)),
);

const dispatched: Array<string> = [];
const threadServer = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      ...fixtureThreads,
      getProjectThreadRecords: ({ threadId }) =>
        Effect.succeed(idleThreadProjection(fixtureShells.get(threadId)!)),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push("threadId" in command ? command.threadId : "");
          return { sequence: 1 } as never;
        }),
    }),
  ),
);

it.effect.each(acceptedForms)("t3_thread_configure and t3_thread_organize take %s", (threadId) =>
  Effect.gen(function* () {
    dispatched.length = 0;
    expect(outcome(yield* callTool("t3_thread_configure", { threadId }))).toMatchObject({
      threadId: uuid,
    });
    expect(outcome(yield* callTool("t3_thread_organize", { action: "pin", threadId }))).toEqual({
      sequence: 1,
    });
    expect(dispatched).toEqual([uuid]);
  }).pipe(Effect.provide(threadServer)),
);
