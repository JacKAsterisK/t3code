import * as Schema from "effect/Schema";
import { FleetMachineId } from "./lanFleet.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const FleetApprovalPolicy = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  destinationMachineId: FleetMachineId,
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  previousDigest: Schema.NullOr(Digest),
  createdAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  grants: Schema.Array(
    Schema.Struct({ callerMachineId: FleetMachineId, enabled: Schema.Boolean }),
  ).check(Schema.isMaxLength(100)),
  signature: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export type FleetApprovalPolicy = typeof FleetApprovalPolicy.Type;
