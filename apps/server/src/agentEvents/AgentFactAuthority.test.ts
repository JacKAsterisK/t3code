import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, OrchestrationV2DomainEventJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { layerDatabase } from "./AgentEvents.testkit.ts";
import * as Journal from "./AgentEventOwnerJournal.ts";
import * as Authority from "./AgentFactAuthority.ts";

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
const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const fixture = Layer.mergeAll(
  ProjectionStore.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
  }),
).pipe(Layer.provideMerge(layerDatabase));
const services = Authority.layer.pipe(Layer.provideMerge(fixture));
const input = {
  sessionId: "session-a",
  eventId: "fact-a",
  attributionSubject: "mcp-client:local",
  originEnvironmentId: "environment-a",
  originGeneration: "missing",
  threadId: "thread-a",
  relayedFrom: null,
};

describe("AgentFactAuthority", () => {
  it.effect(
    "checks current thread readability without using historical or current owner labels",
    () =>
      Effect.gen(function* () {
        const authority = yield* Authority.AgentFactAuthority;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const generation = yield* Journal.sourceGeneration();
        const current = { ...input, originGeneration: generation };
        for (const ownerId of ["dan", "gavin", null]) {
          yield* projection.apply(
            decode({
              id: `owner-${ownerId}`,
              threadId: "thread-a",
              type: "thread.owner-set",
              occurredAt: at,
              payload: { ...thread, ownerId },
            }),
          );
          assert.deepEqual(yield* authority.check(current), { _tag: "Allowed" });
        }
        yield* projection.apply(
          decode({
            id: "deleted",
            threadId: "thread-a",
            type: "thread.deleted",
            occurredAt: at,
            payload: { ...thread, deletedAt: at },
          }),
        );
        assert.deepEqual(yield* authority.check(current), {
          _tag: "Refused",
          reason: "thread_unreadable",
        });
        assert.deepEqual(yield* authority.check({ ...current, threadId: "missing" }), {
          _tag: "Refused",
          reason: "thread_unreadable",
        });
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "refuses source replacement and waits for origin proof instead of trusting cached imports",
    () =>
      Effect.gen(function* () {
        const authority = yield* Authority.AgentFactAuthority;
        assert.deepEqual(yield* authority.check(input), { _tag: "Unavailable" });
        const generation = yield* Journal.sourceGeneration();
        assert.deepEqual(yield* authority.check(input), {
          _tag: "Refused",
          reason: "source_changed",
        });
        const current = { ...input, originGeneration: generation, threadId: null };
        assert.deepEqual(yield* authority.check(current), { _tag: "Allowed" });
        assert.deepEqual(
          yield* authority.check({ ...current, originEnvironmentId: "environment-b" }),
          { _tag: "Unavailable" },
        );
        assert.deepEqual(yield* authority.check({ ...current, relayedFrom: "environment-b" }), {
          _tag: "Unavailable",
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE agent_event_source_state`;
        assert.deepEqual(yield* authority.check(current), { _tag: "Unavailable" });
      }).pipe(Effect.provide(services)),
  );
});
