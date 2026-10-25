// @effect-diagnostics preferSchemaOverJson:off -- The OS credential store contains a schema-validated local secret, never a shared roster entry.
import { AsyncEntry } from "@napi-rs/keyring";
import { LanFleetError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FleetVaultRecord } from "./FleetAuthority.ts";

export class FleetVault extends Context.Service<
  FleetVault,
  {
    readonly read: Effect.Effect<FleetVaultRecord | undefined, LanFleetError>;
    readonly save: (record: FleetVaultRecord) => Effect.Effect<void, LanFleetError>;
  }
>()("t3/lan/FleetVault") {}

const decode = Schema.decodeSync(Schema.fromJsonString(FleetVaultRecord));
const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const id = yield* environment.getEnvironmentId;
  const entry = () => new AsyncEntry("T3 Code LAN fleet", id);
  const lock = path.join(config.stateDir, "lan-fleet-vault.lock");
  const read = Effect.tryPromise({
    try: async () => {
      const raw = await entry().getPassword();
      return raw === undefined ? undefined : decode(raw);
    },
    catch: () => new LanFleetError({ reason: "configuration" }),
  });
  const save = Effect.fn("FleetVault.save")(function* (record: FleetVaultRecord) {
    yield* Effect.acquireUseRelease(
      fs.makeDirectory(lock).pipe(Effect.mapError(() => new LanFleetError({ reason: "busy" }))),
      () =>
        Effect.gen(function* () {
          const previous = yield* read;
          if (
            record.environmentId !== id ||
            (previous !== undefined &&
              (previous.fleetId !== record.fleetId ||
                previous.machineId !== record.machineId ||
                previous.encryptionPrivateKey !== record.encryptionPrivateKey ||
                previous.signingPrivateKey !== record.signingPrivateKey ||
                previous.rootPublicKey !== record.rootPublicKey ||
                previous.rootPrivateKey !== record.rootPrivateKey)) ||
            (previous?.tls !== undefined &&
              (previous.tls.privateKey !== record.tls?.privateKey ||
                previous.tls.origin !== record.tls?.origin ||
                previous.tls.publicKeySha256 !== record.tls?.publicKeySha256))
          )
            return yield* new LanFleetError({ reason: "configuration" });
          yield* Effect.tryPromise({
            try: () =>
              entry().setPassword(
                JSON.stringify({
                  ...record,
                  lastRevision: Math.max(previous?.lastRevision ?? 0, record.lastRevision),
                }),
              ),
            catch: () => new LanFleetError({ reason: "unavailable" }),
          });
        }),
      () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
    );
  });
  return FleetVault.of({ read, save });
});
export const layer = Layer.effect(FleetVault, make);
