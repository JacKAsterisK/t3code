import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  LINKED_OWNER_POLICY_FULL_ACCESS,
  RuntimeMode,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type SourceControlCloneRepositoryInput,
  ProjectId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { ApprovalPeerAccess } from "../auth/ApprovalPeerAccess.ts";
import type { ProjectionTimelinePageOptions } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { PeerMcpClient } from "./PeerMcpClient.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const isLegacyRuntimeMode = Schema.is(RuntimeMode);
const boxProject = ProjectId.make("project:box");
const boxThread = ThreadId.make("thread:box-auto");
const boxRun = RunId.make("run:box-auto");

/** What B's thread service was asked to do. */
interface Seen {
  readonly sends: ReadonlyArray<ThreadManagement.ThreadManagementSendInput>;
  readonly waits: ReadonlyArray<ThreadManagement.ThreadManagementWaitInput>;
  readonly reads: ReadonlyArray<ProjectionTimelinePageOptions>;
  readonly launches: ReadonlyArray<ThreadLaunch.ThreadLaunchInput>;
  readonly projects: ReadonlyArray<ProjectService.ProjectCreateInput>;
  readonly clones: ReadonlyArray<SourceControlCloneRepositoryInput>;
  /** Commands dispatched and delegated-task stops, as `<type> <threadId>`. */
  readonly stops: ReadonlyArray<string>;
}
const nothingSeen: Seen = {
  sends: [],
  waits: [],
  reads: [],
  launches: [],
  projects: [],
  clones: [],
  stops: [],
};

/** The box user's own thread, which no link started. */
const usersThread = ThreadId.make("thread:box-users-own");

/**
 * B's threads: one `auto` thread in `boxProject` that the laptop's link
 * started, whose run finishes on the third wait, and the box user's own.
 * Every send and wait is recorded.
 */
const boxThreads = (
  seen: Ref.Ref<Seen>,
  linkSession: Ref.Ref<string>,
  runtimeMode: "auto" | "full-access",
) => {
  const base = { ...liveThreadShell(boxThread, { runtimeMode }), projectId: boxProject };
  const linked = Ref.get(linkSession).pipe(
    Effect.map((sessionId) => ({ ...base, linkOrigin: { sessionId, label: "T3 Code · Laptop" } })),
  );
  const users = { ...liveThreadShell(usersThread, { runtimeMode: "auto" }), projectId: boxProject };
  const run = (status: OrchestrationV2Run["status"]) =>
    ({
      id: boxRun,
      ordinal: 1,
      status,
      modelSelection: base.modelSelection,
      requestedAt: base.createdAt,
      startedAt: null,
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const shellOf = (threadId: ThreadId): Effect.Effect<OrchestrationV2ThreadShell | null> =>
    threadId === boxThread ? linked : Effect.succeed(threadId === usersThread ? users : null);
  const projectionOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map(
        (thread) =>
          ({ thread, runs: [run("running")], runtimeRequests: [], providerTurns: [] }) as never,
      ),
    );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    getRunCount: () => Effect.succeed(1),
    getTimelinePage: (_threadId, options) =>
      Ref.update(seen, (current) => ({ ...current, reads: [...current.reads, options] })).pipe(
        Effect.as({ items: [], totalItems: 0, hasMore: false, hasEarlier: false }),
      ),
    listProjectThreads: () => linked.pipe(Effect.map((shell) => [shell] as never)),
    getShellSnapshot: () => linked.pipe(Effect.map((shell) => ({ threads: [shell] }) as never)),
    sendToThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, sends: [...current.sends, input] })).pipe(
        Effect.as({ run: run("running"), delivery: "started" } as never),
      ),
    dispatch: (command) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [
          ...current.stops,
          `${command.type} ${"threadId" in command ? command.threadId : ""}`,
        ],
      })).pipe(
        // The stop asks the provider to interrupt the thread's running turn.
        Effect.as({
          sequence: 0,
          storedEvents: [
            {
              sequence: 1,
              commandId: command.commandId,
              event: {
                type: "turn-item.updated",
                runId: boxRun,
                payload: {
                  type: "run_interrupt_request",
                  providerTurnId: "provider-turn:box-auto",
                },
              },
            },
          ],
        } as never),
      ),
    stopDelegatedTasks: (input) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [...current.stops, `delegated-tasks.stop ${input.threadId}`],
      })),
    waitForThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, waits: [...current.waits, input] })).pipe(
        Effect.as({ threadId: input.threadId, run: run("completed"), timedOut: false }),
      ),
  });
};

/** B launches whatever it is asked to, and records it. */
const boxLaunches = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(seen, (current) => ({ ...current, launches: [...current.launches, input] })).pipe(
        Effect.as({
          threadId: input.threadId,
          projection: {
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              title: input.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult),
      ),
  });

/** B clones and registers whatever it is asked to, and records it. */
const boxProjects = (seen: Ref.Ref<Seen>) =>
  Layer.merge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === boxProject
            ? Option.some({
                id,
                title: "t3code",
                workspaceRoot: "/box/t3code",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-18T00:00:00.000Z",
                updatedAt: "2026-10-18T00:00:00.000Z",
                deletedAt: null,
              })
            : Option.none(),
        ),
      create: (input) =>
        Ref.update(seen, (current) => ({
          ...current,
          projects: [...current.projects, input],
        })).pipe(
          Effect.as({
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-18T00:00:00.000Z",
            updatedAt: "2026-10-18T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Ref.update(seen, (current) => ({ ...current, clones: [...current.clones, input] })).pipe(
          Effect.as({
            cwd: input.destinationPath,
            remoteUrl: "https://github.com/pingdotgg/t3code.git",
            repository: null,
          }),
        ),
    }),
  );

/**
 * The orchestrator and project toolkits on B's real `/mcp`, behind its real
 * OAuth. `linkSession` is filled in once A links, so B's fixture thread reads
 * as one that link started.
 */
const serveBox = (
  seen: Ref.Ref<Seen>,
  linkSession: Ref.Ref<string>,
  runtimeMode: "auto" | "full-access" = "auto",
) =>
  servePeer(
    box,
    Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerThreadToolkit,
    ).pipe(
      Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(boxThreads(seen, linkSession, runtimeMode)),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(boxLaunches(seen)),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(boxProjects(seen)),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.mock(ApprovalPeerAccess)({
            rawPeer: (sessionId) =>
              Ref.get(linkSession).pipe(
                Effect.map((expected) =>
                  sessionId === expected
                    ? {
                        linkIdentityId: "fixture-link",
                        sourceEnvironmentId: laptop.environmentId,
                        credentialRevision: 1,
                        expiresAt: 1,
                        access: "full-access",
                        scopes: [],
                        runtimeModeCeiling: "full-access",
                        interactionModeCeiling: "default",
                      }
                    : undefined,
                ),
              ),
          }),
        ),
      ),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-forwarding-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-forwarding-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * Environment A: its own orchestrator toolkit with forwarding, and a thread
 * caller whose modes the test picks. Its local threads never matter here.
 */
const makeLaptop = Effect.fn("makeLaptop")(function* (
  supportedModesFor: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<RuntimeMode> | undefined> = () => Effect.undefined,
  providerOnRead?: Effect.Effect<ProviderInstanceId>,
) {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const layerHere = Layer.mergeAll(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.layerProjectRegistration,
    McpHttpServer.layerThreadToolkit,
  ).pipe(
    Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-laptop-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(PeerForwarding.layer),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: (instanceId) =>
          Effect.succeed({
            snapshot: {
              getSnapshot: supportedModesFor(instanceId).pipe(
                Effect.map((supportedRuntimeModes) => ({ supportedRuntimeModes })),
              ),
            },
          } as ProviderInstance),
      }),
    ),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => {
          const shell =
            threadId === ThreadId.make("thread:laptop-from-desk")
              ? {
                  ...liveThreadShell(threadId, { runtimeMode: "full-access" }),
                  // Work another environment's link started on this laptop.
                  linkOrigin: { sessionId: "session:desk", label: "T3 Code · Desk" },
                }
              : threadId === ThreadId.make("thread:laptop-gavin")
                ? { ...liveThreadShell(threadId, { runtimeMode: "full-access" }), ownerId: "gavin" }
                : liveThreadShell(
                    threadId,
                    threadId === ThreadId.make("thread:laptop-plan")
                      ? { runtimeMode: "full-access", interactionMode: "plan" }
                      : threadId === ThreadId.make("thread:laptop-auto")
                        ? { runtimeMode: "auto" }
                        : threadId === ThreadId.make("thread:laptop-edits")
                          ? { runtimeMode: "auto-accept-edits" }
                          : { runtimeMode: "full-access" },
                  );
          return providerOnRead === undefined
            ? Effect.succeed(shell)
            : Effect.map(providerOnRead, (providerInstanceId) => ({
                ...shell,
                providerInstanceId,
                modelSelection: { ...shell.modelSelection, instanceId: providerInstanceId },
              }));
        },
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({
            thread: liveThreadShell(threadId, { runtimeMode: "full-access" }),
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        // No thread here delegated to the box, so a send there is no follow-up.
        Layer.mock(RemoteDelegation.RemoteDelegation)({
          followUp: (_scope, _environmentId, _request, sent) => Effect.succeed(sent),
        }),
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
      ),
    ),
    Layer.fresh,
  );
  const here = yield* Layer.build(layerHere);
  const server = Context.get(here, McpServer.McpServer);
  const scopeOf = (
    caller: string,
    capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["orchestration"]),
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: laptop.environmentId,
    requestNamespace: `provider-session:${caller}`,
    thread: {
      threadId: ThreadId.make(caller),
      providerSessionId: `provider-session:${caller}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities,
    issuedAt: 1,
  });
  const call = (
    caller: string,
    name: string,
    args: Record<string, unknown>,
    capabilities?: ReadonlySet<McpInvocationContext.McpCapability>,
  ) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          scopeOf(caller, capabilities),
        ),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    settings: Context.get(linking, ServerSettings.ServerSettingsService),
    peerClient: Context.get(linking, PeerMcpClient),
    call,
  };
});

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("an agent here works on a linked environment's threads within its own modes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({
        environmentId: laptop.environmentId,
        links: [
          { environmentId: box.environmentId, label: "Box", status: "reachable", access: "auto" },
        ],
      });

      const threads = yield* a.call("thread:laptop-full", "t3_thread_list", {
        environmentId: box.environmentId,
        projectId: boxProject,
      });
      expect(threads.isError).toBe(false);
      expect(threads.structuredContent).toMatchObject({
        projectId: boxProject,
        threads: [{ threadId: boxThread, runtimeMode: "auto" }],
      });

      // A full-access agent here is held to the link's `auto` there, which
      // the box's `auto` thread is within.
      const sent = yield* a.call("thread:laptop-full", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Carry on there.",
        clientRequestId: "send-1",
      });
      expect(sent.isError).toBe(false);
      expect(sent.structuredContent).toMatchObject({ threadId: boxThread, delivery: "started" });
      // The box records which thread here sent it.
      expect((yield* Ref.get(seen)).sends[0]?.linkedSender).toEqual({
        environmentId: laptop.environmentId,
        threadId: "thread:laptop-full",
        title: "thread:laptop-full",
      });

      // A plan-mode agent here may not steer that thread there: the box
      // refuses it, because the call carries the agent's own modes.
      const planned = yield* a.call("thread:laptop-plan", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Change course.",
      });
      expect(failureOf(planned)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      expect((yield* Ref.get(seen)).sends).toHaveLength(1);

      // stop=true stops the thread there as its Stop button does: the whole
      // thread and the tasks it delegated, not just the running turn.
      const stopped = yield* a.call("thread:laptop-full", "t3_thread_interrupt", {
        environmentId: box.environmentId,
        threadId: boxThread,
        stop: true,
        clientRequestId: "stop-1",
      });
      expect(stopped.structuredContent).toMatchObject({
        threadId: boxThread,
        runId: boxRun,
        status: "interrupt_requested",
      });
      expect((yield* Ref.get(seen)).stops).toEqual([
        `thread.stop ${boxThread}`,
        `delegated-tasks.stop ${boxThread}`,
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("forwards Auto messages to a Full access thread through a Full access link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession, "full-access");
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const message = {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "The Windows checks passed.",
      };
      for (const mode of ["auto", "queue", "steer"] as const) {
        const sent = yield* a.call("thread:laptop-auto", "t3_thread_send", { ...message, mode });
        expect(failureOf(sent)).toBeUndefined();
      }
      for (const [caller, options] of [
        ["thread:laptop-edits", {}],
        ["thread:laptop-auto", { mode: "restart" }],
        ["thread:laptop-auto", { freshContext: true }],
      ] as const) {
        const refused = yield* a.call(caller, "t3_thread_send", { ...message, ...options });
        expect(failureOf(refused)).toMatchObject({ code: "runtime_mode_escalation_denied" });
      }
      expect((yield* Ref.get(seen)).sends.map((input) => input.mode)).toEqual([
        "auto",
        "queue",
        "steer",
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps a forwarded wait short and its retries scoped to the caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const waited = yield* a.call("thread:laptop-full", "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect(waited.structuredContent).toEqual({
        threadId: boxThread,
        runId: boxRun,
        status: "completed",
        timedOut: false,
      });
      // One capped piece, so the caller's MCP request returns before its client times out.
      expect((yield* Ref.get(seen)).waits.map(({ timeoutMs }) => timeoutMs)).toEqual([45_000]);

      const send = (caller: string, clientRequestId: string) =>
        a.call(caller, "t3_thread_send", {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Once.",
          clientRequestId,
        });
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-other", "same-key");
      const [first, retried, other] = (yield* Ref.get(seen)).sends.map((input) => input.commandId);
      // The box sees every caller here as the one link, so the key is scoped
      // to its caller before it leaves: a retry matches, another agent's same
      // key does not.
      expect(retried).toBe(first);
      expect(other).not.toBe(first);
      expect(first).not.toContain("same-key");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("launches in a linked environment with the caller's modes, retry-safe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const launch = (caller: string, args: Record<string, unknown> = {}) =>
        a.call(caller, "t3_thread_launch", {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Run the suite there",
          modelSelection: codex,
          message: "Run the suite.",
          clientRequestId: "launch-1",
          ...args,
        });

      const first = yield* launch("thread:laptop-plan");
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        projectId: boxProject,
        modelSelection: codex,
      });
      const retried = yield* launch("thread:laptop-plan");
      const [launched, relaunched] = (yield* Ref.get(seen)).launches;
      // The thread there runs with the caller's own modes here, below the
      // link's full access, and a retry asks for the same thread.
      expect(launched).toMatchObject({ runtimeMode: "full-access", interactionMode: "plan" });
      expect(relaunched?.threadId).toBe(launched?.threadId);
      expect(retried.structuredContent).toEqual(first.structuredContent);

      // An escalation past the caller's own modes is refused here.
      const escalated = yield* launch("thread:laptop-plan", { interactionMode: "default" });
      expect(failureOf(escalated)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      // A pending upload lives here, so it cannot go along.
      yield* Ref.set(b.bearers, []);
      const withUpload = yield* launch("thread:laptop-full", {
        clientRequestId: "launch-2",
        attachments: [
          { type: "image", id: "upload-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ],
      });
      expect(failureOf(withUpload)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect((yield* Ref.get(seen)).launches).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([
  { source: false, destination: false },
  { source: true, destination: false },
  { source: false, destination: true },
  { source: true, destination: true },
])(
  "Auto can launch Full access through a Full access link with owner policies $source and $destination",
  ({ source, destination }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<Seen>(nothingSeen);
        const linkSession = yield* Ref.make("");
        const b = yield* serveBox(seen, linkSession, "full-access");
        const a = yield* makeLaptop();
        const allowed = source && destination;
        if (source) yield* a.settings.updateSettings({ allowAgentFullAccessLaunches: true });
        if (destination) yield* b.settings.updateSettings({ allowAgentFullAccessLaunches: true });
        yield* linkTo(a.links, b, "full-access");
        yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
        const launch = {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Run the suite there",
          modelSelection,
        };
        const requested = {
          ...launch,
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "gemini-4-neon",
          },
          runtimeMode: "full-access",
        };
        const autoCaller = "thread:laptop-auto";
        // Old receivers only accept the original RuntimeMode enum.
        expect(isLegacyRuntimeMode(LINKED_OWNER_POLICY_FULL_ACCESS)).toBe(false);
        if (allowed) {
          // Simulate a legacy sender talking to the real receiver over an approved link.
          const legacy = yield* a.peerClient
            .call({
              environmentId: box.environmentId,
              tool: "t3_thread_launch",
              arguments: requested,
              limits: { runtimeMode: "auto", interactionMode: "default" },
              writes: true,
              sender: {
                environmentId: laptop.environmentId,
                threadId: ThreadId.make(autoCaller),
                title: "Auto",
              },
              success: Schema.Struct({ threadId: ThreadId }),
            })
            .pipe(Effect.flip);
          expect(legacy.code).toBe("runtime_mode_escalation_denied");
          const forged = yield* a.peerClient
            .call({
              environmentId: box.environmentId,
              tool: "t3_thread_launch",
              arguments: { ...requested, runtimeMode: LINKED_OWNER_POLICY_FULL_ACCESS },
              limits: { runtimeMode: "auto", interactionMode: "default" },
              writes: true,
              sender: {
                environmentId: EnvironmentId.make("environment-unrelated"),
                threadId: ThreadId.make(autoCaller),
                title: "Auto",
              },
              success: Schema.Struct({ threadId: ThreadId }),
            })
            .pipe(Effect.flip);
          expect(forged.code).toBe("invalid_request");
          expect(forged.message).toContain("authenticated peer");
          expect((yield* Ref.get(seen)).launches).toEqual([]);
        }
        const explicit = yield* a.call(autoCaller, "t3_thread_launch", requested);
        if (allowed) {
          expect(failureOf(explicit)).toBeUndefined();
        } else {
          expect(failureOf(explicit)).toMatchObject({ code: "runtime_mode_escalation_denied" });
        }
        expect(failureOf(yield* a.call(autoCaller, "t3_thread_launch", launch))).toBeUndefined();
        const lower = yield* a.call("thread:laptop-edits", "t3_thread_launch", requested);
        expect(failureOf(lower)).toMatchObject({ code: "runtime_mode_escalation_denied" });
        const launches = (yield* Ref.get(seen)).launches;
        if (allowed) {
          expect(launches[0]?.modelSelection).toEqual(requested.modelSelection);
          expect(launches[0]?.runtimeModeEscalation).toMatchObject({
            actor: {
              threadId: autoCaller,
              peer: { sessionId: yield* Ref.get(linkSession), environmentId: laptop.environmentId },
            },
            from: "auto",
            to: "full-access",
            reason: "explicit-launch-under-owner-policy",
          });
        }
        expect(launches.map((input) => input.runtimeMode)).toEqual(
          allowed ? ["full-access", "auto"] : ["auto"],
        );

        const target = { environmentId: box.environmentId, threadId: boxThread };
        const configured = yield* a.call(autoCaller, "t3_thread_configure", {
          ...target,
          modelSelection,
        });
        const organized = yield* a.call(autoCaller, "t3_thread_organize", {
          ...target,
          action: "archive",
        });
        expect(failureOf(configured)).toBeUndefined();
        expect(failureOf(organized)).toBeUndefined();
        expect((yield* Ref.get(seen)).stops).toHaveLength(2);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a launch in a linked environment keeps the calling thread's owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      const launch = (
        caller: string,
        clientRequestId: string,
        args: Record<string, unknown> = {},
      ) =>
        a.call(caller, "t3_thread_launch", {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Owned there",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          message: "Run it.",
          clientRequestId,
          ...args,
        });

      // The review's reproduction: a Gavin-owned thread here launches on a machine whose default
      // is Dan. The box sees only the link session, which has no thread to inherit from.
      expect((yield* launch("thread:laptop-gavin", "owner-inherited")).isError).toBe(false);
      // A named owner still wins, and an unowned caller names none.
      expect(
        (yield* launch("thread:laptop-gavin", "owner-named", { ownerId: "dan" })).isError,
      ).toBe(false);
      expect((yield* launch("thread:laptop-full", "owner-none")).isError).toBe(false);
      const [inherited, named, none] = (yield* Ref.get(seen)).launches;
      expect(inherited?.ownerId).toBe("gavin");
      expect(named?.ownerId).toBe("dan");
      expect(none).toBeDefined();
      expect(none?.ownerId).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("brings a repository to a linked environment, only through full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen, yield* Ref.make(""));
      const a = yield* makeLaptop();
      const clone = { repository: "pingdotgg/t3code", destinationPath: "/home/box/t3code" };
      const register = { title: "t3code", workspaceRoot: "/home/box/t3code" };

      yield* linkTo(a.links, b, "full-access");
      const cloned = yield* a.call("thread:laptop-full", "t3_project_clone", {
        environmentId: box.environmentId,
        ...clone,
      });
      expect(cloned.structuredContent).toMatchObject({ cwd: clone.destinationPath });
      const created = yield* a.call("thread:laptop-full", "t3_project_create", {
        environmentId: box.environmentId,
        ...register,
      });
      expect(created.structuredContent).toMatchObject(register);
      expect((yield* Ref.get(seen)).clones).toEqual([clone]);
      expect((yield* Ref.get(seen)).projects).toMatchObject([register]);

      // A plan-mode agent here may not, and nothing leaves.
      yield* Ref.set(b.bearers, []);
      const planned = yield* a.call("thread:laptop-plan", "t3_project_create", {
        environmentId: box.environmentId,
        ...register,
      });
      expect(failureOf(planned)).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // Nor may a full-access agent through a link with less: the box holds it.
      yield* linkTo(a.links, b, "auto");
      for (const [name, args] of [
        ["t3_project_clone", clone],
        ["t3_project_create", register],
      ] as const) {
        const refused = yield* a.call("thread:laptop-full", name, {
          environmentId: box.environmentId,
          ...args,
        });
        const failure = failureOf(refused);
        expect(failure, name).toMatchObject({ code: "capability_denied" });
        // The agent's thread is full access; what holds it is the link's access.
        expect(failure.message, name).toContain("linked environment");
        expect(failure.message, name).not.toContain("calling thread");
      }
      expect((yield* Ref.get(seen)).clones).toHaveLength(1);
      expect((yield* Ref.get(seen)).projects).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("rejects a forwarded mode change if the authenticated provider changed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const receiver = yield* serveBox(seen, linkSession);
      const reads = yield* Ref.make(0);
      const original = ProviderInstanceId.make("codex");
      const replacement = ProviderInstanceId.make("replacement");
      const sender = yield* makeLaptop(
        (id) => Effect.succeed(id === original ? ["approval-required"] : ["auto"]),
        Ref.getAndUpdate(reads, (count) => count + 1).pipe(
          Effect.map((count) => (count === 0 ? original : replacement)),
        ),
      );
      yield* linkTo(sender.links, receiver, "auto");
      yield* Ref.set(linkSession, (yield* receiver.linkedSessions)[0]!.sessionId);
      const peerCall = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(sender.peerClient, "call")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );

      const refused = yield* sender.call("thread:laptop-auto", "t3_thread_set_runtime_mode", {
        environmentId: box.environmentId,
        threadId: boxThread,
        expectedRuntimeMode: "auto",
        runtimeMode: "approval-required",
      });

      expect(failureOf(refused)).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(reads)).toBe(2);
      expect(peerCall).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("runs any tool that takes a linked environment there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const modes = yield* Ref.make<ReadonlyArray<RuntimeMode> | undefined>(undefined);
      const a = yield* makeLaptop(() => Ref.get(modes));
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const there = yield* a.call("thread:laptop-full", "t3_thread_configure", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(there.structuredContent).toMatchObject({ threadId: boxThread, runtimeMode: "auto" });
      const archived = yield* a.call("thread:laptop-full", "t3_thread_organize", {
        environmentId: box.environmentId,
        threadId: boxThread,
        action: "archive",
      });
      expect(archived.isError).toBe(false);
      expect((yield* Ref.get(seen)).stops).toEqual([`thread.archive ${boxThread}`]);
      // A cursorless read from an agent here gets the newest page there, as it does locally.
      const read = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(read.isError).toBe(false);
      expect((yield* Ref.get(seen)).reads).toEqual([
        { beforePosition: Number.MAX_SAFE_INTEGER, limit: 10, view: "messages" },
      ]);

      const raised = yield* a.call("thread:laptop-full", "t3_thread_set_runtime_mode", {
        environmentId: box.environmentId,
        threadId: boxThread,
        expectedRuntimeMode: "auto",
        runtimeMode: "full-access",
      });
      expect(failureOf(raised)).toMatchObject({ code: "runtime_mode_escalation_denied" });
      yield* Ref.set(modes, ["approval-required"]);
      const fallbackWrite = yield* a.call("thread:laptop-auto", "t3_thread_set_runtime_mode", {
        environmentId: box.environmentId,
        threadId: boxThread,
        expectedRuntimeMode: "auto",
        runtimeMode: "approval-required",
      });
      expect(failureOf(fallbackWrite)).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect((yield* Ref.get(seen)).stops).not.toContain("thread.runtime-mode.set " + boxThread);
      yield* Ref.set(modes, undefined);
      const lowered = yield* a.call("thread:laptop-full", "t3_thread_set_runtime_mode", {
        environmentId: box.environmentId,
        threadId: boxThread,
        expectedRuntimeMode: "auto",
        runtimeMode: "approval-required",
      });
      expect(lowered.isError).toBe(false);
      expect(lowered.structuredContent).toMatchObject({
        threadId: boxThread,
        runtimeMode: "approval-required",
      });
      expect((yield* Ref.get(seen)).stops).toContain("thread.runtime-mode.set " + boxThread);

      // This environment's own id keeps the call here.
      const own = yield* a.call("thread:laptop-full", "t3_thread_configure", {
        environmentId: laptop.environmentId,
      });
      expect(own.structuredContent).toMatchObject({
        threadId: "thread:laptop-full",
        runtimeMode: "full-access",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses what a linked environment cannot take before anything leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      yield* Ref.set(b.bearers, []);

      const unknown = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: EnvironmentId.make("environment-elsewhere"),
        threadId: boxThread,
      });
      expect(failureOf(unknown)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // The box sees only the link's credential, so one that may not control
      // threads here may not reach them there either.
      const previewOnly = new Set<McpInvocationContext.McpCapability>(["preview"]);
      for (const [name, args] of [
        ["t3_environment_links", {}],
        ["t3_project_list", { environmentId: box.environmentId }],
        ["t3_thread_list", { environmentId: box.environmentId, projectId: boxProject }],
        ["t3_thread_read", { environmentId: box.environmentId, threadId: boxThread }],
        ["t3_thread_wait", { environmentId: box.environmentId, threadId: boxThread }],
        [
          "t3_thread_send",
          { environmentId: box.environmentId, threadId: boxThread, message: "Carry on there." },
        ],
        [
          "t3_thread_organize",
          { environmentId: box.environmentId, threadId: boxThread, action: "archive" },
        ],
        [
          "t3_thread_launch",
          {
            environmentId: box.environmentId,
            projectId: boxProject,
            title: "Start there",
            modelSelection: { instanceId: "codex", model: "gpt-5" },
            message: "Start there.",
          },
        ],
      ] as const) {
        const refused = yield* a.call("thread:laptop-full", name, args, previewOnly);
        expect(failureOf(refused), name).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // Work a desk's link started here never uses this laptop's links: the
      // box would see the laptop, not the desk, so its fence could not hold.
      for (const [name, args] of [
        ["t3_thread_read", { environmentId: box.environmentId, threadId: boxThread }],
        [
          "t3_thread_send",
          { environmentId: box.environmentId, threadId: boxThread, message: "From the desk." },
        ],
        [
          "t3_thread_launch",
          { environmentId: box.environmentId, projectId: boxProject, title: "x" },
        ],
      ] as const) {
        const relayed = yield* a.call("thread:laptop-from-desk", name, args);
        expect(failureOf(relayed), name).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a launch there above the link's access, naming the link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop();
      yield* a.settings.updateSettings({ allowAgentFullAccessLaunches: true });
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      // Source policy permits the request so this case exercises the link ceiling.
      const launchAboveLink = a.call("thread:laptop-auto", "t3_thread_launch", {
        environmentId: box.environmentId,
        projectId: boxProject,
        title: "Run the suite there",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        message: "Run the suite.",
        runtimeMode: "full-access",
      });
      const { message } = failureOf(yield* launchAboveLink);
      expect(message).toContain('"Box"');
      expect(message).toContain("auto");
      expect(message).toContain("full-access");
      expect(message).not.toContain("parent mode");
      expect((yield* Ref.get(seen)).launches).toEqual([]);

      // Once the link has expired, that is what the agent needs to hear.
      yield* TestClock.adjust(Duration.days(31));
      expect(failureOf(yield* launchAboveLink).message).toContain("expired");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const refusedRead = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const beforePositionRefusal = refusedRead(
  `Invalid parameters for tool 't3_thread_read': Unknown argument "beforePosition". Accepted arguments: limit, view.`,
);

it("recognizes only a validation refusal of beforePosition", () => {
  const cases: Array<[OrchestratorMcpFailure, boolean]> = [
    [beforePositionRefusal, true],
    [
      refusedRead(
        `Invalid parameters for tool 't3_thread_read': Unknown arguments "runLimit", "beforePosition". Accepted arguments: limit.`,
      ),
      true,
    ],
    [refusedRead(`Invalid parameters for tool 't3_thread_read': Unknown argument "limit".`), false],
    // A thread id can carry the same words; only the refusal's code and prefix count.
    [
      new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: `Thread Unknown argument "beforePosition". Accepted arguments: x. is no longer available.`,
      }),
      false,
    ],
  ];
  for (const [failure, expected] of cases) {
    expect(PeerForwarding.refusesBeforePosition(failure)).toBe(expected);
  }
});

it.effect("retries a newest-page read without its cursor when the peer refuses the cursor", () =>
  Effect.gen(function* () {
    const sent: Array<unknown> = [];
    const olderPeer = (args: unknown): Effect.Effect<string, OrchestratorMcpFailure> => {
      sent.push(args);
      return "beforePosition" in (args as object)
        ? Effect.fail(beforePositionRefusal)
        : Effect.succeed("forward page");
    };
    const params = { threadId: "thread:box-auto", limit: 35 };
    const newest = { ...params, beforePosition: Number.MAX_SAFE_INTEGER };

    const page = yield* PeerForwarding.readNewestOrRetry(olderPeer, newest, params);

    expect(page).toBe("forward page");
    expect(sent).toEqual([newest, params]);
  }),
);
