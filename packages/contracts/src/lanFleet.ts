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

export const FleetConnectHost = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?![\d.]+$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu,
  ),
);
export const FleetTlsIdentity = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  certificate: Schema.String.check(Schema.isMaxLength(8192)),
  publicKeySha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  connectHost: Schema.optionalKey(FleetConnectHost),
});
export type FleetTlsIdentity = typeof FleetTlsIdentity.Type;
export const FleetTlsGatewayInput = Schema.Struct({
  environmentId: EnvironmentId,
  identity: FleetTlsIdentity,
});
export type FleetTlsGatewayInput = typeof FleetTlsGatewayInput.Type;
export const FleetTlsGatewayResult = Schema.Struct({
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
});
export type FleetTlsGatewayResult = typeof FleetTlsGatewayResult.Type;

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
      tls: Schema.optionalKey(FleetTlsIdentity),
      // The sender replaced a credential this machine already holds, such as after an access change.
      replace: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type LanFleetSyncResult = typeof LanFleetSyncResult.Type;

export const FleetAccess = Schema.Literals(["read-only", "standard"]);
export type FleetAccess = typeof FleetAccess.Type;
const FleetMachineAccess = Schema.Struct({ machineId: FleetMachineId, access: FleetAccess });
const VerificationCode = Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/u));
export const LanFleetSetupInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("start"),
    confirmed: Schema.Boolean,
    origin: Schema.String,
    autoPickup: Schema.Boolean,
    access: FleetAccess,
    managedTls: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    operation: Schema.Literal("join"),
    confirmed: Schema.Boolean,
    origin: Schema.String,
    ownerCode: Schema.optionalKey(VerificationCode),
    managedTls: Schema.optionalKey(Schema.Boolean),
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
  Schema.Struct({
    operation: Schema.Literal("access"),
    confirmed: Schema.Boolean,
    // The fleet policy revision this change was made against; a newer one fails the change.
    revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    defaultAccess: FleetAccess,
    machines: Schema.Array(FleetMachineAccess).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    operation: Schema.Literal("transport"),
    confirmed: Schema.Boolean,
    enabled: Schema.Boolean,
  }),
]);
export type LanFleetSetupInput = typeof LanFleetSetupInput.Type;

export const LanFleetSetupState = Schema.Struct({
  available: Schema.Boolean,
  sharedFolderTrust: Schema.optionalKey(Schema.Boolean),
  stage: Schema.Literals(["unconfigured", "join", "pending", "active", "paused"]),
  owner: Schema.Boolean,
  ownerCode: Schema.NullOr(VerificationCode),
  deviceCode: Schema.NullOr(VerificationCode),
  environmentId: EnvironmentId,
  label: Schema.String,
  origin: Schema.String,
  managedTls: Schema.optionalKey(Schema.Boolean),
  tlsEnabled: Schema.optionalKey(Schema.Boolean),
  tlsReady: Schema.optionalKey(Schema.Boolean),
  suggestedTlsOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
  autoPickup: Schema.Boolean,
  // Used until the fleet has an access policy; the first policy takes it as its default.
  access: FleetAccess,
  accessPolicy: Schema.optionalKey(
    Schema.Struct({
      // Zero until a machine saves the first fleet-wide policy.
      revision: Schema.Number,
      defaultAccess: FleetAccess,
      machines: Schema.Array(FleetMachineAccess),
      selfAccess: FleetAccess,
      // Read-only machines may only restrict themselves.
      canChange: Schema.Boolean,
      // A starting list on the share, before any list exists: not adopted yet, or unusable.
      seed: Schema.optionalKey(Schema.Literals(["waiting", "invalid"])),
    }),
  ),
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
  reason: Schema.Literals(["configuration", "unavailable", "busy", "transport"]),
}) {
  override get message(): string {
    if (this.reason === "transport")
      return "The encrypted LAN endpoint could not start. Check that its selected address is local and its port is available; existing keys and connections were preserved.";
    return this.reason === "busy"
      ? "LAN link sync is already running or needs recovery after an interrupted sync."
      : this.reason === "configuration"
        ? "LAN link configuration, recipient trust, or delivery validation failed."
        : "LAN link storage is unavailable. No replacement credential was issued; check status before retrying.";
  }
}
