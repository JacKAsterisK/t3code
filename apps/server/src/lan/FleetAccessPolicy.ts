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
 * `fleet-access-ready/<machineId>.json` beside the roster, signed by that machine: it runs LAN
 * 1.0.26 or later, which never cuts a downgraded peer off. A 1.0.25 issuer would revoke a 1.0.24
 * peer it could not replace, and nothing else tells 1.0.25 from an off machine.
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

export interface FleetAccessSnapshot {
  readonly defaultAccess: Level;
  /** Each machine's own level. Never holds the pair entries below. */
  readonly machines: ReadonlyArray<typeof MachineAccess.Type>;
  /**
   * Exceptions, as pair entry IDs: a caller with standard access on one receiver whatever its own
   * level. None when absent.
   */
  readonly pairs?: ReadonlyArray<string>;
}

/**
 * Exceptions ride in the signed `machines` as entries 1.0.26 reads as unknown machines: a new field
 * would make it skip the revision and all after it. Each is `<hash(caller)>-<hash(pair)>`, so it
 * fits a machine ID and one caller's exceptions are found without knowing every receiver.
 */
const PAIR_PREFIX = "pair-access-";
const PAIR_ENTRY = /^pair-access-[a-f0-9]{16}-[a-f0-9]{16}$/u;
/**
 * A writer that knows exceptions marks its revision with an entry derived from that revision. A
 * 1.0.26 save copies the entries it was shown, its parent's marker among them, and a 1.0.26 merge
 * may join competing heads' exceptions. Without a marker of its own a revision keeps only the
 * exceptions every revision it follows grants, so a writer that cannot see them never adds one.
 */
const WRITER_ENTRY = /^pair-access-writer-[a-f0-9]{32}$/u;
const hashOf = (parts: ReadonlyArray<unknown>, length: number) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, length);
const callerPrefix = (caller: string) =>
  `${PAIR_PREFIX}${hashOf(["fleet-access-pair-caller", caller], 16)}-`;
/** The entry that makes `caller` standard on `receiver`. */
export const pairEntryId = (caller: string, receiver: string) =>
  `${callerPrefix(caller)}${hashOf(["fleet-access-pair", caller, receiver], 16)}`;
const isPairEntryOf = (caller: string, id: string) => id.startsWith(callerPrefix(caller));
const encodedEntry = (machineId: string) =>
  PAIR_ENTRY.test(machineId) || WRITER_ENTRY.test(machineId);
const writerEntryId = (header: {
  readonly fleetId: string;
  readonly revision: number;
  readonly previous: string | ReadonlyArray<string> | null;
  readonly signerMachineId: string;
  readonly createdAt: number;
}) =>
  `${PAIR_PREFIX}writer-${hashOf(
    [
      "fleet-access-pair-writer",
      header.fleetId,
      header.revision,
      header.previous,
      header.signerMachineId,
      header.createdAt,
    ],
    32,
  )}`;
const normalizePairs = (pairs: ReadonlyArray<string> | undefined) =>
  [...new Set(pairs ?? [])].filter((id) => PAIR_ENTRY.test(id)).toSorted();
const intersectPairs = (sets: ReadonlyArray<ReadonlyArray<string> | undefined>) =>
  sets.length === 0
    ? []
    : normalizePairs(sets[0]).filter((id) => sets.every((set) => (set ?? []).includes(id)));

const LocalCache = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String,
  machineId: FleetMachineId,
  peers: Schema.Array(Schema.Struct({ machineId: FleetMachineId, environmentId: Schema.String })),
  entries: Schema.Array(FleetAccessEntry).check(Schema.isMaxLength(10_000)),
  // Entries kept only so later ones still have their parents; they never count as verified.
  unverified: Schema.optionalKey(Schema.Array(Digest).check(Schema.isMaxLength(10_000))),
  member: Schema.optionalKey(Schema.Boolean),
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

/** A machine's own level, before any exception. */
const accessOf = (snapshot: FleetAccessSnapshot, machineId: string): Level =>
  snapshot.machines.find((machine) => machine.machineId === machineId)?.access ??
  snapshot.defaultAccess;

/** What `caller` may do on `receiver`: standard if it is, or if an exception names that pair. */
export const pairAccess = (
  snapshot: FleetAccessSnapshot,
  caller: string,
  receiver: string,
): Level =>
  accessOf(snapshot, caller) === "standard" ||
  (snapshot.pairs ?? []).includes(pairEntryId(caller, receiver))
    ? "standard"
    : "read-only";

/**
 * The exceptions among `machineIds`, by caller. One naming a machine not among them stays in the
 * list but is not shown.
 */
export const exceptionsOf = (snapshot: FleetAccessSnapshot, machineIds: ReadonlyArray<string>) => {
  const ids = [...new Set(machineIds)].toSorted();
  const pairs = new Set(snapshot.pairs ?? []);
  return ids.flatMap((machineId) => {
    const standardOn = ids.filter(
      (receiver) => receiver !== machineId && pairs.has(pairEntryId(machineId, receiver)),
    );
    return standardOn.length === 0 ? [] : [{ machineId, standardOn }];
  });
};

/** `pairs` with each listed caller's exceptions replaced by the receivers given for it. */
export const replaceExceptions = (
  pairs: ReadonlyArray<string> | undefined,
  exceptions: ReadonlyArray<{
    readonly machineId: string;
    readonly standardOn: ReadonlyArray<string>;
  }>,
) =>
  normalizePairs([
    ...(pairs ?? []).filter(
      (id) => !exceptions.some((exception) => isPairEntryOf(exception.machineId, id)),
    ),
    ...exceptions.flatMap((exception) =>
      exception.standardOn
        .filter((receiver) => receiver !== exception.machineId)
        .map((receiver) => pairEntryId(exception.machineId, receiver)),
    ),
  ]);

/**
 * What a revision grants, read from its entries: its machines and, when its writer marked it, its
 * exceptions. Unmarked, it keeps only the exceptions every revision it follows grants.
 */
const snapshotOf = (
  entry: FleetAccessEntry,
  parents: ReadonlyArray<FleetAccessSnapshot>,
): FleetAccessSnapshot => {
  const listed = entry.machines
    .filter((machine) => PAIR_ENTRY.test(machine.machineId) && machine.access === "standard")
    .map((machine) => machine.machineId);
  const marked = entry.machines.some(
    (machine) => machine.machineId === writerEntryId(entry) && machine.access === "standard",
  );
  return {
    defaultAccess: entry.defaultAccess,
    machines: entry.machines.filter((machine) => !encodedEntry(machine.machineId)),
    pairs: marked
      ? normalizePairs(listed)
      : parents.length === 0
        ? []
        : intersectPairs([listed, ...parents.map((parent) => parent.pairs)]),
  };
};

const sameSnapshot = (left: FleetAccessSnapshot, right: FleetAccessSnapshot) =>
  left.defaultAccess === right.defaultAccess &&
  JSON.stringify(normalize(left.machines)) === JSON.stringify(normalize(right.machines)) &&
  JSON.stringify(normalizePairs(left.pairs)) === JSON.stringify(normalizePairs(right.pairs));

/**
 * Each machine at the most restrictive access any of the snapshots gives it, with only the
 * exceptions all of them grant.
 */
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
    pairs: intersectPairs(snapshots.map((snapshot) => snapshot.pairs)),
  };
}

/**
 * Before any policy every machine may write one. After that a standard machine may change
 * anything, and a read-only machine may only restrict itself: it grants no exception, and removes
 * only its own.
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
  const before = normalizePairs(previous.pairs);
  const after = normalizePairs(next.pairs);
  return (
    others(previous) === others(next) &&
    accessOf(next, signerMachineId) === "read-only" &&
    after.every((id) => before.includes(id)) &&
    before.every((id) => after.includes(id) || isPairEntryOf(signerMachineId, id))
  );
}

/** A machine the fleet knows must remain able to change the policy, or no one could lift it. */
const keepsAStandardMachine = (snapshot: FleetAccessSnapshot, machineIds: ReadonlyArray<string>) =>
  machineIds.some((machineId) => accessOf(snapshot, machineId) === "standard");

/**
 * Signs a revision. Its exceptions join `machines` with this revision's writer mark; entries in
 * `machines` itself are written as given.
 */
export function signAccessEntry(
  entry: DistributiveOmit<FleetAccessEntry, "signature" | "machines"> & FleetAccessSnapshot,
  signingPrivateKey: string,
): FleetAccessEntry {
  // The file holds no field 1.0.26 does not know: it skips such a revision and all that follow.
  const { pairs: listed, ...fields } = entry;
  const pairs = normalizePairs(listed);
  const unsigned = {
    ...fields,
    machines: normalize([
      ...entry.machines,
      ...pairs.map((machineId) => ({ machineId, access: "standard" as const })),
      ...(pairs.length === 0
        ? []
        : [{ machineId: writerEntryId(entry), access: "standard" as const }]),
    ]),
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
    const own = snapshotOf(
      entry,
      resolved.map((parent) => parent.effective),
    );
    if (
      !sticky.has(digest) &&
      (JSON.stringify(normalize(entry.machines)) !== JSON.stringify(entry.machines) ||
        // Without any peers (a cache read at startup) there is nothing to check this against.
        (known.length > 0 && !keepsAStandardMachine(own, known)) ||
        !resolved.every((parent) =>
          authorizeAccessChange(parent.effective, own, entry.signerMachineId),
        ))
    )
      continue;
    const verified = sticky.has(digest) || verifiedSigner(entry, input.peers);
    revisions.set(digest, {
      entry,
      digest,
      verified,
      effective: verified
        ? own
        : mostRestrictive([own, ...resolved.map((parent) => parent.effective)]),
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
  /** Exceptions, as pair entry IDs; see `pairAccess`. None when absent. */
  readonly pairs?: ReadonlyArray<string>;
  readonly machineId: string | undefined;
  /** The enabled machines whose credentials this policy governs, this one included while enrolled. */
  readonly peers: ReadonlyArray<{ readonly machineId: string; readonly environmentId: string }>;
  /**
   * This machine, as of its last fleet read, is a validated enrolled member with an enabled roster
   * row. Only then does the fleet link it. Separate from `peers`, which keeps governing credentials.
   */
  readonly member?: boolean;
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
   * While a usable starting list waits for every enabled machine to say it runs LAN 1.0.26 or
   * later: those not confirmed yet, however long they take.
   */
  readonly seedPending?: { readonly machineIds: ReadonlyArray<string> };
}

/** A machine's own level in the list, before any exception. */
export const machineAccess = (state: FleetAccessState, machineId: string) =>
  accessOf(state, machineId);
/** What `machineId` may do here: its own level, or standard where an exception names this machine. */
export const callerAccess = (state: FleetAccessState, machineId: string) =>
  state.machineId === undefined
    ? accessOf(state, machineId)
    : pairAccess(state, machineId, state.machineId);
/**
 * This machine's own level, which also decides whether it may change the list; outside any fleet,
 * or before any saved policy, it is unrestricted.
 */
export const selfAccess = (state: FleetAccessState): Level =>
  state.machineId === undefined || state.revision === 0
    ? "standard"
    : accessOf(state, state.machineId);
/** What this machine may do on `receiver`: its own level, or standard where an exception says so. */
export const accessOn = (state: FleetAccessState, receiver: string): Level =>
  state.machineId === undefined || state.revision === 0
    ? "standard"
    : pairAccess(state, state.machineId, receiver);
/** `accessOn` for a fleet peer's environment, and this machine's own level for any other. */
export const accessOnEnvironment = (state: FleetAccessState, environmentId: string): Level => {
  const peer = state.peers.find((item) => item.environmentId === environmentId);
  return peer === undefined ? selfAccess(state) : accessOn(state, peer.machineId);
};
/** Whether access follows a saved policy; before one, each credential keeps its access. */
export const policyApplies = (state: FleetAccessState) => state.revision > 0;
/**
 * Whether the fleet would link this machine to its peers: at its last fleet read its enrollment
 * was valid and its roster row enabled, and a list exists. Only then do linked environments count
 * as on here.
 */
export const fleetLinksApply = (state: FleetAccessState) =>
  policyApplies(state) && state.member === true;
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
  /** This machine's enrollment is valid and its roster row enabled; see `FleetAccessState.member`. */
  readonly member: boolean;
  /** When given, a read may re-sign a head whose writer's key no longer verifies. */
  readonly signingPrivateKey?: string;
  /** Machines the roster disables: the starting list may still name them but never waits for them. */
  readonly rosterDisabled?: ReadonlyArray<string>;
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
    /**
     * This machine's enrollment is gone or fleet bootstrap is off: the fleet no longer links it.
     * The accepted list stays, so it keeps governing credentials.
     */
    readonly leave: Effect.Effect<void>;
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
    pairs: evaluation?.snapshot?.pairs ?? [],
    machineId: value?.machineId,
    peers: value?.peers ?? [],
    member: value?.member === true,
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
      named.some(
        (machineId) =>
          !input.peers.some((peer) => peer.machineId === machineId) &&
          !input.rosterDisabled?.includes(machineId),
      )
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
  /** Tells the fleet this machine runs 1.0.26, which takes a replaced credential. */
  const markReady = Effect.fn("FleetAccess.markReady")(function* (
    input: FleetAccessInput,
    signingPrivateKey: string,
  ) {
    const unsigned: SeedReady = {
      version: 1,
      fleetId: input.fleetId,
      machineId: input.machineId,
      createdAt: yield* Clock.currentTimeMillis,
      signature: "",
    };
    const signature = NodeCrypto.sign(
      null,
      Buffer.from(seedReadyData(unsigned)),
      signingPrivateKey,
    );
    yield* fs.makeDirectory(path.join(input.root, SEED_READY_DIRECTORY), { recursive: true }).pipe(
      Effect.andThen(
        writeFleetJson(readyFile(input.root, input.machineId), {
          ...unsigned,
          signature: signature.toString("base64"),
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.catchCause((cause) =>
        Effect.logWarning("This machine could not tell the fleet that it runs LAN 1.0.26.", {
          cause,
        }),
      ),
    );
  });

  /**
   * 1.0.25 revokes a downgraded peer's session at once and 1.0.24 cannot take the replacement, so
   * the list waits, however long it takes, until every enabled machine has said it runs 1.0.26.
   * Hub never downgrades, so after that no 1.0.25 issuer is left among them.
   */
  const seedReadiness = Effect.fn("FleetAccess.seedReadiness")(function* (input: FleetAccessInput) {
    const machineIds: Array<string> = [];
    for (const peer of input.peers.filter(
      (item) => item.enabled && !input.rosterDisabled?.includes(item.machineId),
    )) {
      if (verifiedReady(yield* readReady(input.root, peer.machineId), input.fleetId, peer))
        continue;
      // This machine runs 1.0.26 itself: it says so, and never waits for itself.
      if (peer.machineId === input.machineId) {
        if (input.signingPrivateKey !== undefined) yield* markReady(input, input.signingPrivateKey);
        continue;
      }
      machineIds.push(peer.machineId);
    }
    return { machineIds, ready: machineIds.length === 0 };
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
        member: input.member,
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
      const readiness = seed._tag === "valid" ? yield* seedReadiness(input) : undefined;
      const updated = stateOf(
        cache,
        evaluation,
        input.legacyAccess,
        unavailable || seed._tag === "unavailable",
        seed._tag === "valid" ? "waiting" : seed._tag === "invalid" ? "invalid" : undefined,
        readiness === undefined || readiness.ready
          ? undefined
          : { machineIds: readiness.machineIds },
      );
      const previous = yield* SubscriptionRef.get(state);
      if (seed._tag === "invalid" && previous.seed !== "invalid")
        yield* Effect.logWarning(
          `The fleet's starting access list (${SEED_FILE}) cannot be used; nothing links until it is fixed or removed, or a list is saved.`,
          { reason: seed.reason },
        );
      if (
        updated.seedPending !== undefined &&
        JSON.stringify(updated.seedPending) !== JSON.stringify(previous.seedPending)
      )
        yield* Effect.logInfo(
          "The fleet's starting access list waits until every enabled machine runs LAN 1.0.26 or later.",
          { notYetOn1026: updated.seedPending.machineIds },
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
      // A read-only writer leaves every other entry as it was, exceptions and their writer's mark
      // included: 1.0.26 refuses anything else from it. Unmarked, its revision keeps what its
      // parents grant.
      const carried = parents.map((parent) =>
        parent.entry.machines.filter((machine) => encodedEntry(machine.machineId)),
      );
      const readOnly = parents.some(
        (parent) => accessOf(parent.effective, input.machineId) !== "standard",
      );
      if (
        readOnly &&
        (new Set(carried.map((entries) => JSON.stringify(entries))).size > 1 ||
          JSON.stringify(normalizePairs(next.pairs)) !==
            JSON.stringify(intersectPairs(parents.map((parent) => parent.effective.pairs))))
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
        defaultAccess: next.defaultAccess,
        ...(readOnly
          ? { machines: [...next.machines, ...(carried[0] ?? [])] }
          : { machines: next.machines, pairs: next.pairs ?? [] }),
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

  const changeUnlocked = (
    input: Parameters<FleetAccess["Service"]["change"]>[0],
    adoptingSeed = false,
  ) =>
    withShareLock(
      input.root,
      Effect.gen(function* () {
        const view = yield* refreshUnlocked(input);
        if (view.unavailable) return yield* new LanFleetError({ reason: "unavailable" });
        if (view.state.revision !== input.expectedRevision) return yield* configurationError();
        // Every marker is read again under the lock, right before revision 1 is written.
        if (
          adoptingSeed &&
          (view.seed._tag !== "valid" ||
            view.readiness?.ready !== true ||
            !sameSnapshot(view.seed.snapshot, input.next))
        )
          return yield* configurationError();
        const current = view.evaluation.snapshot;
        // A change that does not name exceptions keeps the ones the list has.
        const pairs = normalizePairs(input.next.pairs ?? current?.pairs);
        // Entries are kept for machines that are not enabled peers right now, so a restricted
        // machine that drops out and comes back is still restricted.
        const next: FleetAccessSnapshot = {
          defaultAccess: input.next.defaultAccess,
          machines: normalize(
            input.next.machines.filter((machine) => !encodedEntry(machine.machineId)),
          ),
          pairs,
        };
        if (
          // Exceptions share the 100 entries with the machines, and need their writer's mark.
          next.machines.length + (pairs.length === 0 ? 0 : pairs.length + 1) > 100 ||
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
    return yield* changeUnlocked(
      { ...input, signingPrivateKey: key, expectedRevision: 0, next: snapshot },
      true,
    ).pipe(
      Effect.tap((adopted) =>
        Effect.logInfo("Adopted the fleet's starting access list.", {
          revision: adopted.revision,
          readOnly: snapshot.machines.map((machine) => machine.machineId),
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

  const leave = mutex.withPermits(1)(
    Effect.gen(function* () {
      if (cache?.member === true) {
        const next: LocalCache = { ...cache, member: false };
        yield* writeFleetJson(cacheFile, next).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.tapError((cause) =>
            Effect.logWarning("Fleet access policy cache could not be saved.", { cause }),
          ),
          Effect.ignore,
        );
        cache = next;
      }
      const previous = yield* SubscriptionRef.get(state);
      if (previous.member === true)
        yield* SubscriptionRef.set(state, { ...previous, member: false });
    }),
  );

  const accessFor: FleetAccess["Service"]["accessFor"] = (environmentId) =>
    SubscriptionRef.get(state).pipe(
      Effect.map((current) => {
        const peer = current.peers.find((item) => item.environmentId === environmentId);
        return peer === undefined ? undefined : callerAccess(current, peer.machineId);
      }),
    );

  return FleetAccess.of({
    accessFor,
    current: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    refresh,
    leave,
    change,
  });
});

export const layer = Layer.effect(FleetAccess, make);
