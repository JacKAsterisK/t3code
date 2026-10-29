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

/** One revision of the fleet-wide policy: a full snapshot, signed by the machine that wrote it. */
export const FleetAccessEntry = Schema.Struct({
  version: Schema.Literal(1),
  fleetId: Schema.String.check(Schema.isMaxLength(256)),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  previous: Schema.NullOr(Digest),
  signerMachineId: FleetMachineId,
  createdAt: Schema.Number,
  defaultAccess: FleetAccessLevel,
  machines: Schema.Array(MachineAccess).check(Schema.isMaxLength(100)),
  signature: Schema.String.check(Schema.isMaxLength(1024)),
});
export type FleetAccessEntry = typeof FleetAccessEntry.Type;

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

const normalize = (machines: FleetAccessSnapshot["machines"]) =>
  [...new Map(machines.map((machine) => [machine.machineId, machine.access])).entries()]
    .map(([machineId, access]) => ({ machineId, access }))
    .sort((left, right) => (left.machineId < right.machineId ? -1 : 1));

const accessOf = (snapshot: FleetAccessSnapshot, machineId: string): Level =>
  snapshot.machines.find((machine) => machine.machineId === machineId)?.access ??
  snapshot.defaultAccess;

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

export function signAccessEntry(
  entry: Omit<FleetAccessEntry, "signature" | "machines"> & FleetAccessSnapshot,
  signingPrivateKey: string,
): FleetAccessEntry {
  const unsigned: FleetAccessEntry = {
    ...entry,
    machines: normalize(entry.machines),
    signature: "",
  };
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
    JSON.stringify(normalize(entry.machines)) === JSON.stringify(entry.machines) &&
    NodeCrypto.verify(
      null,
      Buffer.from(entryData(entry)),
      key,
      Buffer.from(entry.signature, "base64"),
    )
  );
}

/**
 * Extends the chain this machine already accepted with entries from the share. Accepted
 * entries are never replaced, so deleting or rewriting share files cannot undo a change here.
 */
function extendAccessChain(input: {
  readonly fleetId: string;
  readonly accepted: ReadonlyArray<FleetAccessEntry>;
  readonly candidates: ReadonlyArray<FleetAccessEntry>;
  readonly peers: ReadonlyArray<FleetPeer>;
}): ReadonlyArray<FleetAccessEntry> {
  const chain = [...input.accepted];
  for (;;) {
    const head = chain.at(-1);
    const previous = head === undefined ? null : entryDigest(head);
    const next = input.candidates
      .filter(
        (entry) =>
          entry.fleetId === input.fleetId &&
          entry.revision === chain.length + 1 &&
          entry.previous === previous &&
          authorizeAccessChange(head, entry, entry.signerMachineId) &&
          verifiedSigner(entry, input.peers),
      )
      // Two valid writers of one revision is a lost race; every machine keeps the same one.
      .sort((left, right) => (entryDigest(left) < entryDigest(right) ? -1 : 1))[0];
    if (next === undefined) return chain;
    chain.push(next);
  }
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
}

export const machineAccess = (state: FleetAccessState, machineId: string) =>
  accessOf(state, machineId);
/** This machine's own access; a machine outside any fleet is unrestricted. */
export const selfAccess = (state: FleetAccessState): Level =>
  state.revision === 0 || state.machineId === undefined
    ? "standard"
    : accessOf(state, state.machineId);

interface FleetAccessInput {
  readonly root: string;
  readonly fleetId: string;
  readonly machineId: string;
  readonly peers: ReadonlyArray<FleetPeer>;
  readonly legacyAccess: Level;
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
    /** Reads the share's policy chain. Share failures keep the last accepted policy. */
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
  const stateOf = (value: LocalCache | undefined, legacyAccess: Level): FleetAccessState => {
    const head = value?.entries.at(-1);
    return {
      revision: head?.revision ?? 0,
      defaultAccess: head?.defaultAccess ?? legacyAccess,
      machines: head?.machines ?? [],
      machineId: value?.machineId,
      peers: value?.peers ?? [],
    };
  };
  const state = yield* SubscriptionRef.make(stateOf(cache, "standard"));

  const readShare = Effect.fn("FleetAccess.readShare")(function* (directory: string) {
    if (!(yield* fs.exists(directory))) return [];
    const names = (yield* fs.readDirectory(directory)).filter((name) => ENTRY_FILE.test(name));
    if (names.length > 1000) return [];
    const entries: Array<FleetAccessEntry> = [];
    for (const name of names) {
      const entry = yield* readFleetJson(path.join(directory, name), FleetAccessEntry).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (entry !== undefined && entryFileName(entry) === name) entries.push(entry);
    }
    return entries;
  });

  const refreshUnlocked = Effect.fn("FleetAccess.refresh")(
    function* (input: FleetAccessInput) {
      const directory = path.join(input.root, "fleet-access");
      const accepted =
        cache?.fleetId === input.fleetId && cache.machineId === input.machineId
          ? cache.entries
          : [];
      const candidates = yield* readShare(directory).pipe(Effect.orElseSucceed(() => []));
      const entries = extendAccessChain({
        fleetId: input.fleetId,
        accepted,
        candidates,
        peers: input.peers,
      });
      const next: LocalCache = {
        version: 1,
        fleetId: input.fleetId,
        machineId: input.machineId,
        peers: input.peers
          .filter((peer) => peer.enabled)
          .map((peer) => ({ machineId: peer.machineId, environmentId: peer.environmentId })),
        entries,
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
      const updated = stateOf(cache, input.legacyAccess);
      if (JSON.stringify(updated) !== JSON.stringify(yield* SubscriptionRef.get(state)))
        yield* SubscriptionRef.set(state, updated);
      return { state: updated, directory, candidates };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  const refresh = (input: FleetAccessInput) =>
    mutex.withPermits(1)(refreshUnlocked(input).pipe(Effect.map(({ state }) => state)));

  const change: FleetAccess["Service"]["change"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const lock = path.join(input.root, "fleet-access.lock");
        return yield* Effect.acquireUseRelease(
          fs.makeDirectory(lock).pipe(Effect.mapError(() => new LanFleetError({ reason: "busy" }))),
          () =>
            Effect.gen(function* () {
              const { state: current, directory, candidates } = yield* refreshUnlocked(input);
              if (current.revision !== input.expectedRevision) return yield* configurationError();
              const enabled = input.peers.filter((peer) => peer.enabled);
              const next: FleetAccessSnapshot = {
                defaultAccess: input.next.defaultAccess,
                machines: normalize(
                  input.next.machines.filter((machine) =>
                    enabled.some((peer) => peer.machineId === machine.machineId),
                  ),
                ),
              };
              const head = cache?.entries.at(-1);
              if (
                !authorizeAccessChange(head, next, input.machineId) ||
                // Someone must remain able to change the policy, or no one could lift it.
                !enabled.some((peer) => accessOf(next, peer.machineId) === "standard")
              )
                return yield* configurationError();
              if (
                head !== undefined &&
                head.defaultAccess === next.defaultAccess &&
                JSON.stringify(head.machines) === JSON.stringify(next.machines)
              )
                return current;
              yield* fs.makeDirectory(directory, { recursive: true });
              // Republish accepted entries the share lost, so machines joining later can verify them.
              const present = new Set(candidates.map(entryFileName));
              for (const entry of cache?.entries ?? [])
                if (!present.has(entryFileName(entry)))
                  yield* writeFleetJson(path.join(directory, entryFileName(entry)), entry);
              const entry = signAccessEntry(
                {
                  version: 1,
                  fleetId: input.fleetId,
                  revision: current.revision + 1,
                  previous: head === undefined ? null : entryDigest(head),
                  signerMachineId: input.machineId,
                  createdAt: yield* Clock.currentTimeMillis,
                  ...next,
                },
                input.signingPrivateKey,
              );
              yield* writeFleetJson(path.join(directory, entryFileName(entry)), entry);
              const { state: written } = yield* refreshUnlocked(input);
              if (written.revision !== entry.revision) return yield* configurationError();
              return written;
            }),
          () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
        );
      }).pipe(
        Effect.mapError((error) =>
          isFleetError(error) ? error : new LanFleetError({ reason: "unavailable" }),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );

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
