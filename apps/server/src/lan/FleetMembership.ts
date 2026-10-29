// @effect-diagnostics preferSchemaOverJson:off -- Compares schema-validated records only, to skip unchanged writes.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { FleetPeer } from "./FleetDelivery.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

/**
 * A machine that a trust check stops finding has left only once it stays missing for this long,
 * over at least `DEPARTURE_CHECKS` successful checks. A machine shown disabled leaves at once.
 */
export const DEPARTURE_GRACE_MS = 15 * 60 * 1000;
export const DEPARTURE_CHECKS = 3;

const Tracked = Schema.Struct({
  peer: FleetPeer,
  missedSince: Schema.optionalKey(Schema.Number),
  misses: Schema.Number,
});
type Tracked = typeof Tracked.Type;
const Saved = Schema.Struct({
  version: Schema.Literal(1),
  machines: Schema.Array(Tracked).check(Schema.isMaxLength(200)),
});

/**
 * One successful trust check against what earlier ones found. Read errors never get here: only
 * a check that succeeded can count a machine as missing.
 */
function trackMembership(input: {
  readonly tracked: ReadonlyArray<Tracked>;
  /** The enabled machines this check found. */
  readonly present: ReadonlyArray<FleetPeer>;
  /** Machines this check positively showed disabled. */
  readonly removed: ReadonlySet<string>;
  readonly now: number;
}): { readonly tracked: ReadonlyArray<Tracked>; readonly retained: ReadonlyArray<FleetPeer> } {
  const present = new Set(input.present.map((peer) => peer.machineId));
  const environments = new Set(input.present.map((peer) => peer.environmentId));
  const tracked: Array<Tracked> = input.present.map((peer) => ({ peer, misses: 0 }));
  const retained: Array<FleetPeer> = [];
  for (const item of input.tracked) {
    if (present.has(item.peer.machineId) || input.removed.has(item.peer.machineId)) continue;
    // Another machine now uses its environment: that is a successful read showing it replaced.
    if (environments.has(item.peer.environmentId)) continue;
    const missedSince = item.missedSince ?? input.now;
    const misses = item.misses + 1;
    if (misses >= DEPARTURE_CHECKS && input.now - missedSince >= DEPARTURE_GRACE_MS) continue;
    tracked.push({ peer: item.peer, missedSince, misses });
    retained.push(item.peer);
  }
  return { tracked, retained };
}

/** A persisted `trackMembership`, so a restart does not count a missed machine as departed. */
export const makeMembership = Effect.fn("FleetMembership.make")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  let tracked: ReadonlyArray<Tracked> = yield* readFleetJson(file, Saved).pipe(
    Effect.map((saved) => saved.machines),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.orElseSucceed(() => []),
  );
  return {
    /** The machines missed by this check that have not left yet. */
    check: (present: ReadonlyArray<FleetPeer>, removed: ReadonlySet<string>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const result = trackMembership({
            tracked,
            present,
            removed,
            now: yield* Clock.currentTimeMillis,
          });
          if (JSON.stringify(result.tracked) !== JSON.stringify(tracked)) {
            tracked = result.tracked;
            yield* writeFleetJson(file, { version: 1, machines: tracked }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.tapError((cause) =>
                Effect.logWarning("Fleet membership could not be saved.", { cause }),
              ),
              Effect.ignore,
            );
          }
          for (const peer of result.retained)
            yield* Effect.logWarning(
              "A fleet machine is missing from the trust check; it keeps its access until it stays missing.",
              { machineId: peer.machineId },
            );
          return result.retained;
        }),
      ),
  };
});
