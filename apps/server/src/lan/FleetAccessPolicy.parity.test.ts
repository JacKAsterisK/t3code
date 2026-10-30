import { describe, expect, it } from "@effect/vitest";

import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import type { FleetAccessEntry } from "./FleetAccessPolicy.ts";
import * as V1026 from "./FleetAccessPolicy.v1026.fixtures.ts";
import type { FleetPeer } from "./FleetDelivery.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";

/**
 * Both versions must count exactly the same revisions: a revision only one of them counts leaves
 * the other on an older list, and every revision after it with it. Exceptions may change only what
 * a counted revision grants. `V1026` is LAN 1.0.26's verifier, frozen.
 */
const FLEET_ID = "fleet-parity";
type Machine = ReturnType<typeof syntheticFleetPeer>;
type Access = "read-only" | "standard";
type Entries = FleetAccessEntry["machines"];

const cryo = syntheticFleetPeer("cryofrog");
const panda = syntheticFleetPeer("pandamedic");
const anvil = syntheticFleetPeer("anviltoad");
const spd = syntheticFleetPeer("spdevmachine");
const fleet = [cryo, panda, anvil, spd];
const id = (machine: Machine) => machine.peer.machineId;
const pair = (caller: Machine, receiver: Machine) =>
  FleetAccessPolicy.pairEntryId(id(caller), id(receiver));
const readOnly = (machine: Machine) => ({ machineId: id(machine), access: "read-only" as const });

let clock = 0;
/** A revision as `signer` writes it: with `pairs`, as this version does; without, as 1.0.26. */
const sign = (
  signer: Machine,
  parents: ReadonlyArray<FleetAccessEntry>,
  machines: Entries,
  options: { readonly pairs?: ReadonlyArray<string>; readonly defaultAccess?: Access } = {},
) => {
  const header = {
    fleetId: FLEET_ID,
    revision: 1 + Math.max(0, ...parents.map((parent) => parent.revision)),
    signerMachineId: id(signer),
    createdAt: ++clock,
    defaultAccess: options.defaultAccess ?? "standard",
    machines,
    ...(options.pairs === undefined ? {} : { pairs: options.pairs }),
  };
  return FleetAccessPolicy.signAccessEntry(
    parents.length > 1
      ? { version: 2, previous: parents.map(FleetAccessPolicy.entryDigest), ...header }
      : {
          version: 1,
          previous: parents[0] === undefined ? null : FleetAccessPolicy.entryDigest(parents[0]),
          ...header,
        },
    signer.signingPrivateKey,
  );
};
/** `parent`'s entries as signed, `change` applied: what a 1.0.26 Settings save writes. */
const edit = (parent: FleetAccessEntry, change: (entries: Array<Entries[number]>) => void) => {
  const entries = [...parent.machines];
  change(entries);
  return entries;
};
const without = (machineId: string) => (entries: Array<Entries[number]>) => {
  const index = entries.findIndex((entry) => entry.machineId === machineId);
  if (index >= 0) entries.splice(index, 1);
};

const asState = (snapshot: FleetAccessPolicy.FleetAccessSnapshot | undefined) => ({
  revision: snapshot === undefined ? 0 : 1,
  defaultAccess: snapshot?.defaultAccess ?? ("standard" as const),
  machines: snapshot?.machines ?? [],
  pairs: snapshot?.pairs ?? [],
  machineId: undefined,
  peers: [],
});

/** Evaluates `entries` in both versions and checks they count the same revisions. */
function parity(
  entries: ReadonlyArray<FleetAccessEntry>,
  peers: ReadonlyArray<FleetPeer> = fleet.map((machine) => machine.peer),
) {
  const input = { fleetId: FLEET_ID, accepted: [], candidates: entries, peers };
  const legacy = V1026.evaluateAccess(input);
  const current = FleetAccessPolicy.evaluateAccess(input);
  const digests = (revisions: ReadonlyArray<{ readonly digest: string }>) =>
    revisions.map((revision) => revision.digest).toSorted();
  expect(digests(current.revisions)).toEqual(digests(legacy.revisions));
  expect(digests(current.heads)).toEqual(digests(legacy.heads));
  expect(current.revision).toBe(legacy.revision);
  expect(
    current.legacy === undefined
      ? undefined
      : { defaultAccess: current.legacy.defaultAccess, machines: current.legacy.machines },
  ).toEqual(legacy.snapshot);
  // Every fleet machine's own level is exactly 1.0.26's. One whose ID is reserved is no machine to
  // this version, which gives it nothing.
  for (const peer of peers.filter((item) => !FleetAccessPolicy.reservedMachineId(item.machineId)))
    expect(FleetAccessPolicy.machineAccess(asState(current.snapshot), peer.machineId)).toBe(
      legacy.snapshot === undefined ? "standard" : V1026.accessOf(legacy.snapshot, peer.machineId),
    );
  // Accepted once, the same revisions count again from a cache.
  const cached = {
    ...input,
    accepted: current.revisions.map((revision) => revision.entry),
    candidates: [],
  };
  expect(digests(FleetAccessPolicy.evaluateAccess(cached).revisions)).toEqual(
    digests(V1026.evaluateAccess(cached).revisions),
  );
  const counted = new Set(digests(current.revisions));
  return {
    current,
    legacy,
    counts: (entry: FleetAccessEntry) => counted.has(FleetAccessPolicy.entryDigest(entry)),
    access: (caller: Machine, receiver: Machine) =>
      current.snapshot === undefined
        ? "standard"
        : FleetAccessPolicy.pairAccess(current.snapshot, id(caller), id(receiver)),
    /** Whether the counted list holds that exception, whether it applies or not. */
    grants: (caller: Machine, receiver: Machine) =>
      (current.snapshot?.pairs ?? []).includes(pair(caller, receiver)),
  };
}

/** R1: AnvilToad and SPDevMachine read-only. R2: AnvilToad standard on SPDevMachine. */
const base = () => {
  const r1 = sign(cryo, [], [readOnly(anvil), readOnly(spd)]);
  const r2 = sign(cryo, [r1], [readOnly(anvil), readOnly(spd)], { pairs: [pair(anvil, spd)] });
  return { r1, r2 };
};

describe("fleet access revisions count the same in LAN 1.0.26 and this version", () => {
  it("stops both at R2 when a read-only machine drops its own exception (the review's history)", () => {
    const { r1, r2 } = base();
    // R3: AnvilToad keeps the base list but removes its own exception.
    const r3 = sign(anvil, [r2], edit(r2, without(pair(anvil, spd))));
    // R4: CryoFrog follows R3 and makes PandaMedic read-only.
    const r4 = sign(cryo, [r3], [readOnly(anvil), readOnly(spd), readOnly(panda)]);
    const result = parity([r1, r2, r3, r4]);
    expect(result.counts(r3)).toBe(false);
    expect(result.counts(r4)).toBe(false);
    expect(result.current.revision).toBe(2);
    expect(result.access(panda, cryo)).toBe("standard");
    expect(result.access(anvil, spd)).toBe("standard");
    // A revision that follows R2 instead counts in both.
    const r4b = sign(cryo, [r2], [readOnly(anvil), readOnly(spd), readOnly(panda)], {
      pairs: [pair(anvil, spd)],
    });
    const followed = parity([r1, r2, r3, r4b]);
    expect(followed.current.revision).toBe(3);
    expect(followed.access(panda, cryo)).toBe("read-only");
    expect(followed.access(anvil, spd)).toBe("standard");
  });

  it("counts a read-only machine's revision only when it restricts nothing but itself", () => {
    const { r1, r2 } = base();
    const cases: ReadonlyArray<readonly [string, Entries, boolean, Access?]> = [
      ["keeps every entry as it was", edit(r2, () => {}), true],
      [
        "grants itself another exception",
        edit(r2, (entries) => entries.push({ machineId: pair(anvil, cryo), access: "standard" })),
        false,
      ],
      ["removes its own exception", edit(r2, without(pair(anvil, spd))), false],
      [
        "grants another machine one",
        edit(r2, (entries) => entries.push({ machineId: pair(spd, anvil), access: "standard" })),
        false,
      ],
      [
        "drops the writer's mark",
        edit(r2, (entries) => {
          const mark = entries.findIndex((entry) => entry.machineId.startsWith("pair-access-w"));
          entries.splice(mark, 1);
        }),
        false,
      ],
      [
        "lifts itself",
        edit(r2, (entries) => {
          entries[entries.findIndex((entry) => entry.machineId === id(anvil))] = {
            machineId: id(anvil),
            access: "standard",
          };
        }),
        false,
      ],
      ["restricts another machine", edit(r2, (entries) => entries.push(readOnly(panda))), false],
      ["changes the default", edit(r2, () => {}), false, "read-only"],
    ];
    for (const [, machines, counted, defaultAccess] of cases) {
      const entry = sign(
        anvil,
        [r2],
        machines,
        defaultAccess === undefined ? {} : { defaultAccess },
      );
      const result = parity([r1, r2, entry]);
      expect(result.counts(entry)).toBe(counted);
      expect(result.access(anvil, spd)).toBe("standard");
      expect(result.grants(anvil, cryo)).toBe(false);
      expect(result.access(spd, anvil)).toBe("read-only");
    }
    // Marking its own revision with exceptions, as a standard writer would, never counts.
    const marked = sign(anvil, [r2], [readOnly(anvil), readOnly(spd)], {
      pairs: [pair(anvil, spd), pair(anvil, cryo)],
    });
    expect(parity([r1, r2, marked]).counts(marked)).toBe(false);
  });

  it("counts every standard machine's revision, whether it changes exceptions or not", () => {
    const { r1, r2 } = base();
    const added = sign(panda, [r2], [readOnly(anvil), readOnly(spd)], {
      pairs: [pair(anvil, spd), pair(spd, anvil)],
    });
    const removed = sign(cryo, [added], [readOnly(anvil), readOnly(spd)], { pairs: [] });
    const legacySave = sign(
      panda,
      [removed],
      edit(removed, (entries) => entries.push(readOnly(cryo))),
    );
    const result = parity([r1, r2, added, removed, legacySave]);
    expect(result.current.revision).toBe(5);
    expect(result.access(anvil, spd)).toBe("read-only");
    expect(result.access(cryo, panda)).toBe("read-only");
    // A 1.0.26 save that copies a marked parent keeps its exceptions, and adds none.
    const copied = sign(
      panda,
      [added],
      edit(added, (entries) => entries.push(readOnly(cryo))),
    );
    const kept = parity([r1, r2, added, copied]);
    expect(kept.access(spd, anvil)).toBe("standard");
    const widened = sign(
      panda,
      [added],
      edit(added, (entries) => entries.push({ machineId: pair(anvil, cryo), access: "standard" })),
    );
    const refused = parity([r1, r2, added, widened]);
    expect(refused.counts(widened)).toBe(true);
    expect(refused.grants(anvil, cryo)).toBe(false);
  });

  it("joins competing revisions the same way, and keeps only exceptions all of them grant", () => {
    const { r1 } = base();
    const both = pair(spd, anvil);
    const one = pair(anvil, spd);
    const left = sign(cryo, [r1], [readOnly(anvil), readOnly(spd)], { pairs: [both, one] });
    const right = sign(panda, [r1], [readOnly(anvil), readOnly(spd)], { pairs: [both] });
    const heads = parity([r1, left, right]);
    expect(heads.current.heads).toHaveLength(2);
    expect(heads.access(spd, anvil)).toBe("standard");
    expect(heads.access(anvil, spd)).toBe("read-only");
    // A standard machine joins them.
    const joined = sign(panda, [left, right], [readOnly(anvil), readOnly(spd)], { pairs: [one] });
    const merged = parity([r1, left, right, joined]);
    expect(merged.counts(joined)).toBe(true);
    expect(merged.access(anvil, spd)).toBe("standard");
    expect(merged.access(spd, anvil)).toBe("read-only");
    // A read-only machine cannot join heads whose entries differ, nor follow one with others'.
    const readOnlyJoin = sign(
      anvil,
      [left, right],
      edit(left, () => {}),
    );
    expect(parity([r1, left, right, readOnlyJoin]).counts(readOnlyJoin)).toBe(false);
    const readOnlyFollow = sign(
      anvil,
      [right],
      edit(left, () => {}),
    );
    expect(parity([r1, left, right, readOnlyFollow]).counts(readOnlyFollow)).toBe(false);
    // Following one head with its entries counts, and grants no more than that head.
    const follows = sign(
      anvil,
      [left],
      edit(left, () => {}),
    );
    const followed = parity([r1, left, right, follows]);
    expect(followed.counts(follows)).toBe(true);
    expect(followed.access(anvil, spd)).toBe("read-only");
    // A 1.0.26 machine joining them lists both heads' exceptions but grants only the shared one.
    const legacyJoin = sign(
      cryo,
      [left, right],
      edit(left, (entries) => entries.push(readOnly(panda))),
    );
    const legacyMerged = parity([r1, left, right, legacyJoin]);
    expect(legacyMerged.counts(legacyJoin)).toBe(true);
    expect(legacyMerged.access(spd, anvil)).toBe("standard");
    expect(legacyMerged.access(anvil, spd)).toBe("read-only");
  });

  it("counts the same revisions from a writer that left, and one that leaves no machine standard", () => {
    const { r1, r2 } = base();
    const lifted = sign(cryo, [r2], [readOnly(anvil)], { pairs: [pair(anvil, spd)] });
    // CryoFrog left: its revisions no longer verify and only restrict.
    const others = [panda, anvil, spd].map((machine) => machine.peer);
    const left = parity([r1, r2, lifted], [{ ...cryo.peer, enabled: false }, ...others]);
    expect(left.current.revision).toBe(3);
    expect(left.access(spd, panda)).toBe("read-only");
    expect(left.access(anvil, spd)).toBe("read-only");
    const nobody = sign(cryo, [r2], [], { defaultAccess: "read-only", pairs: [pair(anvil, spd)] });
    expect(parity([r1, r2, nobody]).counts(nobody)).toBe(false);
  });

  it("counts the same revisions beside a forged machine whose ID is an exception's entry", () => {
    // Only forged share files could admit this ID, and 1.0.26 would admit it: revisions still
    // verify against its key exactly as 1.0.26 verifies them. Its entry is always the exception.
    const odd = syntheticFleetPeer(pair(anvil, spd));
    const peers = [...fleet, odd].map((machine) => machine.peer);
    const r1 = sign(cryo, [], [readOnly(anvil), readOnly(spd), readOnly(odd)]);
    const restricted = parity([r1], peers);
    expect(restricted.access(anvil, spd)).toBe("read-only");
    // Read-only to 1.0.26, its own revision counts on neither.
    const lift = sign(odd, [r1], edit(r1, without(id(odd))));
    expect(parity([r1, lift], peers).counts(lift)).toBe(false);
    // Standard in a marked revision, the entry is AnvilToad's exception on SPDevMachine, as it is
    // on every machine whatever the fleet's membership.
    const r2 = sign(
      cryo,
      [r1],
      [readOnly(anvil), readOnly(spd), { machineId: id(odd), access: "standard" }],
      { pairs: [pair(spd, anvil)] },
    );
    const standard = parity([r1, r2], peers);
    expect(standard.access(anvil, spd)).toBe("standard");
    expect(standard.access(spd, anvil)).toBe("standard");
    expect(parity([r1, r2]).access(anvil, spd)).toBe("standard");
    // A revision its key signs counts exactly as 1.0.26 counts it.
    const byOdd = sign(
      odd,
      [r2],
      edit(r2, (entries) => entries.push(readOnly(panda))),
    );
    expect(parity([r1, r2, byOdd], peers).counts(byOdd)).toBe(true);
  });

  it("counts the same revisions over many random histories, and never lets a read-only writer widen", () => {
    let seed = 0x2f6b_1d3a;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const pick = <A>(items: ReadonlyArray<A>) => items[random(items.length)]!;
    const allPairs = fleet.flatMap((caller) =>
      fleet.filter((receiver) => receiver !== caller).map((receiver) => pair(caller, receiver)),
    );
    let counted = 0;
    for (let history = 0; history < 120; history++) {
      const entries: Array<FleetAccessEntry> = [
        sign(pick(fleet), [], [readOnly(anvil), readOnly(spd)], { pairs: [pair(anvil, spd)] }),
      ];
      for (let step = 0; step < 7; step++) {
        const parent = pick(entries);
        const second = pick(entries);
        const parents =
          random(5) === 0 && second !== parent && second.revision === parent.revision
            ? [parent, second]
            : [parent];
        const signer = pick(fleet);
        const level: Access = random(2) === 0 ? "read-only" : "standard";
        const op = random(7);
        const machines =
          op === 0
            ? edit(parent, () => {})
            : op === 1
              ? edit(parent, (list) => {
                  without(id(signer))(list);
                  list.push({ machineId: id(signer), access: level });
                })
              : op === 2
                ? edit(parent, (list) => {
                    const target = pick(fleet);
                    without(id(target))(list);
                    list.push({ machineId: id(target), access: level });
                  })
                : op === 3
                  ? edit(parent, (list) => list.push({ machineId: pick(allPairs), access: level }))
                  : op === 4
                    ? edit(parent, (list) => {
                        const encoded = list.filter((entry) =>
                          entry.machineId.startsWith("pair-access-"),
                        );
                        if (encoded.length > 0) without(pick(encoded).machineId)(list);
                      })
                    : parent.machines.filter(
                        (entry) => !entry.machineId.startsWith("pair-access-"),
                      );
        const entry = sign(signer, parents, machines, {
          ...(op >= 5 ? { pairs: allPairs.filter(() => random(3) === 0) } : {}),
          ...(random(12) === 0 ? { defaultAccess: "read-only" as const } : {}),
        });
        entries.push(entry);
      }
      const result = parity(entries);
      counted += result.current.revisions.length;
      // A revision whose writer was read-only grants no exception its parents did not.
      const byDigest = new Map(result.current.revisions.map((item) => [item.digest, item]));
      for (const item of result.current.revisions) {
        const parents = (
          item.entry.version === 2
            ? item.entry.previous
            : item.entry.previous === null
              ? []
              : [item.entry.previous]
        ).map((digest) => byDigest.get(digest)!);
        if (
          parents.some(
            (parent) =>
              FleetAccessPolicy.machineAccess(
                asState(parent.effective),
                item.entry.signerMachineId,
              ) === "read-only",
          )
        ) {
          for (const granted of item.effective.pairs ?? [])
            for (const parent of parents) expect(parent.effective.pairs).toContain(granted);
          expect(
            FleetAccessPolicy.machineAccess(asState(item.effective), item.entry.signerMachineId),
          ).toBe("read-only");
        }
      }
    }
    // The histories really exercise the chain, not just first revisions.
    expect(counted).toBeGreaterThan(400);
  });
});
