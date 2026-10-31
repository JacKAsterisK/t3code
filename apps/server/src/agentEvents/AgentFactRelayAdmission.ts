import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Access from "./AgentFactRelayAccess.ts";

export interface RelayAuthorityProof {
  readonly checkedAt: string;
  readonly originAuthorizationGeneration: string;
  readonly authorizationGeneration: string;
}
export class AgentFactRelayAdmission extends Context.Service<
  AgentFactRelayAdmission,
  {
    readonly record: (input: {
      readonly subscriptionId: string;
      readonly eventId: string;
      readonly originEnvironmentId: string;
      readonly sessionId: string;
      readonly attributionSubject: string;
      readonly phase: "prepare" | "dispatch";
      readonly proof: RelayAuthorityProof;
    }) => Effect.Effect<boolean>;
  }
>()("t3/agentEvents/AgentFactRelayAdmission") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* Access.AgentFactRelayAccess;
  const record = Effect.fn("AgentFactRelayAdmission.record")(
    function* (input: Parameters<AgentFactRelayAdmission["Service"]["record"]>[0]) {
      const requester = yield* access.requester({
        sessionId: input.sessionId,
        attributionSubject: input.attributionSubject,
        environmentId: input.originEnvironmentId,
      });
      if (
        requester.verdict !== "allowed" ||
        requester.authorization.generation !== input.proof.authorizationGeneration
      )
        return false;
      const cursor = (yield* sql<{
        authorization_generation: string | null;
        status: string;
      }>`SELECT authorization_generation, status
        FROM agent_event_peer_cursors WHERE environment_id = ${input.originEnvironmentId}`)[0];
      if (
        cursor?.status !== "following" ||
        cursor.authorization_generation !== input.proof.originAuthorizationGeneration
      )
        return false;
      const now = yield* Clock.currentTimeMillis;
      const live =
        yield* sql`SELECT d.event_id FROM agent_event_deliveries d JOIN agent_event_subscriptions s ON s.subscription_id = d.subscription_id
        JOIN agent_event_facts f ON f.event_id = d.event_id
        AND f.origin_environment_id = ${input.originEnvironmentId} AND f.relayed_from = ${input.originEnvironmentId}
        WHERE d.subscription_id = ${input.subscriptionId} AND d.event_id = ${input.eventId} AND d.state = 'sending'
        AND s.state = 'active' AND s.session_id = ${input.sessionId}
        AND s.attribution_subject = ${input.attributionSubject} AND s.expires_at > ${now}`;
      if (live.length !== 1) return false;
      yield* sql`INSERT INTO agent_event_fact_authority_checks(subscription_id, event_id, phase, checked_at,
        origin_checked_at, requester_generation, origin_authorization_generation)
        VALUES (${input.subscriptionId}, ${input.eventId}, ${input.phase}, ${now}, ${input.proof.checkedAt},
          ${input.proof.authorizationGeneration}, ${input.proof.originAuthorizationGeneration})`;
      return true;
    },
    (effect) =>
      access
        .withGate(sql.withTransaction(effect))
        .pipe(Effect.catchCause(() => Effect.succeed(false))),
  );
  return AgentFactRelayAdmission.of({ record });
});
export const layer = Layer.effect(AgentFactRelayAdmission, make);
