import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestrationV2DomainEventJson,
  type AgentEventDeliveryBody,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as AgentEventAuthority from "./AgentEventAuthority.ts";
import * as Delivery from "./AgentEventDelivery.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as Store from "./AgentEventStore.ts";
import { subscribe } from "./AgentEventSubscriptions.ts";
import * as FactAuthority from "./AgentFactAuthority.ts";
import * as Facts from "./AgentFactStore.ts";
import {
  allowed,
  layerAuthority,
  layerFileDatabase,
  receiverTransport,
  StandardWebhook,
  startReceiver,
  testSecret,
} from "./AgentEvents.testkit.ts";
import { WebhookTransport } from "./WebhookSender.ts";

const at = "2026-01-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-a");
const secret = testSecret(11);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "client:fact-delivery-harness",
  thread: undefined,
  client: {
    sessionId: "session-a",
    label: "Fact delivery fixture",
    access: "approval-required",
    sharesOutside: true,
  },
};
const thread = (id: string, deletedAt: string | null = null) => ({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: "project-a",
  title: "Fact delivery fixture",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt,
});
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);

it.live(
  "delivers signed facts for every owner and stops queued facts on deletion or revocation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-fact-delivery-" });
      const receiver = yield* startReceiver();
      const verdicts = yield* Ref.make<ReadonlyMap<string, AgentEventAuthority.AuthorityVerdict>>(
        new Map([["session-a", allowed()]]),
      );
      const fixture = Layer.mergeAll(
        ProjectionStore.layer,
        ServerSecretStore.layer,
        layerAuthority(verdicts),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.succeed(WebhookTransport, receiverTransport(receiver.ca)),
        ServerSettings.layerTest({ agentEventsEnabled: true }),
      ).pipe(
        Layer.provideMerge(layerFileDatabase(path.join(directory, "state.sqlite"))),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), path.join(directory, "home"))),
      );
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const subscribed = yield* subscribe(scope, {
          name: "t3.task_activity",
          arguments: {},
          delivery: { mode: "webhook", url: `https://callback.test:${receiver.port}/t3`, secret },
          cursor: null,
        });
        const verification = yield* Queue.take(receiver.requests);
        new StandardWebhook(secret).verify(verification.body, verification.headers);
        assert.equal(JSON.parse(verification.body).type, "verification");
        const generation = yield* Journal.sourceGeneration();
        const owners = [
          { state: "assigned", id: "alex", label: "Alex" },
          { state: "assigned", id: "bailey", label: "Bailey" },
          { state: "unassigned", id: null, label: null },
          { state: "unknown", id: null, label: null },
        ];
        const fact = (sequence: number, owner = owners[0]!): Facts.FactData => ({
          schema: "t3.agent-event/1",
          kind: "approval",
          factKey: `attention:${sequence}`,
          summary: "Permission request needs attention",
          textIsUntrusted: true,
          environment: { id: environmentId, label: "Machine A" },
          thread: { id: `thread-${sequence}`, delegated: false },
          run: { id: `run-${sequence}` },
          owner,
          origin: {
            environmentId,
            sourceGeneration: generation,
            sourceKind: "orchestration",
            sourceSequence: sequence,
            transitionOrdinal: 0,
            threadSequence: sequence,
            occurredAt: at,
          },
          relay: null,
          detail: { requestId: `request-${sequence}` },
        });
        const append = Effect.fn("factDeliveryHarness.append")(function* (
          sequence: number,
          owner = owners[0]!,
        ) {
          yield* projections.apply(
            decodeEvent({
              id: `create-${sequence}`,
              threadId: `thread-${sequence}`,
              type: "thread.created",
              occurredAt: at,
              payload: { ...thread(`thread-${sequence}`), ownerId: owner.id },
            }),
          );
          const data = fact(sequence, owner);
          const row = yield* Facts.appendFact({ data, recordedAt: yield* Clock.currentTimeMillis });
          return { row, data };
        });
        const deliver = Effect.fn("factDeliveryHarness.deliver")(function* (eventId: string) {
          const claims = yield* Store.claimDue(yield* Clock.currentTimeMillis, 4);
          assert.equal(claims.length, 1);
          assert.equal(claims[0]!.eventId, eventId);
          return yield* Delivery.attempt(claims[0]!);
        });
        const proof = [];
        for (const [index, owner] of owners.entries()) {
          const { row, data } = yield* append(index + 1, owner);
          assert.equal(yield* deliver(row.eventId), "delivered");
          const received = yield* Queue.take(receiver.requests);
          new StandardWebhook(secret).verify(received.body, received.headers);
          const body = JSON.parse(received.body) as AgentEventDeliveryBody;
          assert.equal(received.headers["webhook-id"], row.eventId);
          assert.equal(body.eventId, row.eventId);
          assert.equal(body.name, "t3.task_activity");
          assert.equal(body.timestamp, at);
          assert.deepEqual(body.data, data);
          assert.equal((yield* Store.findDelivery(subscribed.id, row.eventId))!.state, "delivered");
          proof.push({ eventId: row.eventId, logSequence: row.logSeq, owner: body.data.owner });
        }
        const deleted = yield* append(5);
        yield* projections.apply(
          decodeEvent({
            id: "delete-5",
            threadId: "thread-5",
            type: "thread.deleted",
            occurredAt: at,
            payload: thread("thread-5", at),
          }),
        );
        assert.equal(yield* deliver(deleted.row.eventId), "abandoned");
        assert.equal(
          (yield* Store.findDelivery(subscribed.id, deleted.row.eventId))!.lastError,
          "thread_unreadable",
        );
        const revoked = yield* append(6);
        yield* Ref.set(
          verdicts,
          new Map([["session-a", { _tag: "Refused", reason: "outside_sharing_refused" }]]),
        );
        assert.equal(yield* deliver(revoked.row.eventId), "revoked");
        assert.equal((yield* Store.findSubscription(subscribed.id))!.state, "revoked");
        assert.equal(receiver.received.length, owners.length + 1);
        yield* Console.log(
          JSON.stringify({
            proof: "signed-catalog-all-owners",
            subscriptionId: subscribed.id,
            verifiedWith: "standardwebhooks",
            delivered: proof,
            queuedDeletion: deleted.row.eventId,
            queuedRevocation: revoked.row.eventId,
            unintendedPosts: 0,
          }),
        );
      }).pipe(Effect.provide(FactAuthority.layer.pipe(Layer.provideMerge(fixture))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
