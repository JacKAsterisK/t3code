import {
  AGENT_FACT_RELAY_LIMITS,
  AgentFactRelayCursor,
  AgentFactRelayReference,
  AgentFactRelayRead,
  AgentFactRelayValidate,
  AgentFactRelayPage,
  AgentFactRelayProof,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Invocation from "../../McpInvocationContext.ts";

const closed = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const target = Schema.Struct(fields);
  return Schema.StructWithRest(target, [Schema.Record(Schema.String, Schema.Unknown)])
    .check(
      Schema.makeFilter(
        (value) =>
          Object.keys(value).every((key) => Object.hasOwn(fields, key)) || "Unknown relay field",
      ),
    )
    .pipe(Schema.decodeTo(target, SchemaTransformation.passthrough({ strict: false })));
};
const ReadInput = closed({
  ...AgentFactRelayRead.fields,
  after: Schema.NullOr(closed(AgentFactRelayCursor.fields)),
});
const ValidateInput = closed({
  ...AgentFactRelayValidate.fields,
  references: Schema.Array(closed(AgentFactRelayReference.fields)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_FACT_RELAY_LIMITS.pageSize),
  ),
});

export const AgentFactRelayToolkit = Toolkit.make(
  Tool.make("t3_link_agent_facts", {
    description:
      "Internal native-link origin fact feed. Returns only currently readable facts created on this environment.",
    parameters: ReadInput,
    success: AgentFactRelayPage,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, Invocation.hiddenUnlessFactRelayPeer),
  Tool.make("t3_link_agent_fact_authority", {
    description:
      "Internal native-link current origin authority check for exact cached fact references.",
    parameters: ValidateInput,
    success: AgentFactRelayProof,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, Invocation.hiddenUnlessFactRelayPeer),
);
