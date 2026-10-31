import { ThreadId, type AgentFactRelayRefusal } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Relay from "./AgentFactRelay.ts";
import type { RelayAuthorityProof } from "./AgentFactRelayAdmission.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export type FactAuthorityVerdict =
  | { readonly _tag: "Allowed"; readonly relayProof?: RelayAuthorityProof }
  | { readonly _tag: "Refused"; readonly reason: AgentFactRelayRefusal }
  | { readonly _tag: "Unavailable" };

/** Current per-fact readability is independent of the owner label recorded in an old payload. */
export class AgentFactAuthority extends Context.Service<
  AgentFactAuthority,
  {
    readonly check: (input: {
      readonly sessionId: string;
      readonly eventId: string;
      readonly attributionSubject: string;
      readonly originEnvironmentId: string;
      readonly originGeneration: string | null;
      readonly threadId: string | null;
      readonly relayedFrom: string | null;
    }) => Effect.Effect<FactAuthorityVerdict>;
  }
>()("t3/agentEvents/AgentFactAuthority") {}

const make = Effect.gen(function* () {
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const relay = yield* Effect.serviceOption(Relay.AgentFactRelay);
  const check: AgentFactAuthority["Service"]["check"] = Effect.fn("AgentFactAuthority.check")(
    function* (input) {
      if (input.relayedFrom !== null || input.originEnvironmentId !== environmentId) {
        if (input.relayedFrom !== input.originEnvironmentId || Option.isNone(relay))
          return { _tag: "Unavailable" } as const;
        const proof = yield* relay.value.checkCached({
          sessionId: input.sessionId,
          attributionSubject: input.attributionSubject,
          eventId: input.eventId,
        });
        if (proof.decision.verdict === "refused")
          return { _tag: "Refused", reason: proof.decision.reason } as const;
        if (
          proof.decision.verdict !== "allowed" ||
          proof.checkedAt === null ||
          proof.authorizationGeneration === null ||
          proof.originAuthorizationGeneration === null
        )
          return { _tag: "Unavailable" } as const;
        return {
          _tag: "Allowed",
          relayProof: {
            checkedAt: proof.checkedAt,
            authorizationGeneration: proof.authorizationGeneration,
            originAuthorizationGeneration: proof.originAuthorizationGeneration,
          },
        } as const;
      }
      const current = (yield* sql<{ readonly generation: string }>`
        SELECT generation FROM agent_event_source_state WHERE id = 1`)[0];
      if (current === undefined) return { _tag: "Unavailable" } as const;
      if (current.generation !== input.originGeneration)
        return { _tag: "Refused", reason: "source_changed" } as const;
      if (input.threadId === null) return { _tag: "Allowed" } as const;
      const records = yield* projections.getThreadRecords(ThreadId.make(input.threadId), []);
      return records.thread.deletedAt === null
        ? ({ _tag: "Allowed" } as const)
        : ({ _tag: "Refused", reason: "thread_unreadable" } as const);
    },
    Effect.catchTags({
      ProjectionStoreThreadNotFoundError: () =>
        Effect.succeed({ _tag: "Refused", reason: "thread_unreadable" } as const),
    }),
    Effect.catchCause(() => Effect.succeed({ _tag: "Unavailable" } as const)),
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  return AgentFactAuthority.of({ check });
});

export const layer = Layer.effect(AgentFactAuthority, make);
