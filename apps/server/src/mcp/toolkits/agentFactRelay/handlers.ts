import {
  AgentFactRelayRead,
  AgentFactRelayValidate,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Relay from "../../../agentEvents/AgentFactRelay.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { AgentFactRelayToolkit } from "./tools.ts";

const decodeRead = Schema.decodeEffect(AgentFactRelayRead);
const decodeValidate = Schema.decodeEffect(AgentFactRelayValidate);
const invalid = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "Invalid native-link fact request.",
  });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Native-link fact access is unavailable.",
  });
const relayFailure = (error: Relay.RelayError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "capability_denied"
        ? "capability_denied"
        : error.reason === "invalid_request"
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });
export const layer = Access.toLayer(
  AgentFactRelayToolkit,
  Effect.gen(function* () {
    const relay = yield* Effect.serviceOption(Relay.AgentFactRelay);
    const admit = Invocation.McpInvocationContext.pipe(
      Effect.flatMap((scope) =>
        scope.agentEventsEnabled === true &&
        scope.linkedEnvironments === true &&
        scope.thread === undefined &&
        scope.client?.linked === true &&
        scope.client.taskOnly !== true &&
        scope.client.grantId === undefined
          ? Effect.void
          : Effect.fail(unavailable()),
      ),
    );
    return {
      t3_link_agent_facts: Access.reads(
        Effect.fn("mcp.linkAgentFacts")(function* (input: AgentFactRelayRead) {
          yield* admit;
          const request = yield* decodeRead(input, { onExcessProperty: "error" }).pipe(
            Effect.mapError(invalid),
          );
          if (Option.isNone(relay)) return yield* unavailable();
          return yield* relay.value.readOrigin(request).pipe(Effect.mapError(relayFailure));
        }),
      ),
      t3_link_agent_fact_authority: Access.reads(
        Effect.fn("mcp.linkAgentFactAuthority")(function* (input: AgentFactRelayValidate) {
          yield* admit;
          const request = yield* decodeValidate(input, { onExcessProperty: "error" }).pipe(
            Effect.mapError(invalid),
          );
          if (Option.isNone(relay)) return yield* unavailable();
          return yield* relay.value.validateOrigin(request).pipe(Effect.mapError(relayFailure));
        }),
      ),
    };
  }),
);
