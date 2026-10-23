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
  operation: Schema.Literals(["inspect", "verify", "bootstrap"]),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  homeDirectory: Schema.NonEmptyString,
  environmentId: Schema.NonEmptyString,
  journalPath: Schema.NonEmptyString,
  bootstrapId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
});
export type NativeMaintenanceRequest = typeof NativeMaintenanceRequest.Type;
