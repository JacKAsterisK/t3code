// @effect-diagnostics globalJsonInEffect:off -- The encrypted vault persists a validated acyclic credential document.
// @effect-diagnostics preferSchemaOverJson:off -- The OS credential store contains a schema-validated local secret, never a shared roster entry.
import { AsyncEntry, Entry } from "@napi-rs/keyring";
import { LanFleetError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { FleetVaultRecord } from "./FleetAuthority.ts";
import { readFleetVaultRecord, secretMarker } from "./FleetVaultCodec.ts";

export class FleetVault extends Context.Service<
  FleetVault,
  {
    readonly read: Effect.Effect<FleetVaultRecord | undefined, LanFleetError>;
    readonly save: (record: FleetVaultRecord) => Effect.Effect<void, LanFleetError>;
    readonly advanceRevision: (
      expected: FleetVaultRecord,
      revision: number,
    ) => Effect.Effect<void, LanFleetError>;
  }
>()("t3/lan/FleetVault") {}

const credentialEntry = (id: string, platform: NodeJS.Platform) =>
  // On Windows the synchronous store must stay on the calling thread.
  platform === "win32"
    ? new Entry("T3 Code LAN fleet", id)
    : new AsyncEntry("T3 Code LAN fleet", id);

const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const id = yield* environment.getEnvironmentId;
  const mutex = yield* Semaphore.make(1);
  let knownIdentity = false;
  const entry = () => credentialEntry(id, platform);
  const lock = path.join(config.stateDir, "lan-fleet-vault.lock");
  const readStored = readFleetVaultRecord(entry).pipe(
    Effect.flatMap((record) => {
      if (record !== undefined) knownIdentity = true;
      else if (knownIdentity) return Effect.fail(new LanFleetError({ reason: "configuration" }));
      return Effect.succeed(record);
    }),
  );
  const read = readStored.pipe(mutex.withPermit);
  const update = Effect.fn("FleetVault.update")(function* (
    select: (
      previous: FleetVaultRecord | undefined,
    ) => Effect.Effect<FleetVaultRecord | undefined, LanFleetError>,
  ) {
    yield* Effect.acquireUseRelease(
      fs.makeDirectory(lock).pipe(Effect.mapError(() => new LanFleetError({ reason: "busy" }))),
      () =>
        Effect.gen(function* () {
          const previous = yield* readStored;
          const record = yield* select(previous);
          if (record === undefined) return;
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
            try: async () => {
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
              await entry().setSecret(secret);
              knownIdentity = true;
            },
            catch: () => new LanFleetError({ reason: "unavailable" }),
          });
        }),
      () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
    );
  }, mutex.withPermit);
  const save = (record: FleetVaultRecord) => update(() => Effect.succeed(record));

  const advanceRevision = Effect.fn("FleetVault.advanceRevision")(
    (expected: FleetVaultRecord, revision: number) =>
      update((previous) => {
        if (
          previous === undefined ||
          previous.environmentId !== expected.environmentId ||
          previous.fleetId !== expected.fleetId ||
          previous.machineId !== expected.machineId ||
          previous.rootPublicKey !== expected.rootPublicKey
        )
          return Effect.fail(new LanFleetError({ reason: "configuration" }));
        return Effect.succeed(
          revision > previous.lastRevision ? { ...previous, lastRevision: revision } : undefined,
        );
      }),
  );

  return FleetVault.of({ read, save, advanceRevision });
});
export const layer = Layer.effect(FleetVault, make);
