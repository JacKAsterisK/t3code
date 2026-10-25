// @effect-diagnostics nodeBuiltinImport:off -- Only synthetic in-memory test keys are generated here.
import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@t3tools/contracts";
import type { FleetPeer } from "./FleetDelivery.ts";

export function syntheticFleetPeer(machineId: string) {
  const encryption = NodeCrypto.generateKeyPairSync("x25519");
  const signing = NodeCrypto.generateKeyPairSync("ed25519");
  const peer: FleetPeer = {
    machineId,
    environmentId: EnvironmentId.make(`environment:${machineId}`),
    label: `Test ${machineId}`,
    origin: `https://${machineId}.example.test`,
    enabled: true,
    encryptionPublicKey: encryption.publicKey.export({ type: "spki", format: "pem" }).toString(),
    signingPublicKey: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return {
    peer,
    encryptionPrivateKey: encryption.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signingPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
