// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Ed25519 covers strict schema-validated fields in canonical order.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { FleetApprovalPolicy as Entry } from "../../../../packages/contracts/src/fleetApprovalPolicy.ts";
import { reservedMachineId } from "./FleetAccessPolicy.ts";
const decodeEntry = Schema.decodeUnknownSync(Entry);
export const DIRECTORY = "fleet-approval-policy";
const data = (entry: Omit<Entry, "signature">) =>
  JSON.stringify([
    DIRECTORY,
    entry.version,
    entry.fleetId,
    entry.destinationMachineId,
    entry.revision,
    entry.previousDigest,
    entry.createdAt,
    entry.grants.map((g) => [g.callerMachineId, g.enabled]),
  ]);
export const digest = (entry: Entry) =>
  NodeCrypto.createHash("sha256").update(data(entry)).digest("hex");
export const sign = (entry: Omit<Entry, "signature">, key: string): Entry => ({
  ...entry,
  signature: NodeCrypto.sign(null, Buffer.from(data(entry)), key).toString("base64"),
});
export const verify = (
  input: unknown,
  identity: {
    readonly fleetId: string;
    readonly destinationMachineId: string;
    readonly publicKey: string;
  },
): input is Entry => {
  try {
    const entry = decodeEntry(input, { onExcessProperty: "error" });
    return (
      entry.fleetId === identity.fleetId &&
      entry.destinationMachineId === identity.destinationMachineId &&
      !reservedMachineId(entry.destinationMachineId) &&
      new Set(entry.grants.map((g) => g.callerMachineId)).size === entry.grants.length &&
      entry.grants.every((g) => !reservedMachineId(g.callerMachineId)) &&
      NodeCrypto.verify(
        null,
        Buffer.from(data(entry)),
        identity.publicKey,
        Buffer.from(entry.signature, "base64"),
      )
    );
  } catch {
    return false;
  }
};
