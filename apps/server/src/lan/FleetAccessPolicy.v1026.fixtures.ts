// @effect-diagnostics nodeBuiltinImport:off -- A frozen copy of LAN 1.0.26's Ed25519 revision checks.
/**
 * FROZEN: LAN 1.0.26's revision verifier, verbatim from `FleetAccessPolicy.ts` at 9c189144dc with
 * only export modifiers and imports changed. Never edit it to match newer code: the new verifier must
 * count exactly the revisions this one counts, or one version stops on an older list.
 */
import * as NodeCrypto from "node:crypto";
import type { FleetAccess as Level } from "@t3tools/contracts";
import type { FleetPeer } from "./FleetDelivery.ts";
import type { FleetAccessEntry } from "./FleetAccessPolicy.ts";

export interface FleetAccessSnapshot {
  readonly defaultAccess: Level;
  readonly machines: ReadonlyArray<{ readonly machineId: string; readonly access: Level }>;
}

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

const entryDigest = (entry: FleetAccessEntry) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([entryData(entry), entry.signature]))
    .digest("hex");

const parentsOf = (entry: FleetAccessEntry): ReadonlyArray<string> =>
  entry.version === 2 ? entry.previous : entry.previous === null ? [] : [entry.previous];

const normalize = (machines: FleetAccessSnapshot["machines"]) =>
  [...new Map(machines.map((machine) => [machine.machineId, machine.access])).entries()]
    .map(([machineId, access]) => ({ machineId, access }))
    .sort((left, right) => (left.machineId < right.machineId ? -1 : 1));

export const accessOf = (snapshot: FleetAccessSnapshot, machineId: string): Level =>
  snapshot.machines.find((machine) => machine.machineId === machineId)?.access ??
  snapshot.defaultAccess;

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
export function evaluateAccess(input: {
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
