import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type PeerLinkError,
  RuntimeMode,
  LINKED_OWNER_POLICY_FULL_ACCESS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import * as ApprovalAuthority from "../auth/ApprovalAuthority.ts";
import { initiatingClientForForward } from "../approvals/ApprovalLaunchProvenance.ts";
import * as Option from "effect/Option";
import { resolveRuntimeMode, runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, threadCreationRuntimeLimit, unavailable } from "../mcp/threadAccess.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

// Match local waits: return before MCP client timeouts and T3 Connect's ~100 s idle drop.
const FORWARDED_WAIT_CHUNK_MS = 45_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 45_000;

type Scope = McpInvocationContext.McpInvocationScope;

const LAUNCH_TOOL = "t3_thread_launch";

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     * `writes` is whether the call changes anything there, as the tool's
     * declaration says (`McpToolAccess`).
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
      writes: boolean,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, bounded like a local wait. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** What an agent hears when it names another machine while the beta is off here. */
export const linkedEnvironmentsOff = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.",
});

const isRuntimeMode = Schema.is(RuntimeMode);

const linkStorageFailure = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

// Older peers reject beforePosition during parameter validation.
const BEFORE_POSITION_REFUSAL =
  /^Invalid parameters for tool 't3_thread_read': Unknown arguments? (?:"[^"]+", )*"beforePosition"(?:, "[^"]+")*\. Accepted arguments: /;
export const refusesBeforePosition = (failure: {
  readonly code: string;
  readonly message: string;
}) => failure.code === "invalid_request" && BEFORE_POSITION_REFUSAL.test(failure.message);

/** A newest-page read, retried as the peer always served it when the peer refuses the cursor. */
export const readNewestOrRetry = Effect.fn("PeerForwarding.readNewestOrRetry")(function* <A>(
  read: (args: unknown) => Effect.Effect<A, OrchestratorMcpFailure>,
  newest: unknown,
  params: unknown,
) {
  return yield* read(newest).pipe(Effect.catchIf(refusesBeforePosition, () => read(params)));
});

const make = Effect.gen(function* () {
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const approvalAuthority = yield* Effect.serviceOption(ApprovalAuthority.ApprovalAuthority);
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Digest.Digest;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /**
   * The caller's own limits and thread, which travel with every forwarded call: the peer sees only the
   * link's credential, so a caller that may not control threads here is refused here. Work a
   * link started never uses this environment's links, since the peer would see this
   * environment's session instead of that link, and its fence could not hold.
   */
  const forwardingCaller = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /**
   * The linked environment refuses a mode above the link's access too, but as
   * "broader than parent mode", which misleads when the parent here is broader.
   * A read-only link refuses the launch there with its own capability error,
   * and an expired one is left to say it expired.
   */
  const assertWithinLinkAccess = Effect.fn("PeerForwarding.assertWithinLinkAccess")(function* (
    environmentId: EnvironmentId,
    requested: unknown,
  ) {
    if (!isRuntimeMode(requested)) return;
    const link = yield* links.get(environmentId).pipe(Effect.mapError(linkStorageFailure));
    if (Option.isNone(link)) return;
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, yield* DateTime.now)) return;
    const { label, access } = link.value;
    if (access === "read-only" || runtimeModeRank(requested) <= runtimeModeRank(access)) return;
    return yield* new OrchestratorMcpFailure({
      code: "runtime_mode_escalation_denied",
      message: `Linked environment "${label}" was linked with ${access} access, so work there cannot run in ${requested}. Omit runtimeMode to run it at a mode up to ${access}, or link it again with broader access.`,
    });
  });

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
    writes: boolean,
  ) {
    const { caller, limits } = yield* forwardingCaller(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    yield* assertWithinLinkAccess(environmentId, args.runtimeMode);
    if (toolName === LAUNCH_TOOL && args.runtimeMode === "full-access") {
      const runtimeLimit = Option.isSome(serverSettings)
        ? yield* threadCreationRuntimeLimit(scope, limits.runtimeMode, "full-access", caller).pipe(
            Effect.provideService(ServerSettingsService, serverSettings.value),
          )
        : limits.runtimeMode;
      yield* resolveRuntimeMode(runtimeLimit, "full-access");
      if (limits.runtimeMode === "auto") args.runtimeMode = LINKED_OWNER_POLICY_FULL_ACCESS;
    }
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    // T3 Code LAN: the peer sees a link session with no calling thread, so a thread launched
    // there would get its machine's default owner. It takes the caller's owner here, as a
    // delegated task does, unless the call names one.
    if (toolName === LAUNCH_TOOL && args.ownerId === undefined && caller?.ownerId != null) {
      args.ownerId = caller.ownerId;
    }
    const initiatingClientId = writes
      ? yield* initiatingClientForForward(scope, Option.getOrUndefined(approvalAuthority)).pipe(
          Effect.mapError(unavailable),
        )
      : undefined;
    // So a message sent there names the thread that sent it, even to a client that cannot reach here.
    const sender =
      caller === undefined
        ? undefined
        : {
            environmentId: scope.environmentId,
            threadId: caller.id,
            title: caller.title,
          };
    return yield* peers.call({
      environmentId,
      ...(initiatingClientId === undefined ? {} : { initiatingClientId }),
      tool: toolName,
      arguments: args,
      limits,
      writes,
      ...(sender === undefined ? {} : { sender }),
      success: success as Schema.Decoder<A>,
    });
  });

  // These name their tools, so each says what the tool's declaration says: reading and waiting
  // read, interrupting writes.
  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
      false,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
      true,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = Effect.fn(
    "PeerForwarding.waitForThread",
  )(function* (scope, environmentId, input) {
    let remaining = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    let runId = input.runId;
    while (true) {
      const chunk = Math.min(remaining, FORWARDED_WAIT_CHUNK_MS);
      const result = yield* forward<OrchestratorMcpThreadWaitResult>(
        scope,
        "t3_thread_wait",
        OrchestratorMcpThreadWaitInput,
        OrchestratorMcpThreadWaitResult,
        environmentId,
        {
          threadId: input.threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: chunk,
          ...(input.untilDelegatedWorkSettled === undefined
            ? {}
            : { untilDelegatedWorkSettled: input.untilDelegatedWorkSettled }),
        },
        false,
      );
      remaining -= chunk;
      if (!result.timedOut || remaining <= 0) return result;
      // Later pieces wait for the run the first one picked, not a newer one.
      runId = result.runId ?? undefined;
    }
  });

  // While the beta is off, agents start nothing over links. Tasks already running there keep
  // following through readThread, waitForThread and interruptThread, so they still finish.
  const requireEnabled = links.enabled.pipe(
    Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(linkedEnvironmentsOff))),
  );

  // A peer pages a client's cursorless read forward; an agent's gets the newest page, as it does here.
  const newestPageForAgent = (scope: Scope, toolName: string, params: unknown) => {
    if (toolName !== "t3_thread_read" || scope.thread === undefined) return undefined;
    const input = params as OrchestratorMcpThreadReadInput;
    return input.afterPosition === undefined && input.beforePosition === undefined
      ? { ...input, beforePosition: Number.MAX_SAFE_INTEGER }
      : undefined;
  };

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params, writes) => {
    const forwardTool = (
      args: unknown,
    ): Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure> =>
      forward(
        scope,
        tool.name,
        tool.parametersSchema,
        tool.successSchema,
        environmentId,
        args,
        writes,
      );
    const newest = newestPageForAgent(scope, tool.name, params);
    const forwarded: Effect.Effect<
      Tool.Success<typeof tool>,
      OrchestratorMcpFailure
    > = tool.name === "t3_thread_wait"
      ? (waitForThread(
          scope,
          environmentId,
          params as OrchestratorMcpThreadWaitInput,
        ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
      : newest === undefined
        ? forwardTool(params)
        : readNewestOrRetry(forwardTool, newest, params);
    return Effect.andThen(requireEnabled, forwarded);
  };

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* forwardingCaller(scope);
      yield* requireEnabled;
      const listed = yield* links.list.pipe(Effect.mapError(linkStorageFailure));
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
        })),
        notListed: NOT_LISTED,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
