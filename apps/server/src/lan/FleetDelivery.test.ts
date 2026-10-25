import { describe, expect, it } from "@effect/vitest";
import { FleetRoster } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Delivery from "./FleetDelivery.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { validateRoster } from "./FleetFiles.ts";

const now = 1_800_000_000_000;
const credential = "synthetic-pairing-code";
const decodeRoster = Schema.decodeUnknownSync(FleetRoster);
const fixture = () => {
  const a = syntheticFleetPeer("alpha");
  const b = syntheticFleetPeer("beta");
  const peers = [a.peer, b.peer];
  const config = (identity: typeof a): Delivery.FleetPrivateConfig => ({
    version: 1,
    machineId: identity.peer.machineId,
    rosterPath: "unused",
    deliveryDirectory: "unused",
    autoPickup: false,
    ...identity,
    peers,
  });
  const senderConfig = config(a);
  const recipientConfig = config(b);
  const envelope = Delivery.sealDelivery({
    config: senderConfig,
    sender: a.peer,
    recipient: b.peer,
    deliveryId: "00000000-0000-4000-8000-000000000001",
    expiresAt: now + 60_000,
    credential,
  });
  return { a, b, senderConfig, recipientConfig, envelope };
};

describe("recipient-protected fleet deliveries", () => {
  it("keeps the code and private keys off shared storage and opens only for the assigned peer", () => {
    const f = fixture();
    const wire = JSON.stringify(f.envelope);
    expect(wire).not.toContain(credential);
    expect(wire).not.toContain("PRIVATE KEY");
    expect(
      Delivery.openDelivery(f.envelope, f.recipientConfig, f.a.peer, f.b.peer, now).credential,
    ).toBe(credential);
    expect(() =>
      Delivery.openDelivery(f.envelope, f.senderConfig, f.a.peer, f.b.peer, now),
    ).toThrow();
    expect(() =>
      Delivery.openDelivery(f.envelope, f.recipientConfig, f.a.peer, f.a.peer, now),
    ).toThrow();
  });

  it("rejects tampering, untrusted signing keys, expiry, and changed environment identities", () => {
    const f = fixture();
    const open = (delivery = f.envelope, sender = f.a.peer, at = now) =>
      Delivery.openDelivery(delivery, f.recipientConfig, sender, f.b.peer, at);
    expect(() => open({ ...f.envelope, ciphertext: f.envelope.ciphertext.slice(4) })).toThrow();
    expect(() =>
      open({ ...f.envelope, header: { ...f.envelope.header, expiresAt: now + 120_000 } }),
    ).toThrow();
    expect(() =>
      open(f.envelope, { ...f.a.peer, signingPublicKey: f.b.peer.signingPublicKey }),
    ).toThrow();
    expect(() => open(f.envelope, f.a.peer, now + 60_000)).toThrow();
    expect(() =>
      open(f.envelope, { ...f.a.peer, environmentId: f.b.peer.environmentId }),
    ).toThrow();
    expect(() => Delivery.validateFleetKeys(f.recipientConfig, f.a.peer)).toThrow();
  });

  it("accepts only the assigned recipient's signed receipt for the exact delivery", () => {
    const f = fixture();
    const receipt = Delivery.makeReceipt(f.envelope, f.recipientConfig);
    expect(Delivery.verifyReceipt(receipt, f.envelope.header.deliveryId, f.a.peer, f.b.peer)).toBe(
      true,
    );
    expect(Delivery.verifyReceipt(receipt, "another-delivery", f.a.peer, f.b.peer)).toBe(false);
    expect(
      Delivery.verifyReceipt(
        { ...receipt, recipientId: "alpha" },
        f.envelope.header.deliveryId,
        f.a.peer,
        f.b.peer,
      ),
    ).toBe(false);
  });

  it("rejects duplicate IDs, secret-bearing metadata, and insecure or noncanonical origins", () => {
    const machine = {
      machineId: "alpha",
      environmentId: "environment:alpha",
      label: "Alpha",
      origin: "https://alpha.example.test",
      enabled: true,
    };
    const parse = (value: unknown) =>
      validateRoster(decodeRoster(value, { onExcessProperty: "error" }));
    expect(() => parse({ version: 1, machines: [machine, machine] })).toThrow();
    expect(() => parse({ version: 1, machines: [{ ...machine, credential }] })).toThrow();
    for (const origin of [
      "http://alpha.example.test",
      "https://user:secret@alpha.example.test",
      "https://alpha.example.test/#token",
      "https://alpha.example.test/path",
    ])
      expect(() => parse({ version: 1, machines: [{ ...machine, origin }] })).toThrow();
  });
});
