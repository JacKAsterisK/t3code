import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  LanTaskObserveResult,
  LanTaskObservation,
  OrchestratorMcpFailure,
  RuntimeRequestId,
  type LanRoutingConfig,
  type LanEnvironmentRoute,
  type LanTaskLaunchInput,
  type OrchestratorMcpThreadReadResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Environment from "../environment/ServerEnvironment.ts";
import type * as Invocation from "../mcp/McpInvocationContext.ts";
import Migration from "../persistence/Migrations/069_LanRouting.ts";
import GenerationMigration from "../persistence/Migrations/071_LanObservationGenerations.ts";
import * as Registry from "./EnvironmentRegistry.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as Routing from "./EnvironmentRouting.ts";
import * as Native from "./NativeTaskService.ts";
import * as Remote from "./RemoteTaskTransport.ts";
import * as Store from "./RoutingStore.ts";
const decodeArguments = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(LanTaskObservation));
const decodeObservedDelivery = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...LanTaskObserveResult.fields,
    delivery: Schema.Struct({ events: Schema.Array(Schema.Unknown), wakeDelivery: Schema.String }),
  }),
);

const environmentId = EnvironmentId.make("environment:local");
const remoteId = EnvironmentId.make("environment:remote");
const threadId = ThreadId.make("thread:native");
const projectId = ProjectId.make("project:approved");
const sourceId = EventId.make("event:created");
const eventId = EventId.make("event:finished");
const runId = RunId.make("run:native");
const scope = (sessionId = "session:one"): Invocation.McpInvocationScope => ({
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: { sessionId, grantId: "approved", taskOnly: true, label: "dot", access: "auto" },
});
const config = (remote = false): LanRoutingConfig => ({
  version: 1,
  environments: [
    {
      environmentId: remote ? remoteId : environmentId,
      label: "approved",
      origin: remote ? "https://target.example" : null,
      credentialRef: remote ? "enrolled" : null,
      enabled: true,
      protocolVersion: 2,
      routingVersion: 1,
      runtimeCeiling: "full-access",
      models: [launch.modelSelection],
    },
  ],
  grants: [
    {
      principalId: "grant:approved",
      environmentId: remote ? remoteId : environmentId,
      enabled: true,
      projectIds: [projectId],
      threadIds: [threadId],
      allowLaunch: true,
      allowOperate: true,
      runtimeCeiling: "auto",
    },
  ],
});
const launch: LanTaskLaunchInput = {
  projectId,
  title: "Native task",
  message: "Mock work",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  runtimeMode: "auto",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  clientRequestId: "request:launch",
};
const launched = {
  threadId,
  projectId,
  modelSelection: launch.modelSelection,
  runId,
  status: "running" as const,
};
const metadata: OrchestratorMcpThreadReadResult = {
  thread: {
    threadId,
    projectId,
    title: "Native task",
    createdBy: "agent",
    creationSource: "mcp",
    status: "running",
    latestRunId: runId,
    activeRunId: runId,
    providerInstanceId: launch.modelSelection.instanceId,
    model: "model",
    runtimeMode: "auto",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 1,
    itemCount: 0,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: null,
  hasMore: false,
};
const page: typeof LanTaskObserveResult.Type = {
  taskWorkState: "result_available",
  taskResultRunId: runId,
  taskResultStatus: "completed",
  threadId,
  sourceId,
  status: "ok",
  resetReason: null,
  events: [
    { eventId, sequence: 7, kind: "run_terminal", runId, requestId: null, status: "completed" },
  ],
  nextCursor: { sourceId, sequence: 7, anchorEventId: eventId },
  headSequence: 7,
  hasMore: false,
};
const fail = () =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: "Mock connection lost." });

function layer(
  options: {
    readonly config?: Effect.Effect<LanRoutingConfig>;
    readonly remote?: Remote.RemoteTaskTransport["Service"]["call"];
    readonly read?: Native.NativeTaskService["Service"]["read"];
    readonly observe?: Native.NativeTaskService["Service"]["observe"];
    readonly fleetAccess?: "read-only" | "standard";
    // This machine, whatever its own level, is standard on the fleet machine behind `remoteId`.
    readonly standardOnRemote?: boolean;
  } = {},
) {
  const database = Layer.effectDiscard(Migration.pipe(Effect.andThen(GenerationMigration))).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const services = Layer.mergeAll(
    Store.layer.pipe(Layer.provide(database), Layer.provide(NodeCrypto.layer)),
    Layer.succeed(Registry.EnvironmentRegistry, {
      read: options.config ?? Effect.succeed(config()),
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId,
        label: "local",
        platform: { os: "windows", arch: "x64" },
        serverVersion: "test",
        orchestrationProtocolVersion: 2,
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(Native.NativeTaskService)({
      launch: () => Effect.succeed(launched),
      read: options.read ?? (() => Effect.succeed(metadata)),
      observe: options.observe ?? (() => Effect.succeed(page)),
    }),
    Layer.mock(Remote.RemoteTaskTransport)({ call: options.remote ?? (() => Effect.fail(fail())) }),
    Layer.mock(FleetAccessPolicy.FleetAccess)({
      current: Effect.succeed({
        revision: 1,
        defaultAccess: options.fleetAccess ?? "standard",
        machines: [],
        pairs: options.standardOnRemote
          ? [FleetAccessPolicy.pairEntryId("machine-self", "machine-remote")]
          : [],
        machineId: "machine-self",
        peers: [{ machineId: "machine-remote", environmentId: remoteId }],
      }),
    }),
  );
  return Routing.layer.pipe(Layer.provideMerge(services));
}

it.effect(
  "lets a read-only fleet machine change tasks only on the machines it is standard on",
  () =>
    Effect.gen(function* () {
      const attempt = (standardOnRemote: boolean) =>
        Routing.EnvironmentRouting.pipe(
          Effect.flatMap((router) =>
            router.launch(scope(), { ...launch, environmentId: remoteId }),
          ),
          Effect.flip,
          Effect.provide(
            layer({
              config: Effect.succeed(config(true)),
              fleetAccess: "read-only",
              standardOnRemote,
            }),
          ),
        );
      assert.equal((yield* attempt(false)).code, "capability_denied");
      // Past the read-only gate, it reaches the transport, which this test leaves unreachable.
      assert.equal((yield* attempt(true)).code, "orchestration_error");
    }),
);

it.effect(
  "denies provider tokens, read-only writes, unknown machines and unapproved transcripts",
  () =>
    Effect.gen(function* () {
      const router = yield* Routing.EnvironmentRouting;
      const provider: Invocation.McpInvocationScope = {
        ...scope(),
        client: undefined,
        thread: {
          threadId,
          providerInstanceId: launch.modelSelection.instanceId,
          providerSessionId: "provider",
        },
      };
      assert.equal(
        (yield* router.environments(provider).pipe(Effect.flip)).code,
        "capability_denied",
      );
      // An in-app thread is refused even with an approved client session and grant, so hiding the
      // LAN task tools from threads takes no reach away.
      const inThread = { ...scope(), thread: provider.thread };
      assert.equal(
        (yield* router.environments(inThread).pipe(Effect.flip)).code,
        "capability_denied",
      );
      assert.equal(
        (yield* router.launch(inThread, { ...launch, environmentId }).pipe(Effect.flip)).code,
        "capability_denied",
      );
      assert.equal(
        (yield* router.list(inThread, { environmentId, projectId }).pipe(Effect.flip)).code,
        "capability_denied",
      );
      const readOnly = { ...scope(), client: { ...scope().client!, access: "read-only" as const } };
      assert.equal(
        (yield* router.launch(readOnly, { ...launch, environmentId }).pipe(Effect.flip)).code,
        "capability_denied",
      );
      assert.equal(
        (yield* router.launch(scope(), { ...launch, environmentId: remoteId }).pipe(Effect.flip))
          .code,
        "capability_denied",
      );
      assert.equal(
        (yield* router
          .read(scope(), { environmentId, threadId: ThreadId.make("human:private") })
          .pipe(Effect.flip)).code,
        "capability_denied",
      );
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "returns native IDs and keeps task ownership across a renewed authenticated session",
  () =>
    Effect.gen(function* () {
      const router = yield* Routing.EnvironmentRouting;
      const store = yield* Store.RoutingStore;
      const result = yield* router.launch(scope(), { ...launch, environmentId });
      assert.deepEqual(result.result, launched);
      assert.deepEqual(yield* store.owned("grant:approved", environmentId), [threadId]);
      const second = yield* router.read(scope("session:renewed"), { environmentId, threadId });
      assert.deepEqual(second.result, metadata);
      assert.deepEqual(yield* store.owned("grant:different", environmentId), []);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "refuses a read-only fleet machine's launch, send, interrupt and respond on another machine but lets it list, read and observe",
  () =>
    Effect.gen(function* () {
      const tools = yield* Ref.make<Array<string>>([]);
      const remote = (_route: LanEnvironmentRoute, tool: string) =>
        Ref.update(tools, (items) => [...items, tool]).pipe(
          Effect.as({
            environmentId: remoteId,
            result:
              tool === "t3_lan_task_list"
                ? { projectId, currentThreadId: null, threads: [], nextCursor: null, total: 0 }
                : tool === "t3_lan_task_observe"
                  ? page
                  : metadata,
          }),
        );
      yield* Effect.gen(function* () {
        const router = yield* Routing.EnvironmentRouting;
        const target = { environmentId: remoteId, threadId };
        for (const refused of [
          router.launch(scope(), { ...launch, environmentId: remoteId }),
          router.send(scope(), { ...target, message: "Continue" }),
          router.interrupt(scope(), target),
          router.respond(scope(), {
            ...target,
            requestId: RuntimeRequestId.make("request:question"),
            clientRequestId: "request:answer",
            answers: {},
          }),
        ]) {
          const error = yield* refused.pipe(Effect.flip);
          assert.equal(error.code, "capability_denied");
          assert.match(error.message, /read-only access to the other fleet machines/u);
        }
        assert.deepEqual(yield* Ref.get(tools), []);
        yield* router.list(scope(), { environmentId: remoteId, projectId });
        yield* router.read(scope(), target);
        yield* router.observe(scope(), target);
        assert.includeMembers(yield* Ref.get(tools), [
          "t3_lan_task_list",
          "t3_lan_task_read",
          "t3_lan_task_observe",
        ]);
      }).pipe(
        Effect.provide(
          layer({ config: Effect.succeed(config(true)), remote, fleetAccess: "read-only" }),
        ),
      );
    }),
);

it.effect("fails remote operations without creating a local fallback task", () =>
  Effect.gen(function* () {
    const router = yield* Routing.EnvironmentRouting;
    const error = yield* router
      .launch(scope(), { ...launch, environmentId: remoteId })
      .pipe(Effect.flip);
    assert.equal(error.code, "orchestration_error");
    const store = yield* Store.RoutingStore;
    assert.deepEqual(yield* store.owned("grant:approved", remoteId), []);
  }).pipe(Effect.provide(layer({ config: Effect.succeed(config(true)) }))),
);

it.effect(
  "replays from the source after a destination commits but its first response is lost",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<Record<string, unknown>>>([]);
      const remote = Effect.fn("test.remote")(function* (
        _route: LanEnvironmentRoute,
        tool: string,
        input: unknown,
      ) {
        if (tool === "t3_lan_task_read") return { environmentId: remoteId, result: metadata };
        if (tool === "t3_lan_events_ack")
          return { environmentId: remoteId, result: { acknowledged: true } };
        const args = yield* decodeArguments(input).pipe(Effect.mapError(fail));
        yield* Ref.update(calls, (items) => [...items, args]);
        if ((yield* Ref.get(calls)).length === 1) return yield* fail();
        assert.equal(args.replayFromStart, true);
        return { environmentId: remoteId, result: page };
      });
      yield* Effect.gen(function* () {
        const router = yield* Routing.EnvironmentRouting;
        yield* router.observe(scope(), { environmentId: remoteId, threadId }).pipe(Effect.flip);
        const retry = yield* router.observe(scope("session:renewed"), {
          environmentId: remoteId,
          threadId,
        });
        const result = yield* decodeObservedDelivery(retry.result);
        assert.equal(result.delivery.events.length, 1);
        assert.equal(result.delivery.wakeDelivery, "unsupported");
        const store = yield* Store.RoutingStore;
        assert.deepEqual(
          yield* store.cursor("grant:approved", remoteId, threadId),
          page.nextCursor,
        );
        assert.equal((yield* store.pending("grant:approved", remoteId, threadId)).length, 1);
        yield* router.acknowledge(scope(), {
          environmentId: remoteId,
          threadId,
          sourceId,
          eventIds: [eventId],
        });
        assert.equal((yield* store.pending("grant:approved", remoteId, threadId)).length, 0);
      }).pipe(Effect.provide(layer({ config: Effect.succeed(config(true)), remote })));
    }),
);

it.effect("deduplicates replay, scopes acknowledgements and refuses invalid checkpoints", () =>
  Effect.gen(function* () {
    const store = yield* Store.RoutingStore;
    yield* store.ingest("grant:approved", environmentId, page, { expectedDeliverySourceId: null });
    yield* store.ingest("grant:approved", environmentId, page, {
      expectedDeliverySourceId: sourceId,
    });
    assert.equal((yield* store.pending("grant:approved", environmentId, threadId)).length, 1);
    yield* store.acknowledge("grant:other", environmentId, threadId, [eventId], sourceId);
    assert.equal((yield* store.pending("grant:approved", environmentId, threadId)).length, 1);
    yield* store
      .ingest(
        "grant:approved",
        environmentId,
        { ...page, nextCursor: { sourceId, sequence: 100 } },
        { expectedDeliverySourceId: sourceId },
      )
      .pipe(Effect.flip);
    assert.deepEqual(
      yield* store.cursor("grant:approved", environmentId, threadId),
      page.nextCursor,
    );
    yield* store.acknowledge("grant:approved", environmentId, threadId, [eventId], sourceId);
    yield* store.ingest("grant:approved", environmentId, page, {
      expectedDeliverySourceId: sourceId,
    });
    assert.equal((yield* store.pending("grant:approved", environmentId, threadId)).length, 0);
  }).pipe(Effect.provide(layer())),
);

it.effect("keeps acknowledgements inside the observed source generation", () =>
  Effect.gen(function* () {
    const store = yield* Store.RoutingStore;
    yield* store.ingest("grant:approved", environmentId, page, { expectedDeliverySourceId: null });
    const restoredSource = EventId.make("source:restored");
    const restoredDelivery = yield* store.ingest(
      "grant:approved",
      environmentId,
      {
        ...page,
        sourceId: restoredSource,
        nextCursor: { ...page.nextCursor, sourceId: restoredSource },
      },
      { reset: true, expectedDeliverySourceId: sourceId },
    );
    yield* store.acknowledge("grant:approved", environmentId, threadId, [eventId], sourceId);
    assert.equal((yield* store.pending("grant:approved", environmentId, threadId)).length, 1);
    yield* store.acknowledge(
      "grant:approved",
      environmentId,
      threadId,
      [eventId],
      restoredDelivery,
    );
    assert.equal((yield* store.pending("grant:approved", environmentId, threadId)).length, 0);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "isolates replay after restored history retains thread creation and reuses an event ID",
  () =>
    Effect.gen(function* () {
      const future = {
        ...page.events[0]!,
        eventId: EventId.make("event:removed-future"),
        sequence: 9,
      };
      const current = yield* Ref.make<typeof LanTaskObserveResult.Type>({
        ...page,
        events: [...page.events, future],
        nextCursor: { sourceId, sequence: 9, anchorEventId: future.eventId },
        headSequence: 9,
      });
      const requests = yield* Ref.make<
        Array<Parameters<Native.NativeTaskService["Service"]["observe"]>[1]>
      >([]);
      yield* Effect.gen(function* () {
        const router = yield* Routing.EnvironmentRouting;
        const first = yield* router.observe(scope(), { environmentId, threadId });
        const previous = yield* decodeObservedDelivery(first.result);
        yield* Ref.set(current, {
          ...page,
          status: "reset_required",
          resetReason: "source_changed",
          events: [],
          nextCursor: { sourceId, sequence: 0 },
          headSequence: 4,
        });
        const reset = yield* router.observe(scope(), { environmentId, threadId });
        assert.equal((yield* decodeObservedDelivery(reset.result)).status, "reset_required");
        const restored = {
          ...page,
          taskWorkState: "working" as const,
          taskResultRunId: null,
          taskResultStatus: null,
          events: [
            {
              ...page.events[0]!,
              sequence: 4,
              kind: "run_state" as const,
              status: "running" as const,
            },
          ],
          nextCursor: { sourceId, sequence: 4, anchorEventId: eventId },
          headSequence: 4,
        };
        yield* Ref.set(current, restored);
        const replay = yield* router.observe(scope(), {
          environmentId,
          threadId,
          replayFromStart: true,
          after: previous.nextCursor,
        });
        const delivered = yield* decodeObservedDelivery(replay.result);
        assert.notEqual(delivered.sourceId, previous.sourceId);
        assert.equal(delivered.nextCursor.sourceId, delivered.sourceId);
        assert.deepEqual(delivered.delivery.events, restored.events);
        assert.equal((yield* Ref.get(requests)).at(-1)?.after, undefined);
        const obsolete = yield* router
          .observe(scope(), {
            environmentId,
            threadId,
            after: previous.nextCursor,
          })
          .pipe(Effect.flip);
        assert.equal(obsolete.code, "invalid_request");
        yield* router.acknowledge(scope(), {
          environmentId,
          threadId,
          sourceId: previous.sourceId,
          eventIds: [eventId],
        });
        const repeated = yield* router.observe(scope(), {
          environmentId,
          threadId,
          after: delivered.nextCursor,
        });
        assert.equal((yield* Ref.get(requests)).at(-1)?.after?.sourceId, sourceId);
        assert.deepEqual(
          (yield* decodeObservedDelivery(repeated.result)).delivery.events,
          restored.events,
        );
        yield* router.acknowledge(scope(), {
          environmentId,
          threadId,
          sourceId: delivered.sourceId,
          eventIds: [eventId],
        });
        const store = yield* Store.RoutingStore;
        assert.deepEqual(yield* store.pending("grant:approved", environmentId, threadId), []);
      }).pipe(
        Effect.provide(
          layer({
            observe: (_scope, input) =>
              Ref.update(requests, (items) => [...items, input]).pipe(
                Effect.andThen(Ref.get(current)),
              ),
          }),
        ),
      );
    }),
);

it.effect("refuses an in-flight old generation after replay without relabeling its facts", () =>
  Effect.gen(function* () {
    const store = yield* Store.RoutingStore;
    yield* store.ingest("grant:approved", environmentId, page, { expectedDeliverySourceId: null });
    const restored = {
      ...page,
      events: [],
      nextCursor: { sourceId, sequence: 2 },
      headSequence: 2,
    };
    const deliverySourceId = yield* store.ingest("grant:approved", environmentId, restored, {
      reset: true,
      expectedDeliverySourceId: sourceId,
    });
    const stale = yield* store
      .ingest("grant:approved", environmentId, page, {
        expectedDeliverySourceId: sourceId,
      })
      .pipe(Effect.flip);
    assert.equal(stale.code, "orchestration_error");
    assert.equal(
      (yield* store.checkpoint("grant:approved", environmentId, threadId))?.deliverySourceId,
      deliverySourceId,
    );
    assert.deepEqual(
      yield* store.cursor("grant:approved", environmentId, threadId),
      restored.nextCursor,
    );
    assert.deepEqual(yield* store.pending("grant:approved", environmentId, threadId), []);
    yield* store.pending("grant:approved", environmentId, threadId, sourceId).pipe(Effect.flip);
  }).pipe(Effect.provide(layer())),
);

it.effect("migrates existing checkpoints without discarding any inbox generation", () => {
  const database = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Migration;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO lan_observation_cursors
        (principal_id, environment_id, thread_id, source_id, sequence, anchor_event_id)
        VALUES ('grant:approved', ${environmentId}, ${threadId}, ${sourceId}, 7, ${eventId})`;
      const encoded = yield* encodeObservation(page.events[0]!);
      yield* sql`INSERT INTO lan_observation_inbox
        (principal_id, environment_id, thread_id, source_id, event_id, sequence, event_json)
        VALUES ('grant:approved', ${environmentId}, ${threadId}, ${sourceId}, ${eventId}, 7, ${encoded})`;
      yield* GenerationMigration;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
  return Effect.gen(function* () {
    const store = yield* Store.RoutingStore;
    assert.deepEqual(yield* store.checkpoint("grant:approved", environmentId, threadId), {
      cursor: page.nextCursor,
      deliverySourceId: sourceId,
    });
    assert.deepEqual(yield* store.pending("grant:approved", environmentId, threadId), page.events);
    const generation = yield* store.ingest("grant:approved", environmentId, page, {
      reset: true,
      expectedDeliverySourceId: sourceId,
    });
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      source_id: string;
      acknowledged: number;
    }>`SELECT source_id, acknowledged FROM lan_observation_inbox ORDER BY source_id`;
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.source_id)), new Set([sourceId, generation]));
    assert.equal(
      rows.every((row) => row.acknowledged === 0),
      true,
    );
  }).pipe(
    Effect.provide(Store.layer.pipe(Layer.provideMerge(database), Layer.provide(NodeCrypto.layer))),
  );
});

it.effect("keeps downstream acknowledgements and cursors in the destination generation", () =>
  Effect.gen(function* () {
    const acknowledgements = yield* Ref.make<Array<Record<string, unknown>>>([]);
    const cursors = yield* Ref.make<Array<unknown>>([]);
    const remote = Effect.fn("test.generationRemote")(function* (
      _route: LanEnvironmentRoute,
      tool: string,
      input: unknown,
    ) {
      if (tool === "t3_lan_task_read") return { environmentId: remoteId, result: metadata };
      const args = yield* decodeArguments(input).pipe(Effect.mapError(fail));
      if (tool === "t3_lan_events_ack") {
        yield* Ref.update(acknowledgements, (items) => [...items, args]);
        return { environmentId: remoteId, result: { acknowledged: true } };
      }
      yield* Ref.update(cursors, (items) => [...items, args.after]);
      return { environmentId: remoteId, result: page };
    });
    yield* Effect.gen(function* () {
      const router = yield* Routing.EnvironmentRouting;
      const observed = yield* router.observe(scope(), {
        environmentId: remoteId,
        threadId,
        replayFromStart: true,
      });
      const delivered = yield* decodeObservedDelivery(observed.result);
      assert.notEqual(delivered.sourceId, sourceId);
      assert.equal((yield* Ref.get(acknowledgements))[0]?.sourceId, sourceId);
      yield* router.observe(scope(), {
        environmentId: remoteId,
        threadId,
        after: delivered.nextCursor,
      });
      assert.deepEqual((yield* Ref.get(cursors))[1], page.nextCursor);
      yield* router.acknowledge(scope(), {
        environmentId: remoteId,
        threadId,
        sourceId,
        eventIds: [eventId],
      });
      const store = yield* Store.RoutingStore;
      assert.deepEqual(yield* store.pending("grant:approved", remoteId, threadId), page.events);
      yield* router.acknowledge(scope(), {
        environmentId: remoteId,
        threadId,
        sourceId: delivered.sourceId,
        eventIds: [eventId],
      });
      assert.deepEqual(yield* store.pending("grant:approved", remoteId, threadId), []);
    }).pipe(Effect.provide(layer({ config: Effect.succeed(config(true)), remote })));
  }),
);

it.effect("rechecks a revoked grant after metadata awaits before dispatch", () =>
  Effect.gen(function* () {
    const policy = yield* Ref.make(config());
    yield* Effect.gen(function* () {
      const router = yield* Routing.EnvironmentRouting;
      const error = yield* router
        .send(scope(), {
          environmentId,
          threadId,
          message: "must not dispatch",
          clientRequestId: "message",
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "capability_denied");
    }).pipe(
      Effect.provide(
        layer({
          config: Ref.get(policy),
          read: () => Ref.set(policy, { ...config(), grants: [] }).pipe(Effect.as(metadata)),
        }),
      ),
    );
  }),
);

it.effect("reports and drains a durable delivery backlog beyond one event page", () =>
  Effect.gen(function* () {
    const store = yield* Store.RoutingStore;
    const events = Array.from({ length: 101 }, (_, index) => ({
      ...page.events[0]!,
      eventId: EventId.make(`event:backlog:${index}`),
      sequence: index + 1,
    }));
    yield* store.ingest(
      "grant:approved",
      environmentId,
      {
        ...page,
        events: events.slice(0, 100),
        headSequence: 101,
        nextCursor: { sourceId, sequence: 100 },
        hasMore: true,
      },
      { expectedDeliverySourceId: null },
    );
    yield* store.ingest(
      "grant:approved",
      environmentId,
      {
        ...page,
        events: events.slice(100),
        headSequence: 101,
        nextCursor: { sourceId, sequence: 101 },
      },
      { expectedDeliverySourceId: sourceId },
    );
    const router = yield* Routing.EnvironmentRouting;
    const decode = Schema.decodeUnknownEffect(
      Schema.Struct({
        delivery: Schema.Struct({
          events: Schema.Array(Schema.Struct({ eventId: EventId })),
          hasMore: Schema.Boolean,
        }),
      }),
    );
    const first = yield* decode(
      (yield* router.observe(scope(), { environmentId, threadId })).result,
    );
    assert.equal(first.delivery.events.length, 100);
    assert.equal(first.delivery.hasMore, true);
    yield* router.acknowledge(scope(), {
      environmentId,
      threadId,
      sourceId,
      eventIds: first.delivery.events.map((event) => event.eventId),
    });
    const last = yield* decode(
      (yield* router.observe(scope(), { environmentId, threadId })).result,
    );
    assert.equal(last.delivery.events.length, 1);
    assert.equal(last.delivery.hasMore, false);
  }).pipe(
    Effect.provide(
      layer({
        observe: () =>
          Effect.succeed({
            ...page,
            events: [],
            nextCursor: { sourceId, sequence: 101 },
            headSequence: 101,
          }),
      }),
    ),
  ),
);
