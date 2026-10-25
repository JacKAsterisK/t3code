import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FleetMachineId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u));
export const FleetMachine = Schema.Struct({
  machineId: FleetMachineId,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  enabled: Schema.Boolean,
});
export type FleetMachine = typeof FleetMachine.Type;

// This is discovery metadata. Adding an entry never grants access to that machine.
export const FleetRoster = Schema.Struct({
  version: Schema.Literal(1),
  machines: Schema.Array(FleetMachine).check(Schema.isMaxLength(100)),
});
export type FleetRoster = typeof FleetRoster.Type;

export const LanFleetSyncInput = Schema.Struct({
  mode: Schema.Literals(["status", "manual", "automatic"]),
  connectedEnvironmentIds: Schema.Array(EnvironmentId).check(Schema.isMaxLength(1000)),
  sendMachineIds: Schema.Array(FleetMachineId).check(Schema.isMaxLength(100)),
});
export type LanFleetSyncInput = typeof LanFleetSyncInput.Type;

export const LanFleetSyncResult = Schema.Struct({
  enabled: Schema.Boolean,
  autoPickup: Schema.Boolean,
  machines: Schema.Array(
    Schema.Struct({
      machineId: FleetMachineId,
      environmentId: EnvironmentId,
      label: Schema.String,
      status: Schema.Literals([
        "self",
        "untrusted",
        "ready",
        "pending",
        "connected",
        "expired",
        "uncertain",
      ]),
    }),
  ),
  incoming: Schema.Array(
    Schema.Struct({
      deliveryId: Schema.String,
      environmentId: EnvironmentId,
      host: Schema.String,
      pairingCode: Schema.String,
    }),
  ),
});
export type LanFleetSyncResult = typeof LanFleetSyncResult.Type;

const FleetAccess = Schema.Literals(["read-only", "standard"]);
const VerificationCode = Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/u));
export const LanFleetSetupInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("start"),
    confirmed: Schema.Boolean,
    origin: Schema.String,
    autoPickup: Schema.Boolean,
    access: FleetAccess,
  }),
  Schema.Struct({
    operation: Schema.Literal("join"),
    confirmed: Schema.Boolean,
    origin: Schema.String,
    ownerCode: VerificationCode,
    autoPickup: Schema.Boolean,
    access: FleetAccess,
  }),
  Schema.Struct({
    operation: Schema.Literal("approve"),
    confirmed: Schema.Boolean,
    machineId: FleetMachineId,
    verificationCode: VerificationCode,
  }),
  Schema.Struct({
    operation: Schema.Literal("revoke"),
    confirmed: Schema.Boolean,
    machineId: FleetMachineId,
  }),
  Schema.Struct({
    operation: Schema.Literal("settings"),
    confirmed: Schema.Boolean,
    enabled: Schema.Boolean,
    autoPickup: Schema.Boolean,
    access: FleetAccess,
  }),
  Schema.Struct({
    operation: Schema.Literal("link"),
    confirmed: Schema.Boolean,
    machineIds: Schema.Array(FleetMachineId).check(Schema.isMaxLength(100)),
  }),
]);
export type LanFleetSetupInput = typeof LanFleetSetupInput.Type;

export const LanFleetSetupState = Schema.Struct({
  available: Schema.Boolean,
  stage: Schema.Literals(["unconfigured", "join", "pending", "active", "paused"]),
  owner: Schema.Boolean,
  ownerCode: Schema.NullOr(VerificationCode),
  deviceCode: Schema.NullOr(VerificationCode),
  environmentId: EnvironmentId,
  label: Schema.String,
  origin: Schema.String,
  autoPickup: Schema.Boolean,
  access: FleetAccess,
  peers: Schema.Array(
    Schema.Struct({
      machineId: FleetMachineId,
      environmentId: EnvironmentId,
      label: Schema.String,
      origin: Schema.String,
      verificationCode: VerificationCode,
      status: Schema.Literals(["pending", "approved", "revoked"]),
    }),
  ),
});
export type LanFleetSetupState = typeof LanFleetSetupState.Type;

export class LanFleetError extends Schema.TaggedError<LanFleetError>()("LanFleetError", {
  reason: Schema.Literals(["configuration", "unavailable", "busy"]),
}) {
  override get message(): string {
    return this.reason === "busy"
      ? "LAN link sync is already running or needs recovery after an interrupted sync."
      : this.reason === "configuration"
        ? "LAN link configuration, recipient trust, or delivery validation failed."
        : "LAN link storage is unavailable. No replacement credential was issued; check status before retrying.";
  }
}
