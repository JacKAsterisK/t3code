import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as Config from "../config.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import { credentialAccess, fleetCredentialScopes } from "./FleetAccessPolicy.ts";
import type { FleetPeer } from "./FleetDelivery.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { writeFleetJson } from "./FleetFiles.ts";

describe("fleet credential scopes", () => {
  it("let a read-only machine read and observe another's threads but not launch, send, interrupt or respond", () => {
    const readOnly = fleetCredentialScopes("read-only");
    // Sends, interrupts and answers to approvals and questions are all dispatched commands.
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.launchThread,
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
      WS_METHODS.projectsMutate,
    ])
      expect(readOnly).not.toContain(requiredScopeForRpcMethod(method));
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
      ORCHESTRATION_V2_WS_METHODS.searchThreads,
      ORCHESTRATION_V2_WS_METHODS.getTurnItem,
    ])
      expect(readOnly).toContain(requiredScopeForRpcMethod(method));
    expect(credentialAccess({ scopes: readOnly })).toBe("read-only");
    expect(credentialAccess({ scopes: fleetCredentialScopes("standard") })).toBe("standard");
  });
});

const FLEET_ID = "fleet-synthetic";
type Machine = ReturnType<typeof syntheticFleetPeer>;
type Access = "read-only" | "standard";

// Synthetic machines on one temporary share; each policy instance has its own empty state directory.
const fleet = Effect.fn("FleetAccessPolicyTest.fleet")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* Config.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-share-" });
  const cryo = syntheticFleetPeer("cryofrog");
  const panda = syntheticFleetPeer("pandamedic");
  const anvil = syntheticFleetPeer("anviltoad");
  const spd = syntheticFleetPeer("spdevmachine");
  let peers: ReadonlyArray<FleetPeer> = [cryo.peer, panda.peer, anvil.peer, spd.peer];
  const machine = Effect.fn("FleetAccessPolicyTest.machine")(function* () {
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-state-" });
    const context = yield* Layer.build(
      FleetAccessPolicy.layer.pipe(Layer.provide(Config.layer({ ...base, stateDir }))),
    );
    return Context.get(context, FleetAccessPolicy.FleetAccess);
  });
  const input = (self: Machine) => ({
    root,
    fleetId: FLEET_ID,
    machineId: self.peer.machineId,
    peers,
    legacyAccess: "standard" as const,
    signingPrivateKey: self.signingPrivateKey,
  });
  const directory = path.join(root, "fleet-access");
  const writeEntry = (entry: FleetAccessPolicy.FleetAccessEntry) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.andThen(
          writeFleetJson(path.join(directory, FleetAccessPolicy.entryFileName(entry)), entry),
        ),
      );
  const sign = (
    signer: Machine,
    revision: number,
    previous: string | null,
    machines: ReadonlyArray<{ machineId: string; access: Access }>,
    createdAt = 0,
    defaultAccess: Access = "standard",
  ) =>
    FleetAccessPolicy.signAccessEntry(
      {
        version: 1,
        fleetId: FLEET_ID,
        revision,
        previous,
        signerMachineId: signer.peer.machineId,
        createdAt,
        defaultAccess,
        machines,
      },
      signer.signingPrivateKey,
    );
  const change = (
    service: FleetAccessPolicy.FleetAccess["Service"],
    self: Machine,
    expectedRevision: number,
    machines: ReadonlyArray<{ machineId: string; access: Access }>,
  ) =>
    service.change({
      ...input(self),
      expectedRevision,
      next: { defaultAccess: "standard", machines },
    });
  const accessOf = (state: FleetAccessPolicy.FleetAccessState, self: Machine) =>
    FleetAccessPolicy.machineAccess(state, self.peer.machineId);
  const readOnly = (self: Machine) => ({
    machineId: self.peer.machineId,
    access: "read-only" as const,
  });
  const writeSeed = (seed: unknown) =>
    fs.writeFileString(
      path.join(root, FleetAccessPolicy.SEED_FILE),
      typeof seed === "string" ? seed : JSON.stringify(seed),
    );
  const seedOf = (...machines: ReadonlyArray<Machine>) => ({
    version: 1,
    fleetId: FLEET_ID,
    readOnly: machines.map((machine) => machine.peer.machineId),
  });
  return {
    fs,
    path,
    root,
    directory,
    cryo,
    panda,
    anvil,
    spd,
    machine,
    input,
    writeEntry,
    sign,
    change,
    accessOf,
    readOnly,
    writeSeed,
    seedOf,
    setPeers: (next: ReadonlyArray<FleetPeer>) => {
      peers = next;
    },
  };
});

const configLayer = Config.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fleet-access-config-",
});

it.layer(NodeServices.layer)("fleet access policy revisions", (it) => {
  it.effect(
    "never lets a ground competing first revision lift a restriction, even with an empty cache",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        const cryo = yield* f.machine();
        yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.anvil)]);
        const legit = (yield* f.fs.readDirectory(f.directory))[0]!;
        // AnvilToad grinds its own "everyone standard" first revision until it sorts first.
        let createdAt = 0;
        let forged = f.sign(f.anvil, 1, null, [], createdAt);
        while (FleetAccessPolicy.entryFileName(forged) > legit)
          forged = f.sign(f.anvil, 1, null, [], ++createdAt);
        yield* f.writeEntry(forged);
        // It also extends that branch, where it was never restricted.
        yield* f.writeEntry(f.sign(f.anvil, 2, FleetAccessPolicy.entryDigest(forged), []));
        const fresh = yield* f.machine();
        for (const [service, self] of [
          [fresh, f.panda],
          [cryo, f.cryo],
        ] as const) {
          const state = yield* service.refresh(f.input(self));
          expect(f.accessOf(state, f.anvil)).toBe("read-only");
        }
        // Its own server sees it restricted too, and it cannot write its way out.
        const anvil = yield* f.machine();
        const own = yield* anvil.refresh(f.input(f.anvil));
        expect(FleetAccessPolicy.selfAccess(own)).toBe("read-only");
        expect((yield* f.change(anvil, f.anvil, own.revision, []).pipe(Effect.flip)).reason).toBe(
          "configuration",
        );
        // A standard machine's next change follows both heads and applies everywhere.
        yield* f.change(cryo, f.cryo, own.revision, [f.readOnly(f.anvil), f.readOnly(f.spd)]);
        const joined = yield* (yield* f.machine()).refresh(f.input(f.panda));
        expect(joined.revision).toBe(3);
        expect(f.accessOf(joined, f.anvil)).toBe("read-only");
        expect(f.accessOf(joined, f.spd)).toBe("read-only");
        expect(f.accessOf(joined, f.cryo)).toBe("standard");
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("keeps verifying history after its writer leaves or changes keys", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const cryo = yield* f.machine();
      const panda = yield* f.machine();
      yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.anvil)]);
      yield* panda.refresh(f.input(f.panda));
      yield* f.change(panda, f.panda, 1, [f.readOnly(f.anvil), f.readOnly(f.spd)]);
      // CryoFrog leaves. Its revision no longer verifies, but PandaMedic's builds on it.
      const others = [f.panda.peer, f.anvil.peer, f.spd.peer];
      f.setPeers([{ ...f.cryo.peer, enabled: false }, ...others]);
      const fresh = yield* (yield* f.machine()).refresh(f.input(f.spd));
      expect(fresh.revision).toBe(2);
      expect(f.accessOf(fresh, f.anvil)).toBe("read-only");
      expect(f.accessOf(fresh, f.spd)).toBe("read-only");

      // CryoFrog returns with a new key and lifts SPDevMachine, then changes keys again.
      const rekeyed = syntheticFleetPeer("cryofrog");
      f.setPeers([rekeyed.peer, ...others]);
      yield* f.change(yield* f.machine(), rekeyed, 2, [f.readOnly(f.anvil)]);
      yield* panda.refresh({ ...f.input(f.panda) });
      f.setPeers([syntheticFleetPeer("cryofrog").peer, ...others]);
      // A machine that never saw that lift verified only takes the restrictions from it.
      const unendorsed = yield* (yield* f.machine()).refresh(f.input(f.spd));
      expect(f.accessOf(unendorsed, f.spd)).toBe("read-only");
      expect(f.accessOf(unendorsed, f.anvil)).toBe("read-only");
      // PandaMedic accepted it while it verified, and re-signs it for the others.
      const endorsed = yield* panda.refresh(f.input(f.panda));
      expect(endorsed.revision).toBe(4);
      expect(f.accessOf(endorsed, f.spd)).toBe("standard");
      const after = yield* (yield* f.machine()).refresh(f.input(f.spd));
      expect(f.accessOf(after, f.spd)).toBe("standard");
      expect(f.accessOf(after, f.anvil)).toBe("read-only");
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("never starts a second chain beside history it cannot follow", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const first = f.sign(f.cryo, 1, null, [f.readOnly(f.anvil)]);
      // The share lost the first revision; only its successor remains.
      yield* f.writeEntry(
        f.sign(f.cryo, 2, FleetAccessPolicy.entryDigest(first), [f.readOnly(f.anvil)]),
      );
      const fresh = yield* f.machine();
      expect((yield* fresh.refresh(f.input(f.panda))).revision).toBe(0);
      expect((yield* f.change(fresh, f.panda, 0, []).pipe(Effect.flip)).reason).toBe(
        "configuration",
      );
      expect((yield* f.fs.readDirectory(f.directory)).length).toBe(1);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("refuses, when verifying, a revision that leaves no machine standard", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      yield* f.writeEntry(f.sign(f.cryo, 1, null, [], 0, "read-only"));
      const state = yield* (yield* f.machine()).refresh(f.input(f.panda));
      expect(state.revision).toBe(0);
      expect(FleetAccessPolicy.selfAccess(state)).toBe("standard");
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "adopts the starting list as the first revision, which every machine then follows",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
        // A machine that cannot sign leaves it waiting.
        const { signingPrivateKey: _, ...unsigned } = f.input(f.cryo);
        const waiting = yield* (yield* f.machine()).refresh(unsigned);
        expect(waiting).toMatchObject({ revision: 0, seed: "waiting" });
        expect(yield* f.fs.exists(f.directory)).toBe(false);

        // A machine the list makes read-only may adopt it: it only restricts.
        const adopted = yield* (yield* f.machine()).refresh(f.input(f.anvil));
        expect(adopted.revision).toBe(1);
        expect(adopted.seed).toBeUndefined();
        expect(adopted.defaultAccess).toBe("standard");
        expect(f.accessOf(adopted, f.anvil)).toBe("read-only");
        expect(f.accessOf(adopted, f.spd)).toBe("read-only");
        expect(f.accessOf(adopted, f.cryo)).toBe("standard");
        expect(f.accessOf(adopted, f.panda)).toBe("standard");
        const other = yield* (yield* f.machine()).refresh(f.input(f.panda));
        expect(other.seed).toBeUndefined();
        expect(other).toMatchObject({ revision: 1, machines: adopted.machines });
        expect(yield* f.fs.readDirectory(f.directory)).toHaveLength(1);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("lets only one of the machines adopting the starting list at once write it", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
      const machines = [
        [yield* f.machine(), f.cryo],
        [yield* f.machine(), f.panda],
        [yield* f.machine(), f.anvil],
      ] as const;
      yield* Effect.forEach(machines, ([service, self]) => service.refresh(f.input(self)), {
        concurrency: "unbounded",
      });
      for (const [service, self] of machines) {
        const state = yield* service.refresh(f.input(self));
        expect(state).toMatchObject({ revision: 1, defaultAccess: "standard" });
        expect(state.seed).toBeUndefined();
        expect(f.accessOf(state, f.anvil)).toBe("read-only");
        expect(f.accessOf(state, f.spd)).toBe("read-only");
        expect(f.accessOf(state, f.cryo)).toBe("standard");
      }
      expect(yield* f.fs.readDirectory(f.directory)).toHaveLength(1);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("ignores the starting list once any list exists, on the share or only here", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const cryo = yield* f.machine();
      yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.spd)]);
      yield* f.writeSeed(f.seedOf(f.anvil));
      const fresh = yield* (yield* f.machine()).refresh(f.input(f.panda));
      expect(fresh.revision).toBe(1);
      expect(fresh.seed).toBeUndefined();
      expect(f.accessOf(fresh, f.anvil)).toBe("standard");

      // The share loses its list; the copy this machine accepted still counts.
      yield* f.fs.remove(f.directory, { recursive: true });
      const cached = yield* cryo.refresh(f.input(f.cryo));
      expect(cached.revision).toBe(1);
      expect(cached.seed).toBeUndefined();
      expect(f.accessOf(cached, f.anvil)).toBe("standard");
      expect(f.accessOf(cached, f.spd)).toBe("read-only");

      // So does history on the share that cannot be followed.
      const lost = f.sign(f.cryo, 1, null, []);
      yield* f.writeEntry(f.sign(f.cryo, 2, FleetAccessPolicy.entryDigest(lost), []));
      const unfollowed = yield* (yield* f.machine()).refresh(f.input(f.panda));
      expect(unfollowed.revision).toBe(0);
      expect(unfollowed.seed).toBeUndefined();
      expect(yield* f.fs.readDirectory(f.directory)).toHaveLength(1);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("reports a starting list it cannot use and writes nothing", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const ids = (...machines: ReadonlyArray<Machine>) =>
        machines.map((machine) => machine.peer.machineId);
      for (const seed of [
        "{not json",
        { ...f.seedOf(f.anvil), version: 2 },
        { ...f.seedOf(f.anvil), fleetId: "another-fleet" },
        { ...f.seedOf(f.anvil), standard: ids(f.cryo) },
        f.seedOf(),
        { ...f.seedOf(), readOnly: ["machine-not-in-this-fleet"] },
        f.seedOf(f.anvil, f.anvil),
        f.seedOf(f.cryo, f.panda, f.anvil, f.spd),
      ]) {
        yield* f.writeSeed(seed);
        const state = yield* (yield* f.machine()).refresh(f.input(f.cryo));
        expect(state).toMatchObject({ revision: 0, seed: "invalid" });
        expect(yield* f.fs.exists(f.directory)).toBe(false);
      }
      // Without the file, nothing changes.
      yield* f.fs.remove(f.path.join(f.root, FleetAccessPolicy.SEED_FILE));
      const none = yield* (yield* f.machine()).refresh(f.input(f.cryo));
      expect(none.revision).toBe(0);
      expect(none.seed).toBeUndefined();
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("keeps a restriction for a machine that drops out and comes back", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const cryo = yield* f.machine();
      yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.anvil)]);
      f.setPeers([f.cryo.peer, f.panda.peer, { ...f.anvil.peer, enabled: false }, f.spd.peer]);
      yield* f.change(cryo, f.cryo, 1, [f.readOnly(f.anvil), f.readOnly(f.spd)]);
      f.setPeers([f.cryo.peer, f.panda.peer, f.anvil.peer, f.spd.peer]);
      expect(f.accessOf(yield* cryo.refresh(f.input(f.cryo)), f.anvil)).toBe("read-only");
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("clears a lock a crashed change left behind, but not a live one", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const cryo = yield* f.machine();
      const lock = f.path.join(f.root, "fleet-access.lock");
      yield* f.fs.makeDirectory(lock);
      // The test clock starts at zero, so a lock made on disk just now reads as live.
      expect(
        (yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.anvil)]).pipe(Effect.flip)).reason,
      ).toBe("busy");
      yield* f.fs.utimes(lock, 0, 0);
      yield* TestClock.adjust(FleetAccessPolicy.STALE_LOCK_MS + 1);
      expect((yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.anvil)])).revision).toBe(1);
      expect(yield* f.fs.exists(lock)).toBe(false);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("keeps the last accepted policy when the share is flooded with entry files", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const cryo = yield* f.machine();
      yield* f.change(cryo, f.cryo, 0, [f.readOnly(f.anvil)]);
      for (let index = 0; index <= 1000; index++)
        yield* f.fs.writeFileString(
          f.path.join(f.directory, `000009-${index.toString(16).padStart(16, "0")}.json`),
          "{}",
        );
      // A machine that accepted the policy keeps it and reports the share unreadable.
      const cached = yield* cryo.refresh(f.input(f.cryo));
      expect(cached.unavailable).toBe(true);
      expect(cached.revision).toBe(1);
      expect(f.accessOf(cached, f.anvil)).toBe("read-only");
      expect((yield* f.change(cryo, f.cryo, 1, []).pipe(Effect.flip)).reason).toBe("unavailable");
      // It caps at that policy but may revoke nothing for access until the share reads again.
      expect(FleetAccessPolicy.policyApplies(cached)).toBe(true);
      expect(FleetAccessPolicy.mayRevokeForAccess(cached)).toBe(false);
      // One that never accepted a policy behaves as before any was saved, never read-only.
      const fresh = yield* (yield* f.machine()).refresh(f.input(f.anvil));
      expect(fresh.unavailable).toBe(true);
      expect(FleetAccessPolicy.policyApplies(fresh)).toBe(false);
      expect(FleetAccessPolicy.selfAccess(fresh)).toBe("standard");
      expect(f.accessOf(fresh, f.panda)).toBe("standard");
    }).pipe(Effect.provide(configLayer)),
  );
});
