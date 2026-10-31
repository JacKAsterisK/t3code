import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ApprovalReceipts from "./ApprovalReceipts.ts";
import { ApprovalAuditActor } from "./ApprovalContext.ts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess } from "effect/process";
import { makeNodeClient } from "effect-codex-app-server/node";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import {
  CodexSettings,
  EnvironmentHttpApi,
  MessageId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import { McpProtocol, McpServer } from "effect/ai";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ApprovalDelivery from "./ApprovalDelivery.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import type * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ApprovalNativeDescriptor,
  type ApprovalRespondInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Authority from "../auth/ApprovalAuthority.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Service from "./ApprovalService.ts";
import * as Presentation from "./ApprovalPresentation.ts";
import { ApprovalTestHooks } from "./ApprovalTestHooks.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const instanceId = ProviderInstanceId.make("codex");
const database = Sqlite.layerMemory;
const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-approval-service-" });
const environment = ServerEnvironment.layerIdentity.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(config),
);
const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(environment),
  Layer.provide(config),
);
const nativeLayer = Replay.layerWithRegistry(
  { name: "guarded-approvals" },
  Registry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("No paid provider process is used"),
    },
  ]),
  { databaseLayer: database, runEffectWorker: false },
).pipe(Layer.provideMerge(authLayer));
const layer = Service.layer.pipe(
  Layer.provideMerge(ThreadCommandExecutor.layer),
  Layer.provideMerge(nativeLayer),
  Layer.provideMerge(Projections.layer.pipe(Layer.provide(database))),
  Layer.provideMerge(CommandReceipts.layer.pipe(Layer.provide(database))),
  Layer.provideMerge(Outbox.layer.pipe(Layer.provide(database))),
  Layer.provideMerge(config),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(NodeServices.layer),
);
const seed = Effect.fn("ApprovalFixture.seed")(function* (suffix: string) {
  const native = yield* Orchestrator.OrchestratorV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.issueMcpClientSession({
    label: "Assistant",
    access: "full-access",
    approvals: true,
    peerLink: false,
    applicationId: "application",
    approvalSubject: "owner",
    client: { deviceType: "bot" },
  });
  const caller = {
    sessionId: session.sessionId,
    label: "Assistant",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
  const threadId = ThreadId.make(`approval-thread:${suffix}`);
  const requestId = RuntimeRequestId.make(`approval-request:${suffix}`);
  const providerSessionId = ProviderSessionId.make(`codex-session:${suffix}`);
  const nodeId = NodeId.make(`approval-node:${suffix}`);
  yield* native.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${suffix}`),
    threadId,
    projectId: ProjectId.make(`project:${suffix}`),
    title: "Approval",
    modelSelection: { instanceId, model: "fake" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const now = yield* DateTime.now;
  const permissions = { network: { enabled: true }, fileSystem: { write: ["/repo/output"] } };
  const descriptor: ApprovalNativeDescriptor = {
    requestIncarnation: `incarnation:${suffix}`,
    providerSessionId,
    providerGeneration: "generation-one",
    presentationRevision: 1,
    nativeRequestId: 42,
    grant: {
      version: 1,
      profile: "codex-permissions-687a119f-v1",
      provider: "codex",
      providerVersion: "0.159.0",
      nativeMethod: "item/permissions/requestApproval",
      nativeDecision: { permissions, scope: "turn" },
      permission: {
        cwd: "/repo",
        itemId: "item",
        threadId: "native-thread",
        turnId: "native-turn",
        startedAtMs: 1,
        permissions,
      },
      resources: { cwd: "/repo", permissions },
      effectiveScope: "turn",
      persistence: "none",
      supported: true,
      appliesTo: "All requested permissions for native-turn",
      expiresWhen: "native-turn ends",
    },
  };
  const request = {
    id: requestId,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "permission" as const,
    status: "pending" as const,
    responseCapability: { type: "live" as const, providerSessionId },
    createdAt: now,
    resolvedAt: null,
    approval: descriptor,
  };
  const item = {
    id: TurnItemId.make(`item:${suffix}`),
    threadId,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting" as const,
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "approval_request" as const,
    requestId,
    requestKind: "permission" as const,
    approval: descriptor,
    options: [
      { decision: "accept" as const, label: "Allow for this turn" },
      { decision: "decline" as const, label: "Decline" },
    ],
  };
  yield* projections.apply({
    id: EventId.make(`session:${suffix}`),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: providerSessionId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/repo",
      model: "fake",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`node:${suffix}`),
    type: "node.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`request:${suffix}`),
    type: "runtime-request.updated",
    threadId,
    occurredAt: now,
    payload: request,
  });
  yield* projections.apply({
    id: EventId.make(`item:${suffix}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: item,
  });
  const shown = (yield* Presentation.presentation({
    environmentId: yield* identity.getEnvironmentId,
    threadId,
    request,
    item,
  }))!;
  const input: ApprovalRespondInput = {
    action: "respond",
    threadId,
    requestId,
    clientRequestId: `retry-key:${suffix}`,
    decision: "accept",
    expected: shown.expected,
    consent: {
      effectiveScope: "turn",
      grantDigest: shown.grantDigest,
      onBehalfOf: "Person",
      authorization: "Allow these full permissions for this provider turn.",
    },
  };
  return { input, caller, native, projections, request, item };
});
it.effect(
  "commits one native response/receipt/outbox and returns exact retry before pending rejection",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed("retry");
      const service = yield* Service.ApprovalService;
      const outbox = yield* Outbox.EffectOutboxV2;
      const first = yield* service.respond(fixture.input, fixture.caller);
      assert.equal(first.state, "committed");
      yield* Console.log(
        JSON.stringify({
          proof: "native_commit",
          receiptId: first.receiptId,
          commandId: first.commandId,
          state: first.state,
        }),
      );
      const retry = yield* service.respond(fixture.input, fixture.caller);
      assert.equal(retry.receiptId, first.receiptId);
      assert.isTrue(retry.replayed);
      assert.equal((yield* outbox.listByCommandId(CommandId.make(first.commandId))).length, 1);
      assert.equal(
        (yield* service
          .respond(
            { ...fixture.input, consent: { ...fixture.input.consent, authorization: "changed" } },
            fixture.caller,
          )
          .pipe(Effect.flip)).code,
        "idempotency_conflict",
      );
      assert.equal(
        (yield* service
          .respond(
            { ...fixture.input, clientRequestId: "new-key-after-resolution" },
            fixture.caller,
          )
          .pipe(Effect.flip)).code,
        "already_answered",
      );
      const context = yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        fixture.input.requestId,
      );
      assert.equal(context.request?.resolvedBy?.principalId, `session:${fixture.caller.sessionId}`);
      assert.equal(context.request?.resolvedBy?.assertion?.onBehalfOf, "Person");
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect("revocation after prepare and UI races leave exactly one native winner", () =>
  Effect.gen(function* () {
    for (const winner of ["revocation", "ui"] as const) {
      const fixture = yield* seed(winner);
      const service = yield* Service.ApprovalService;
      const authority = yield* Authority.ApprovalAuthority;
      const prepared = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const paused = yield* service.respond(fixture.input, fixture.caller).pipe(
        Effect.provideService(ApprovalTestHooks, {
          afterPrepare: Deferred.succeed(prepared, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(prepared);
      if (winner === "revocation") yield* authority.remove(fixture.caller.sessionId, false);
      else
        yield* fixture.native.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("ui-winner"),
          threadId: fixture.input.threadId,
          requestId: fixture.input.requestId,
          decision: "decline",
        });
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(paused);
      assert.equal(result.state, "refused");
      const context = yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        fixture.input.requestId,
      );
      assert.equal(context.request?.status, winner === "ui" ? "resolved" : "pending");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${result.commandId}`)
          .length,
        0,
      );
    }
  }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect.each(["revocation", "authority-storage", "settings"] as const)(
  "%s after native commit withholds handoff and reopens only a fresh live incarnation",
  (fault) =>
    Effect.gen(function* () {
      const fixture = yield* seed("postcommit");
      const service = yield* Service.ApprovalService;
      const authority = yield* Authority.ApprovalAuthority;
      const receipt = yield* service.respond(fixture.input, fixture.caller);
      const outbox = yield* Outbox.EffectOutboxV2;
      const effect = (yield* outbox.listByCommandId(CommandId.make(receipt.commandId)))[0]!;
      assert.equal(effect.request.type, "runtime-request.respond");
      if (effect.request.type !== "runtime-request.respond") return;
      let writes = 0;
      const response = effect.request;
      const live = {
        respondToRuntimeRequest: (input: Adapter.ProviderAdapterV2RuntimeRequestResponseInput) =>
          Effect.gen(function* () {
            const guarded = input.guardedResponse!;
            const allowed = yield* guarded.admit(
              Effect.sync(() => {
                writes++;
                return true;
              }),
            );
            if (allowed) {
              yield* guarded.onResult("response_written", {
                commandId: guarded.commandId,
                boundary: "node_write_callback",
              });
              return;
            }
            const fresh = {
              ...guarded.descriptor,
              requestIncarnation: "fresh-after-withholding",
              presentationRevision: guarded.descriptor.presentationRevision + 1,
            };
            yield* guarded.onResult(
              "delivery_withheld",
              { commandId: guarded.commandId, boundary: "not_started" },
              fresh,
            );
          }),
      } as unknown as Adapter.ProviderAdapterV2SessionRuntime;
      const settingsFailure = yield* Ref.make(false);
      const settings = yield* ServerSettings.ServerSettingsService;
      const currentSettings = Layer.succeed(ServerSettings.ServerSettingsService, {
        ...settings,
        getSettings: Ref.get(settingsFailure).pipe(
          Effect.flatMap((failed) =>
            failed
              ? Effect.fail(
                  new ServerSettingsError({
                    settingsPath: "temporary-fixture/settings.json",
                    operation: "read-file",
                  }),
                )
              : settings.getSettings,
          ),
        ),
      });
      const deliveryLayer = ApprovalDelivery.layer.pipe(
        Layer.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedSome(live),
          }),
        ),
        Layer.provide(currentSettings),
      );
      const context = yield* Layer.build(deliveryLayer);
      const delivery = Context.get(context, ApprovalDelivery.ApprovalDelivery);
      const sink = yield* EventSink.EventSinkV2;
      const recorded = yield* sink.stream({ afterSequence: receipt.sequence! }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" &&
            stored.event.payload.approvalDelivery === "delivery_withheld",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pending = yield* delivery
        .respond({
          threadId: fixture.input.threadId,
          providerSessionId: response.providerSessionId,
          requestId: response.requestId,
          decision: response.decision!,
          commandId: effect.commandId,
          effectId: effect.id,
          approvalGuard: response.approvalGuard!,
        })
        .pipe(
          Effect.provideService(ApprovalTestHooks, {
            beforeDeliveryAdmission: Deferred.succeed(paused, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          }),
          Effect.forkScoped,
        );
      yield* Deferred.await(paused);
      const sql = yield* SqlClient.SqlClient;
      if (fault === "revocation") yield* authority.remove(fixture.caller.sessionId, false);
      else if (fault === "authority-storage")
        yield* sql`ALTER TABLE agent_approval_authorizations RENAME TO fixture_unavailable_authority`;
      else yield* Ref.set(settingsFailure, true);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      yield* Fiber.join(recorded);
      if (fault === "authority-storage")
        yield* sql`ALTER TABLE fixture_unavailable_authority RENAME TO agent_approval_authorizations`;
      yield* Ref.set(settingsFailure, false);
      const withheld = (yield* ApprovalReceipts.byCommand(receipt.commandId))!;
      assert.equal(withheld.failure_code, fault === "revocation" ? "authority_revoked" : null);
      assert.equal(writes, 0);
      yield* Console.log(
        JSON.stringify({
          proof: "postcommit_revocation",
          receiptId: receipt.receiptId,
          commandId: receipt.commandId,
          nativeWrites: writes,
          state: "delivery_withheld",
        }),
      );
      const current = (yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        fixture.input.requestId,
      )).request!;
      assert.equal(current.status, "pending");
      assert.equal(current.approval?.requestIncarnation, "fresh-after-withholding");
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM agent_approval_receipts WHERE receipt_id = ${receipt.receiptId}`)[0]!
          .state,
        "delivery_withheld",
      );
      const actor = { kind: "user" as const, principalId: "user:dan", label: "Dan" };
      const native = yield* Orchestrator.OrchestratorV2;
      yield* native
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("app-after-withholding"),
          threadId: fixture.input.threadId,
          requestId: fixture.input.requestId,
          decision: "decline",
        })
        .pipe(Effect.provideService(ApprovalAuditActor, actor));
      const answered = yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        fixture.input.requestId,
      );
      assert.equal(answered.request!.status, "resolved");
      assert.isUndefined(answered.request!.approvalDelivery);
      assert.isUndefined(answered.request!.approvalReceiptId);
      assert.deepEqual(answered.request!.resolvedBy, actor);
      if (answered.item?.type !== "approval_request") return assert.fail("Expected approval item");
      assert.isUndefined(answered.item.approvalDelivery);
      assert.deepEqual(answered.item.resolvedBy, actor);
      assert.deepEqual(answered.item.approval, current.approval);
      const read = yield* service.read(
        { action: "read", threadId: fixture.input.threadId, requestId: fixture.input.requestId },
        fixture.caller.sessionId,
      );
      assert.notInclude(JSON.stringify(read), '"deliveryState":"delivery_withheld"');
      if (fault !== "revocation") return;
      const lost = yield* seed("lost-before-admission");
      const committed = yield* service.respond(lost.input, lost.caller);
      const lostEffect = (yield* outbox.listByCommandId(CommandId.make(committed.commandId)))[0]!;
      if (lostEffect.request.type !== "runtime-request.respond")
        return assert.fail("Expected response effect");
      const lostResponse = lostEffect.request;
      const observed: Array<string> = [];
      const failedRecorded = yield* sink.stream({ afterSequence: committed.sequence! }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" &&
            stored.event.payload.approvalDelivery === "delivery_failed",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const noRequest = {
        respondToRuntimeRequest: () => Effect.die(new Error("No pending native runtime request")),
      } as unknown as Adapter.ProviderAdapterV2SessionRuntime;
      const missingLayer = ApprovalDelivery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () => Effect.succeedSome(noRequest),
            }),
            Layer.succeed(Orchestrator.OrchestratorV2, {
              ...native,
              dispatch: (command) => {
                if (command.type === "approval.delivery.record") observed.push(command.receiptId);
                return native.dispatch(command);
              },
            }),
          ),
        ),
      );
      const missing = Context.get(
        yield* Layer.build(missingLayer),
        ApprovalDelivery.ApprovalDelivery,
      );
      yield* missing.respond({
        threadId: lost.input.threadId,
        providerSessionId: lostResponse.providerSessionId,
        requestId: lostResponse.requestId,
        decision: lostResponse.decision!,
        commandId: lostEffect.commandId,
        effectId: lostEffect.id,
        approvalGuard: lostResponse.approvalGuard!,
      });
      yield* Fiber.join(failedRecorded);
      const failed = yield* ApprovalReceipts.byCommand(committed.commandId);
      assert.equal(failed!.state, "delivery_failed");
      assert.include(failed!.delivery_evidence_json!, '"boundary":"not_started"');
      assert.notInclude(
        observed,
        receipt.receiptId,
        "startup must not re-dispatch an old receipt already replaced by an app answer",
      );
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.live(
  "approval tools use both real HTTP protocol adapters and preserve local refusal codes",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed("mcp-http");
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
        requestNamespace: "approval-http",
        thread: undefined,
        client: {
          sessionId: fixture.caller.sessionId,
          label: fixture.caller.label,
          access: "full-access",
        },
      };
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => fixture.projections.getThreadShell(id).pipe(Effect.orDie),
        getProjectThreadRecords: () =>
          fixture.projections.getThreadProjection(fixture.input.threadId).pipe(Effect.orDie),
      });
      yield* HttpRouter.serve(
        McpHttpServer.layerApprovalToolkit.pipe(
          Layer.provideMerge(
            McpServer.layerHttp({
              name: "approval-http",
              version: "1",
              path: "/mcp",
              protocols: [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28],
            }),
          ),
          Layer.provide(threads),
          Layer.provide(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const headers = { accept: "application/json, text/event-stream" };
      const initialize = yield* client.post("/mcp", {
        headers,
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "approval-fixture", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      yield* initialize.text;
      let ordinal = 10;
      for (const protocol of ["2025-06-18", "2026-07-28"]) {
        const call = (input: Record<string, unknown>) =>
          Effect.gen(function* () {
            const meta = {
              "io.modelcontextprotocol/protocolVersion": protocol,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "approval-fixture", version: "1" },
            };
            const response = yield* client.post("/mcp", {
              headers: {
                ...headers,
                "mcp-protocol-version": protocol,
                ...(protocol === "2025-06-18"
                  ? { "mcp-session-id": initialize.headers["mcp-session-id"]! }
                  : { "mcp-method": "tools/call", "mcp-name": "t3_approval_request" }),
              },
              body: HttpBody.text(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: ordinal++,
                  method: "tools/call",
                  params: {
                    name: "t3_approval_request",
                    arguments: input,
                    ...(protocol === "2026-07-28" ? { _meta: meta } : {}),
                  },
                }),
                "application/json",
              ),
            });
            const raw = yield* response.text;
            const text = raw.trim().startsWith("data:")
              ? raw
                  .split(/\r?\n/u)
                  .find((line) => line.startsWith("data:"))!
                  .slice(5)
                  .trim()
              : raw;
            const result = JSON.parse(text) as { result?: { isError?: boolean }; error?: unknown };
            return { status: response.status, raw, result };
          });
        const read = yield* call({
          action: "read",
          threadId: fixture.input.threadId,
          requestId: fixture.input.requestId,
        });
        assert.equal(read.status, 200, `${protocol}: ${read.raw}`);
        assert.isFalse(read.result.result?.isError ?? false);
        assert.include(read.raw, "grantDigest");
        const remote = yield* call({ ...fixture.input, environmentId: "remote-environment" });
        assert.include(remote.raw, "forwarding_unavailable");
        const forged = yield* call({ ...fixture.input, resolvedBy: { kind: "user" } });
        assert.isTrue(forged.result.error !== undefined || forged.result.result?.isError === true);
        const submitted = yield* call(fixture.input);
        assert.isFalse(submitted.result.result?.isError ?? false);
        assert.include(submitted.raw, "committed");
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, NodeHttpServer.layerTest, NodeServices.layer)),
      Effect.scoped,
    ),
);

it.effect("a crash after preparation reuses its immutable guard and stable native command", () =>
  Effect.gen(function* () {
    const fixture = yield* seed("prepare-crash");
    const service = yield* Service.ApprovalService;
    const crashed = yield* service
      .respond(fixture.input, fixture.caller)
      .pipe(
        Effect.provideService(ApprovalTestHooks, { afterPrepare: Effect.interrupt }),
        Effect.exit,
      );
    assert.isTrue(Exit.isFailure(crashed));
    const sql = yield* SqlClient.SqlClient;
    const before = (yield* sql<{
      state: string;
      command_id: string;
    }>`SELECT state, command_id FROM agent_approval_receipts WHERE client_request_id = ${fixture.input.clientRequestId}`)[0]!;
    assert.equal(before.state, "prepared");
    const recovered = yield* service.respond(fixture.input, fixture.caller);
    assert.equal(recovered.commandId, before.command_id);
    assert.equal(recovered.state, "committed");
    const outbox = yield* Outbox.EffectOutboxV2;
    assert.equal((yield* outbox.listByCommandId(CommandId.make(before.command_id))).length, 1);
    const answered = yield* seed("prepare-crash-app-won");
    yield* service
      .respond(answered.input, answered.caller)
      .pipe(
        Effect.provideService(ApprovalTestHooks, { afterPrepare: Effect.interrupt }),
        Effect.exit,
      );
    const native = yield* Orchestrator.OrchestratorV2;
    yield* native.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("app-won-prepared"),
      threadId: answered.input.threadId,
      requestId: answered.input.requestId,
      decision: "decline",
    });
    const refused = yield* service.respond(answered.input, answered.caller);
    assert.equal(refused.state, "refused");
    assert.equal(refused.failureCode, "already_answered");
  }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "startup reconciles an admitted response without write evidence as uncertain and never resends",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed("admitted-crash");
      const service = yield* Service.ApprovalService;
      const receipt = yield* service.respond(fixture.input, fixture.caller);
      const outbox = yield* Outbox.EffectOutboxV2;
      const effect = (yield* outbox.listByCommandId(CommandId.make(receipt.commandId)))[0]!;
      if (effect.request.type !== "runtime-request.respond")
        return assert.fail("Expected response effect");
      const response = effect.request;
      let writes = 0;
      const live = {
        respondToRuntimeRequest: (input: Adapter.ProviderAdapterV2RuntimeRequestResponseInput) =>
          input
            .guardedResponse!.admit(
              Effect.sync(() => {
                writes++;
                return true;
              }),
            )
            .pipe(Effect.asVoid),
      } as unknown as Adapter.ProviderAdapterV2SessionRuntime;
      const deliveryLayer = ApprovalDelivery.layer.pipe(
        Layer.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedSome(live),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
      );
      const input = {
        threadId: fixture.input.threadId,
        providerSessionId: response.providerSessionId,
        requestId: response.requestId,
        decision: response.decision!,
        approvalGuard: response.approvalGuard!,
        commandId: effect.commandId,
        effectId: effect.id,
      };
      const firstScope = yield* Scope.make();
      const first = Context.get(
        yield* Layer.buildWithScope(deliveryLayer, firstScope),
        ApprovalDelivery.ApprovalDelivery,
      );
      yield* first.respond(input);
      assert.equal(writes, 1);
      yield* Scope.close(firstScope, Exit.void);
      const sink = yield* EventSink.EventSinkV2;
      const recorded = yield* sink.stream({ afterSequence: receipt.sequence! }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" &&
            stored.event.payload.approvalDelivery === "delivery_unknown",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const second = Context.get(
        yield* Layer.build(deliveryLayer),
        ApprovalDelivery.ApprovalDelivery,
      );
      yield* Fiber.join(recorded);
      yield* second.respond(input);
      assert.equal(writes, 1);
      const current = (yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        fixture.input.requestId,
      )).request!;
      assert.equal(current.status, "resolved");
      assert.equal(current.approval?.requestIncarnation, fixture.input.expected.requestIncarnation);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM agent_approval_receipts WHERE receipt_id = ${receipt.receiptId}`)[0]!
          .state,
        "delivery_unknown",
      );
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "all unverified profiles stay app-only for both decisions and preserve the native app response",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed("unsupported");
      const service = yield* Service.ApprovalService;
      const { approval: _descriptor, ...request } = fixture.request;
      const now = yield* DateTime.now;
      yield* fixture.projections.apply({
        id: EventId.make("unsupported:raw"),
        type: "runtime-request.updated",
        threadId: fixture.input.threadId,
        occurredAt: now,
        payload: {
          ...request,
          approvalUnsupported: {
            supported: false,
            reason: "unknown_raw_fields",
            complete: true,
            safeRaw: { permissions: { network: { hosts: ["*"] } } },
          },
        },
      });
      for (const decision of ["accept", "decline"] as const) {
        const error = yield* service
          .respond(
            { ...fixture.input, decision, clientRequestId: `unsupported-${decision}` },
            fixture.caller,
          )
          .pipe(Effect.flip);
        assert.equal(error.code, "ui_only");
      }
      const shown = yield* service.read(
        { action: "read", threadId: fixture.input.threadId, requestId: fixture.input.requestId },
        fixture.caller.sessionId,
      );
      assert.include(JSON.stringify(shown), "unknown_raw_fields");
      yield* fixture.native.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("unsupported:app-decline"),
        threadId: fixture.input.threadId,
        requestId: fixture.input.requestId,
        decision: "decline",
      });
      assert.equal(
        (yield* fixture.projections.getRuntimeResponseContext(
          fixture.input.threadId,
          fixture.input.requestId,
        )).request?.status,
        "resolved",
      );
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "startup repairs terminal delivery projections after receipt persistence without resending",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed("terminal-projection-crash");
      const service = yield* Service.ApprovalService;
      const receipt = yield* service.respond(fixture.input, fixture.caller);
      yield* ApprovalReceipts.transition(receipt.commandId, "delivery_admitted", {
        commandId: receipt.commandId,
        boundary: "delivery_admission",
      });
      yield* ApprovalReceipts.transition(receipt.commandId, "response_written", {
        commandId: receipt.commandId,
        boundary: "node_write_callback",
      });
      assert.equal(
        (yield* fixture.projections.getRuntimeResponseContext(
          fixture.input.threadId,
          fixture.input.requestId,
        )).request?.approvalDelivery,
        "committed",
      );
      const sink = yield* EventSink.EventSinkV2;
      const projected = yield* sink.stream({ afterSequence: receipt.sequence! }).pipe(
        Stream.filter(
          (event) =>
            event.event.type === "runtime-request.updated" &&
            event.event.payload.approvalDelivery === "response_written",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Layer.build(
        ApprovalDelivery.layer.pipe(
          Layer.provide(
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.die("Terminal receipt reconciliation must not send a native response"),
            }),
          ),
        ),
      );
      yield* Fiber.join(projected);
      assert.equal(
        (yield* fixture.projections.getRuntimeResponseContext(
          fixture.input.threadId,
          fixture.input.requestId,
        )).request?.approvalDelivery,
        "response_written",
      );
      const read = yield* service.read(
        { action: "read", threadId: fixture.input.threadId, requestId: fixture.input.requestId },
        fixture.caller.sessionId,
      );
      assert.include(JSON.stringify(read), receipt.receiptId);
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

class ApprovalOAuthApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.mcpOAuth,
) {}

it.live.each(["accept", "decline"] as const)(
  "OAuth/PKCE consent through authenticated MCP reaches the native callback for %s",
  (decision) =>
    Effect.gen(function* () {
      const suffix = `full-path-${decision}`;
      const fixture = yield* seed(suffix);
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const here = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
      const nativeClient = yield* makeNodeClient(
        ChildProcess.make(
          process.execPath,
          [
            `${import.meta.dirname}/../../../../packages/effect-codex-app-server/test/fixtures/codex-app-server-mock-peer.ts`,
          ],
          { env: { ...process.env, CODEX_APP_SERVER_TEST_PERMISSION_PROFILE: "1" } },
        ),
        {
          platform: yield* HostProcess.Platform,
          onSpawn: (pid) =>
            Console.log(JSON.stringify({ proof: "native_process", pid, scenario: suffix })),
        },
      );
      const modelSelection = { instanceId, model: "gpt-5.4" };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: process.cwd(),
      };
      const adapter = yield* CodexAdapter.makeCodexAdapterV2({
        instanceId,
        settings: yield* decodeCodexSettings({}),
        environment: {},
        clientFactory: { open: () => Effect.succeed(nativeClient) },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        continuationRequests: { offer: () => Effect.void },
      });
      const runtime = yield* adapter.openSession({
        threadId: fixture.input.threadId,
        providerSessionId: ProviderSessionId.make(fixture.input.expected.providerSessionId),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: fixture.input.threadId,
        modelSelection,
        runtimePolicy,
      });
      const ready =
        yield* Deferred.make<import("@t3tools/contracts").OrchestrationV2RuntimeRequest>();
      let ordinal = 0;
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const common = {
              id: EventId.make(`native-harness:${suffix}:${ordinal++}`),
              threadId: fixture.input.threadId,
              occurredAt: yield* DateTime.now,
            };
            if (event.type === "node.updated")
              yield* fixture.projections.apply({
                ...common,
                type: "node.updated",
                payload: event.node,
              });
            if (event.type === "turn_item.updated")
              yield* fixture.projections.apply({
                ...common,
                type: "turn-item.updated",
                payload: event.turnItem,
              });
            if (event.type === "runtime_request.updated") {
              yield* fixture.projections.apply({
                ...common,
                type: "runtime-request.updated",
                payload: event.runtimeRequest,
              });
              yield* Deferred.succeed(ready, event.runtimeRequest);
            }
          }),
        ),
        Effect.forkScoped,
      );
      const appThread = yield* fixture.projections.getThread(fixture.input.threadId);
      yield* runtime.startTurn({
        appThread,
        threadId: appThread.id,
        runId: RunId.make(`run:${suffix}`),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make(`attempt:${suffix}`),
        rootNodeId: fixture.request.nodeId,
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${suffix}`),
          text: "Request permissions",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const nativeRaw = {
        cwd: process.cwd(),
        itemId: "approval-harness-item",
        threadId: "thread-approval-harness",
        turnId: "turn-approval-harness",
        startedAtMs: 1,
        permissions: { network: { enabled: true }, fileSystem: { write: ["/tmp/output"] } },
      };
      const nativeReply = yield* nativeClient.raw
        .request("test/permission", nativeRaw)
        .pipe(Effect.forkScoped);
      const pending = yield* Deferred.await(ready);
      assert.deepEqual(pending.approval?.grant.permission, nativeRaw);
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => fixture.projections.getThreadShell(id).pipe(Effect.orDie),
        getProjectThreadRecords: () =>
          fixture.projections.getThreadProjection(fixture.input.threadId).pipe(Effect.orDie),
      });
      const oauth = HttpApiBuilder.layer(ApprovalOAuthApi).pipe(
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      );
      const mcp = McpHttpServer.layerApprovalToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(threads),
        Layer.provide(
          McpSessionRegistry.layer.pipe(
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(here),
              }),
            ),
          ),
        ),
        Layer.provide(
          McpOAuth.layerMcpClientAuthenticator.pipe(
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(here),
              }),
            ),
          ),
        ),
      );
      yield* HttpRouter.serve(
        Layer.mergeAll(oauth, mcp).pipe(
          Layer.provide(HttpPlatform.layer.pipe(Layer.provide(Etag.layerWeak))),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const http = yield* HttpClient.HttpClient;
      const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        http.post(path, { headers, body: HttpBody.text(JSON.stringify(body), "application/json") });
      const registered = yield* jsonPost("/oauth/mcp/register", {
        client_name: "Approval fixture",
        redirect_uris: ["http://localhost/callback"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
      });
      const registration = yield* registered.json;
      const clientId = (registration as { client_id: string }).client_id;
      assert.isString(clientId);
      const authorization = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:51234/callback",
        code_challenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
        code_challenge_method: "S256",
        state: "approval-harness",
      };
      const codeGrant = yield* auth.issuePairingCredential(
        { approvalGrant: true },
        { subject: "owner", scopes: new Set(["access:write"]) },
      );
      const approved = yield* jsonPost("/oauth/mcp/decision", {
        authorization,
        decision: {
          _tag: "pairing-code",
          code: codeGrant.credential,
          access: "full-access",
          approvals: true,
        },
      });
      const consentResult = yield* approved.json;
      assert.equal(approved.status, 200, JSON.stringify(consentResult));
      const code = new URL((consentResult as { redirectTo: string }).redirectTo).searchParams.get(
        "code",
      )!;
      const tokenResponse = yield* http.post("/oauth/mcp/token", {
        body: HttpBody.text(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            redirect_uri: authorization.redirect_uri,
            code_verifier: "a".repeat(43) + "-verifier-for-tests",
          }).toString(),
          "application/x-www-form-urlencoded",
        ),
      });
      const token = yield* tokenResponse.json;
      assert.equal(tokenResponse.status, 200, JSON.stringify(token));
      const bearer = (token as { access_token: string }).access_token;
      const headers = {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
      };
      const initialized = yield* jsonPost(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "approval-harness", version: "1" },
          },
        },
        headers,
      );
      yield* initialized.text;
      const mcpHeaders = {
        ...headers,
        "mcp-session-id": initialized.headers["mcp-session-id"]!,
        "mcp-protocol-version": "2025-06-18",
      };
      const tool = (id: number, input: unknown) =>
        jsonPost(
          "/mcp",
          {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "t3_approval_request", arguments: input },
          },
          mcpHeaders,
        ).pipe(Effect.flatMap((response) => response.text));
      const context = yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        pending.id,
      );
      const shown = (yield* Presentation.presentation({
        environmentId: here,
        threadId: fixture.input.threadId,
        request: context.request!,
        item: context.item!,
      }))!;
      const read = yield* tool(2, {
        action: "read",
        threadId: fixture.input.threadId,
        requestId: pending.id,
      });
      assert.include(read, shown.grantDigest);
      const input = {
        ...fixture.input,
        requestId: pending.id,
        expected: shown.expected,
        decision,
        consent: { ...fixture.input.consent, grantDigest: shown.grantDigest },
      };
      const submitted = yield* tool(3, input);
      assert.include(submitted, "committed");
      const sql = yield* SqlClient.SqlClient;
      const receipt = (yield* sql<{
        command_id: string;
        receipt_id: string;
      }>`SELECT command_id, receipt_id FROM agent_approval_receipts WHERE client_request_id = ${input.clientRequestId}`)[0]!;
      const effect = (yield* (yield* Outbox.EffectOutboxV2).listByCommandId(
        CommandId.make(receipt.command_id),
      ))[0]!;
      if (effect.request.type !== "runtime-request.respond")
        return assert.fail("Expected approval response");
      const deliveryContext = yield* Layer.build(
        ApprovalDelivery.layer.pipe(
          Layer.provide(
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () => Effect.succeedSome(runtime),
            }),
          ),
        ),
      );
      const delivery = Context.get(deliveryContext, ApprovalDelivery.ApprovalDelivery);
      const sink = yield* EventSink.EventSinkV2;
      const written = yield* sink.stream({ afterSequence: 0 }).pipe(
        Stream.filter(
          (event) =>
            event.event.type === "runtime-request.updated" &&
            event.event.payload.id === pending.id &&
            event.event.payload.approvalDelivery === "response_written",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* delivery.respond({
        threadId: fixture.input.threadId,
        providerSessionId: effect.request.providerSessionId,
        requestId: pending.id,
        decision,
        commandId: effect.commandId,
        effectId: effect.id,
        approvalGuard: effect.request.approvalGuard!,
      });
      const received = yield* Fiber.join(nativeReply);
      assert.deepEqual(received, {
        nativeResponse: {
          permissions: decision === "accept" ? nativeRaw.permissions : {},
          scope: "turn",
        },
      });
      yield* Fiber.join(written);
      const directRetry = yield* Deferred.make<string>();
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.id,
        decision,
        guardedResponse: {
          commandId: receipt.command_id,
          descriptor: pending.approval!,
          admit: () => Effect.die("A completed native reply must not be admitted again"),
          onResult: (state) => Deferred.succeed(directRetry, state).pipe(Effect.asVoid),
        },
      });
      assert.equal(yield* Deferred.await(directRetry), "response_written");
      const conflict = yield* runtime
        .respondToRuntimeRequest({
          requestId: pending.id,
          decision: decision === "accept" ? "decline" : "accept",
          guardedResponse: {
            commandId: receipt.command_id,
            descriptor: pending.approval!,
            admit: () => Effect.die("Conflicting native reply must not be admitted"),
            onResult: () => Effect.void,
          },
        })
        .pipe(Effect.result);
      assert.equal(conflict._tag, "Failure");
      const retry = yield* tool(4, input);
      assert.include(retry, "response_written");
      assert.equal(
        (yield* (yield* Outbox.EffectOutboxV2).listByCommandId(CommandId.make(receipt.command_id)))
          .length,
        1,
      );
      yield* Console.log(
        JSON.stringify({
          proof: "oauth_mcp_native",
          decision,
          receiptId: receipt.receipt_id,
          commandId: receipt.command_id,
          state: "response_written",
          nativeReply: received,
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          NodeHttpServer.layerTest,
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
    ),
);

it.effect("a paused exact retry cannot replace admitted write evidence with refusal", () =>
  Effect.gen(function* () {
    const fixture = yield* seed("retry-after-admission");
    const service = yield* Service.ApprovalService;
    const authority = yield* Authority.ApprovalAuthority;
    const prepared = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const paused = yield* service.respond(fixture.input, fixture.caller).pipe(
      Effect.provideService(ApprovalTestHooks, {
        afterPrepare: Deferred.succeed(prepared, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(prepared);
    const committed = yield* service.respond(fixture.input, fixture.caller);
    assert.equal(committed.state, "committed");
    assert.isTrue(
      yield* ApprovalReceipts.transition(committed.commandId, "delivery_admitted", {
        commandId: committed.commandId,
        boundary: "delivery_admission",
      }),
    );
    yield* authority.remove(fixture.caller.sessionId, false);
    yield* Deferred.succeed(release, undefined);
    const observed = yield* Fiber.join(paused);
    assert.equal(observed.state, "delivery_admitted");
    assert.isTrue(
      yield* ApprovalReceipts.transition(committed.commandId, "response_written", {
        commandId: committed.commandId,
        boundary: "node_write_callback",
      }),
    );
    assert.equal(
      (yield* ApprovalReceipts.byCommand(committed.commandId))!.state,
      "response_written",
    );
  }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "an exact retry recovers a prepared receipt whose native command was durably rejected",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed("rejected-command-crash");
      const service = yield* Service.ApprovalService;
      yield* service
        .respond(fixture.input, fixture.caller)
        .pipe(
          Effect.provideService(ApprovalTestHooks, { afterPrepare: Effect.interrupt }),
          Effect.exit,
        );
      const row = (yield* ApprovalReceipts.find(
        `session:${fixture.caller.sessionId}`,
        fixture.input.clientRequestId,
      ))!;
      const commands = yield* CommandReceipts.CommandReceiptStoreV2;
      yield* commands.insertIfAbsent({
        commandId: CommandId.make(row.command_id),
        threadId: fixture.input.threadId,
        commandType: "runtime-request.respond",
        acceptedAt: yield* DateTime.now,
        resultSequence: 0,
        status: "rejected",
        error: "The native command was rejected before response commitment.",
      });
      const recovered = yield* service.respond(fixture.input, fixture.caller);
      assert.equal(recovered.state, "refused");
      assert.isTrue(recovered.replayed);
      assert.equal(recovered.commandId, row.command_id);
      const outbox = yield* Outbox.EffectOutboxV2;
      assert.deepEqual(yield* outbox.listByCommandId(CommandId.make(row.command_id)), []);
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect("native approval responses require an explicitly offered decision", () =>
  Effect.gen(function* () {
    const fixture = yield* seed("omitted-decision");
    const commandId = CommandId.make("omitted-decision:response");
    const result = yield* Effect.exit(
      fixture.native.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId: fixture.input.threadId,
        requestId: fixture.input.requestId,
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.equal(
      (yield* fixture.projections.getRuntimeResponseContext(
        fixture.input.threadId,
        fixture.input.requestId,
      )).request?.status,
      "pending",
    );
    const outbox = yield* Outbox.EffectOutboxV2;
    assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
  }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "transient local authority failure before and after preparation preserves an exact retry",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("transient-authority");
      const service = yield* Service.ApprovalService;
      const sql = yield* SqlClient.SqlClient;
      const removeTable = sql`ALTER TABLE agent_approval_authorizations RENAME TO fixture_unavailable_authorizations`;
      const restoreTable = sql`ALTER TABLE fixture_unavailable_authorizations RENAME TO agent_approval_authorizations`;
      yield* removeTable;
      const read = yield* service
        .read(
          { action: "read", threadId: f.input.threadId, requestId: f.input.requestId },
          f.caller.sessionId,
        )
        .pipe(Effect.exit);
      const before = yield* service
        .respond(f.input, f.caller)
        .pipe(Effect.exit, Effect.ensuring(restoreTable.pipe(Effect.orDie)));
      for (const outcome of [read, before]) {
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag === "Failure") {
          const error = Cause.findError(outcome.cause);
          assert.equal(error._tag, "Success");
          if (error._tag === "Success")
            assert.equal((error.success as { code: string }).code, "orchestration_error");
        }
      }
      const after = yield* service.respond(f.input, f.caller).pipe(
        Effect.provideService(ApprovalTestHooks, {
          afterPrepare: removeTable.pipe(Effect.asVoid, Effect.orDie),
        }),
        Effect.exit,
        Effect.ensuring(restoreTable.pipe(Effect.orDie)),
      );
      assert.equal(after._tag, "Failure");
      const prepared = (yield* ApprovalReceipts.find(
        `session:${f.caller.sessionId}`,
        f.input.clientRequestId,
      ))!;
      assert.equal(prepared.state, "prepared");
      assert.isNull(prepared.failure_code);
      const result = yield* service.respond(f.input, f.caller);
      assert.equal(result.state, "committed");
      assert.equal(result.commandId, prepared.command_id);
    }).pipe(Effect.provide(Layer.mergeAll(layer, NodeServices.layer)), Effect.scoped),
);
