import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ModelSelection } from "./modelSelection.ts";

const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const LanEnvironmentRoute = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  // A null origin selects this server. Remote routes never come from tool input.
  origin: Schema.NullOr(Schema.String),
  credentialRef: Schema.NullOr(BoundedId),
  enabled: Schema.Boolean,
  protocolVersion: Schema.Literal(2),
  routingVersion: Schema.Literal(1),
  runtimeCeiling: RuntimeMode,
  models: Schema.optionalKey(Schema.Array(ModelSelection).check(Schema.isMaxLength(100))),
});
export type LanEnvironmentRoute = typeof LanEnvironmentRoute.Type;

export const LanRoutingGrant = Schema.Struct({
  principalId: BoundedId,
  environmentId: EnvironmentId,
  enabled: Schema.Boolean,
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(100)),
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(1000)),
  allowLaunch: Schema.Boolean,
  allowOperate: Schema.Boolean,
  runtimeCeiling: RuntimeMode,
});
export type LanRoutingGrant = typeof LanRoutingGrant.Type;

export const LanRoutingConfig = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Array(LanEnvironmentRoute).check(Schema.isMaxLength(100)),
  grants: Schema.Array(LanRoutingGrant).check(Schema.isMaxLength(1000)),
});
export type LanRoutingConfig = typeof LanRoutingConfig.Type;

export const LanRoutedResult = Schema.Struct({
  environmentId: EnvironmentId,
  result: Schema.Unknown,
});
export type LanRoutedResult = typeof LanRoutedResult.Type;

export const LanEnvironmentSummary = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  local: Schema.Boolean,
  routingVersion: Schema.Literal(1),
  projectIds: Schema.Array(ProjectId),
  models: Schema.Array(ModelSelection),
  runtimeCeiling: RuntimeMode,
  canLaunch: Schema.Boolean,
  canOperate: Schema.Boolean,
});

export const LanEventsAckInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sourceId: EventId,
  eventIds: Schema.Array(BoundedId).check(Schema.isMaxLength(100)),
});
export type LanEventsAckInput = typeof LanEventsAckInput.Type;
