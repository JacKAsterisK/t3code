import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, FleetMachineId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetVault from "./FleetVault.ts";

const keyring = vi.hoisted(() => ({
  value: null as string | null | undefined,
  failure: false,
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    async getPassword() {
      if (keyring.failure) throw new Error("synthetic keyring failure");
      return keyring.value;
    }
    async setPassword(value: string) {
      keyring.value = value;
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

it.layer(NodeServices.layer)("fleet credential storage", (it) => {
  it.effect.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ])("treats a missing keyring result ($label) as unconfigured", ({ value }) =>
    Effect.gen(function* () {
      keyring.value = value;
      keyring.failure = false;
      assert.isUndefined(yield* read);
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("can initialize a new fleet record when the Windows keyring returns null", () =>
    Effect.gen(function* () {
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

  it.effect("still refuses malformed saved credentials", () =>
    Effect.gen(function* () {
      keyring.value = "{invalid-json";
      keyring.failure = false;
      assert.equal((yield* read.pipe(Effect.flip)).reason, "configuration");
    }).pipe(Effect.provide(vaultLayer)),
  );

  it.effect("still refuses an actual keyring failure", () =>
    Effect.gen(function* () {
      keyring.value = undefined;
      keyring.failure = true;
      assert.equal((yield* read.pipe(Effect.flip)).reason, "configuration");
      keyring.failure = false;
    }).pipe(Effect.provide(vaultLayer)),
  );
});
