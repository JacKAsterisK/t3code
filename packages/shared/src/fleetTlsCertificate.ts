// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- X.509 DER encoding and validation use Node's crypto implementation; callers own time and setup consent.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

const der = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Buffer => {
  const value = Buffer.concat(parts);
  const length: number[] = [];
  for (let remaining = value.length; remaining > 0; remaining >>>= 8)
    length.unshift(remaining & 255);
  return Buffer.concat([
    Buffer.from([
      tag,
      ...(value.length < 128 ? [value.length] : [0x80 | length.length, ...length]),
    ]),
    value,
  ]);
};
const sequence = (...parts: ReadonlyArray<Uint8Array>) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const signatureAlgorithm = () => sequence(oid("2a8648ce3d040302"));
const name = () =>
  sequence(der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from("T3 LAN fleet peer")))));
const date = (milliseconds: number) => {
  const iso = new Date(milliseconds).toISOString();
  const generalized = iso.slice(0, 19).replaceAll(/[-:T]/gu, "") + "Z";
  const utc = milliseconds >= Date.UTC(1950, 0, 1) && milliseconds < Date.UTC(2050, 0, 1);
  return der(utc ? 0x17 : 0x18, Buffer.from(utc ? generalized.slice(2) : generalized));
};
const extension = (id: string, content: Buffer, critical = false) =>
  sequence(oid(id), ...(critical ? [der(0x01, Buffer.from([255]))] : []), der(0x04, content));

export function fleetTlsPublicKeySha256(key: NodeCrypto.KeyObject): string {
  return NodeCrypto.createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function createFleetTlsCertificate(input: {
  readonly address: string;
  readonly now: number;
  readonly privateKey?: string;
}) {
  // Managed LAN endpoints use an actual advertised IPv4 address, never a bind
  // wildcard, guessed hostname or special loopback fallback for another machine.
  if (!NodeNet.isIPv4(input.address) || input.address === "0.0.0.0" || !Number.isFinite(input.now))
    throw new Error("A managed fleet certificate requires its actual IPv4 address.");
  const privateKey =
    input.privateKey === undefined
      ? NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
      : NodeCrypto.createPrivateKey(input.privateKey);
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error("Unsupported fleet TLS key.");
  const publicKey = NodeCrypto.createPublicKey(privateKey);
  const serial = NodeCrypto.randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 1;
  serial[15] = serial[15]! | 1;
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    signatureAlgorithm(),
    name(),
    sequence(date(input.now - 5 * 60_000), date(input.now + 365 * 24 * 60 * 60_000)),
    name(),
    publicKey.export({ type: "spki", format: "der" }),
    der(
      0xa3,
      sequence(
        extension("551d13", sequence(), true), // basicConstraints: CA=false
        extension("551d0f", der(0x03, Buffer.from([7, 0x80])), true),
        extension("551d25", sequence(oid("2b06010505070301"))), // serverAuth
        extension("551d11", sequence(der(0x87, Buffer.from(input.address.split(".").map(Number))))),
      ),
    ),
  );
  const bytes = sequence(
    body,
    signatureAlgorithm(),
    der(0x03, Buffer.from([0]), NodeCrypto.sign("sha256", body, privateKey)),
  );
  const certificate = `-----BEGIN CERTIFICATE-----\n${bytes
    .toString("base64")
    .match(/.{1,64}/gu)!
    .join("\n")}\n-----END CERTIFICATE-----\n`;
  const pin = fleetTlsPublicKeySha256(publicKey);
  if (!verifyFleetTlsCertificate(certificate, input.address, pin, input.now))
    throw new Error("Generated fleet certificate did not validate.");
  return {
    certificate,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySha256: pin,
  };
}

export function verifyFleetTlsCertificate(
  pem: string,
  hostname: string,
  expectedPublicKeySha256: string,
  now: number,
): boolean {
  if (
    pem.length > 16_384 ||
    !/^[a-f0-9]{64}$/u.test(expectedPublicKeySha256) ||
    !Number.isFinite(now)
  )
    return false;
  try {
    const certificate = new NodeCrypto.X509Certificate(pem);
    return (
      !certificate.ca &&
      certificate.publicKey.asymmetricKeyType === "ec" &&
      certificate.publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1" &&
      certificate.verify(certificate.publicKey) &&
      fleetTlsPublicKeySha256(certificate.publicKey) === expectedPublicKeySha256 &&
      Date.parse(certificate.validFrom) <= now &&
      now < Date.parse(certificate.validTo) &&
      (NodeNet.isIP(hostname) !== 0
        ? certificate.checkIP(hostname) !== undefined
        : certificate.checkHost(hostname) !== undefined)
    );
  } catch {
    return false;
  }
}
