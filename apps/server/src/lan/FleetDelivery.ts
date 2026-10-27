// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Node owns the key formats; canonical JSON contains only schema-validated envelope fields.
import * as NodeCrypto from "node:crypto";
import {
  FleetMachine,
  FleetMachineId,
  FleetTlsIdentity,
  FleetConnectHost,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Pem = Schema.String.check(Schema.isMaxLength(8192));
export const FleetCampaign = Schema.Struct({
  id: Schema.String,
  expiresAt: Schema.Number,
  machineIds: Schema.Array(FleetMachineId).check(Schema.isMaxLength(100)),
});
export const FleetPeer = Schema.Struct({
  ...FleetMachine.fields,
  encryptionPublicKey: Pem,
  signingPublicKey: Pem,
  tls: Schema.optionalKey(FleetTlsIdentity),
});
export type FleetPeer = typeof FleetPeer.Type;
export const FleetPrivateConfig = Schema.Struct({
  version: Schema.Literal(1),
  machineId: FleetMachineId,
  rosterPath: Schema.optionalKey(Schema.String),
  deliveryDirectory: Schema.optionalKey(Schema.String),
  autoPickup: Schema.Boolean,
  encryptionPrivateKey: Pem,
  signingPrivateKey: Pem,
  peers: Schema.Array(FleetPeer).check(Schema.isMaxLength(100)),
  managed: Schema.optionalKey(Schema.Boolean),
  access: Schema.optionalKey(Schema.Literals(["read-only", "standard"])),
  campaign: Schema.optionalKey(Schema.NullOr(FleetCampaign)),
});
export type FleetPrivateConfig = typeof FleetPrivateConfig.Type;

const Text = Schema.String.check(Schema.isMaxLength(16384));
const Header = Schema.Struct({
  version: Schema.Literal(1),
  deliveryId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  senderId: FleetMachineId,
  recipientId: FleetMachineId,
  expiresAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ephemeralPublicKey: Pem,
});
export const Delivery = Schema.Struct({
  header: Header,
  nonce: Text,
  ciphertext: Text,
  tag: Text,
  signature: Text,
});
export type Delivery = typeof Delivery.Type;
const Payload = Schema.Struct({
  senderEnvironmentId: FleetMachine.fields.environmentId,
  recipientEnvironmentId: FleetMachine.fields.environmentId,
  origin: FleetMachine.fields.origin,
  credential: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
const decodePayload = Schema.decodeSync(Schema.fromJsonString(Payload));
const isConnectHost = Schema.is(FleetConnectHost);
export const Receipt = Schema.Struct({
  deliveryId: Schema.String,
  recipientId: FleetMachineId,
  senderId: FleetMachineId,
  status: Schema.Literal("connected"),
  signature: Text,
});
export type Receipt = typeof Receipt.Type;

export const FleetCatalog = Schema.Struct({
  version: Schema.Literal(1),
  machineId: FleetMachineId,
  environmentId: FleetMachine.fields.environmentId,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  connectedEnvironmentIds: Schema.Array(FleetMachine.fields.environmentId).check(
    Schema.isMaxLength(1000),
  ),
  availableDeliveryIds: Schema.optionalKey(
    Schema.Array(Header.fields.deliveryId).check(Schema.isMaxLength(100)),
  ),
  connectHost: Schema.optionalKey(FleetConnectHost),
  rejectedDeliveryIds: Schema.optionalKey(
    Schema.Array(Header.fields.deliveryId).check(Schema.isMaxLength(100)),
  ),
  signature: Text,
});
type FleetCatalog = typeof FleetCatalog.Type;
const catalogData = (value: FleetCatalog) =>
  JSON.stringify([
    value.version,
    value.machineId,
    value.environmentId,
    value.createdAt,
    value.expiresAt,
    value.connectedEnvironmentIds,
    ...(value.availableDeliveryIds === undefined ? [] : [value.availableDeliveryIds]),
    ...(value.connectHost === undefined ? [] : [["connectHost", value.connectHost]]),
    ...(value.rejectedDeliveryIds === undefined
      ? []
      : [["rejectedDeliveryIds", value.rejectedDeliveryIds]]),
  ]);

export function makeFleetCatalog(
  config: FleetPrivateConfig,
  self: FleetPeer,
  connectedEnvironmentIds: FleetCatalog["connectedEnvironmentIds"],
  now: number,
  availableDeliveryIds?: FleetCatalog["availableDeliveryIds"],
  connectHost?: FleetCatalog["connectHost"],
  rejectedDeliveryIds?: FleetCatalog["rejectedDeliveryIds"],
): FleetCatalog {
  if (connectHost !== undefined && !isConnectHost(connectHost))
    throw new Error("Invalid fleet connection hostname");
  const catalog: FleetCatalog = {
    version: 1,
    machineId: self.machineId,
    environmentId: self.environmentId,
    createdAt: now,
    expiresAt: now + 10 * 60 * 1000,
    connectedEnvironmentIds,
    ...(availableDeliveryIds === undefined ? {} : { availableDeliveryIds }),
    ...(connectHost === undefined ? {} : { connectHost }),
    ...(rejectedDeliveryIds === undefined ? {} : { rejectedDeliveryIds }),
    signature: "",
  };
  return {
    ...catalog,
    signature: NodeCrypto.sign(
      null,
      Buffer.from(catalogData(catalog)),
      config.signingPrivateKey,
    ).toString("base64"),
  };
}

export function verifyFleetCatalog(value: FleetCatalog, peer: FleetPeer, now: number): boolean {
  return (
    value.machineId === peer.machineId &&
    value.environmentId === peer.environmentId &&
    value.createdAt <= now + 60_000 &&
    value.expiresAt > now &&
    value.expiresAt <= value.createdAt + 10 * 60 * 1000 &&
    (value.connectHost === undefined || isConnectHost(value.connectHost)) &&
    (value.availableDeliveryIds === undefined ||
      new Set(value.availableDeliveryIds).size === value.availableDeliveryIds.length) &&
    (value.rejectedDeliveryIds === undefined ||
      (value.rejectedDeliveryIds.length <= 100 &&
        new Set(value.rejectedDeliveryIds).size === value.rejectedDeliveryIds.length)) &&
    NodeCrypto.verify(
      null,
      Buffer.from(catalogData(value)),
      NodeCrypto.createPublicKey(peer.signingPublicKey),
      Buffer.from(value.signature, "base64"),
    )
  );
}

const unsigned = (delivery: Delivery) =>
  JSON.stringify([delivery.header, delivery.nonce, delivery.ciphertext, delivery.tag]);
const receiptData = (receipt: Receipt) =>
  JSON.stringify([receipt.deliveryId, receipt.recipientId, receipt.senderId, receipt.status]);
const key = (shared: Buffer, header: typeof Header.Type) =>
  Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      shared,
      Buffer.from(header.deliveryId),
      Buffer.from(JSON.stringify(header)),
      32,
    ),
  );
const publicKey = (pem: string, type: "x25519" | "ed25519") => {
  const parsed = NodeCrypto.createPublicKey(pem);
  if (parsed.asymmetricKeyType !== type) throw new Error("Invalid fleet key type");
  return parsed;
};

export function validateFleetKeys(config: FleetPrivateConfig, self: FleetPeer): void {
  const pairs = [
    [config.encryptionPrivateKey, self.encryptionPublicKey, "x25519"],
    [config.signingPrivateKey, self.signingPublicKey, "ed25519"],
  ] as const;
  for (const [privatePem, publicPem, type] of pairs) {
    const privateKey = NodeCrypto.createPrivateKey(privatePem);
    if (
      privateKey.asymmetricKeyType !== type ||
      !NodeCrypto.createPublicKey(privateKey).equals(publicKey(publicPem, type))
    )
      throw new Error("Fleet identity key mismatch");
  }
  for (const peer of config.peers) {
    publicKey(peer.encryptionPublicKey, "x25519");
    publicKey(peer.signingPublicKey, "ed25519");
  }
}

export function sealDelivery(input: {
  config: FleetPrivateConfig;
  sender: FleetPeer;
  recipient: FleetPeer;
  deliveryId: string;
  expiresAt: number;
  credential: string;
}): Delivery {
  const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
  const header = {
    version: 1 as const,
    deliveryId: input.deliveryId,
    senderId: input.sender.machineId,
    recipientId: input.recipient.machineId,
    expiresAt: input.expiresAt,
    ephemeralPublicKey: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const shared = NodeCrypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKey(input.recipient.encryptionPublicKey, "x25519"),
  });
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key(shared, header), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const payload = {
    senderEnvironmentId: input.sender.environmentId,
    recipientEnvironmentId: input.recipient.environmentId,
    origin: input.sender.origin,
    credential: input.credential,
  };
  const delivery: Delivery = {
    header,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    signature: "",
  };
  return {
    ...delivery,
    signature: NodeCrypto.sign(
      null,
      Buffer.from(unsigned(delivery)),
      input.config.signingPrivateKey,
    ).toString("base64"),
  };
}

export function verifyDelivery(
  delivery: Delivery,
  sender: FleetPeer,
  recipient: FleetPeer,
  now: number,
): boolean {
  return (
    delivery.header.recipientId === recipient.machineId &&
    delivery.header.senderId === sender.machineId &&
    delivery.header.expiresAt > now &&
    delivery.header.expiresAt <= now + 24 * 60 * 60 * 1000 &&
    NodeCrypto.verify(
      null,
      Buffer.from(unsigned(delivery)),
      publicKey(sender.signingPublicKey, "ed25519"),
      Buffer.from(delivery.signature, "base64"),
    )
  );
}

export function openDelivery(
  delivery: Delivery,
  config: FleetPrivateConfig,
  sender: FleetPeer,
  self: FleetPeer,
  now: number,
) {
  if (!verifyDelivery(delivery, sender, self, now))
    throw new Error("Fleet delivery assignment, expiry or signature mismatch");
  const shared = NodeCrypto.diffieHellman({
    privateKey: NodeCrypto.createPrivateKey(config.encryptionPrivateKey),
    publicKey: publicKey(delivery.header.ephemeralPublicKey, "x25519"),
  });
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key(shared, delivery.header),
    Buffer.from(delivery.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(JSON.stringify(delivery.header)));
  decipher.setAuthTag(Buffer.from(delivery.tag, "base64"));
  const raw = Buffer.concat([
    decipher.update(Buffer.from(delivery.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const payload = decodePayload(raw);
  if (
    payload.senderEnvironmentId !== sender.environmentId ||
    payload.recipientEnvironmentId !== self.environmentId ||
    payload.origin !== sender.origin
  )
    throw new Error("Fleet environment identity mismatch");
  return payload;
}

export function makeReceipt(delivery: Delivery, config: FleetPrivateConfig): Receipt {
  const receipt: Receipt = {
    deliveryId: delivery.header.deliveryId,
    recipientId: config.machineId,
    senderId: delivery.header.senderId,
    status: "connected",
    signature: "",
  };
  return {
    ...receipt,
    signature: NodeCrypto.sign(
      null,
      Buffer.from(receiptData(receipt)),
      config.signingPrivateKey,
    ).toString("base64"),
  };
}

export function verifyReceipt(
  receipt: Receipt,
  deliveryId: string,
  sender: FleetPeer,
  recipient: FleetPeer,
): boolean {
  return (
    receipt.deliveryId === deliveryId &&
    receipt.senderId === sender.machineId &&
    receipt.recipientId === recipient.machineId &&
    NodeCrypto.verify(
      null,
      Buffer.from(receiptData(receipt)),
      publicKey(recipient.signingPublicKey, "ed25519"),
      Buffer.from(receipt.signature, "base64"),
    )
  );
}

export const deliveryFileName = (senderId: string, recipientId: string) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([senderId, recipientId]))
    .digest("hex");
