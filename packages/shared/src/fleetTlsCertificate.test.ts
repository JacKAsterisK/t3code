// @effect-diagnostics nodeBuiltinImport:off -- The fixture independently inspects the actual X.509 leaf and private key.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { createFleetTlsCertificate, verifyFleetTlsCertificate } from "./fleetTlsCertificate.ts";

const now = 1_798_848_000_000;

it("creates a non-CA server certificate bound to a synthetic address and stable private key", () => {
  const first = createFleetTlsCertificate({ address: "192.168.40.10", now });
  const certificate = new NodeCrypto.X509Certificate(first.certificate);
  expect(certificate.ca).toBe(false);
  expect(certificate.checkPrivateKey(NodeCrypto.createPrivateKey(first.privateKey))).toBe(true);
  expect(
    verifyFleetTlsCertificate(first.certificate, "192.168.40.10", first.publicKeySha256, now),
  ).toBe(true);
  const renewed = createFleetTlsCertificate({
    address: "192.168.40.10",
    now: now + 60_000,
    privateKey: first.privateKey,
  });
  expect(renewed.privateKey).toBe(first.privateKey);
  expect(renewed.publicKeySha256).toBe(first.publicKeySha256);
});

it("rejects a different address, unapproved key, invalid certificate and expired identity", () => {
  const first = createFleetTlsCertificate({ address: "192.168.40.10", now });
  expect(
    verifyFleetTlsCertificate(first.certificate, "192.168.40.11", first.publicKeySha256, now),
  ).toBe(false);
  expect(verifyFleetTlsCertificate(first.certificate, "192.168.40.10", "0".repeat(64), now)).toBe(
    false,
  );
  expect(verifyFleetTlsCertificate("invalid", "192.168.40.10", first.publicKeySha256, now)).toBe(
    false,
  );
  expect(
    verifyFleetTlsCertificate(
      first.certificate,
      "192.168.40.10",
      first.publicKeySha256,
      now + 366 * 24 * 60 * 60_000,
    ),
  ).toBe(false);
});

it("refuses wildcard addresses and guessed names as managed listener identities", () => {
  for (const address of ["0.0.0.0", "machine.example.test", "", "256.1.1.1"])
    expect(() => createFleetTlsCertificate({ address, now })).toThrow();
});
