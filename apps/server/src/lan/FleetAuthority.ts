// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Ed25519 signs only schema-validated public metadata in a canonical field order.
import * as NodeCrypto from "node:crypto";
import { EnvironmentId, FleetMachineId, FleetTlsIdentity } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { FleetCampaign, FleetPeer } from "./FleetDelivery.ts";

const Pem = Schema.String.check(Schema.isMaxLength(8192));
export const FleetVaultRecord = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String,
  machineId: FleetMachineId,
  environmentId: EnvironmentId,
  encryptionPrivateKey: Pem,
  signingPrivateKey: Pem,
  rootPublicKey: Pem,
  rootPrivateKey: Schema.optionalKey(Pem),
  lastRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  enabled: Schema.Boolean,
  autoPickup: Schema.Boolean,
  access: Schema.Literals(["read-only", "standard"]),
  tls: Schema.optionalKey(Schema.Struct({ ...FleetTlsIdentity.fields, privateKey: Pem })),
  tlsEnabled: Schema.optionalKey(Schema.Boolean),
});
export type FleetVaultRecord = typeof FleetVaultRecord.Type;

export const FleetAuthority = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String,
  rootPublicKey: Pem,
  ownerEnvironmentId: EnvironmentId,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  peers: Schema.Array(FleetPeer).check(Schema.isMaxLength(100)),
  campaign: Schema.NullOr(FleetCampaign),
  signature: Schema.String.check(Schema.isMaxLength(1024)),
});
export type FleetAuthority = typeof FleetAuthority.Type;

export const FleetEnrollmentRequest = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String,
  peer: FleetPeer,
  signature: Schema.String.check(Schema.isMaxLength(1024)),
});
export type FleetEnrollmentRequest = typeof FleetEnrollmentRequest.Type;

const publicPem = (privateKey: string) =>
  NodeCrypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
const privatePem = (pair: ReturnType<typeof NodeCrypto.generateKeyPairSync>) =>
  pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const authorityData = (value: FleetAuthority) =>
  JSON.stringify([
    value.version,
    value.fleetId,
    value.rootPublicKey,
    value.ownerEnvironmentId,
    value.revision,
    value.peers,
    value.campaign,
  ]);
const requestData = (value: FleetEnrollmentRequest) =>
  JSON.stringify([value.version, value.fleetId, value.peer]);
export const ownerVerificationCode = (authority: FleetAuthority) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([authority.fleetId, authority.ownerEnvironmentId, authority.rootPublicKey]),
    )
    .digest("hex")
    .slice(0, 12);
export const peerVerificationCode = (peer: FleetPeer) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        peer.machineId,
        peer.environmentId,
        peer.origin,
        peer.encryptionPublicKey,
        peer.signingPublicKey,
        ...(peer.tls === undefined ? [] : [peer.tls]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
const stableFleetMachineId = (environmentId: string) =>
  `machine-${NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 24)}`;

export function generateFleetIdentity(
  environmentId: EnvironmentId,
  fleetId: string,
  rootPublicKey: string,
  owner: boolean,
  settings: { autoPickup: boolean; access: "read-only" | "standard" },
  machineId = stableFleetMachineId(environmentId),
): FleetVaultRecord {
  const encryption = NodeCrypto.generateKeyPairSync("x25519");
  const signing = NodeCrypto.generateKeyPairSync("ed25519");
  const root = owner ? NodeCrypto.generateKeyPairSync("ed25519") : undefined;
  return {
    version: 1,
    fleetId,
    machineId,
    environmentId,
    encryptionPrivateKey: privatePem(encryption),
    signingPrivateKey: privatePem(signing),
    rootPublicKey:
      root === undefined
        ? rootPublicKey
        : root.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ...(root === undefined ? {} : { rootPrivateKey: privatePem(root) }),
    lastRevision: 0,
    enabled: true,
    ...settings,
  };
}

export function identityPeer(record: FleetVaultRecord, label: string, origin: string): FleetPeer {
  return {
    machineId: record.machineId,
    environmentId: record.environmentId,
    label,
    origin,
    enabled: true,
    encryptionPublicKey: publicPem(record.encryptionPrivateKey),
    signingPublicKey: publicPem(record.signingPrivateKey),
    ...(record.tls === undefined
      ? {}
      : {
          tls: {
            origin: record.tls.origin,
            certificate: record.tls.certificate,
            publicKeySha256: record.tls.publicKeySha256,
          },
        }),
  };
}

export function signAuthority(value: FleetAuthority, privateKey: string): FleetAuthority {
  return {
    ...value,
    signature: NodeCrypto.sign(null, Buffer.from(authorityData(value)), privateKey).toString(
      "base64",
    ),
  };
}

export function verifyAuthority(value: FleetAuthority, record?: FleetVaultRecord): void {
  const key = NodeCrypto.createPublicKey(value.rootPublicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !NodeCrypto.verify(
      null,
      Buffer.from(authorityData(value)),
      key,
      Buffer.from(value.signature, "base64"),
    ) ||
    new Set(value.peers.map((peer) => peer.machineId)).size !== value.peers.length ||
    new Set(value.peers.map((peer) => peer.environmentId)).size !== value.peers.length ||
    (record !== undefined &&
      (value.fleetId !== record.fleetId ||
        value.rootPublicKey !== record.rootPublicKey ||
        value.revision < record.lastRevision ||
        (record.rootPrivateKey !== undefined &&
          !NodeCrypto.createPublicKey(record.rootPrivateKey).equals(key))))
  )
    throw new Error("Fleet authority or revision mismatch");
}

export function enrollmentRequest(
  record: FleetVaultRecord,
  peer: FleetPeer,
): FleetEnrollmentRequest {
  const request: FleetEnrollmentRequest = {
    version: 1,
    fleetId: record.fleetId,
    peer,
    signature: "",
  };
  return {
    ...request,
    signature: NodeCrypto.sign(
      null,
      Buffer.from(requestData(request)),
      record.signingPrivateKey,
    ).toString("base64"),
  };
}

export function verifyEnrollment(request: FleetEnrollmentRequest, authority: FleetAuthority): void {
  const key = NodeCrypto.createPublicKey(request.peer.signingPublicKey);
  if (
    request.fleetId !== authority.fleetId ||
    key.asymmetricKeyType !== "ed25519" ||
    NodeCrypto.createPublicKey(request.peer.encryptionPublicKey).asymmetricKeyType !== "x25519" ||
    !NodeCrypto.verify(
      null,
      Buffer.from(requestData(request)),
      key,
      Buffer.from(request.signature, "base64"),
    )
  )
    throw new Error("Invalid fleet enrollment proof");
}
