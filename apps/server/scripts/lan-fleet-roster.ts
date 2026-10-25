// @effect-diagnostics nodeBuiltinImport:off -- This offline administrator command accepts explicit input/output paths and never loads a T3 home or credentials.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { FleetRoster, LanFleetError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { readFleetJson, writeFleetRoster } from "../src/lan/FleetFiles.ts";

const args = process.argv.slice(2);
NodeRuntime.runMain(
  Effect.gen(function* () {
    if (args.length !== 2) return yield* new LanFleetError({ reason: "configuration" });
    const path = yield* Path.Path;
    const source = path.resolve(args[0]!);
    const destination = path.resolve(args[1]!);
    const roster = yield* readFleetJson(source, FleetRoster);
    yield* writeFleetRoster(destination, roster);
    yield* Effect.log("Fleet roster validated and replaced atomically.");
  }).pipe(Effect.provide(NodeServices.layer)),
);
