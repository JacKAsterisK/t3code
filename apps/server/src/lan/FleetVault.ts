// @effect-diagnostics preferSchemaOverJson:off -- The OS credential store contains a schema-validated local secret, never a shared roster entry.
import { AsyncEntry } from "@napi-rs/keyring";
import { LanFleetError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
const secretMarker = "T3F1:";
const secretPrefix = new TextEncoder().encode(secretMarker);
const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const id = yield* environment.getEnvironmentId;
  const entry = () => new AsyncEntry("T3 Code LAN fleet", id);
  const lock = path.join(config.stateDir, "lan-fleet-vault.lock");
  const read = Effect.tryPromise({
    try: async () => {
      const raw = await entry().getSecret();
      // Windows keyring returns null for an absent credential despite its TypeScript declaration.
      if (raw === undefined || raw === null) return undefined;
      if (
        raw.length >= secretPrefix.length &&
        secretPrefix.every((value, index) => raw[index] === value)
      )
        return decode(
          new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(secretPrefix.length)),
        );
      // Existing entries use the keyring's UTF-16 password encoding. Read them
      // without rewriting or regenerating any identity material.
      const legacy = await entry().getPassword();
      if (legacy === undefined || legacy === null)
        throw new Error("Existing fleet credential cannot be decoded.");
      return decode(legacy);
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
            try: () => {
              // Password encoding doubles this JSON on Windows. Store bounded
              // UTF-8 bytes in the same OS-protected credential instead.
              const secret = new TextEncoder().encode(
                secretMarker +
                  JSON.stringify({
                    ...record,
                    lastRevision: Math.max(previous?.lastRevision ?? 0, record.lastRevision),
                  }),
              );
              if (platform === "win32" && secret.length > 2560)
                throw new Error("Fleet credential exceeds the Windows storage limit.");
              return entry().setSecret(secret);
            },
            catch: () => new LanFleetError({ reason: "unavailable" }),
          });
        }),
      () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
    );
  });
  return FleetVault.of({ read, save });
});
export const layer = Layer.effect(FleetVault, make);
