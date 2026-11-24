// @effect-diagnostics nodeBuiltinImport:off -- The native store stays external to the portable inspection and home-repair bundles.
import * as NodeModule from "node:module";
import { LanFleetError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Config from "../config.ts";
import { readFleetVaultRecord } from "./FleetVaultCodec.ts";
import { FLEET_ROSTER_ENV, fleetLocalName } from "./FleetBootstrap.ts";

// Resolve the normal server's external dependency only when startup found a valid legacy file.
// Offline inspection and home repair never instantiate the fleet policy runtime.
const requireExternal = NodeModule.createRequire(import.meta.url);
const readStartupEntry = (id: string, platform: NodeJS.Platform) => {
  const { Entry, AsyncEntry } = requireExternal(
    "@napi-rs/keyring",
  ) as typeof import("@napi-rs/keyring");
  return platform === "win32"
    ? new Entry("T3 Code LAN fleet", id)
    : new AsyncEntry("T3 Code LAN fleet", id);
};

// Startup can check an existing identity before descriptor services initialize. Reading the
// persisted ID never creates a new one and uses the same credential target and decoder as enrollment.
export const readStartupCredential = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const id = (yield* fs.readFileString(config.environmentIdPath)).trim();
  if (id === "") return yield* new LanFleetError({ reason: "configuration" });
  const rosterPath = (yield* HostProcess.Environment)[FLEET_ROSTER_ENV];
  return yield* readFleetVaultRecord(() =>
    readStartupEntry(fleetLocalName(id, rosterPath), platform),
  );
}).pipe(Effect.mapError(() => new LanFleetError({ reason: "configuration" })));
