import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectIconColor } from "./project.ts";

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

// A person the fleet's tasks belong to, listed in fleet-users.json beside the roster. An owner is
// a label only: it never grants or limits access to anything.
export const FleetUserId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,31}$/u));
export type FleetUserId = typeof FleetUserId.Type;
export const FleetUser = Schema.Struct({
  id: FleetUserId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  // A theme colour token; without one the badge picks a stable colour from the id.
  color: Schema.optionalKey(ProjectIconColor),
});
export type FleetUser = typeof FleetUser.Type;
// fleet-users.json beside the roster. Each machine keeps its last good copy, so badges survive
// the share being away.
export const FleetUsersFile = Schema.Struct({
  version: Schema.Literal(1),
  users: Schema.Array(FleetUser).check(Schema.isMaxLength(50)),
  // The owner each machine gives a task nothing else names an owner for.
  machineOwners: Schema.Record(FleetMachineId, FleetUserId),
});
export type FleetUsersFile = typeof FleetUsersFile.Type;
// What a client sees: the users, and this machine's id and default owner when it knows them.
export const FleetUsersDirectory = Schema.Struct({
  users: Schema.Array(FleetUser),
  machineId: Schema.NullOr(FleetMachineId),
  defaultOwnerId: Schema.NullOr(FleetUserId),
});
export type FleetUsersDirectory = typeof FleetUsersDirectory.Type;

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

export const sameFleetTlsIdentity = (left: FleetTlsIdentity, right: FleetTlsIdentity) =>
  left.origin === right.origin &&
  left.publicKeySha256 === right.publicKeySha256 &&
  left.certificate === right.certificate;

export const sameFleetTlsRoute = (left: FleetTlsIdentity, right: FleetTlsIdentity) =>
  sameFleetTlsIdentity(left, right) && left.connectHost === right.connectHost;

export const FleetTlsGatewayInput = Schema.Struct({
  environmentId: EnvironmentId,
  identity: FleetTlsIdentity,
  /** Only a verified replacement can name the precise gateway it supersedes. */
  previousIdentity: Schema.optionalKey(FleetTlsIdentity),
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
  completedReplacementDeliveryIds: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(1000)),
  ),
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
      preserveManualConnection: Schema.optionalKey(Schema.Literal(true)),
      requireSavedConnection: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
});
export type LanFleetSyncResult = typeof LanFleetSyncResult.Type;

export const FleetAccess = Schema.Literals(["read-only", "standard"]);
export type FleetAccess = typeof FleetAccess.Type;
const FleetMachineAccess = Schema.Struct({ machineId: FleetMachineId, access: FleetAccess });
// A read-only machine with standard access on the machines it names, whatever its own level.
const FleetAccessException = Schema.Struct({
  machineId: FleetMachineId,
  standardOn: Schema.Array(FleetMachineId).check(Schema.isMaxLength(100)),
});
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
    // Replaces the exceptions of each machine it names; without it, exceptions stay as they are.
    exceptions: Schema.optionalKey(
      Schema.Array(FleetAccessException).check(Schema.isMaxLength(100)),
    ),
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
  credentialUnavailable: Schema.optionalKey(Schema.Boolean),
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
      // Exceptions among the fleet's machines, by caller.
      exceptions: Schema.optionalKey(Schema.Array(FleetAccessException)),
      selfAccess: FleetAccess,
      // Read-only machines may only restrict themselves.
      canChange: Schema.Boolean,
      // A starting list on the share, before any list exists: not adopted yet, or unusable.
      seed: Schema.optionalKey(Schema.Literals(["waiting", "invalid"])),
      // While it waits for every enabled machine to run LAN 1.0.26 or later: those not confirmed.
      seedPending: Schema.optionalKey(Schema.Struct({ machineIds: Schema.Array(FleetMachineId) })),
      // With no list and no starting list: the list this machine had on its previous fleet, for a
      // person to save as this fleet's first. Never saved on its own.
      carryProposal: Schema.optionalKey(
        Schema.Struct({
          defaultAccess: FleetAccess,
          machines: Schema.Array(FleetMachineAccess),
          exceptions: Schema.Array(FleetAccessException),
        }),
      ),
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

/** What fleet setup tells a person when it refuses, by refusal. Shown as written; no secrets. */
const FLEET_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  "roster-row-disabled":
    "The fleet roster has a disabled row for this machine. Enable or remove its row in fleet-roster.json on the shared folder, then try again.",
  "roster-origin-mismatch":
    "The fleet roster lists this machine at a different LAN address. Use the address in its roster row, or update that row, then try again.",
  "roster-row-without-keys":
    "This machine is already in the fleet's roster or trust list, but this install does not have its fleet keys. Ask the fleet owner to revoke this machine in Machine access, then join again.",
  "already-member":
    "This machine is already a member of a fleet, so it cannot create one. Join that fleet, or leave it before creating a new one.",
  "owner-authority-missing":
    "This machine owns a fleet whose fleet-authority.json is missing from the shared folder. Restore that file rather than creating the fleet again.",
  "switched-fleet-start":
    "Only BuildMachine creates the replacement fleet. Join that fleet from this machine instead.",
  "fleet-exists": "The shared folder already has a fleet. Join it instead of creating a new one.",
  "fleet-missing":
    "The shared folder has no fleet yet. Create it on the owner machine first, then join.",
  "owner-code-mismatch":
    "The owner verification code does not match this fleet's owner. Check the code on the owner machine.",
  "not-owner": "Only the fleet's owner machine can do this.",
  "machine-not-enabled":
    "This machine, or one it was asked to link, is not an enabled fleet member in both the roster and the fleet's trust list.",
};

export class LanFleetError extends Schema.TaggedError<LanFleetError>()("LanFleetError", {
  reason: Schema.Literals(["configuration", "unavailable", "busy", "transport"]),
  // Why a change was refused, when it has a clearer message than its reason. A string, so a
  // client that does not know one shows the reason's message instead.
  refusal: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    if (this.refusal === "exception-onto-standard")
      return "An exception only applies on a machine that is itself read-only. Standard access on a standard machine reaches every machine it can change, so choose only read-only machines.";
    if (this.refusal === "exception-unknown-machine")
      return "An exception must name two machines in this fleet. Reload Machine access and choose from its machines.";
    const refusal =
      this.refusal !== undefined && Object.hasOwn(FLEET_REFUSAL_MESSAGES, this.refusal)
        ? FLEET_REFUSAL_MESSAGES[this.refusal]
        : undefined;
    if (refusal !== undefined) return refusal;
    if (this.reason === "transport")
      return "The encrypted LAN endpoint could not start. Check that its selected address is local and its port is available; existing keys and connections were preserved.";
    return this.reason === "busy"
      ? "LAN link sync is already running or needs recovery after an interrupted sync."
      : this.reason === "configuration"
        ? "LAN link configuration, recipient trust, or delivery validation failed."
        : "LAN link storage is unavailable. No replacement credential was issued; check status before retrying.";
  }
}
