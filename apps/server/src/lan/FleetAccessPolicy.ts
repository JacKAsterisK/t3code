// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Ed25519 signs only schema-validated policy fields in a canonical order.
import * as NodeCrypto from "node:crypto";
import {
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type EnvironmentId,
  FleetAccess as FleetAccessLevel,
  FleetMachineId,
  LanFleetError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerConfig from "../config.ts";
import type { FleetPeer } from "./FleetDelivery.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

type Level = FleetAccessLevel;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const MachineAccess = Schema.Struct({ machineId: FleetMachineId, access: FleetAccessLevel });
const entryFields = {
  fleetId: Schema.String.check(Schema.isMaxLength(256)),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  signerMachineId: FleetMachineId,
  createdAt: Schema.Number,
  defaultAccess: FleetAccessLevel,
  machines: Schema.Array(MachineAccess).check(Schema.isMaxLength(100)),
  signature: Schema.String.check(Schema.isMaxLength(1024)),
};

/**
 * One revision of the fleet-wide policy: a full snapshot, signed by the machine that wrote it.
 * Version 1 follows one revision, or none for the first; version 2 joins competing revisions.
 */
export const FleetAccessEntry = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), previous: Schema.NullOr(Digest), ...entryFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    previous: Schema.Array(Digest).check(Schema.isMinLength(2), Schema.isMaxLength(16)),
    ...entryFields,
  }),
]);
export type FleetAccessEntry = typeof FleetAccessEntry.Type;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * `fleet-access-seed.json` beside the roster: machines that start read-only, and the access every
 * other machine (and Machines added later) starts with, for a fleet with no list yet. The first
 * machine to read it signs it in as revision 1.
 */
export const SEED_FILE = "fleet-access-seed.json";
export const FleetAccessSeed = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String.check(Schema.isMaxLength(256)),
  // Explicit, so the result never depends on which machine adopts it first.
  defaultAccess: FleetAccessLevel,
  readOnly: Schema.Array(FleetMachineId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type FleetAccessSeed = typeof FleetAccessSeed.Type;

/**
 * `fleet-access-ready/<machineId>.json` beside the roster, signed by that machine: it runs a build
 * that swaps in a replaced fleet credential. LAN 1.0.24 cannot, so adopting the starting list while
 * a machine it makes read-only still runs it would cut that machine's connections off.
 */
export const SEED_READY_DIRECTORY = "fleet-access-ready";
const SeedReady = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String.check(Schema.isMaxLength(256)),
  machineId: FleetMachineId,
  createdAt: Schema.Number,
  signature: Schema.String.check(Schema.isMaxLength(1024)),
});
type SeedReady = typeof SeedReady.Type;
const seedReadyData = (marker: SeedReady) =>
  JSON.stringify([
    "fleet-access-ready",
    marker.version,
    marker.fleetId,
    marker.machineId,
    marker.createdAt,
  ]);
/** How long a machine waits for those machines before adopting the starting list anyway. */
export const SEED_READY_WAIT_MS = 24 * 60 * 60 * 1000;
// When this machine first saw the fleet's starting list.
const SeedSeen = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String,
  firstSeenAt: Schema.Number,
});

export interface FleetAccessSnapshot {
  readonly defaultAccess: Level;
  readonly machines: ReadonlyArray<typeof MachineAccess.Type>;
}

const LocalCache = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String,
  machineId: FleetMachineId,
  peers: Schema.Array(Schema.Struct({ machineId: FleetMachineId, environmentId: Schema.String })),
  entries: Schema.Array(FleetAccessEntry).check(Schema.isMaxLength(10_000)),
  // Entries kept only so later ones still have their parents; they never count as verified.
  unverified: Schema.optionalKey(Schema.Array(Digest).check(Schema.isMaxLength(10_000))),
});
type LocalCache = typeof LocalCache.Type;

const entryData = (entry: FleetAccessEntry) =>
  JSON.stringify([
    entry.version,
    entry.fleetId,
    entry.revision,
    entry.previous,
    entry.signerMachineId,
    entry.createdAt,
    entry.defaultAccess,
    entry.machines.map((machine) => [machine.machineId, machine.access]),
  ]);

export const entryDigest = (entry: FleetAccessEntry) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([entryData(entry), entry.signature]))
    .digest("hex");

export const entryFileName = (entry: FleetAccessEntry) =>
  `${String(entry.revision).padStart(6, "0")}-${entryDigest(entry).slice(0, 16)}.json`;
const ENTRY_FILE = /^\d{6}-[a-f0-9]{16}\.json$/u;
// More entry files than this is a flood, not a history: the policy reads as unavailable.
const MAX_SHARE_ENTRIES = 1000;
// A change holds the share lock for moments; one older than this was left by a crash.
export const STALE_LOCK_MS = 2 * 60 * 1000;

const parentsOf = (entry: FleetAccessEntry): ReadonlyArray<string> =>
  entry.version === 2 ? entry.previous : entry.previous === null ? [] : [entry.previous];

const normalize = (machines: FleetAccessSnapshot["machines"]) =>
  [...new Map(machines.map((machine) => [machine.machineId, machine.access])).entries()]
    .map(([machineId, access]) => ({ machineId, access }))
    .sort((left, right) => (left.machineId < right.machineId ? -1 : 1));

const accessOf = (snapshot: FleetAccessSnapshot, machineId: string): Level =>
  snapshot.machines.find((machine) => machine.machineId === machineId)?.access ??
  snapshot.defaultAccess;

const sameSnapshot = (left: FleetAccessSnapshot, right: FleetAccessSnapshot) =>
  left.defaultAccess === right.defaultAccess &&
  JSON.stringify(normalize(left.machines)) === JSON.stringify(normalize(right.machines));

/** Each machine at the most restrictive access any of the snapshots gives it. */
function mostRestrictive(snapshots: ReadonlyArray<FleetAccessSnapshot>): FleetAccessSnapshot {
  const least = (levels: ReadonlyArray<Level>): Level =>
    levels.includes("read-only") ? "read-only" : "standard";
  const ids = new Set(snapshots.flatMap((snapshot) => snapshot.machines.map((m) => m.machineId)));
  return {
    defaultAccess: least(snapshots.map((snapshot) => snapshot.defaultAccess)),
    machines: normalize(
      [...ids].map((machineId) => ({
        machineId,
        access: least(snapshots.map((snapshot) => accessOf(snapshot, machineId))),
      })),
    ),
  };
}

/**
 * Before any policy every machine may write one. After that a standard machine may change
 * anything, and a read-only machine may only restrict itself.
 */
function authorizeAccessChange(
  previous: FleetAccessSnapshot | undefined,
  next: FleetAccessSnapshot,
  signerMachineId: string,
): boolean {
  if (previous === undefined || accessOf(previous, signerMachineId) === "standard") return true;
  if (next.defaultAccess !== previous.defaultAccess) return false;
  const others = (snapshot: FleetAccessSnapshot) =>
    JSON.stringify(normalize(snapshot.machines.filter((m) => m.machineId !== signerMachineId)));
  return others(previous) === others(next) && accessOf(next, signerMachineId) === "read-only";
}

/** A machine the fleet knows must remain able to change the policy, or no one could lift it. */
const keepsAStandardMachine = (snapshot: FleetAccessSnapshot, machineIds: ReadonlyArray<string>) =>
  machineIds.some((machineId) => accessOf(snapshot, machineId) === "standard");

export function signAccessEntry(
  entry: DistributiveOmit<FleetAccessEntry, "signature" | "machines"> & FleetAccessSnapshot,
  signingPrivateKey: string,
): FleetAccessEntry {
  const unsigned = {
    ...entry,
    machines: normalize(entry.machines),
    signature: "",
  } as FleetAccessEntry;
  return {
    ...unsigned,
    signature: NodeCrypto.sign(null, Buffer.from(entryData(unsigned)), signingPrivateKey).toString(
      "base64",
    ),
  };
}

function verifiedSigner(entry: FleetAccessEntry, peers: ReadonlyArray<FleetPeer>) {
  const signer = peers.find((peer) => peer.machineId === entry.signerMachineId && peer.enabled);
  if (signer === undefined) return false;
  const key = NodeCrypto.createPublicKey(signer.signingPublicKey);
  return (
    key.asymmetricKeyType === "ed25519" &&
    NodeCrypto.verify(
      null,
      Buffer.from(entryData(entry)),
      key,
      Buffer.from(entry.signature, "base64"),
    )
  );
}

export interface AccessRevision {
  readonly entry: FleetAccessEntry;
  readonly digest: string;
  /** Signed by a current peer's current key, or accepted here when it was. */
  readonly verified: boolean;
  /** What it grants: its snapshot, or for an unverified one, no more than its parents grant. */
  readonly effective: FleetAccessSnapshot;
}

export interface AccessEvaluation {
  readonly revisions: ReadonlyArray<AccessRevision>;
  /** Revisions nothing follows yet. Competing ones all apply, most restrictively. */
  readonly heads: ReadonlyArray<AccessRevision>;
  readonly snapshot: FleetAccessSnapshot | undefined;
  readonly revision: number;
}

/**
 * Each entry is checked against what its parents grant. One no current key verifies (its writer
 * left or changed keys) still restricts but never lifts. Competing heads combine to each machine's
 * most restrictive access, so no revision undoes a restriction another valid one imposes.
 */
function evaluateAccess(input: {
  readonly fleetId: string;
  readonly accepted: ReadonlyArray<FleetAccessEntry>;
  readonly candidates: ReadonlyArray<FleetAccessEntry>;
  readonly peers: ReadonlyArray<FleetPeer>;
}): AccessEvaluation {
  const sticky = new Set(input.accepted.map(entryDigest));
  const known = input.peers.map((peer) => peer.machineId);
  const entries = new Map<string, FleetAccessEntry>();
  for (const entry of [...input.accepted, ...input.candidates])
    if (entry.fleetId === input.fleetId) entries.set(entryDigest(entry), entry);
  const revisions = new Map<string, AccessRevision>();
  for (const [digest, entry] of [...entries].toSorted(
    ([leftDigest, left], [rightDigest, right]) =>
      left.revision - right.revision || (leftDigest < rightDigest ? -1 : 1),
  )) {
    const parents = parentsOf(entry).map((parent) => revisions.get(parent));
    if (parents.some((parent) => parent === undefined)) continue;
    const resolved = parents as ReadonlyArray<AccessRevision>;
    if (entry.revision !== 1 + Math.max(0, ...resolved.map((parent) => parent.entry.revision)))
      continue;
    if (
      !sticky.has(digest) &&
      (JSON.stringify(normalize(entry.machines)) !== JSON.stringify(entry.machines) ||
        // Without any peers (a cache read at startup) there is nothing to check this against.
        (known.length > 0 && !keepsAStandardMachine(entry, known)) ||
        !resolved.every((parent) =>
          authorizeAccessChange(parent.effective, entry, entry.signerMachineId),
        ))
    )
      continue;
    const verified = sticky.has(digest) || verifiedSigner(entry, input.peers);
    revisions.set(digest, {
      entry,
      digest,
      verified,
      effective: verified
        ? { defaultAccess: entry.defaultAccess, machines: entry.machines }
        : mostRestrictive([entry, ...resolved.map((parent) => parent.effective)]),
    });
  }
  const followed = new Set([...revisions.values()].flatMap((item) => parentsOf(item.entry)));
  const heads = [...revisions.values()].filter((item) => !followed.has(item.digest));
  return {
    revisions: [...revisions.values()],
    heads,
    snapshot: heads.length === 0 ? undefined : mostRestrictive(heads.map((head) => head.effective)),
    revision: Math.max(0, ...heads.map((head) => head.entry.revision)),
  };
}

const READ_ONLY_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
];

/** The scopes this machine issues to a fleet peer at that access. */
export const fleetCredentialScopes = (access: Level): ReadonlyArray<AuthEnvironmentScope> =>
  access === "read-only" ? READ_ONLY_SCOPES : AuthStandardClientScopes;

/** The access a credential this machine issued actually carries. */
export const credentialAccess = (credential: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly permissions?: ReadonlyArray<AuthEnvironmentScope> | undefined;
}): Level =>
  (credential.permissions ?? credential.scopes).includes(AuthOrchestrationOperateScope)
    ? "standard"
    : "read-only";

export interface FleetAccessState {
  /** Zero until a machine saves the first policy; until then `defaultAccess` is the legacy setting. */
  readonly revision: number;
  readonly defaultAccess: Level;
  readonly machines: FleetAccessSnapshot["machines"];
  readonly machineId: string | undefined;
  readonly peers: ReadonlyArray<{ readonly machineId: string; readonly environmentId: string }>;
  /**
   * The share's policy could not be read. The last accepted policy still caps credentials, and
   * with none nothing changes. Nothing is revoked or replaced for access until a read succeeds.
   */
  readonly unavailable?: boolean;
  /**
   * No list exists yet, but the share holds a starting list: one not adopted yet, or one that
   * cannot be used. Until a list exists nothing may be linked.
   */
  readonly seed?: "waiting" | "invalid";
  /**
   * While a usable starting list waits for machines it makes read-only to run a build that can
   * take a replaced credential: those machines, and when it is adopted anyway.
   */
  readonly seedPending?: {
    readonly machineIds: ReadonlyArray<string>;
    readonly adoptAt: number;
  };
}

export const machineAccess = (state: FleetAccessState, machineId: string) =>
  accessOf(state, machineId);
/** This machine's own access; outside any fleet, or before any saved policy, it is unrestricted. */
export const selfAccess = (state: FleetAccessState): Level =>
  state.machineId === undefined || state.revision === 0
    ? "standard"
    : accessOf(state, state.machineId);
/** Whether access follows a saved policy; before one, each credential keeps its access. */
export const policyApplies = (state: FleetAccessState) => state.revision > 0;
/**
 * Whether the fleet would link this machine to its peers: it was an enabled member at its last
 * fleet read, and a list exists. Only then do linked environments count as on here.
 */
export const fleetLinksApply = (state: FleetAccessState) =>
  policyApplies(state) &&
  state.machineId !== undefined &&
  state.peers.some((peer) => peer.machineId === state.machineId);
/**
 * Whether the policy was just read from the share. Only then may access revoke or replace
 * anything: a read error only caps, at the last accepted policy, so it never costs a machine a
 * credential that the share coming back would not restore.
 */
export const mayRevokeForAccess = (state: FleetAccessState) => state.unavailable !== true;

interface FleetAccessInput {
  readonly root: string;
  readonly fleetId: string;
  readonly machineId: string;
  readonly peers: ReadonlyArray<FleetPeer>;
  readonly legacyAccess: Level;
  /** When given, a read may re-sign a head whose writer's key no longer verifies. */
  readonly signingPrivateKey?: string;
}

/**
 * The fleet-wide access policy: what each machine may do on the others. Every issuing
 * machine applies it to the credentials it gives its peers, so the receiving side enforces it.
 */
export class FleetAccess extends Context.Service<
  FleetAccess,
  {
    /** The access a peer environment has here; undefined when it is not a fleet peer. */
    readonly accessFor: (environmentId: EnvironmentId) => Effect.Effect<Level | undefined>;
    readonly current: Effect.Effect<FleetAccessState>;
    /** Emits whenever a fleet read accepts a new policy revision or peer set. */
    readonly changes: Stream.Stream<FleetAccessState>;
    /** Reads the share's policy. Share failures keep the last accepted policy. */
    readonly refresh: (input: FleetAccessInput) => Effect.Effect<FleetAccessState>;
    /** Signs and publishes a new revision as this machine; refused if this machine may not. */
    readonly change: (
      input: FleetAccessInput & {
        readonly signingPrivateKey: string;
        readonly expectedRevision: number;
        readonly next: FleetAccessSnapshot;
      },
    ) => Effect.Effect<FleetAccessState, LanFleetError>;
  }
>()("t3/lan/FleetAccessPolicy/FleetAccess") {}

const configurationError = () => new LanFleetError({ reason: "configuration" });
const isFleetError = Schema.is(LanFleetError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const cacheFile = path.join(config.stateDir, "lan-fleet-access.json");
  const mutex = yield* Semaphore.make(1);
  const readCache = (yield* fs.exists(cacheFile).pipe(Effect.orElseSucceed(() => false)))
    ? yield* readFleetJson(cacheFile, LocalCache).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  let cache: LocalCache | undefined = readCache;
  const cachedEntries = (value: LocalCache | undefined) => {
    const unverified = new Set(value?.unverified ?? []);
    return {
      accepted: (value?.entries ?? []).filter((entry) => !unverified.has(entryDigest(entry))),
      kept: (value?.entries ?? []).filter((entry) => unverified.has(entryDigest(entry))),
    };
  };
  const stateOf = (
    value: LocalCache | undefined,
    evaluation: AccessEvaluation | undefined,
    legacyAccess: Level,
    unavailable: boolean,
    seed?: FleetAccessState["seed"],
    seedPending?: FleetAccessState["seedPending"],
  ): FleetAccessState => ({
    revision: evaluation?.revision ?? 0,
    defaultAccess: evaluation?.snapshot?.defaultAccess ?? legacyAccess,
    machines: evaluation?.snapshot?.machines ?? [],
    machineId: value?.machineId,
    peers: value?.peers ?? [],
    ...(unavailable ? { unavailable: true } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(seedPending === undefined ? {} : { seedPending }),
  });
  const startup =
    cache === undefined
      ? undefined
      : evaluateAccess({
          fleetId: cache.fleetId,
          ...((entries) => ({ accepted: entries.accepted, candidates: entries.kept }))(
            cachedEntries(cache),
          ),
          peers: [],
        });
  const state = yield* SubscriptionRef.make(stateOf(cache, startup, "standard", false));

  const readShare = Effect.fn("FleetAccess.readShare")(function* (directory: string) {
    if (!(yield* fs.exists(directory))) return [];
    const names = (yield* fs.readDirectory(directory)).filter((name) => ENTRY_FILE.test(name));
    if (names.length > MAX_SHARE_ENTRIES)
      return yield* new LanFleetError({ reason: "unavailable" });
    const entries: Array<FleetAccessEntry> = [];
    for (const name of names) {
      const entry = yield* readFleetJson(path.join(directory, name), FleetAccessEntry).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (entry !== undefined && entryFileName(entry) === name) entries.push(entry);
    }
    return entries;
  });

  type SeedRead =
    | { readonly _tag: "absent" }
    // The share did not answer. Wait for it: the file may not even exist.
    | { readonly _tag: "unavailable" }
    | { readonly _tag: "invalid"; readonly reason: string }
    | { readonly _tag: "valid"; readonly snapshot: FleetAccessSnapshot };
  const invalidSeed = (reason: string): SeedRead => ({ _tag: "invalid", reason });
  /** The share's starting list as a first revision; anything doubtful refuses it. */
  const readSeed = Effect.fn("FleetAccess.readSeed")(function* (input: FleetAccessInput) {
    const file = path.join(input.root, SEED_FILE);
    const exists = yield* Effect.result(fs.exists(file));
    if (exists._tag === "Failure") return { _tag: "unavailable" } satisfies SeedRead;
    if (!exists.success) return { _tag: "absent" } satisfies SeedRead;
    const seed = yield* readFleetJson(file, FleetAccessSeed).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.asSome,
      Effect.catchTags({ PlatformError: () => Effect.succeed("unavailable" as const) }),
      Effect.orElseSucceed(() => Option.none<FleetAccessSeed>()),
    );
    if (seed === "unavailable") return { _tag: "unavailable" } satisfies SeedRead;
    if (Option.isNone(seed)) return invalidSeed("malformed");
    const named = seed.value.readOnly;
    if (seed.value.fleetId !== input.fleetId) return invalidSeed("another fleet");
    if (
      new Set(named).size !== named.length ||
      named.some((machineId) => !input.peers.some((peer) => peer.machineId === machineId))
    )
      return invalidSeed("a machine it names is not in the fleet");
    const snapshot: FleetAccessSnapshot = {
      defaultAccess: seed.value.defaultAccess,
      machines: normalize(named.map((machineId) => ({ machineId, access: "read-only" }))),
    };
    if (
      !input.peers.some((peer) => peer.enabled && accessOf(snapshot, peer.machineId) === "standard")
    )
      return invalidSeed("it leaves no machine standard");
    return { _tag: "valid", snapshot } satisfies SeedRead;
  });

  const readyFile = (root: string, machineId: string) =>
    path.join(root, SEED_READY_DIRECTORY, `${machineId}.json`);
  const verifiedReady = (marker: SeedReady | undefined, fleetId: string, peer: FleetPeer) => {
    if (marker === undefined || marker.fleetId !== fleetId || marker.machineId !== peer.machineId)
      return false;
    const key = NodeCrypto.createPublicKey(peer.signingPublicKey);
    return (
      key.asymmetricKeyType === "ed25519" &&
      NodeCrypto.verify(
        null,
        Buffer.from(seedReadyData(marker)),
        key,
        Buffer.from(marker.signature, "base64"),
      )
    );
  };
  const readReady = (root: string, machineId: string) =>
    readFleetJson(readyFile(root, machineId), SeedReady).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.orElseSucceed(() => undefined),
    );
  // This server's own marker, once written or found, so it is not read again on every refresh.
  let markedReady: string | undefined;
  /** Tells the fleet this machine takes a replaced credential. */
  const markReady = Effect.fn("FleetAccess.markReady")(function* (
    input: FleetAccessInput,
    now: number,
  ) {
    const key = input.signingPrivateKey;
    const self = input.peers.find((peer) => peer.machineId === input.machineId && peer.enabled);
    const mark = `${input.fleetId}:${input.machineId}`;
    if (key === undefined || self === undefined || markedReady === mark) return;
    if (!verifiedReady(yield* readReady(input.root, input.machineId), input.fleetId, self)) {
      const unsigned: SeedReady = {
        version: 1,
        fleetId: input.fleetId,
        machineId: input.machineId,
        createdAt: now,
        signature: "",
      };
      const signature = NodeCrypto.sign(null, Buffer.from(seedReadyData(unsigned)), key);
      const written = yield* fs
        .makeDirectory(path.join(input.root, SEED_READY_DIRECTORY), { recursive: true })
        .pipe(
          Effect.andThen(
            writeFleetJson(readyFile(input.root, input.machineId), {
              ...unsigned,
              signature: signature.toString("base64"),
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "This machine could not tell the fleet that it takes replaced credentials.",
              { cause },
            ).pipe(Effect.as(false)),
          ),
        );
      if (!written) return;
    }
    markedReady = mark;
  });

  const seenFile = path.join(config.stateDir, "lan-fleet-access-seed.json");
  let seen: typeof SeedSeen.Type | undefined;
  /** When this machine first saw the fleet's starting list, kept so a restart does not reset it. */
  const firstSeen = Effect.fn("FleetAccess.firstSeen")(function* (fleetId: string, now: number) {
    if (seen === undefined && (yield* fs.exists(seenFile).pipe(Effect.orElseSucceed(() => false))))
      seen = yield* readFleetJson(seenFile, SeedSeen).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.orElseSucceed(() => undefined),
      );
    if (seen?.fleetId === fleetId) return seen.firstSeenAt;
    seen = { version: 1, fleetId, firstSeenAt: now };
    yield* writeFleetJson(seenFile, seen).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.catchCause((cause) =>
        Effect.logWarning("When this machine first saw the starting access list was not saved.", {
          cause,
        }),
      ),
    );
    return now;
  });

  /**
   * Adopting the list replaces the fleet credentials of the machines it makes read-only. It waits
   * until each of them runs a build that takes the replacement, or a day after this machine first
   * saw the list: a machine that has not updated by then is off or not updating, and recovers
   * through the replacement once it does.
   */
  const seedReadiness = Effect.fn("FleetAccess.seedReadiness")(function* (
    input: FleetAccessInput,
    snapshot: FleetAccessSnapshot,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const named = snapshot.machines
      .filter((machine) => machine.access === "read-only")
      .map((machine) => machine.machineId);
    if (named.includes(input.machineId)) yield* markReady(input, now);
    const adoptAt = (yield* firstSeen(input.fleetId, now)) + SEED_READY_WAIT_MS;
    const machineIds: Array<string> = [];
    for (const machineId of named) {
      const peer = input.peers.find((item) => item.machineId === machineId && item.enabled);
      if (
        peer !== undefined &&
        !verifiedReady(yield* readReady(input.root, machineId), input.fleetId, peer)
      )
        machineIds.push(machineId);
    }
    return { machineIds, adoptAt, ready: machineIds.length === 0 || now >= adoptAt };
  });

  const refreshUnlocked = Effect.fn("FleetAccess.refresh")(
    function* (input: FleetAccessInput) {
      const directory = path.join(input.root, "fleet-access");
      const own = cache?.fleetId === input.fleetId && cache.machineId === input.machineId;
      const { accepted, kept } = cachedEntries(own ? cache : undefined);
      const read = yield* readShare(directory).pipe(Effect.option);
      const unavailable = Option.isNone(read);
      if (unavailable)
        yield* Effect.logWarning(
          "The fleet access policy on the share could not be read; the last accepted policy still applies.",
        );
      const candidates = Option.getOrElse(read, () => []);
      const evaluation = evaluateAccess({
        fleetId: input.fleetId,
        accepted,
        candidates: [...kept, ...candidates],
        peers: input.peers,
      });
      const next: LocalCache = {
        version: 1,
        fleetId: input.fleetId,
        machineId: input.machineId,
        peers: input.peers
          .filter((peer) => peer.enabled)
          .map((peer) => ({ machineId: peer.machineId, environmentId: peer.environmentId })),
        entries: evaluation.revisions.map((item) => item.entry),
        unverified: evaluation.revisions
          .filter((item) => !item.verified)
          .map((item) => item.digest),
      };
      if (JSON.stringify(next) !== JSON.stringify(cache)) {
        yield* writeFleetJson(cacheFile, next).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Fleet access policy cache could not be saved.", { cause }),
          ),
          Effect.ignore,
        );
        cache = next;
      }
      // Any history here or on the share, even history that cannot be followed, is a list.
      const listed =
        accepted.length > 0 ||
        kept.length > 0 ||
        candidates.some((entry) => entry.fleetId === input.fleetId);
      const seed: SeedRead = listed ? { _tag: "absent" } : yield* readSeed(input);
      const readiness =
        seed._tag === "valid" ? yield* seedReadiness(input, seed.snapshot) : undefined;
      const updated = stateOf(
        cache,
        evaluation,
        input.legacyAccess,
        unavailable || seed._tag === "unavailable",
        seed._tag === "valid" ? "waiting" : seed._tag === "invalid" ? "invalid" : undefined,
        readiness === undefined || readiness.ready
          ? undefined
          : { machineIds: readiness.machineIds, adoptAt: readiness.adoptAt },
      );
      const previous = yield* SubscriptionRef.get(state);
      if (seed._tag === "invalid" && previous.seed !== "invalid")
        yield* Effect.logWarning(
          `The fleet's starting access list (${SEED_FILE}) cannot be used; nothing links until it is fixed or removed, or a list is saved.`,
          { reason: seed.reason },
        );
      if (JSON.stringify(updated) !== JSON.stringify(previous))
        yield* SubscriptionRef.set(state, updated);
      return {
        state: updated,
        directory,
        candidates,
        evaluation,
        unavailable: unavailable || seed._tag === "unavailable",
        seed,
        readiness,
      };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  type View = Effect.Success<ReturnType<typeof refreshUnlocked>>;

  /** The share lock, cleared first if a crash left it behind. */
  const withShareLock = <A, E>(root: string, use: Effect.Effect<A, E>) => {
    const lock = path.join(root, "fleet-access.lock");
    const busy = () => new LanFleetError({ reason: "busy" });
    const acquire = Effect.gen(function* () {
      if ((yield* Effect.result(fs.makeDirectory(lock)))._tag === "Success") return;
      const now = yield* Clock.currentTimeMillis;
      const stale = yield* fs.stat(lock).pipe(
        Effect.map((info) =>
          Option.match(info.mtime, {
            onNone: () => false,
            onSome: (modified) => now - modified.getTime() > STALE_LOCK_MS,
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!stale) return yield* busy();
      yield* Effect.logWarning("Clearing a fleet access lock a crashed change left behind.");
      // Moving it aside is atomic, so two machines clearing it cannot both go on to take it.
      const aside = `${lock}.stale-${NodeCrypto.randomUUID()}`;
      yield* fs.rename(lock, aside).pipe(Effect.mapError(busy));
      yield* fs.remove(aside, { recursive: true }).pipe(Effect.ignore);
      yield* fs.makeDirectory(lock).pipe(Effect.mapError(busy));
    });
    return Effect.acquireUseRelease(
      acquire,
      () => use,
      () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
    );
  };

  /** Signs `next` as this machine after every head it may follow, and writes it to the share. */
  const publish = Effect.fn("FleetAccess.publish")(
    function* (
      input: FleetAccessInput & { readonly signingPrivateKey: string },
      view: View,
      next: FleetAccessSnapshot,
    ) {
      const { evaluation, directory, candidates } = view;
      const parents = evaluation.heads
        .filter((head) => authorizeAccessChange(head.effective, next, input.machineId))
        .toSorted((left, right) => (left.digest < right.digest ? -1 : 1))
        .slice(0, 16);
      // Never a second first revision while any history exists, even history this machine
      // cannot follow: it would only ever add a competing chain.
      if (
        parents.length === 0 &&
        (evaluation.revisions.length > 0 ||
          candidates.some((entry) => entry.fleetId === input.fleetId))
      )
        return yield* configurationError();
      yield* fs.makeDirectory(directory, { recursive: true });
      // Republish accepted entries the share lost, so machines joining later can verify them.
      const present = new Set(candidates.map(entryFileName));
      for (const { entry } of evaluation.revisions)
        if (!present.has(entryFileName(entry)))
          yield* writeFleetJson(path.join(directory, entryFileName(entry)), entry);
      const common = {
        fleetId: input.fleetId,
        revision: 1 + Math.max(0, ...parents.map((parent) => parent.entry.revision)),
        signerMachineId: input.machineId,
        createdAt: yield* Clock.currentTimeMillis,
        ...next,
      };
      const entry = signAccessEntry(
        parents.length > 1
          ? { version: 2, previous: parents.map((parent) => parent.digest), ...common }
          : { version: 1, previous: parents[0]?.digest ?? null, ...common },
        input.signingPrivateKey,
      );
      yield* writeFleetJson(path.join(directory, entryFileName(entry)), entry);
      return entry;
    },
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  /**
   * A head accepted here whose writer has since left or changed keys reads as restrict-only on a
   * machine without this cache. A standard machine re-signs it so every machine reads the same.
   */
  const endorse = Effect.fn("FleetAccess.endorse")(function* (input: FleetAccessInput, view: View) {
    const key = input.signingPrivateKey;
    const snapshot = view.evaluation.snapshot;
    if (
      key === undefined ||
      view.unavailable ||
      snapshot === undefined ||
      accessOf(snapshot, input.machineId) !== "standard" ||
      !view.evaluation.heads.some(
        (head) => head.verified && !verifiedSigner(head.entry, input.peers),
      )
    )
      return view.state;
    return yield* withShareLock(
      input.root,
      Effect.gen(function* () {
        const fresh = yield* refreshUnlocked(input);
        if (fresh.evaluation.snapshot === undefined) return fresh.state;
        yield* publish({ ...input, signingPrivateKey: key }, fresh, fresh.evaluation.snapshot);
        return (yield* refreshUnlocked(input)).state;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A fleet access revision could not be re-signed.", { cause }).pipe(
          Effect.as(view.state),
        ),
      ),
    );
  });

  const changeUnlocked = (input: Parameters<FleetAccess["Service"]["change"]>[0]) =>
    withShareLock(
      input.root,
      Effect.gen(function* () {
        const view = yield* refreshUnlocked(input);
        if (view.unavailable) return yield* new LanFleetError({ reason: "unavailable" });
        if (view.state.revision !== input.expectedRevision) return yield* configurationError();
        const current = view.evaluation.snapshot;
        // Entries are kept for machines that are not enabled peers right now, so a restricted
        // machine that drops out and comes back is still restricted.
        const next: FleetAccessSnapshot = {
          defaultAccess: input.next.defaultAccess,
          machines: normalize(input.next.machines),
        };
        if (
          next.machines.length > 100 ||
          !authorizeAccessChange(current, next, input.machineId) ||
          // Someone must remain able to change the policy, or no one could lift it.
          !input.peers.some((peer) => peer.enabled && accessOf(next, peer.machineId) === "standard")
        )
          return yield* configurationError();
        if (
          current !== undefined &&
          view.evaluation.heads.length === 1 &&
          sameSnapshot(current, next)
        )
          return view.state;
        const entry = yield* publish(input, view, next);
        const written = yield* refreshUnlocked(input);
        // A competing head that restricts more still applies; report it rather than succeed.
        if (
          !written.evaluation.revisions.some((item) => item.digest === entryDigest(entry)) ||
          written.evaluation.snapshot === undefined ||
          !sameSnapshot(written.evaluation.snapshot, next)
        )
          return yield* configurationError();
        return written.state;
      }),
    ).pipe(
      Effect.mapError((error) =>
        isFleetError(error) ? error : new LanFleetError({ reason: "unavailable" }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  /**
   * Signs the starting list in as revision 1 through the ordinary change path. A machine that
   * loses the race sees the winner's revision and stops; two that both write merge restrictively.
   */
  const adopt = Effect.fn("FleetAccess.adopt")(function* (
    input: FleetAccessInput,
    view: View,
    snapshot: FleetAccessSnapshot,
  ) {
    const key = input.signingPrivateKey;
    if (
      key === undefined ||
      view.unavailable ||
      !input.peers.some((peer) => peer.enabled && peer.machineId === input.machineId)
    )
      return view.state;
    return yield* changeUnlocked({
      ...input,
      signingPrivateKey: key,
      expectedRevision: 0,
      next: snapshot,
    }).pipe(
      Effect.tap((adopted) =>
        Effect.logInfo("Adopted the fleet's starting access list.", {
          revision: adopted.revision,
          readOnly: snapshot.machines.map((machine) => machine.machineId),
          ...(view.readiness === undefined || view.readiness.machineIds.length === 0
            ? {}
            : { notUpdatedAfterWaiting: view.readiness.machineIds }),
        }),
      ),
      // Once the share holds the list and gives it back, the starting list is spent. Removing it
      // means a later loss of the share's list can never bring it in again.
      Effect.tap(() =>
        refreshUnlocked(input).pipe(
          Effect.flatMap((back) =>
            !back.unavailable &&
            back.state.revision > 0 &&
            back.candidates.some((entry) =>
              back.evaluation.revisions.some((item) => item.digest === entryDigest(entry)),
            )
              ? fs.remove(path.join(input.root, SEED_FILE))
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(`The spent starting access list (${SEED_FILE}) was not removed.`, {
              cause,
            }),
          ),
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("The fleet's starting access list was not adopted this time.", {
          reason: error.reason,
        }).pipe(
          Effect.andThen(refreshUnlocked(input)),
          Effect.map((fresh) => fresh.state),
        ),
      ),
    );
  });

  const refresh = (input: FleetAccessInput) =>
    mutex.withPermits(1)(
      refreshUnlocked(input).pipe(
        Effect.flatMap((view) =>
          view.seed._tag !== "valid"
            ? endorse(input, view)
            : view.readiness?.ready === true
              ? adopt(input, view, view.seed.snapshot)
              : Effect.succeed(view.state),
        ),
      ),
    );

  const change: FleetAccess["Service"]["change"] = (input) =>
    mutex.withPermits(1)(changeUnlocked(input));

  const accessFor: FleetAccess["Service"]["accessFor"] = (environmentId) =>
    SubscriptionRef.get(state).pipe(
      Effect.map((current) => {
        const peer = current.peers.find((item) => item.environmentId === environmentId);
        return peer === undefined ? undefined : accessOf(current, peer.machineId);
      }),
    );

  return FleetAccess.of({
    accessFor,
    current: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    refresh,
    change,
  });
});

export const layer = Layer.effect(FleetAccess, make);
