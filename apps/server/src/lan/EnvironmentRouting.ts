// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Canonical retry hashes and comparisons encode only validated policy values, never untrusted JSON input.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  type EnvironmentId,
  type LanEnvironmentSummary,
  type LanRoutingGrant,
  type LanEnvironmentRoute,
  type LanEventsAckInput,
  type LanTaskLaunchInput,
  LanTaskLaunchResult,
  type LanTaskObserveInput,
  LanTaskObserveResult,
  LanRoutedResult,
  OrchestratorMcpFailure,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
  type OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  type LanTaskRequestsInput,
  LanTaskRequestsResult,
  type LanTaskRespondInput,
  LanTaskRespondResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as NativeTaskService from "./NativeTaskService.ts";
import * as RemoteTaskTransport from "./RemoteTaskTransport.ts";
import * as RoutingStore from "./RoutingStore.ts";

type Scope = McpInvocationContext.McpInvocationScope;
type Targeted<A> = A & {
  readonly environmentId: EnvironmentId;
  readonly runtimeCeiling?: RuntimeMode;
  readonly replayFromStart?: boolean;
};
type Result = typeof LanRoutedResult.Type;
const decodeEnvelope = Schema.decodeUnknownEffect(LanRoutedResult);
const decodeLaunch = Schema.decodeUnknownEffect(LanTaskLaunchResult);
const decodeList = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeSend = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeInterrupt = Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptResult);
const decodeRequests = Schema.decodeUnknownEffect(LanTaskRequestsResult);
const decodeRespond = Schema.decodeUnknownEffect(LanTaskRespondResult);
const decodeObserve = Schema.decodeUnknownEffect(LanTaskObserveResult);

export class EnvironmentRouting extends Context.Service<
  EnvironmentRouting,
  {
    readonly environments: (
      scope: Scope,
    ) => Effect.Effect<ReadonlyArray<typeof LanEnvironmentSummary.Type>, OrchestratorMcpFailure>;
    readonly launch: (
      scope: Scope,
      input: Targeted<LanTaskLaunchInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly list: (
      scope: Scope,
      input: Targeted<OrchestratorMcpThreadListInput> & { readonly projectId: ProjectId },
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly read: (
      scope: Scope,
      input: Targeted<OrchestratorMcpThreadReadInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly send: (
      scope: Scope,
      input: Targeted<OrchestratorMcpThreadSendInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly interrupt: (
      scope: Scope,
      input: Targeted<OrchestratorMcpThreadInterruptInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly requests: (
      scope: Scope,
      input: Targeted<LanTaskRequestsInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly respond: (
      scope: Scope,
      input: Targeted<LanTaskRespondInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly observe: (
      scope: Scope,
      input: Targeted<LanTaskObserveInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
    readonly acknowledge: (
      scope: Scope,
      input: Targeted<LanEventsAckInput>,
    ) => Effect.Effect<Result, OrchestratorMcpFailure>;
  }
>()("t3/lan/EnvironmentRouting") {}

const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "This task operation is outside the approved LAN routing grant.",
  });
const readOnlyMachine = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "This machine has read-only access to the other fleet machines. It can list, read and observe their tasks but not start, send to, interrupt or answer them.",
  });
const invalidDestination = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The configured destination identity, response, or routing capability did not match.",
  });
const modes: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

const principal = (scope: Scope) =>
  scope.thread !== undefined ||
  scope.client === undefined ||
  !scope.capabilities.has("orchestration")
    ? undefined
    : scope.client.grantId === undefined
      ? `session:${scope.client.sessionId}`
      : `grant:${scope.client.grantId}`;

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const store = yield* RoutingStore.RoutingStore;
  const native = yield* NativeTaskService.NativeTaskService;
  const remote = yield* RemoteTaskTransport.RemoteTaskTransport;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fleetAccess = yield* FleetAccessPolicy.FleetAccess;

  const authorize = Effect.fn("EnvironmentRouting.authorize")(function* (
    scope: Scope,
    environmentId: EnvironmentId,
    write = false,
    requestedCeiling: RuntimeMode = "full-access",
  ) {
    const id = principal(scope);
    if (id === undefined || (write && scope.client?.access === "read-only")) return yield* denied();
    const config = yield* registry.read;
    const route = config.environments.find(
      (item) => item.environmentId === environmentId && item.enabled,
    );
    const grant = config.grants.find(
      (item) => item.environmentId === environmentId && item.principalId === id && item.enabled,
    );
    if (route === undefined || grant === undefined || (write && !grant.allowOperate))
      return yield* denied();
    if (
      write &&
      route.origin !== null &&
      FleetAccessPolicy.accessOnEnvironment(yield* fleetAccess.current, environmentId) ===
        "read-only"
    )
      return yield* readOnlyMachine();
    const descriptor = yield* environment.getDescriptor;
    if ((route.origin === null) !== (descriptor.environmentId === environmentId))
      return yield* invalidDestination();
    const ceiling = [
      route.runtimeCeiling,
      grant.runtimeCeiling,
      requestedCeiling,
      scope.client?.access === "read-only"
        ? "approval-required"
        : (scope.client?.access ?? "approval-required"),
    ].reduce<RuntimeMode>(
      (lowest, mode) => (modes[mode] < modes[lowest] ? mode : lowest),
      "full-access",
    );
    const localScope: Scope = {
      ...scope,
      requestNamespace: `lan:${id}`,
      client:
        scope.client === undefined
          ? undefined
          : {
              ...scope.client,
              access: scope.client.access === "read-only" ? "read-only" : ceiling,
            },
    };
    return { id, route, grant, scope: localScope, ceiling };
  });
  type Authorized = {
    readonly id: string;
    readonly route: LanEnvironmentRoute;
    readonly grant: LanRoutingGrant;
    readonly scope: Scope;
    readonly ceiling: RuntimeMode;
  };

  const allowedThread = Effect.fn("EnvironmentRouting.allowedThread")(function* (
    auth: Authorized,
    threadId: ThreadId,
  ) {
    const owned = yield* store.owned(auth.id, auth.route.environmentId);
    if (!auth.grant.threadIds.includes(threadId) && !owned.includes(threadId))
      return yield* denied();
    const metadata = yield* call(
      auth,
      "t3_lan_task_read",
      {
        environmentId: auth.route.environmentId,
        threadId,
        limit: 1,
        runLimit: 1,
        maxCharsPerItem: 1,
      },
      decodeRead,
      native.read(auth.scope, { threadId, limit: 1, runLimit: 1, maxCharsPerItem: 1 }),
    );
    if (
      metadata.thread.threadId !== threadId ||
      !auth.grant.projectIds.includes(metadata.thread.projectId)
    )
      return yield* denied();
  });
  const call = Effect.fn("EnvironmentRouting.call")(function* <A>(
    auth: Authorized,
    tool: string,
    input: unknown,
    decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>,
    local: Effect.Effect<A, OrchestratorMcpFailure>,
  ) {
    const current = yield* authorize(
      auth.scope,
      auth.route.environmentId,
      [
        "t3_lan_task_launch",
        "t3_lan_task_send",
        "t3_lan_task_interrupt",
        "t3_lan_task_respond",
      ].includes(tool),
      auth.ceiling,
    );
    if (
      !NodeUtil.isDeepStrictEqual(current.route, auth.route) ||
      !NodeUtil.isDeepStrictEqual(current.grant, auth.grant)
    )
      return yield* denied();
    if (auth.route.origin === null) return yield* local;
    const raw = yield* remote.call(auth.route, tool, {
      ...(input as object),
      runtimeCeiling: auth.ceiling,
    });
    const envelope = yield* decodeEnvelope(raw).pipe(Effect.mapError(invalidDestination));
    if (envelope.environmentId !== auth.route.environmentId) return yield* invalidDestination();
    return yield* decode(envelope.result).pipe(Effect.mapError(invalidDestination));
  });
  const remoteKey = (auth: Authorized, input: { readonly clientRequestId?: string | undefined }) =>
    NodeCrypto.createHash("sha256")
      .update(JSON.stringify([auth.id, input.clientRequestId]))
      .digest("hex");
  const environments = Effect.fn("EnvironmentRouting.environments")(function* (scope: Scope) {
    const id = principal(scope);
    if (id === undefined) return yield* denied();
    const config = yield* registry.read;
    const local = yield* environment.getDescriptor;
    return config.environments
      .filter(
        (route) =>
          route.enabled &&
          config.grants.some(
            (grant) =>
              grant.enabled &&
              grant.principalId === id &&
              grant.environmentId === route.environmentId,
          ),
      )
      .map((route) => {
        const grant = config.grants.find(
          (item) =>
            item.enabled && item.principalId === id && item.environmentId === route.environmentId,
        )!;
        const access = scope.client?.access ?? "read-only";
        const ceiling = [
          route.runtimeCeiling,
          grant.runtimeCeiling,
          access === "read-only" ? "approval-required" : access,
        ].reduce<RuntimeMode>(
          (lowest, mode) => (modes[mode] < modes[lowest] ? mode : lowest),
          "full-access",
        );
        return {
          environmentId: route.environmentId,
          label: route.label,
          local: route.environmentId === local.environmentId,
          routingVersion: 1 as const,
          projectIds: grant.projectIds,
          models: route.models ?? [],
          runtimeCeiling: ceiling,
          canLaunch:
            access !== "read-only" &&
            grant.allowOperate &&
            grant.allowLaunch &&
            (route.models?.length ?? 0) > 0,
          canOperate: access !== "read-only" && grant.allowOperate,
        };
      });
  });
  const launch = Effect.fn("EnvironmentRouting.launch")(function* (
    scope: Scope,
    input: Targeted<LanTaskLaunchInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, true, input.runtimeCeiling);
    if (
      !auth.grant.allowLaunch ||
      !auth.grant.projectIds.includes(input.projectId) ||
      !auth.route.models?.some(
        (model) =>
          model.instanceId === input.modelSelection.instanceId &&
          model.model === input.modelSelection.model &&
          NodeUtil.isDeepStrictEqual(model.options, input.modelSelection.options),
      ) ||
      modes[input.runtimeMode] > modes[auth.ceiling]
    )
      return yield* denied();
    const forwarded = { ...input, clientRequestId: remoteKey(auth, input) };
    const result = yield* call(
      auth,
      "t3_lan_task_launch",
      forwarded,
      decodeLaunch,
      native.launch(auth.scope, input),
    );
    if (result.projectId !== input.projectId) return yield* invalidDestination();
    yield* store.own(auth.id, input.environmentId, result);
    return { environmentId: input.environmentId, result };
  });
  const list = Effect.fn("EnvironmentRouting.list")(function* (
    scope: Scope,
    input: Targeted<OrchestratorMcpThreadListInput> & { readonly projectId: ProjectId },
  ) {
    const auth = yield* authorize(scope, input.environmentId, false, input.runtimeCeiling);
    if (!auth.grant.projectIds.includes(input.projectId)) return yield* denied();
    const owned = yield* store.owned(auth.id, input.environmentId, input.projectId);
    const result = yield* call(
      auth,
      "t3_lan_task_list",
      input,
      decodeList,
      native.list(auth.scope, input),
    );
    if (result.projectId !== input.projectId) return yield* invalidDestination();
    const threads = result.threads.filter(
      (thread) => auth.grant.threadIds.includes(thread.threadId) || owned.includes(thread.threadId),
    );
    return {
      environmentId: input.environmentId,
      result: { ...result, threads, total: threads.length, currentThreadId: null },
    };
  });
  const read = Effect.fn("EnvironmentRouting.read")(function* (
    scope: Scope,
    input: Targeted<OrchestratorMcpThreadReadInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, false, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    const result = yield* call(
      auth,
      "t3_lan_task_read",
      input,
      decodeRead,
      native.read(auth.scope, input),
    );
    if (
      result.thread.threadId !== input.threadId ||
      !auth.grant.projectIds.includes(result.thread.projectId)
    )
      return yield* denied();
    return {
      environmentId: input.environmentId,
      result: {
        ...result,
        items: result.items.filter((item) => item.sourceThreadId === input.threadId),
      },
    };
  });
  const send = Effect.fn("EnvironmentRouting.send")(function* (
    scope: Scope,
    input: Targeted<OrchestratorMcpThreadSendInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, true, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    if (input.clientRequestId === undefined) return yield* denied();
    const result = yield* call(
      auth,
      "t3_lan_task_send",
      { ...input, clientRequestId: remoteKey(auth, input) },
      decodeSend,
      native.send(auth.scope, input),
    );
    if (result.threadId !== input.threadId) return yield* invalidDestination();
    return { environmentId: input.environmentId, result };
  });
  const interrupt = Effect.fn("EnvironmentRouting.interrupt")(function* (
    scope: Scope,
    input: Targeted<OrchestratorMcpThreadInterruptInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, true, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    if (input.clientRequestId === undefined) return yield* denied();
    const result = yield* call(
      auth,
      "t3_lan_task_interrupt",
      { ...input, clientRequestId: remoteKey(auth, input) },
      decodeInterrupt,
      native.interrupt(auth.scope, input),
    );
    if (result.threadId !== input.threadId) return yield* invalidDestination();
    return { environmentId: input.environmentId, result };
  });
  const requests = Effect.fn("EnvironmentRouting.requests")(function* (
    scope: Scope,
    input: Targeted<LanTaskRequestsInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, false, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    const result = yield* call(
      auth,
      "t3_lan_task_requests",
      input,
      decodeRequests,
      native.requests(auth.scope, input),
    );
    if (result.threadId !== input.threadId) return yield* invalidDestination();
    return {
      environmentId: input.environmentId,
      result: {
        ...result,
        requests: result.requests.map((request) => ({
          ...request,
          canRespond:
            request.canRespond && auth.grant.allowOperate && scope.client?.access !== "read-only",
        })),
      },
    };
  });
  const respond = Effect.fn("EnvironmentRouting.respond")(function* (
    scope: Scope,
    input: Targeted<LanTaskRespondInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, true, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    const result = yield* call(
      auth,
      "t3_lan_task_respond",
      { ...input, clientRequestId: remoteKey(auth, input) },
      decodeRespond,
      native.respond(auth.scope, input),
    );
    return { environmentId: input.environmentId, result };
  });
  const observe = Effect.fn("EnvironmentRouting.observe")(function* (
    scope: Scope,
    input: Targeted<LanTaskObserveInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, false, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    const checkpoint = yield* store.checkpoint(auth.id, input.environmentId, input.threadId);
    if (
      input.replayFromStart !== true &&
      input.after !== undefined &&
      input.after.sourceId !== checkpoint?.deliverySourceId
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "This observation cursor is obsolete. Reconcile the task and replay from the start.",
      });
    const after =
      input.replayFromStart === true
        ? undefined
        : input.after === undefined
          ? checkpoint?.cursor
          : { ...input.after, sourceId: checkpoint!.cursor.sourceId };
    const { after: _after, ...withoutCursor } = input;
    const request = { ...withoutCursor, ...(after === undefined ? {} : { after }) };
    // A destination's delivery cursor must never substitute for this router's source cursor.
    const result = yield* call(
      auth,
      "t3_lan_task_observe",
      { ...request, replayFromStart: after === undefined },
      decodeObserve,
      native.observe(auth.scope, request),
    );
    if (result.threadId !== input.threadId) return yield* invalidDestination();
    const deliverySourceId =
      result.status === "ok"
        ? yield* store.ingest(auth.id, input.environmentId, result, {
            reset: input.replayFromStart === true,
            expectedDeliverySourceId: checkpoint?.deliverySourceId ?? null,
          })
        : result.sourceId;
    if (auth.route.origin !== null && result.status === "ok") {
      yield* remote
        .call(auth.route, "t3_lan_events_ack", {
          environmentId: input.environmentId,
          threadId: input.threadId,
          sourceId: result.sourceId,
          eventIds: result.events.map((event) => event.eventId),
        })
        .pipe(Effect.ignore);
    }
    const pending =
      result.status === "ok"
        ? yield* store.pending(auth.id, input.environmentId, input.threadId, deliverySourceId)
        : [];
    return {
      environmentId: input.environmentId,
      result: {
        ...result,
        sourceId: deliverySourceId,
        nextCursor: { ...result.nextCursor, sourceId: deliverySourceId },
        delivery: {
          events: pending.slice(0, 100),
          hasMore: pending.length > 100,
          acknowledgementRequired: true,
          wakeDelivery: "unsupported",
        },
      },
    };
  });
  const acknowledge = Effect.fn("EnvironmentRouting.acknowledge")(function* (
    scope: Scope,
    input: Targeted<LanEventsAckInput>,
  ) {
    const auth = yield* authorize(scope, input.environmentId, false, input.runtimeCeiling);
    yield* allowedThread(auth, input.threadId);
    yield* store.acknowledge(
      auth.id,
      input.environmentId,
      input.threadId,
      input.eventIds,
      input.sourceId,
    );
    return { environmentId: input.environmentId, result: { acknowledged: true } };
  });
  return EnvironmentRouting.of({
    environments,
    launch,
    list,
    read,
    send,
    interrupt,
    requests,
    respond,
    observe,
    acknowledge,
  });
});
export const layer = Layer.effect(EnvironmentRouting, make);
