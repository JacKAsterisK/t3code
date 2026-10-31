import { assert } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type RuntimeMode,
  type ApprovalRespondInput,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { makeNodeClient } from "effect-codex-app-server/node";
import * as Config from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Adapter from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderSessions from "../../orchestration-v2/ProviderSessionManager.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Outbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Delivery from "../ApprovalDelivery.ts";
import * as Presentation from "../ApprovalPresentation.ts";
import { instanceId, proof, type FleetEnvironment } from "./ApprovalFleetHarnessEnvironment.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);
export const startNative = Effect.fn("ApprovalFleetHarness.startNative")(function* (
  env: FleetEnvironment,
  suffix: string,
  runtimeMode: RuntimeMode = "full-access",
  existingThreadId?: ThreadId,
) {
  const native = Context.get(env.context, Orchestrator.OrchestratorV2);
  const config = Context.get(env.context, Config.ServerConfig);
  const threadId = existingThreadId ?? ThreadId.make(`fleet-operator:${suffix}`);
  const providerSessionId = ProviderSessionId.make(`fleet-native:${suffix}`);
  const nodeId = NodeId.make(`fleet-root:${suffix}`);
  const modelSelection = { instanceId, model: "gpt-5.4" };
  if (existingThreadId === undefined)
    yield* native.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`fleet-create:${suffix}`),
      threadId,
      projectId: ProjectId.make(`fleet-project:${suffix}`),
      title: "Operator approval probe",
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  let ownedPid: number | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (ownedPid === undefined) return;
      const exited = yield* Effect.try({
        try: () => process.kill(ownedPid!, 0),
        catch: (error) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH",
      }).pipe(Effect.match({ onFailure: (missing) => missing, onSuccess: () => false }));
      assert.isTrue(exited, `Owned native fixture PID ${ownedPid} survived scope disposal`);
      yield* proof("nativecommand", { environment: env.name, pid: ownedPid, state: "exited" });
    }),
  );
  const client = yield* makeNodeClient(
    ChildProcess.make(
      process.execPath,
      [
        `${import.meta.dirname}/../../../../../packages/effect-codex-app-server/test/fixtures/codex-app-server-mock-peer.ts`,
      ],
      {
        cwd: config.baseDir,
        env: {
          CODEX_APP_SERVER_TEST_PERMISSION_PROFILE: "1",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          PATH: process.env.PATH ?? "",
          HOME: config.baseDir,
          USERPROFILE: config.baseDir,
          APPDATA: config.baseDir,
        },
      },
    ),
    {
      platform: yield* HostProcess.Platform,
      onSpawn: (pid) =>
        Effect.sync(() => {
          ownedPid = pid;
        }).pipe(
          Effect.andThen(
            proof("nativecommand", {
              environment: env.name,
              scenario: suffix,
              pid,
              profile: "free-codex-0.159.0",
              state: "spawned",
            }),
          ),
        ),
    },
  );
  const adapter = yield* Adapter.makeCodexAdapterV2({
    instanceId,
    settings: yield* decodeSettings({}),
    environment: {},
    clientFactory: { open: () => Effect.succeed(client) },
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: config,
    continuationRequests: { offer: () => Effect.void },
  });
  const runtimePolicy = {
    runtimeMode,
    interactionMode: "default" as const,
    cwd: config.baseDir,
  };
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  yield* env.projections.apply({
    id: EventId.make(`fleet-session:${suffix}`),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: providerSessionId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      status: "ready",
      cwd: config.baseDir,
      model: modelSelection.model,
      capabilities: Adapter.CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  const ready = yield* Deferred.make<OrchestrationV2RuntimeRequest>();
  let ordinal = 0;
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const common = {
          id: EventId.make(`fleet-native-event:${suffix}:${ordinal++}`),
          threadId,
          occurredAt: yield* DateTime.now,
        };
        if (event.type === "node.updated")
          yield* env.projections.apply({ ...common, type: "node.updated", payload: event.node });
        if (event.type === "turn_item.updated")
          yield* env.projections.apply({
            ...common,
            type: "turn-item.updated",
            payload: event.turnItem,
          });
        if (event.type === "runtime_request.updated") {
          yield* env.projections.apply({
            ...common,
            type: "runtime-request.updated",
            payload: event.runtimeRequest,
          });
          if (event.runtimeRequest.status === "pending")
            yield* Deferred.succeed(ready, event.runtimeRequest);
        }
      }),
    ),
    Effect.forkScoped,
  );
  yield* runtime.startTurn({
    appThread: yield* env.projections.getThread(threadId),
    threadId,
    runId: RunId.make(`fleet-run:${suffix}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`fleet-attempt:${suffix}`),
    rootNodeId: nodeId,
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`fleet-message:${suffix}`),
      text: "Request fixture permissions",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  const nativeRaw = {
    cwd: config.baseDir,
    itemId: "approval-harness-item",
    threadId: "thread-approval-harness",
    turnId: "turn-approval-harness",
    startedAtMs: 1,
    permissions: { network: { enabled: true }, fileSystem: { write: ["/tmp/output"] } },
  };
  const reply = yield* client.raw.request("test/permission", nativeRaw).pipe(Effect.forkScoped);
  const pending = yield* Deferred.await(ready);
  assert.deepEqual(pending.approval?.grant.permission, nativeRaw);
  const responseContext = yield* env.projections.getRuntimeResponseContext(threadId, pending.id);
  const shown = (yield* Presentation.presentation({
    environmentId: env.id,
    threadId,
    request: responseContext.request!,
    item: responseContext.item!,
  }))!;
  const input: ApprovalRespondInput = {
    action: "respond",
    environmentId: env.id,
    threadId,
    requestId: pending.id,
    clientRequestId: `fleet-key:${suffix}`,
    decision: "accept",
    expected: shown.expected,
    consent: {
      effectiveScope: "turn",
      grantDigest: shown.grantDigest,
      onBehalfOf: "fixture owner",
      authorization: "Allow these exact permissions for this provider turn.",
    },
  };
  const deliveryContext = yield* Layer.build(
    Delivery.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
          get: () => Effect.succeedSome(runtime),
        }),
      ),
    ),
  ).pipe(Effect.provide(env.context));
  const delivery = Context.get(deliveryContext, Delivery.ApprovalDelivery);
  const handoff = Effect.fn("ApprovalFleetHarness.handoff")(function* (
    commandId: string,
    state: "response_written" | "delivery_withheld" = "response_written",
  ) {
    const outbox = Context.get(env.context, Outbox.EffectOutboxV2);
    const effects = yield* outbox.listByCommandId(CommandId.make(commandId));
    assert.equal(effects.length, 1);
    const effect = effects[0]!;
    assert.equal(effect.request.type, "runtime-request.respond");
    if (effect.request.type !== "runtime-request.respond")
      return assert.fail("Expected native approval outbox effect");
    const written = yield* Context.get(env.context, EventSink.EventSinkV2)
      .stream({ afterSequence: 0 })
      .pipe(
        Stream.filter(
          (event) =>
            event.event.type === "runtime-request.updated" &&
            event.event.payload.id === pending.id &&
            event.event.payload.approvalDelivery !== undefined &&
            [
              "response_written",
              "delivery_withheld",
              "delivery_failed",
              "delivery_unknown",
            ].includes(event.event.payload.approvalDelivery),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
    yield* delivery.respond({
      threadId,
      providerSessionId: effect.request.providerSessionId,
      requestId: pending.id,
      ...(effect.request.decision === undefined ? {} : { decision: effect.request.decision }),
      commandId: effect.commandId,
      effectId: effect.id,
      approvalGuard: effect.request.approvalGuard!,
    });
    const observed = (yield* Fiber.join(written))[0]!.event;
    if (observed.type !== "runtime-request.updated")
      return assert.fail("Expected native delivery evidence");
    yield* proof("nativecommand", {
      environment: env.name,
      commandId,
      ...(effect.request.decision === undefined ? {} : { decision: effect.request.decision }),
      state: observed.payload.approvalDelivery,
      expectedState: state,
      boundary:
        observed.payload.approvalDelivery === "response_written"
          ? "node_write_callback"
          : "not_started",
    });
    assert.equal(observed.payload.approvalDelivery, state);
  });
  yield* proof("boundary", {
    environment: env.name,
    scenario: suffix,
    requestId: pending.id,
    incarnation: pending.approval!.requestIncarnation,
    state: "pending_verified",
    origin:
      existingThreadId === undefined
        ? "operator-created; explicit delegation required"
        : "authenticated-link/client creation provenance",
  });
  return { env, input, pending, nativeRaw, runtime, reply, handoff, native };
});
export type NativeProbe = Effect.Success<ReturnType<typeof startNative>>;
export const nativeLayer = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer);
