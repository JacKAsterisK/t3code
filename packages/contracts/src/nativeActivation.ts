import * as Schema from "effect/Schema";

export const NativeActivationBuildIdentity = Schema.Struct({
  appId: Schema.NonEmptyString,
  productName: Schema.NonEmptyString,
  protocolScheme: Schema.NonEmptyString,
  homeDirectoryName: Schema.Literal("T3CodeLAN"),
  telemetry: Schema.Literal("disabled"),
  cloudConfiguration: Schema.Literal("disabled"),
  nativeUpdater: Schema.Literal("disabled"),
  protocolVersion: Schema.Literal(2),
  applicationVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
});
export type NativeActivationBuildIdentity = typeof NativeActivationBuildIdentity.Type;

export const NativeMaintenanceRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literals(["inspect", "verify", "bootstrap", "probe"]),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  homeDirectory: Schema.NonEmptyString,
  environmentId: Schema.NonEmptyString,
  journalPath: Schema.NonEmptyString,
  bootstrapId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  manualActivation: Schema.optionalKey(Schema.Boolean),
  reportStaleWork: Schema.optionalKey(Schema.Boolean),
  fleetSwitch: Schema.optionalKey(Schema.Literal(true)),
  generationVersion: Schema.optionalKey(Schema.Literal(2)),
});
export type NativeMaintenanceRequest = typeof NativeMaintenanceRequest.Type;

const UnfinishedWorkRequestFields = {
  schemaVersion: Schema.Literal(1),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  homeDirectory: Schema.NonEmptyString,
  environmentId: Schema.NonEmptyString,
  journalPath: Schema.NonEmptyString,
  includeScheduledWork: Schema.optionalKey(Schema.Boolean),
  includeRestartContinuations: Schema.optionalKey(Schema.Boolean),
};

export const NativeUnfinishedWorkRequest = Schema.Union([
  Schema.Struct({
    ...UnfinishedWorkRequestFields,
    operation: Schema.Literal("inspect-unfinished-work"),
  }),
  Schema.Struct({
    ...UnfinishedWorkRequestFields,
    operation: Schema.Literals(["cancel-unfinished-work", "settle-stale-work"]),
    expectedWorkGeneration: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    expectedReviewSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
]);
export type NativeUnfinishedWorkRequest = typeof NativeUnfinishedWorkRequest.Type;
