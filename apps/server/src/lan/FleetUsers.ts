// @effect-diagnostics preferSchemaOverJson:off -- Compares two schema-validated values for change, never parses.
/**
 * T3 Code LAN: the fleet's users, from fleet-users.json beside the roster. Each machine reads it
 * with its fleet sync and keeps the last good copy in userdata, so owner badges and this machine's
 * default owner survive the share being away. Owners are labels: nothing here grants access.
 */
import {
  type FleetUserId,
  type FleetUsersDirectory,
  FleetMachineId,
  FleetUsersFile,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerConfig from "../config.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

export const FLEET_USERS_FILE = "fleet-users.json";
const CACHE_FILE = "lan-fleet-users.json";

const LocalCache = Schema.Struct({
  version: Schema.Literal(1),
  machineId: FleetMachineId,
  // Null once the share is reachable without a users file: its users were removed.
  file: Schema.NullOr(FleetUsersFile),
});
type LocalCache = typeof LocalCache.Type;

export interface FleetUsersRefreshInput {
  readonly rosterPath: string;
  readonly machineId: string;
}

export class FleetUsers extends Context.Service<
  FleetUsers,
  {
    readonly current: Effect.Effect<FleetUsersDirectory>;
    /** Emits whenever a read changes the users or this machine's default owner. */
    readonly changes: Stream.Stream<FleetUsersDirectory>;
    /** Reads the share's file. An unreachable share or an invalid file keeps the last good copy. */
    readonly refresh: (input: FleetUsersRefreshInput) => Effect.Effect<FleetUsersDirectory>;
  }
>()("t3/lan/FleetUsers") {}

const directoryOf = (cache: LocalCache | undefined): FleetUsersDirectory => {
  const file = cache?.file ?? null;
  const defaultOwnerId: FleetUserId | null =
    file === null || cache === undefined || !Object.hasOwn(file.machineOwners, cache.machineId)
      ? null
      : (file.machineOwners[cache.machineId] ?? null);
  return {
    users: file?.users ?? [],
    machineId: cache?.machineId ?? null,
    defaultOwnerId,
  };
};

/** Rejects a file that names one user twice, so a badge never has two names. */
export function validateFleetUsers(file: FleetUsersFile): FleetUsersFile {
  if (new Set(file.users.map((user) => user.id)).size !== file.users.length)
    throw new Error("fleet-users.json names a user twice");
  return file;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const cacheFile = path.join(config.stateDir, CACHE_FILE);
  const mutex = yield* Semaphore.make(1);
  let cache: LocalCache | undefined = (yield* fs
    .exists(cacheFile)
    .pipe(Effect.orElseSucceed(() => false)))
    ? yield* readFleetJson(cacheFile, LocalCache).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  const state = yield* SubscriptionRef.make(directoryOf(cache));

  const readShare = Effect.fn("FleetUsers.readShare")(function* (rosterPath: string) {
    const root = path.dirname(rosterPath);
    // An unreachable share says nothing about the users; keep what this machine last read.
    if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false))))
      return { _tag: "unavailable" } as const;
    const file = path.join(root, FLEET_USERS_FILE);
    // Only a confirmed absence removes the users: exists is false for NotFound alone, and an
    // access or network error checking for the file keeps the last good copy too.
    const present = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => undefined));
    if (present === undefined) return { _tag: "unavailable" } as const;
    if (!present) return { _tag: "absent" } as const;
    return yield* readFleetJson(file, FleetUsersFile).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.flatMap((value) => Effect.try(() => validateFleetUsers(value))),
      Effect.map((value) => ({ _tag: "valid", value }) as const),
      Effect.catch((cause) => Effect.succeed({ _tag: "invalid", cause } as const)),
    );
  });

  const refresh = Effect.fn("FleetUsers.refresh")(
    function* (input: FleetUsersRefreshInput) {
      const read = yield* readShare(input.rosterPath);
      const kept = cache?.machineId === input.machineId ? cache.file : null;
      if (read._tag === "invalid")
        yield* Effect.logWarning(
          `${FLEET_USERS_FILE} on the fleet share cannot be used; the last good copy still applies.`,
          { cause: read.cause },
        );
      const next: LocalCache = {
        version: 1,
        machineId: input.machineId,
        file:
          read._tag === "valid"
            ? read.value
            : read._tag === "absent"
              ? null
              : // Unavailable or invalid.
                kept,
      };
      if (JSON.stringify(next) !== JSON.stringify(cache)) {
        yield* writeFleetJson(cacheFile, next).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.tapError((cause) =>
            Effect.logWarning("Fleet users cache could not be saved.", { cause }),
          ),
          Effect.ignore,
        );
        cache = next;
      }
      const updated = directoryOf(cache);
      if (JSON.stringify(updated) !== JSON.stringify(yield* SubscriptionRef.get(state)))
        yield* SubscriptionRef.set(state, updated);
      return updated;
    },
    (effect) => mutex.withPermits(1)(effect),
  );

  return FleetUsers.of({
    current: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    refresh,
  });
});

export const layer = Layer.effect(FleetUsers, make);

/** A fixed directory, for tests and machines outside a fleet. */
export const layerStatic = (directory: FleetUsersDirectory) =>
  Layer.effect(
    FleetUsers,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make(directory);
      return FleetUsers.of({
        current: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        refresh: Effect.fn("FleetUsers.refreshStatic")(function* () {
          return yield* SubscriptionRef.get(state);
        }),
      });
    }),
  );

/** The name a user goes by, or their raw id when the users file does not list them. */
export const ownerName = (
  directory: Pick<FleetUsersDirectory, "users">,
  ownerId: string | null | undefined,
): string | null =>
  ownerId == null ? null : (directory.users.find((user) => user.id === ownerId)?.name ?? ownerId);

/** The owner a thread an agent starts gets: the one it names, else its parent's. */
export const inheritedOwner = (
  named: string | undefined,
  parentOwnerId: string | null | undefined,
): { readonly ownerId?: string } => {
  const ownerId = named ?? parentOwnerId ?? undefined;
  return ownerId === undefined ? {} : { ownerId };
};

/** A directory with no users, for machines outside a fleet. */
export const NO_FLEET_USERS: FleetUsersDirectory = {
  users: [],
  machineId: null,
  defaultOwnerId: null,
};

/** A thread's owner for agent-facing results: its id and the name it goes by. */
export const threadOwnerFields = (
  directory: Pick<FleetUsersDirectory, "users">,
  ownerId: string | null | undefined,
) => ({ ownerId: ownerId ?? null, ownerName: ownerName(directory, ownerId) });
