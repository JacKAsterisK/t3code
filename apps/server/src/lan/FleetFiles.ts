// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off -- Atomic JSON files are decoded at both boundaries; random names prevent concurrent temporary-file collisions.
import * as NodeCrypto from "node:crypto";
import { FleetRoster, LanFleetError } from "@t3tools/contracts";
import { strictJson } from "@t3tools/shared/strictJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { secureOrigin } from "./GatewayT3OAuthClient.ts";

export const readFleetJson = Effect.fn("FleetFiles.read")(function* <A>(
  file: string,
  schema: Schema.Codec<A, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(file);
  if (Number(stat.size) > 1024 * 1024) return yield* new LanFleetError({ reason: "configuration" });
  const raw = yield* fs.readFileString(file);
  if (raw.length > 1024 * 1024) return yield* new LanFleetError({ reason: "configuration" });
  const parsed = yield* Effect.try(() => strictJson(new TextEncoder().encode(raw)));
  return yield* Schema.decodeUnknownEffect(schema)(parsed, { onExcessProperty: "error" });
});

export const writeFleetJson = Effect.fn("FleetFiles.write")(function* (
  file: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temp, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(JSON.stringify(value)));
      yield* file.sync;
    }),
  );
  yield* fs.rename(temp, file).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)));
});

export function validateRoster(roster: FleetRoster): FleetRoster {
  if (
    new Set(roster.machines.map((m) => m.machineId)).size !== roster.machines.length ||
    new Set(roster.machines.map((m) => m.environmentId)).size !== roster.machines.length
  )
    throw new Error("Duplicate fleet identity");
  for (const machine of roster.machines) {
    if (secureOrigin(machine.origin) !== machine.origin)
      throw new Error("Fleet origin must be canonical");
  }
  return roster;
}

const decodeRoster = Schema.decodeUnknownEffect(FleetRoster);

export const writeFleetRoster = Effect.fn("FleetFiles.writeRoster")(function* (
  file: string,
  input: unknown,
) {
  const roster = yield* decodeRoster(input, {
    onExcessProperty: "error",
  });
  yield* Effect.try(() => validateRoster(roster));
  yield* writeFleetJson(file, roster);
});
