import { assert, describe, it } from "@effect/vitest";
import {
  ApplicationProjectEvent,
  EnvironmentId,
  EventId,
  type LanTaskObserveResult,
  ThreadId,
  type AgentEventDeliveryBody,
  type ApprovalNativeDescriptor,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Queue from "effect/Queue";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Retention from "./AgentFactRetention.ts";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Delivery from "./AgentEventDelivery.ts";
import * as Authority from "./AgentEventAuthority.ts";
import * as FactAuthority from "./AgentFactAuthority.ts";
import * as Runtime from "./AgentFactRuntime.ts";
import * as Subscriptions from "./AgentEventSubscriptions.ts";
import { WebhookTransport } from "./WebhookSender.ts";
import {
  allowed,
  layerAuthority,
  layerMemorySecrets,
  layerFileDatabase,
  startReceiver,
  receiverTransport,
  testSecret,
  StandardWebhook,
} from "./AgentEvents.testkit.ts";

import * as FleetUsers from "../lan/FleetUsers.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SourceStore from "../persistence/OrchestrationEventStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as NativeTask from "../lan/NativeTaskService.ts";
import * as Gateway from "../lan/GatewayCompatibility.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CompatibilityFacts from "./AgentGatewayCompatibilityFacts.ts";
import * as Deriver from "./AgentFactDeriver.ts";
import * as Checkpoints from "./AgentFactCheckpoints.ts";
import * as Facts from "./AgentFactStore.ts";
import * as DeliveryStore from "./AgentEventStore.ts";

const decodeWorkInputs = Schema.decodeUnknownEffect(Schema.Struct({ controlsJson: Schema.String }));
const decodeWorkControls = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ thread: Schema.Struct({ title: Schema.String }) })),
);

const database = layerDatabase;
const coreForDatabase = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const records = Layer.mergeAll(
    SourceStore.layer,
    ProjectionStore.layer,
    FleetUsers.layerStatic({
      users: [
        { id: "dan", name: "Dan" },
        { id: "gavin", name: "Gavin" },
      ],
      machineId: null,
      defaultOwnerId: null,
    }),
  ).pipe(Layer.provideMerge(database));
  return EventSink.layer.pipe(
    Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
    Layer.provideMerge(records),
  );
};
const core = coreForDatabase(database);
const environment = { id: "environment-a", label: "Machine A" };
const instance = Deriver.AgentFactDeriver.pipe(
  Effect.provide(Deriver.layer(environment).pipe(Layer.provide(NodeServices.layer))),
);
const at = "2026-01-01T00:00:00.000Z";
const thread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-a",
  projectId: "project-a",
  title: "Task A",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-a" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const request = {
  id: "request-a",
  nodeId: "node-a",
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: at,
  resolvedAt: null,
};
const item = {
  id: "item-a",
  threadId: "thread-a",
  runId: null,
  nodeId: "node-a",
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "pending",
  title: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
  type: "approval_request",
  requestId: "request-a",
  requestKind: "command",
};
const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const decodeProject = Schema.decodeUnknownSync(ApplicationProjectEvent);
const event = (id: string, type: string, payload: unknown) =>
  decode({ id, type, payload, threadId: "thread-a", occurredAt: at });
const commit = Effect.fn("fixture.commit")(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const sink = yield* EventSink.EventSinkV2;
  return yield* sink.write({ events });
});
const seed = Effect.fn("fixture.seed")(function* () {
  yield* commit([
    event("created", "thread.created", thread),
    event("request", "runtime-request.updated", request),
    event("item", "turn-item.updated", item),
  ]);
});

describe("AgentFactDeriver", () => {
  it.effect(
    "uses one log for actual EventSink/native observations and lossless work snapshots through rebuild, compaction and reset",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const deriver = yield* instance;
        yield* deriver.activate;
        const run = {
          id: "run-a",
          threadId: "thread-a",
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: "message-a",
          rootNodeId: null,
          activeAttemptId: null,
          requestedAt: at,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const stored = yield* commit([
          event("created", "thread.created", {
            ...thread,
            title: "Long task title ".repeat(2_000),
          }),
          event("queued", "run.created", { ...run, status: "queued" }),
          event("running", "run.updated", { ...run, status: "running" }),
          event("approval", "runtime-request.updated", request),
          event("question", "runtime-request.updated", {
            ...request,
            id: "question-a",
            kind: "user_input",
          }),
          event("closed", "runtime-request.updated", {
            ...request,
            id: "question-a",
            kind: "user_input",
            status: "resolved",
            resolvedAt: at,
          }),
          event("finished", "run.updated", { ...run, status: "completed", completedAt: at }),
        ]);
        yield* deriver.catchUp;
        const native = yield* NativeTask.NativeTaskService.pipe(
          Effect.provide(
            NativeTask.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
                    getThreadRecords: (id, fields, filter) =>
                      projections.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
                    delegatedTaskResultPending: () => Effect.succeed(false),
                  }),
                  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
                  Layer.mock(OrchestratorMcp.OrchestratorMcpService)({}),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                ),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make(environment.id),
          requestNamespace: "fixture:read",
          thread: undefined,
          client: { sessionId: "outside-reader", label: "reader", access: "read-only" },
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const page = yield* native.observe(scope, { threadId: ThreadId.make("thread-a") });
        assert.deepEqual(
          page.events.map((item) => [item.eventId, item.sequence, item.kind]),
          [
            ["queued", 2, "run_state"],
            ["running", 3, "run_state"],
            ["approval", 4, "approval"],
            ["question", 5, "question"],
            ["closed", 6, "request_state"],
            ["finished", 7, "run_terminal"],
          ],
        );
        assert.equal(page.taskWorkState, "result_available");
        const all = yield* Facts.readFacts(0, 100, true);
        const observations = all.filter((fact) => fact.kind === "gateway_observation");
        assert.equal(observations.length, 6);
        assert.deepEqual(
          observations.map((fact) => [fact.originGeneration, fact.sourceSequence]),
          stored.slice(1).map((row) => [row.event.id, row.sequence]),
        );
        const work = all.find((fact) => fact.kind === "gateway_work_snapshot")!;
        const inputs = yield* CompatibilityFacts.readWorkSnapshot(work.eventId);
        assert.isBelow(Buffer.byteLength(work.dataJson), 16_384);
        const controls = yield* decodeWorkControls(
          (yield* decodeWorkInputs(inputs.inputs)).controlsJson,
        );
        assert.equal(controls.thread.title, "Long task title ".repeat(2_000).trim());
        assert.deepEqual(inputs.page, page);
        assert.deepEqual(yield* sql`SELECT * FROM agent_gateway_compatibility_facts`, []);
        assert.deepEqual(yield* sql`SELECT * FROM agent_event_deliveries`, []);
        const compatibility = yield* Gateway.GatewayCompatibility.pipe(
          Effect.provide(Gateway.layer.pipe(Layer.provide(NodeServices.layer))),
        );
        const target = {
          principal: "grant:reader",
          environmentId: scope.environmentId,
          threadId: page.threadId,
        };
        yield* compatibility.startShadow({ mode: "legacy", generation: 0 });
        yield* compatibility.observe(target, page, { expectedDeliverySourceId: null });
        yield* compatibility.acknowledge(target, [page.events[0]!.eventId], page.sourceId);
        const inbox = yield* sql`SELECT * FROM agent_gateway_compatibility_inbox ORDER BY event_id`;
        const cursors = yield* sql`SELECT * FROM agent_gateway_compatibility_cursors`;
        const before = yield* Facts.readFacts(0, 100, true);
        const occurrences = yield* sql`SELECT * FROM agent_event_occurrences ORDER BY log_seq`;
        const head = (yield* DeliveryStore.logState()).headSeq;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM agent_event_facts WHERE source_kind='gateway'`;
            yield* deriver.rebuild;
          }),
        );
        assert.deepEqual(yield* Facts.readFacts(0, 100, true), before);
        assert.deepEqual(
          yield* sql`SELECT * FROM agent_event_occurrences ORDER BY log_seq`,
          occurrences,
        );
        assert.deepEqual(
          yield* sql`SELECT * FROM agent_gateway_compatibility_inbox ORDER BY event_id`,
          inbox,
        );
        assert.deepEqual(yield* sql`SELECT * FROM agent_gateway_compatibility_cursors`, cursors);
        assert.equal((yield* DeliveryStore.logState()).headSeq, head);
        yield* Retention.pruneLog(20 * 24 * 60 * 60_000);
        const retainedInbox =
          yield* sql`SELECT * FROM agent_gateway_compatibility_inbox ORDER BY event_id`;
        assert.deepEqual(
          retainedInbox,
          yield* sql`SELECT *,NULL AS fact_id FROM lan_observation_inbox ORDER BY event_id`,
        );
        const base = (yield* sql<{
          sequence: number;
        }>`SELECT rebuild_sequence AS sequence FROM agent_event_source_state`)[0]!.sequence;
        assert.isAbove(base, 0);
        yield* sql`DELETE FROM orchestration_events WHERE sequence < ${base}`;
        const retained = yield* Facts.readFacts(0, 100, true);
        yield* deriver.rebuild;
        assert.deepEqual(yield* Facts.readFacts(0, 100, true), retained);
        assert.deepEqual(yield* compatibility.pending(target), page.events.slice(1));
        const generation = (yield* sql<{
          generation: string;
        }>`SELECT generation FROM agent_event_source_state`)[0]!.generation;
        yield* deriver.rebootstrap({ generation, throughSequence: 7 });
        const afterReset = yield* Facts.readFacts(0, 100, true);
        assert.deepEqual(
          afterReset.filter((row) => row.sourceKind === "gateway"),
          retained.filter((row) => row.sourceKind === "gateway"),
        );
        assert.deepEqual(yield* compatibility.pending(target), page.events.slice(1));
        assert.deepEqual(
          yield* sql`SELECT * FROM agent_gateway_compatibility_inbox ORDER BY event_id`,
          retainedInbox,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        process.stdout.write(
          JSON.stringify({
            proof: "gateway_fact_log",
            scenario: "event_sink_native_rebuild",
            actualEventSink: true,
            observationKinds: page.events.map((row) => row.kind),
            workSnapshotBytes: Buffer.byteLength(work.dataJson),
            canonicalObservations: observations.length,
            catalogIdsAndBytesPreserved: true,
            originalManifestSlots: true,
            pendingAndAckPreserved: true,
            sourceCompaction: true,
            rebootstrap: true,
            webhookDisabled: true,
          }) + "\n",
        );
      }).pipe(Effect.provide(core)),
  );
  it.effect(
    "rebuilds retained facts with the same identities and bytes while preserving probes, claims and handled delivery state",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* instance;
        yield* service.activate;
        const log = yield* DeliveryStore.logState();
        yield* DeliveryStore.upsertSubscription(
          {
            subscriptionId: "client",
            principalId: "session:a",
            sessionId: "a",
            attributionSubject: "mcp-client:local",
            clientLabel: "Client",
            eventName: "t3.task_activity",
            argumentsJson: "{}",
            callbackUrl: "https://callback.test",
            secretRef: "fixture",
            previousSecretRef: null,
            previousSecretUntil: null,
            state: "active",
            expiresAt: 10_000,
            logEpoch: log.epoch,
            updatedAt: 0,
          },
          0,
        );
        yield* commit([
          event("created", "thread.created", { ...thread, ownerId: "dan" }),
          event("opened", "runtime-request.updated", request),
          event("A", "turn-item.updated", { ...item, prompt: "A" }),
          event("B", "turn-item.updated", { ...item, prompt: "B" }),
          event("second-A", "turn-item.updated", { ...item, prompt: "A" }),
          event("closed", "runtime-request.updated", {
            ...request,
            status: "resolved",
            resolvedAt: at,
          }),
        ]);
        yield* service.catchUp;
        yield* DeliveryStore.appendProbe({
          eventId: "private-probe",
          subscriptionId: "client",
          occurredAt: 0,
          dataJson: "{}",
          now: 0,
        });
        yield* sql`UPDATE agent_event_deliveries SET state = 'delivered', finished_at = 1 WHERE log_seq = 1`;
        yield* sql`UPDATE agent_event_deliveries SET state = 'sending' WHERE log_seq = 2`;
        const before = yield* Facts.readFacts(0);
        const deliveries = yield* sql`SELECT * FROM agent_event_deliveries ORDER BY log_seq`;
        const checkpoints =
          yield* sql`SELECT * FROM agent_event_derivation_state ORDER BY state_key`;
        const probes = yield* sql`SELECT * FROM agent_event_probes`;
        const previousLog = yield* DeliveryStore.logState();
        yield* sql`DELETE FROM agent_event_facts WHERE source_sequence = 4`;
        const renamed = yield* Deriver.AgentFactDeriver.pipe(
          Effect.provide(
            Deriver.layer(environment).pipe(
              Layer.provide(
                FleetUsers.layerStatic({
                  users: [{ id: "dan", name: "Daniel" }],
                  machineId: null,
                  defaultOwnerId: null,
                }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        assert.strictEqual(
          (JSON.parse(before[1]!.dataJson) as { owner: { label: string } }).owner.label,
          "Dan",
        );
        const rebuilt = yield* renamed.rebuild;
        assert.strictEqual(rebuilt.restored, before.length);
        assert.notStrictEqual(rebuilt.cursorEpoch, previousLog.epoch);
        assert.deepEqual(yield* Facts.readFacts(0), before);
        assert.deepEqual(
          yield* sql`SELECT * FROM agent_event_deliveries ORDER BY log_seq`,
          deliveries,
        );
        assert.deepEqual(
          yield* sql`SELECT * FROM agent_event_derivation_state ORDER BY state_key`,
          checkpoints,
        );
        assert.deepEqual(yield* sql`SELECT * FROM agent_event_probes`, probes);
        assert.strictEqual((yield* DeliveryStore.logState()).headSeq, previousLog.headSeq);
        assert.strictEqual(
          (yield* DeliveryStore.findSubscription("client"))!.logEpoch,
          rebuilt.cursorEpoch,
        );
        assert.deepEqual(yield* service.catchUp, { throughSequence: 6, facts: 0 });
        yield* sql`UPDATE agent_event_occurrences SET data_digest = 'changed' WHERE source_sequence = 4`;
        assert.strictEqual((yield* Effect.flip(service.rebuild)).reason, "replay_failed");
        assert.strictEqual((yield* DeliveryStore.logState()).epoch, rebuilt.cursorEpoch);
        assert.deepEqual(yield* Facts.readFacts(0), before);
        assert.deepEqual(
          yield* sql`SELECT * FROM agent_event_deliveries ORDER BY log_seq`,
          deliveries,
        );
        assert.strictEqual(yield* Facts.progress(), 6);
      }).pipe(Effect.provide(core)),
  );

  it.effect("advances the replay base with retention and never resurrects pruned facts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* instance;
      yield* TestClock.setTime(0);
      yield* service.activate;
      yield* seed();
      yield* service.catchUp;
      yield* TestClock.setTime(15 * 24 * 60 * 60_000);
      yield* commit([event("new-presentation", "turn-item.updated", { ...item, prompt: "B" })]);
      yield* service.catchUp;
      const before = (yield* Facts.readFacts(0)).at(-1)!;
      yield* Retention.pruneLog(yield* Clock.currentTimeMillis);
      assert.strictEqual(
        (yield* sql<{
          readonly sequence: number;
        }>`SELECT rebuild_sequence AS sequence FROM agent_event_source_state`)[0]!.sequence,
        3,
      );
      assert.strictEqual((yield* Facts.readFacts(0)).length, 1);
      assert.strictEqual((yield* service.rebuild).restored, 1);
      assert.deepEqual(yield* Facts.readFacts(0), [before]);
    }).pipe(Effect.provide(core)),
  );

  it.live(
    "collects signed local facts, resumes historical changes after restart, and preserves approval evidence",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const receiver = yield* startReceiver();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const disposableDatabase = path.join(yield* fs.makeTempDirectoryScoped(), "facts.sqlite");
          const verdicts = yield* Ref.make<ReadonlyMap<string, Authority.AuthorityVerdict>>(
            new Map([["session-dot", allowed()]]),
          );
          const shared = Layer.mergeAll(
            coreForDatabase(layerFileDatabase(disposableDatabase)),
            layerMemorySecrets,
            layerAuthority(verdicts),
            Settings.layerTest({ agentEventsEnabled: true }),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-facts-runtime-" }),
            Layer.succeed(WebhookTransport, receiverTransport(receiver.ca)),
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make(environment.id)),
            }),
            Layer.mock(SessionStore.SessionStore)({
              cookieName: "t3",
              legacyCookieName: undefined,
              streamChanges: Stream.empty,
            }),
          ).pipe(Layer.provideMerge(NodeServices.layer));
          const services = yield* Layer.build(shared);
          const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(Effect.provide(services));
          const permissions = { network: { enabled: true } };
          const descriptor: ApprovalNativeDescriptor = {
            requestIncarnation: "native-incarnation-one",
            providerSessionId: "native-session",
            providerGeneration: "native-generation",
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
                itemId: "native-item",
                threadId: "native-thread",
                turnId: "native-turn",
                startedAtMs: 1,
                permissions,
              },
              resources: { cwd: "/repo", permissions },
              effectiveScope: "turn",
              persistence: "none",
              supported: true,
              appliesTo: "Requested permissions for native-turn",
              expiresWhen: "native-turn ends",
            },
          };
          const nativeRequest = {
            ...request,
            approval: descriptor,
            kind: "permission",
            responseCapability: { type: "live", providerSessionId: "native-session" },
          };
          yield* provide(
            commit([
              event("created", "thread.created", { ...thread, ownerId: "dan" }),
              event("opened", "runtime-request.updated", nativeRequest),
              event("A", "turn-item.updated", {
                ...item,
                requestKind: "permission",
                prompt: "A",
                options: [
                  { decision: "accept", label: "Allow for this turn" },
                  { decision: "decline", label: "Decline" },
                ],
              }),
            ]),
          );
          const secret = testSecret(9);
          const subscription = yield* provide(
            Subscriptions.subscribe(
              {
                environmentId: EnvironmentId.make(environment.id),
                capabilities: new Set(["orchestration"]),
                issuedAt: 0,
                requestNamespace: "client:session-dot",
                thread: undefined,
                client: {
                  sessionId: "session-dot",
                  label: "Gecko Butler",
                  access: "approval-required",
                  sharesOutside: true,
                },
              },
              {
                name: "t3.task_activity",
                arguments: {},
                delivery: {
                  mode: "webhook",
                  url: `https://callback.test:${receiver.port}/facts`,
                  secret,
                },
                cursor: null,
              },
            ),
          );
          const startServer = Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const worker = yield* Layer.buildWithScope(
              Runtime.layerForEnvironment(environment).pipe(
                Layer.provideMerge(Delivery.layer),
                Layer.provideMerge(FactAuthority.layer),
              ),
              scope,
            ).pipe(Effect.provide(services));
            return { scope, worker };
          });
          const nextBody: Effect.Effect<AgentEventDeliveryBody> = Queue.take(
            receiver.requests,
          ).pipe(
            Effect.flatMap((received) => {
              if (received.body.includes('"type":"verification"')) return nextBody;
              new StandardWebhook(secret).verify(received.body, received.headers);
              return Effect.succeed(JSON.parse(received.body) as AgentEventDeliveryBody);
            }),
          );
          const nextFact: Effect.Effect<AgentEventDeliveryBody> = nextBody.pipe(
            Effect.filterOrElse(
              (body) => body.data.kind !== "probe",
              () => nextFact,
            ),
          );
          const first = yield* startServer;
          const initial = yield* nextFact;
          assert.strictEqual(initial.data.kind, "approval");
          assert.strictEqual(initial.data.detail.bootstrap_snapshot, true);
          assert.strictEqual(initial.data.detail.requestIncarnation, descriptor.requestIncarnation);
          assert.deepEqual(initial.data.detail.grant, descriptor.grant);
          assert.deepEqual(initial.data.detail.answerable, {
            via: "t3_approval_request",
            decisions: ["accept", "decline"],
            requiredConsentScope: "turn",
          });
          assert.match(String(initial.data.detail.presentationDigest), /^[a-f0-9]{64}$/);
          // The next delivery proves the first's durable completion before the generation closes.
          const now = yield* Clock.currentTimeMillis;
          yield* provide(
            DeliveryStore.appendProbe({
              eventId: "harness-milestone",
              subscriptionId: subscription.id,
              occurredAt: now,
              dataJson: JSON.stringify({ ...initial.data, kind: "probe" }),
              now,
            }),
          );
          yield* Delivery.AgentEventDelivery.pipe(
            Effect.flatMap((service) => service.wake),
            Effect.provide(first.worker),
          );
          assert.strictEqual((yield* nextBody).eventId, "harness-milestone");
          yield* Scope.close(first.scope, Exit.void);
          const actor = {
            kind: "mcp_client",
            principalId: "session:approved",
            label: "Gecko Butler",
            assertion: { onBehalfOf: "Dan", authorization: "Grant this turn" },
          };
          const stored = yield* provide(
            commit([
              event("B", "turn-item.updated", { ...item, requestKind: "permission", prompt: "B" }),
              event("second-A", "turn-item.updated", {
                ...item,
                requestKind: "permission",
                prompt: "A",
              }),
              event("closed", "runtime-request.updated", {
                ...nativeRequest,
                status: "resolved",
                resolvedAt: at,
                decision: "accept",
                resolvedBy: actor,
              }),
              event("failed", "runtime-request.updated", {
                ...nativeRequest,
                status: "resolved",
                resolvedAt: at,
                decision: "accept",
                resolvedBy: actor,
                approvalDelivery: "delivery_unknown",
                approvalReceiptId: "receipt-a",
              }),
              event("owner", "thread.owner-set", { ...thread, ownerId: "gavin" }),
            ]),
          );
          const second = yield* startServer;
          const resumed: Array<AgentEventDeliveryBody> = [];
          for (let index = 0; index < 5; index++) resumed.push(yield* nextFact);
          assert.deepEqual(
            resumed.map((body) => body.data.kind),
            ["approval", "approval", "request_closed", "blocked", "owner_changed"],
          );
          assert.deepEqual(
            resumed.slice(0, 2).map((body) => body.data.detail.prompt),
            ["B", "A"],
          );
          assert.notStrictEqual(initial.eventId, resumed[1]!.eventId);
          assert.strictEqual(initial.data.factKey, resumed[1]!.data.factKey);
          assert.deepEqual(resumed[2]!.data.detail.resolvedBy, actor);
          assert.strictEqual(resumed[3]!.data.detail.reason, "answer_not_delivered");
          assert.deepEqual(
            resumed.map((body) => body.data.owner!.id),
            ["dan", "dan", "dan", "dan", "gavin"],
          );
          assert.strictEqual(yield* provide(Facts.progress()), stored.at(-1)!.sequence);
          assert.strictEqual((yield* provide(Facts.readFacts(0))).length, 6);
          yield* Scope.close(second.scope, Exit.void);
          yield* Effect.sync(() =>
            process.stdout.write(
              JSON.stringify({
                proof: "facts-runtime",
                signed: true,
                restartReplay: true,
                historicalOwners: true,
                verifiedApprovalGrant: true,
                liveCredentials: false,
              }) + "\n",
            ),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "replays open, A → B → A and close after the current projection is already resolved",
    () =>
      Effect.gen(function* () {
        const service = yield* instance;
        yield* service.activate;
        yield* commit([
          event("created", "thread.created", thread),
          event("opened", "runtime-request.updated", request),
          event("first-A", "turn-item.updated", { ...item, prompt: "A" }),
          event("B", "turn-item.updated", { ...item, prompt: "B" }),
          event("second-A", "turn-item.updated", { ...item, prompt: "A" }),
          event("closed", "runtime-request.updated", {
            ...request,
            status: "resolved",
            resolvedAt: at,
          }),
        ]);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const current = yield* projections.getThreadRecords(
          decode({
            id: "lookup",
            type: "thread.created",
            payload: thread,
            threadId: "thread-a",
            occurredAt: at,
          }).threadId,
          ["runtimeRequests"],
        );
        assert.strictEqual(current.runtimeRequests[0]!.status, "resolved");
        const reconstructed = yield* instance;
        assert.deepEqual(yield* reconstructed.catchUp, { throughSequence: 6, facts: 5 });
        const facts = yield* Facts.readFacts(0);
        assert.deepEqual(
          facts.map((fact) => [fact.sourceSequence, fact.kind]),
          [
            [1, "owner_changed"],
            [3, "approval"],
            [4, "approval"],
            [5, "approval"],
            [6, "request_closed"],
          ],
        );
        const presentations = facts.filter((fact) => fact.kind === "approval");
        assert.strictEqual(new Set(presentations.map((fact) => fact.factKey)).size, 1);
        assert.strictEqual(new Set(presentations.map((fact) => fact.eventId)).size, 3);
        assert.deepEqual(yield* reconstructed.catchUp, { throughSequence: 6, facts: 0 });
      }).pipe(Effect.provide(core)),
  );

  it.effect("updates a bounded set of checkpoints even when a thread has many old requests", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();
      for (let index = 0; index < 50; index++)
        yield* commit([
          event(`request-${index}`, "runtime-request.updated", {
            ...request,
            id: `other-${index}`,
          }),
          event(`item-${index}`, "turn-item.updated", {
            ...item,
            id: `other-item-${index}`,
            requestId: `other-${index}`,
          }),
        ]);
      const service = yield* instance;
      yield* service.activate;
      const root = yield* Facts.readState(Checkpoints.rootKey("thread-a"));
      assert.deepEqual((JSON.parse(root!.json) as { requests: unknown }).requests, {});
      const stored = yield* commit([
        event("changed", "turn-item.updated", { ...item, prompt: "Changed authority" }),
      ]);
      assert.deepEqual(yield* service.catchUp, { throughSequence: stored[0]!.sequence, facts: 1 });
      const changed = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM agent_event_derivation_state
        WHERE source_sequence = ${stored[0]!.sequence}`;
      assert.strictEqual(changed[0]!.count, 2);
      assert.strictEqual((yield* Facts.readFacts(0)).length, 52);
    }).pipe(Effect.provide(core)),
  );

  it.effect(
    "activates one durable snapshot and resumes through project events after reconstruction",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const first = yield* instance;
        yield* first.activate;
        yield* first.activate;
        const initial = yield* Facts.readFacts(0);
        assert.strictEqual(initial.length, 1);
        const bootstrap = JSON.parse(initial[0]!.dataJson) as {
          detail: { bootstrap_snapshot: boolean };
        };
        assert.strictEqual(bootstrap.detail.bootstrap_snapshot, true);
        assert.strictEqual(yield* Facts.progress(), 3);
        const source = yield* SourceStore.OrchestrationEventStore;
        yield* source.appendProjectEvent(
          decodeProject({
            sequence: 0,
            eventId: "project-event",
            aggregateKind: "project",
            aggregateId: "project-a",
            type: "project.created",
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId: "project-a",
              title: "Project A",
              workspaceRoot: "C:/fixture",
              defaultModelSelection: null,
              scripts: [],
              createdAt: at,
              updatedAt: at,
            },
          }),
        );
        yield* commit([
          event("resolved", "runtime-request.updated", {
            ...request,
            status: "resolved",
            resolvedAt: at,
          }),
        ]);
        const reconstructed = yield* instance;
        assert.deepEqual(yield* reconstructed.catchUp, { throughSequence: 5, facts: 1 });
        assert.deepEqual(yield* reconstructed.catchUp, { throughSequence: 5, facts: 0 });
        const facts = yield* Facts.readFacts(0);
        assert.strictEqual(facts.length, 2);
        assert.strictEqual(facts[1]!.kind, "request_closed");
        assert.strictEqual(facts[1]!.sourceSequence, 5);
        assert.strictEqual(facts[0]!.eventId, initial[0]!.eventId);
      }).pipe(Effect.provide(core)),
  );

  it.effect("rolls back activation and source progress if matching cannot be persisted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();
      const priorSource = yield* sql`SELECT * FROM agent_event_source_state`;
      const log = yield* DeliveryStore.logState();
      yield* DeliveryStore.upsertSubscription(
        {
          subscriptionId: "client",
          principalId: "session:a",
          sessionId: "a",
          attributionSubject: "mcp-client:local",
          clientLabel: "Client",
          eventName: "t3.task_activity",
          argumentsJson: "{}",
          callbackUrl: "https://callback.test",
          secretRef: "fixture",
          previousSecretRef: null,
          previousSecretUntil: null,
          state: "active",
          expiresAt: 10_000,
          logEpoch: log.epoch,
          updatedAt: 0,
        },
        0,
      );
      yield* sql`CREATE TRIGGER refuse_delivery BEFORE INSERT ON agent_event_deliveries
        BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`;
      const service = yield* instance;
      const failure = yield* Effect.flip(service.activate);
      assert.strictEqual(failure.reason, "activation_failed");
      assert.deepEqual(yield* Facts.readFacts(0), []);
      assert.strictEqual(yield* Facts.progress(), 0);
      assert.strictEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM agent_event_derivation_state`)[0]!.count,
        0,
      );
      assert.deepEqual(yield* sql`SELECT * FROM agent_event_source_state`, priorSource);
      yield* sql`DROP TRIGGER refuse_delivery`;
      yield* service.activate;
      assert.strictEqual(yield* Facts.progress(), 3);
      assert.strictEqual((yield* DeliveryStore.listDeliveries("client", 10)).length, 1);
    }).pipe(Effect.provide(core)),
  );

  it.effect(
    "persists one gap warning and refuses to invent transitions across missing history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* instance;
        yield* service.activate;
        const stored = yield* commit([
          event("created", "thread.created", thread),
          event("missing", "thread.metadata-updated", { ...thread, ownerId: "dan" }),
          event("later", "thread.metadata-updated", { ...thread, ownerId: "gavin" }),
        ]);
        yield* sql`DELETE FROM orchestration_events WHERE sequence = ${stored[1]!.sequence}`;
        assert.strictEqual((yield* Effect.flip(service.catchUp)).reason, "source_gap");
        const facts = yield* Facts.readFacts(0);
        assert.deepEqual(
          facts.map((fact) => fact.kind),
          ["owner_changed", "source_status"],
        );
        assert.strictEqual(yield* Facts.progress(), 1);
        const reconstructed = yield* instance;
        assert.strictEqual((yield* Effect.flip(reconstructed.catchUp)).reason, "source_gap");
        assert.strictEqual((yield* Facts.readFacts(0)).length, 2);
        const state = yield* Facts.readState(Checkpoints.rootKey("thread-a"));
        assert.strictEqual(state!.sourceSequence, 1);
        const generation = (yield* sql<{
          readonly generation: string;
        }>`SELECT generation FROM agent_event_source_state`)[0]!.generation;
        assert.strictEqual(
          (yield* Effect.flip(service.rebootstrap({ generation: "stale", throughSequence: 1 })))
            .reason,
          "stale_recovery",
        );
        yield* commit([
          event("pending-after-gap", "runtime-request.updated", request),
          event("item-after-gap", "turn-item.updated", item),
        ]);
        const reset = yield* service.rebootstrap({ generation, throughSequence: 1 });
        assert.notStrictEqual(reset.generation, generation);
        assert.strictEqual(reset.bootstrapSequence, 5);
        const recovered = yield* Facts.readFacts(0);
        assert.deepEqual(recovered.slice(0, 2), facts);
        assert.deepEqual(
          recovered.slice(2).map((fact) => fact.kind),
          ["source_status", "approval"],
        );
        assert.strictEqual(recovered[3]!.sourceKind, "bootstrap");
        assert.strictEqual(recovered[3]!.originGeneration, reset.generation);
        assert.deepEqual(yield* service.catchUp, { throughSequence: 5, facts: 0 });
      }).pipe(Effect.provide(core)),
  );
});

it.effect.each(["soft-cap", "pending"] as const)(
  "retains whole source ordinals at a %s floor and rebuilds their historical bytes",
  (boundary) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* instance;
      yield* service.activate;
      yield* seed();
      yield* service.catchUp;
      yield* commit([
        event("lost-request", "runtime-request.updated", {
          ...request,
          responseCapability: { type: "not_resumable", reason: "provider gone" },
        }),
      ]);
      yield* service.catchUp;
      const facts = yield* Facts.readFacts(0);
      const latest = facts.at(-1)!;
      const siblings = facts.filter((row) => row.sourceSequence === latest.sourceSequence);
      assert.equal(siblings.length, 2);
      const actualHead = (yield* DeliveryStore.logState()).headSeq;
      // Both boundaries land on ordinal one of the same native source transition.
      if (boundary === "pending") {
        yield* DeliveryStore.upsertSubscription(
          {
            subscriptionId: "ordinal-client",
            principalId: "session:ordinal",
            sessionId: "ordinal",
            attributionSubject: "mcp-client:local",
            clientLabel: "Client",
            eventName: "t3.task_activity",
            argumentsJson: "{}",
            callbackUrl: "https://callback.invalid",
            secretRef: "fixture",
            previousSecretRef: null,
            previousSecretUntil: null,
            state: "active",
            expiresAt: 50 * 86_400_000,
            logEpoch: (yield* DeliveryStore.logState()).epoch,
            updatedAt: 0,
          },
          0,
        );
        yield* sql`INSERT INTO agent_event_deliveries(subscription_id,event_id,log_seq,state,queued_at,next_attempt_at)
        VALUES ('ordinal-client',${latest.eventId},${latest.logSeq},'pending',${yield* Clock.currentTimeMillis},${yield* Clock.currentTimeMillis})`;
      }
      yield* sql`UPDATE agent_event_log_state SET head_seq=${latest.logSeq + 50_000 - (boundary === "soft-cap" ? 1 : 0)}`;
      yield* Retention.pruneLog(yield* Clock.currentTimeMillis);
      assert.equal((yield* DeliveryStore.logState()).floorSeq, siblings[0]!.logSeq);
      // Restore the synthetic head after exercising the real soft-cap calculation.
      yield* sql`UPDATE agent_event_log_state SET head_seq=${actualHead}`;
      const retained = yield* Facts.readFacts(0);
      yield* service.rebuild;
      assert.deepEqual(yield* Facts.readFacts(0), retained);
    }).pipe(Effect.provide(core)),
);

it.effect(
  "rebuilds retained private pages from original pre-floor dependency receipts without recreating replay slots",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* instance;
      yield* TestClock.setTime(0);
      yield* service.activate;
      const sourceId = EventId.make("native:snapshot-source");
      const page: LanTaskObserveResult = {
        threadId: ThreadId.make("snapshot-thread"),
        sourceId,
        status: "ok",
        resetReason: null,
        events: [],
        nextCursor: { sourceId, sequence: 0 },
        headSequence: 0,
        hasMore: false,
        taskWorkState: "working",
        taskResultRunId: null,
        taskResultStatus: null,
      };
      const inputs = { controlsJson: "original private controls" };
      yield* CompatibilityFacts.captureWorkSnapshot(environment.id, page, inputs);
      yield* TestClock.setTime(30 * 86_400_000);
      const current = {
        ...page,
        events: [...page.events],
        headSequence: 1,
        nextCursor: { sourceId, sequence: 1 },
      };
      yield* CompatibilityFacts.captureWorkSnapshot(environment.id, current, inputs);
      yield* Retention.pruneLog(yield* Clock.currentTimeMillis);
      const before = yield* Facts.readFacts(0, 100, true);
      const occurrences = yield* sql`SELECT * FROM agent_event_occurrences ORDER BY log_seq`;
      const log = yield* DeliveryStore.logState();
      assert.isAbove(log.floorSeq, 1);
      const work = before.find((fact) => fact.kind === "gateway_work_snapshot")!;
      assert.deepEqual(yield* CompatibilityFacts.readWorkSnapshot(work.eventId), {
        inputs,
        page: current,
      });
      yield* service.rebuild;
      assert.deepEqual(yield* Facts.readFacts(0, 100, true), before);
      assert.deepEqual(
        yield* sql`SELECT * FROM agent_event_occurrences ORDER BY log_seq`,
        occurrences,
      );
      assert.equal((yield* DeliveryStore.logState()).headSeq, log.headSeq);
      assert.deepEqual(yield* CompatibilityFacts.readWorkSnapshot(work.eventId), {
        inputs,
        page: current,
      });
      const receipt = (yield* sql<{ id: string }>`SELECT event_id AS id FROM agent_event_occurrences
        WHERE source_kind='gateway' AND log_seq < ${log.floorSeq} LIMIT 1`)[0]!.id;
      for (const mutation of [
        sql`UPDATE agent_event_occurrences SET bootstrap_json='{}' WHERE event_id=${receipt}`,
        sql`DELETE FROM agent_event_occurrences WHERE event_id=${receipt}`,
      ]) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* mutation;
              assert.equal((yield* service.rebuild.pipe(Effect.flip)).reason, "replay_failed");
              assert.deepEqual(yield* Facts.readFacts(0, 100, true), before);
              return yield* Effect.fail("rollback" as const);
            }),
          )
          .pipe(
            Effect.catchIf(
              (error) => error === "rollback",
              () => Effect.void,
            ),
          );
      }
      process.stdout.write(
        JSON.stringify({
          proof: "gateway_fact_log",
          scenario: "retained_dependency_receipts_rebuild",
          floorAdvanced: true,
          originalManifestPreserved: true,
          belowFloorSlotsRecreated: false,
        }) + "\n",
      );
    }).pipe(Effect.provide(core)),
);
