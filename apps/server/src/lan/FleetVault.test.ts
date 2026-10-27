import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, FleetMachineId } from "@t3tools/contracts";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetVault from "./FleetVault.ts";
import { generateFleetIdentity } from "./FleetAuthority.ts";

const keyring = vi.hoisted(() => ({
  value: null as string | null | undefined,
  failure: false,
  secret: undefined as Uint8Array | number[] | null | undefined,
  writeFailure: false,
  secretWriteAttempts: 0,
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    async getSecret() {
      if (keyring.failure) throw new Error("synthetic keyring failure");
      return (
        keyring.secret ??
        (typeof keyring.value === "string" ? Buffer.from(keyring.value, "utf16le") : keyring.value)
      );
    }
    async getPassword() {
      if (keyring.failure) throw new Error("synthetic keyring failure");
      return keyring.value;
    }
    async setPassword(value: string) {
      if (Buffer.byteLength(value, "utf16le") > 2560)
        throw new Error("synthetic Windows credential size limit");
      keyring.value = value;
    }
    async setSecret(value: Uint8Array) {
      keyring.secretWriteAttempts++;
      if (keyring.writeFailure || value.length > 2560)
        throw new Error("synthetic credential write failure");
      // The native async keyring returns a plain array despite its typed-array declaration.
      keyring.secret = Array.from(value);
      keyring.value = undefined;
    }
  },
}));

const environmentId = EnvironmentId.make("environment:fleet-vault-synthetic");
const vaultLayer = FleetVault.layer.pipe(
  Layer.provide(Config.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-vault-test-" })),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);
const read = FleetVault.FleetVault.pipe(Effect.flatMap((vault) => vault.read));
const recordFixture = () => ({
  version: 1 as const,
  fleetId: "synthetic-fleet",
  machineId: FleetMachineId.make("synthetic-machine"),
  environmentId,
  encryptionPrivateKey: "synthetic-encryption-key",
  signingPrivateKey: "synthetic-signing-key",
  rootPublicKey: "synthetic-root-key",
  lastRevision: 0,
  enabled: true,
  autoPickup: false,
  access: "read-only" as const,
});
const reset = () => {
  keyring.secret = undefined;
  keyring.value = undefined;
  keyring.failure = false;
  keyring.writeFailure = false;
  keyring.secretWriteAttempts = 0;
};

it.layer(NodeServices.layer)("fleet credential storage", (it) => {
  it.effect.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ])("treats a missing keyring result ($label) as unconfigured", ({ value }) =>
    Effect.gen(function* () {
      reset();
      keyring.value = value;
      keyring.failure = false;
      assert.isUndefined(yield* read);
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("can initialize a new fleet record when the Windows keyring returns null", () =>
    Effect.gen(function* () {
      reset();
      keyring.value = null;
      keyring.failure = false;
      const record = {
        version: 1 as const,
        fleetId: "synthetic-fleet",
        machineId: FleetMachineId.make("synthetic-machine"),
        environmentId,
        encryptionPrivateKey: "synthetic-encryption-key",
        signingPrivateKey: "synthetic-signing-key",
        rootPublicKey: "synthetic-root-key",
        lastRevision: 0,
        enabled: true,
        autoPickup: false,
        access: "read-only" as const,
      };
      const vault = yield* FleetVault.FleetVault;
      yield* vault.save(record);
      assert.deepEqual(yield* vault.read, record);
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("stores a real owner and managed TLS record within the Windows credential limit", () =>
    Effect.gen(function* () {
      reset();
      const owner = generateFleetIdentity(
        environmentId,
        "00000000-0000-4000-8000-000000000001",
        "",
        true,
        { autoPickup: true, access: "standard" },
      );
      const record = {
        ...owner,
        tls: {
          origin: "https://192.168.2.25:3774",
          ...createFleetTlsCertificate({ address: "192.168.2.25", now: 1_800_000_000_000 }),
        },
        tlsEnabled: true,
      };
      assert.isAbove(Buffer.byteLength(JSON.stringify(record), "utf16le"), 2560);
      const vault = yield* FleetVault.FleetVault;
      yield* vault.save(record);
      assert.isAtMost(keyring.secret!.length, 2560);
      assert.deepEqual(yield* vault.read, record);
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect(
    "reads legacy UTF-16 password records and preserves their keys when upgrading storage",
    () =>
      Effect.gen(function* () {
        reset();
        const record = { ...recordFixture(), fleetId: "legacy-fleet-鍵", lastRevision: 7 };
        const original = JSON.stringify(record);
        keyring.value = original;
        const vault = yield* FleetVault.FleetVault;
        assert.deepEqual(yield* vault.read, record);
        assert.equal(keyring.secretWriteAttempts, 0);
        assert.equal(keyring.value, original);
        yield* vault.save({ ...record, autoPickup: true, lastRevision: 2 });
        assert.deepEqual(yield* vault.read, { ...record, autoPickup: true });
        assert.equal(keyring.secretWriteAttempts, 1);
      }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("keeps an existing credential intact when its replacement write fails", () =>
    Effect.gen(function* () {
      reset();
      const record = recordFixture(),
        original = JSON.stringify(record);
      keyring.value = original;
      keyring.writeFailure = true;
      const vault = yield* FleetVault.FleetVault;
      assert.equal(
        (yield* vault.save({ ...record, autoPickup: true }).pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.equal(keyring.value, original);
      assert.isUndefined(keyring.secret);
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("refuses an oversized Windows blob before attempting to write it", () =>
    Effect.gen(function* () {
      reset();
      const vault = yield* FleetVault.FleetVault;
      assert.equal(
        (yield* vault
          .save({ ...recordFixture(), encryptionPrivateKey: "x".repeat(3000) })
          .pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.equal(keyring.secretWriteAttempts, 0);
      assert.isUndefined(keyring.secret);
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("still refuses malformed saved credentials", () =>
    Effect.gen(function* () {
      reset();
      keyring.value = "{invalid-json";
      keyring.failure = false;
      assert.equal((yield* read.pipe(Effect.flip)).reason, "configuration");
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("still refuses an actual keyring failure", () =>
    Effect.gen(function* () {
      reset();
      keyring.value = undefined;
      keyring.failure = true;
      assert.equal((yield* read.pipe(Effect.flip)).reason, "configuration");
      keyring.failure = false;
    }).pipe(Effect.provide(vaultLayer)),
  );
});
