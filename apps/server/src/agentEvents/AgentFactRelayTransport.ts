import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PeerClient from "../peer/PeerMcpClient.ts";
import * as Discovery from "../peer/PeerFactRelayDiscovery.ts";
import * as Ports from "./AgentFactRelayAccess.ts";

const make = Effect.gen(function* () {
  const peer = yield* PeerClient.PeerMcpClient;
  const discovery = yield* Discovery.PeerFactRelayDiscovery;
  const access = yield* Ports.AgentFactRelayAccess;
  const fresh = Effect.fn("AgentFactRelayTransport.fresh")(
    function* (authorization: Ports.RelayAuthorization) {
      const current = yield* access.outgoing(authorization.peerEnvironmentId);
      if (
        current.verdict !== "allowed" ||
        current.authorization.peerEnvironmentId !== authorization.peerEnvironmentId ||
        current.authorization.generation !== authorization.generation
      )
        return yield* new Ports.RelayPeerError({ reason: "refused" });
    },
    (effect) => access.withGate(effect),
  );
  const beforeSend = (authorization: Ports.RelayAuthorization) =>
    fresh(authorization).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The captured linked fact source authorization is no longer current.",
          }),
      ),
    );
  const read: Ports.AgentFactRelayTransport["Service"]["read"] = Effect.fn(
    "AgentFactRelayTransport.read",
  )(
    function* (input) {
      yield* fresh(input.authorization);
      yield* discovery.require(input.authorization);
      yield* fresh(input.authorization);
      const response = yield* peer.call({
        environmentId: EnvironmentId.make(input.authorization.peerEnvironmentId),
        tool: "t3_link_agent_facts",
        arguments: input.request,
        limits: input.authorization.limits,
        writes: false,
        beforeSend: beforeSend(input.authorization),
        requestTimeoutMs: (input.request.waitMs ?? 0) + 15_000,
        success: Schema.Unknown,
      });
      yield* fresh(input.authorization);
      return response;
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "AgentFactRelayPeerError"
            ? cause
            : new Ports.RelayPeerError({
                reason:
                  cause._tag === "OrchestratorMcpFailure" && cause.code === "capability_denied"
                    ? "refused"
                    : "unreachable",
                cause,
              }),
        ),
      ),
  );
  const validate: Ports.AgentFactRelayTransport["Service"]["validate"] = Effect.fn(
    "AgentFactRelayTransport.validate",
  )(
    function* (input) {
      yield* fresh(input.authorization);
      yield* discovery.require(input.authorization);
      yield* fresh(input.authorization);
      const response = yield* peer.call({
        environmentId: EnvironmentId.make(input.authorization.peerEnvironmentId),
        tool: "t3_link_agent_fact_authority",
        arguments: input.request,
        limits: input.authorization.limits,
        writes: false,
        beforeSend: beforeSend(input.authorization),
        success: Schema.Unknown,
      });
      yield* fresh(input.authorization);
      return response;
    },
    Effect.mapError((cause) =>
      cause._tag === "AgentFactRelayPeerError"
        ? cause
        : new Ports.RelayPeerError({
            reason:
              cause._tag === "OrchestratorMcpFailure" && cause.code === "capability_denied"
                ? "refused"
                : "unreachable",
            cause,
          }),
    ),
  );
  return Ports.AgentFactRelayTransport.of({ read, validate });
});
export const layer = Layer.effect(Ports.AgentFactRelayTransport, make);
