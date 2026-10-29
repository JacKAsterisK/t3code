// @effect-diagnostics nodeBuiltinImport:off -- This offline administrator command reads the named roster's folder and never loads a T3 home or credentials.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { FleetRoster, LanFleetError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FleetAuthority } from "../src/lan/FleetAuthority.ts";
import { FleetAccessSeed, SEED_FILE } from "../src/lan/FleetAccessPolicy.ts";
import { readFleetJson, writeFleetJson } from "../src/lan/FleetFiles.ts";

// node apps/server/scripts/lan-fleet-access-seed.ts <roster.json> <machineId>... [--write]
// Prints the starting access list that makes the named machines read-only; --write places it
// beside the roster. It refuses once a list exists, since machines would then ignore it.
const args = process.argv.slice(2);
const write = args.includes("--write");
const [rosterArg, ...machineIds] = args.filter((arg) => arg !== "--write");
const refuse = (message: string) =>
  Effect.logError(message).pipe(Effect.andThen(new LanFleetError({ reason: "configuration" })));
const decodeSeed = Schema.decodeUnknownEffect(FleetAccessSeed);

NodeRuntime.runMain(
  Effect.gen(function* () {
    if (rosterArg === undefined || machineIds.length === 0)
      return yield* refuse(
        "Usage: lan-fleet-access-seed.ts <roster.json> <machineId>... [--write]",
      );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roster = path.resolve(rosterArg);
    const root = path.dirname(roster);
    const machines = (yield* readFleetJson(roster, FleetRoster)).machines;
    const authority = yield* readFleetJson(path.join(root, "fleet-authority.json"), FleetAuthority);
    for (const machineId of machineIds)
      if (!machines.some((machine) => machine.machineId === machineId && machine.enabled))
        return yield* refuse(`${machineId} is not an enabled machine in ${roster}.`);
    const seed = yield* decodeSeed({
      version: 1,
      fleetId: authority.fleetId,
      readOnly: machineIds,
    });
    for (const machineId of machineIds)
      yield* Effect.log(
        `read-only: ${machineId} (${machines.find((machine) => machine.machineId === machineId)?.label})`,
      );
    yield* Effect.log(JSON.stringify(seed));
    if (!write) return;
    const history = path.join(root, "fleet-access");
    if ((yield* fs.exists(history)) && (yield* fs.readDirectory(history)).length > 0)
      return yield* refuse(`${history} already holds a list; machines ignore a starting list now.`);
    const file = path.join(root, SEED_FILE);
    if (yield* fs.exists(file)) return yield* refuse(`${file} already exists.`);
    yield* writeFleetJson(file, seed);
    yield* Effect.log(`Wrote ${file}.`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
