// @effect-diagnostics nodeBuiltinImport:off -- the test signs a readiness marker as another machine would.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FLEET_ROSTER_ENV, FLEET_SWITCH_ROSTER } from "./FleetBootstrap.ts";
import { describe, expect, it } from "@effect/vitest";
import { LanFleetError, ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as Config from "../config.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as Authority from "./FleetAuthority.ts";
import * as Vault from "./FleetVault.ts";
import { credentialAccess, fleetCredentialScopes } from "./FleetAccessPolicy.ts";
import * as Delivery from "./FleetDelivery.ts";
import type { FleetPeer } from "./FleetDelivery.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

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
  const machine = Effect.fn("FleetAccessPolicyTest.machine")(function* (
    existingStateDir?: string,
    read: Vault.FleetVault["Service"]["read"] = Effect.undefined,
  ) {
    const stateDir =
      existingStateDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-state-" }));
    const context = yield* Layer.build(
      FleetAccessPolicy.layerWithCredentialReader(read).pipe(
        Layer.provide(Config.layer({ ...base, stateDir })),
      ),
    );
    return Context.get(context, FleetAccessPolicy.FleetAccess);
  });
  const deliveryDirectory = path.join(root, "fleet-deliveries");
  const input = (self: Machine) => ({
    root,
    fleetId: FLEET_ID,
    machineId: self.peer.machineId,
    peers,
    legacyAccess: "standard" as const,
    member: true,
    signingPrivateKey: self.signingPrivateKey,
  });
  const catalogFile = (self: Machine) =>
    path.join(
      deliveryDirectory,
      `${Delivery.deliveryFileName(self.peer.machineId, self.peer.machineId)}.catalog.json`,
    );
  /** `self` publishes its signed connection summary, as a running 1.0.24 or 1.0.25 does. */
  const publishCatalog = (self: Machine, createdAt?: number) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(deliveryDirectory, { recursive: true });
      const now = createdAt ?? (yield* Clock.currentTimeMillis);
      yield* writeFleetJson(
        catalogFile(self),
        Delivery.makeFleetCatalog(
          {
            version: 1,
            machineId: self.peer.machineId,
            autoPickup: true,
            encryptionPrivateKey: self.encryptionPrivateKey,
            signingPrivateKey: self.signingPrivateKey,
            peers,
          },
          self.peer,
          [],
          now,
        ),
      );
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
    defaultAccess: "standard",
    readOnly: machines.map((machine) => machine.peer.machineId),
  });
  const seedFile = path.join(root, FleetAccessPolicy.SEED_FILE);
  const readyDirectory = path.join(root, FleetAccessPolicy.SEED_READY_DIRECTORY);
  /** What a machine on a build that takes replaced credentials writes, signed by `signer`. */
  const markReady = (
    self: Machine,
    signer: Machine = self,
    at: { readonly root: string; readonly fleetId: string } = { root, fleetId: FLEET_ID },
  ) => {
    const markerDirectory = path.join(at.root, FleetAccessPolicy.SEED_READY_DIRECTORY);
    const marker = {
      version: 1 as const,
      fleetId: at.fleetId,
      machineId: self.peer.machineId,
      createdAt: 0,
    };
    const data = JSON.stringify([
      "fleet-access-ready",
      marker.version,
      marker.fleetId,
      marker.machineId,
      marker.createdAt,
    ]);
    return fs.makeDirectory(markerDirectory, { recursive: true }).pipe(
      Effect.andThen(
        writeFleetJson(path.join(markerDirectory, `${self.peer.machineId}.json`), {
          ...marker,
          signature: NodeCrypto.sign(null, Buffer.from(data), signer.signingPrivateKey).toString(
            "base64",
          ),
        }),
      ),
    );
  };
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
    seedFile,
    markReady,
    readyFile: (self: Machine) => path.join(readyDirectory, `${self.peer.machineId}.json`),
    publishCatalog,
    catalogFile,
    setPeers: (next: ReadonlyArray<FleetPeer>) => {
      peers = next;
    },
  };
});

const configLayer = Config.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fleet-access-config-",
});

describe("fleet access exception evaluation", () => {
  const anvil = "anviltoad";
  const spd = "spdevmachine";
  const panda = "pandamedic";
  const snapshot = (
    levels: Record<string, Access>,
    standardOn: Record<string, ReadonlyArray<string>>,
  ): FleetAccessPolicy.FleetAccessSnapshot => ({
    defaultAccess: "standard",
    machines: Object.entries(levels).map(([machineId, access]) => ({ machineId, access })),
    pairs: FleetAccessPolicy.replaceExceptions(
      [],
      Object.entries(standardOn).map(([machineId, receivers]) => ({
        machineId,
        standardOn: receivers,
      })),
    ),
  });

  it("applies an exception only while its receiver is read-only itself", () => {
    // Standard on PandaMedic would reach every machine PandaMedic writes to.
    const list = snapshot({ [anvil]: "read-only" }, { [anvil]: [panda] });
    expect(FleetAccessPolicy.exceptionApplies(list, panda)).toBe(false);
    expect(FleetAccessPolicy.pairAccess(list, anvil, panda)).toBe("read-only");
    // An unlisted receiver has the list's default.
    const unlisted = snapshot({ [anvil]: "read-only" }, { [anvil]: ["buildmachine"] });
    expect(FleetAccessPolicy.pairAccess(unlisted, anvil, "buildmachine")).toBe("read-only");
    expect(
      FleetAccessPolicy.pairAccess(
        { ...unlisted, defaultAccess: "read-only" },
        anvil,
        "buildmachine",
      ),
    ).toBe("standard");
  });

  it("follows the receiver's level as it changes, the exception stored throughout", () => {
    const at = (receiver: Access) =>
      snapshot({ [anvil]: "read-only", [spd]: receiver }, { [anvil]: [spd] });
    expect(FleetAccessPolicy.pairAccess(at("read-only"), anvil, spd)).toBe("standard");
    expect(FleetAccessPolicy.pairAccess(at("standard"), anvil, spd)).toBe("read-only");
    expect(at("standard").pairs).toEqual(at("read-only").pairs);
    expect(FleetAccessPolicy.pairAccess(at("read-only"), anvil, spd)).toBe("standard");
    // A standard caller is standard everywhere, exception or not.
    expect(FleetAccessPolicy.pairAccess(at("standard"), spd, anvil)).toBe("standard");
  });

  it("gives two read-only machines standard on each other and on no other machine", () => {
    const list = snapshot(
      { [anvil]: "read-only", [spd]: "read-only" },
      { [anvil]: [spd], [spd]: [anvil] },
    );
    expect(FleetAccessPolicy.pairAccess(list, anvil, spd)).toBe("standard");
    expect(FleetAccessPolicy.pairAccess(list, spd, anvil)).toBe("standard");
    for (const caller of [anvil, spd])
      expect(FleetAccessPolicy.pairAccess(list, caller, panda)).toBe("read-only");
    const state = { ...list, revision: 1, peers: [] };
    expect(FleetAccessPolicy.accessOn({ ...state, machineId: anvil }, spd)).toBe("standard");
    expect(FleetAccessPolicy.callerAccess({ ...state, machineId: spd }, anvil)).toBe("standard");
    expect(FleetAccessPolicy.accessOn({ ...state, machineId: anvil }, panda)).toBe("read-only");
    expect(FleetAccessPolicy.selfAccess({ ...state, machineId: anvil })).toBe("read-only");
  });
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

        // SPDevMachine runs 1.0.26. It says so, and waits for every other machine to.
        const spd = yield* (yield* f.machine()).refresh(f.input(f.spd));
        expect(spd).toMatchObject({
          revision: 0,
          seed: "waiting",
          seedPending: {
            machineIds: [f.cryo.peer.machineId, f.panda.peer.machineId, f.anvil.peer.machineId],
          },
        });
        expect(yield* f.fs.exists(f.directory)).toBe(false);

        // Once the others say so too, a machine the list makes read-only may adopt it: it only
        // restricts.
        yield* f.markReady(f.cryo);
        yield* f.markReady(f.panda);
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
        // Read back from the share, the starting list is spent and removed.
        expect(yield* f.fs.exists(f.seedFile)).toBe(false);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("gives unnamed machines the starting list's default, whichever machine adopts it", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
      yield* f.markReady(f.cryo);
      yield* f.markReady(f.anvil);
      yield* f.markReady(f.spd);
      // The adopting machine was set up granting read-only; the list still says standard.
      const adopted = yield* (yield* f.machine()).refresh({
        ...f.input(f.panda),
        legacyAccess: "read-only",
      });
      expect(adopted.revision).toBe(1);
      expect(adopted.defaultAccess).toBe("standard");
      expect(f.accessOf(adopted, f.cryo)).toBe("standard");
      expect(f.accessOf(adopted, f.panda)).toBe("standard");
      expect(f.accessOf(adopted, f.anvil)).toBe("read-only");
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("lets only one of the machines adopting the starting list at once write it", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
      for (const machine of [f.cryo, f.panda, f.anvil, f.spd]) yield* f.markReady(machine);
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
        { version: 1, fleetId: FLEET_ID, readOnly: ids(f.anvil) },
        { ...f.seedOf(f.anvil), defaultAccess: "full" },
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

  it.effect.each(["fresh", "stale", "missing", "unreadable", "behind-clock"])(
    "waits, however long it takes, for an enabled machine without a marker whose summary is %s",
    (summary) =>
      Effect.gen(function* () {
        const f = yield* fleet();
        yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
        for (const machine of [f.anvil, f.spd]) yield* f.markReady(machine);
        // PandaMedic may run 1.0.25: whatever its connection summary says, it signed no marker.
        const start = yield* Clock.currentTimeMillis;
        if (summary === "fresh") yield* f.publishCatalog(f.panda);
        if (summary === "stale") yield* f.publishCatalog(f.panda, start - 30 * 86_400_000);
        if (summary === "behind-clock") yield* f.publishCatalog(f.panda, 0);
        // A listing that wrongly says the summary is not there, as a share can.
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          exists: (file) =>
            summary === "unreadable" && file === f.catalogFile(f.panda)
              ? Effect.succeed(false)
              : f.fs.exists(file),
        });
        const stateDir = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-state-" });
        for (let day = 0; day <= 30; day += 10) {
          if (day > 0) yield* TestClock.adjust(`${10 * 24} hours`);
          if (summary === "fresh") yield* f.publishCatalog(f.panda);
          // A restart keeps nothing that would end the wait.
          const cryo = yield* f
            .machine(stateDir)
            .pipe(Effect.provideService(FileSystem.FileSystem, observed));
          const waiting = yield* cryo.refresh(f.input(f.cryo));
          expect(waiting).toMatchObject({
            revision: 0,
            seed: "waiting",
            seedPending: { machineIds: [f.panda.peer.machineId] },
          });
          expect(FleetAccessPolicy.policyApplies(waiting)).toBe(false);
          expect(yield* f.fs.exists(f.directory)).toBe(false);
        }
        // A marker signed with another machine's key does not count.
        yield* f.markReady(f.panda, f.cryo);
        const cryo = yield* f.machine(stateDir);
        expect((yield* cryo.refresh(f.input(f.cryo))).revision).toBe(0);
        // It updates and says so: the list is adopted at once.
        yield* f.markReady(f.panda);
        const adopted = yield* cryo.refresh(f.input(f.cryo));
        expect(adopted.revision).toBe(1);
        expect(adopted.seedPending).toBeUndefined();
        expect(f.accessOf(adopted, f.anvil)).toBe("read-only");
        expect(f.accessOf(adopted, f.spd)).toBe("read-only");
        expect(yield* f.fs.exists(f.seedFile)).toBe(false);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("reads every marker again under the lock before it writes the first revision", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
      for (const machine of [f.panda, f.anvil, f.spd]) yield* f.markReady(machine);
      // PandaMedic's marker goes between the check and the lock, as when it is replaced by a
      // machine with new keys that has not said it runs 1.0.26 yet.
      const lock = f.path.join(f.root, "fleet-access.lock");
      const observed = FileSystem.FileSystem.of({
        ...f.fs,
        makeDirectory: (file, options) =>
          file === lock
            ? f.fs
                .remove(f.readyFile(f.panda))
                .pipe(Effect.ignore, Effect.andThen(f.fs.makeDirectory(file, options)))
            : f.fs.makeDirectory(file, options),
      });
      const cryo = yield* f.machine().pipe(Effect.provideService(FileSystem.FileSystem, observed));
      const state = yield* cryo.refresh(f.input(f.cryo));
      expect(state).toMatchObject({
        revision: 0,
        seed: "waiting",
        seedPending: { machineIds: [f.panda.peer.machineId] },
      });
      expect(yield* f.fs.exists(f.directory)).toBe(false);
      expect(yield* f.fs.exists(lock)).toBe(false);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "adopts at once when every enabled machine runs 1.0.26, and never waits for a disabled one",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
        for (const machine of [f.cryo, f.panda, f.anvil, f.spd]) yield* f.publishCatalog(machine);
        for (const machine of [f.panda, f.anvil]) yield* f.markReady(machine);
        // SPDevMachine is disabled: it is not waited for, and still starts read-only.
        f.setPeers([f.cryo.peer, f.panda.peer, f.anvil.peer, { ...f.spd.peer, enabled: false }]);
        const adopted = yield* (yield* f.machine()).refresh(f.input(f.cryo));
        expect(adopted.revision).toBe(1);
        expect(f.accessOf(adopted, f.spd)).toBe("read-only");
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "never brings a spent starting list back once the share and this machine lose the list",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        yield* f.writeSeed(f.seedOf(f.anvil, f.spd));
        for (const machine of [f.panda, f.anvil, f.spd]) yield* f.markReady(machine);
        expect((yield* (yield* f.machine()).refresh(f.input(f.cryo))).revision).toBe(1);
        expect(yield* f.fs.exists(f.seedFile)).toBe(false);
        // The share's list is lost and this machine has no saved history: fleet-access reads as
        // not found. There is no list, nothing is adopted, and no list applies to links.
        yield* f.fs.remove(f.directory, { recursive: true });
        const lost = yield* (yield* f.machine()).refresh(f.input(f.panda));
        expect(lost.revision).toBe(0);
        expect(lost.seed).toBeUndefined();
        expect(FleetAccessPolicy.policyApplies(lost)).toBe(false);
        expect(yield* f.fs.exists(f.directory)).toBe(false);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("waits, without calling it invalid, for a starting list it cannot read", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      // Present but unreadable, as when the share stops answering mid-read.
      yield* f.fs.makeDirectory(f.seedFile);
      const state = yield* (yield* f.machine()).refresh(f.input(f.cryo));
      expect(state.revision).toBe(0);
      expect(state.seed).toBeUndefined();
      expect(state.unavailable).toBe(true);
      expect(yield* f.fs.exists(f.directory)).toBe(false);
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

it.layer(NodeServices.layer)("fleet access exceptions", (it) => {
  type Fleet = Effect.Success<ReturnType<typeof fleet>>;
  /** The live list's shape: AnvilToad and SPDevMachine read-only, standard on each other. */
  const pairList = (f: Fleet) => ({
    defaultAccess: "standard" as const,
    machines: [f.readOnly(f.anvil), f.readOnly(f.spd)],
    pairs: FleetAccessPolicy.replaceExceptions(
      [],
      [
        { machineId: f.anvil.peer.machineId, standardOn: [f.spd.peer.machineId] },
        { machineId: f.spd.peer.machineId, standardOn: [f.anvil.peer.machineId] },
      ],
    ),
  });
  const ids = (f: Fleet) =>
    [f.cryo, f.panda, f.anvil, f.spd].map((machine) => machine.peer.machineId);
  const onlyEntry = (f: Fleet) =>
    Effect.gen(function* () {
      const [name] = yield* f.fs.readDirectory(f.directory);
      const file = f.path.join(f.directory, name!);
      return {
        name: name!,
        file,
        entry: yield* readFleetJson(file, FleetAccessPolicy.FleetAccessEntry),
      };
    });

  it.effect("applies an exception on the receiver it names, for that caller only", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const anvil = f.anvil.peer.machineId;
      const spd = f.spd.peer.machineId;
      yield* (yield* f.machine()).change({
        ...f.input(f.cryo),
        expectedRevision: 0,
        next: pairList(f),
      });
      const spdService = yield* f.machine();
      const atSpd = yield* spdService.refresh(f.input(f.spd));
      expect(FleetAccessPolicy.callerAccess(atSpd, anvil)).toBe("standard");
      expect(FleetAccessPolicy.machineAccess(atSpd, anvil)).toBe("read-only");
      expect(FleetAccessPolicy.callerAccess(atSpd, f.panda.peer.machineId)).toBe("standard");
      expect(yield* spdService.accessFor(f.anvil.peer.environmentId)).toBe("standard");
      for (const self of [f.cryo, f.panda]) {
        const elsewhere = yield* (yield* f.machine()).refresh(f.input(self));
        expect(FleetAccessPolicy.callerAccess(elsewhere, anvil)).toBe("read-only");
        expect(FleetAccessPolicy.callerAccess(elsewhere, spd)).toBe("read-only");
      }
      const atAnvil = yield* (yield* f.machine()).refresh(f.input(f.anvil));
      expect(FleetAccessPolicy.callerAccess(atAnvil, spd)).toBe("standard");
      expect(FleetAccessPolicy.accessOn(atAnvil, spd)).toBe("standard");
      expect(FleetAccessPolicy.accessOnEnvironment(atAnvil, f.spd.peer.environmentId)).toBe(
        "standard",
      );
      expect(FleetAccessPolicy.accessOn(atAnvil, f.cryo.peer.machineId)).toBe("read-only");
      // Its own level, which decides whether it may change the list, stays read-only.
      expect(FleetAccessPolicy.selfAccess(atAnvil)).toBe("read-only");
      expect(FleetAccessPolicy.exceptionsOf(atSpd, ids(f))).toEqual([
        { machineId: anvil, standardOn: [spd] },
        { machineId: spd, standardOn: [anvil] },
      ]);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "refuses a save adding an exception onto a standard machine, and keeps inactive ones",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        const anvil = f.anvil.peer.machineId;
        const spd = f.spd.peer.machineId;
        const panda = f.panda.peer.machineId;
        const cryo = yield* f.machine();
        const saved = yield* cryo.change({
          ...f.input(f.cryo),
          expectedRevision: 0,
          next: pairList(f),
        });
        // PandaMedic is standard: an exception onto it is refused, with a reason Settings shows.
        const ontoPanda = cryo.change({
          ...f.input(f.cryo),
          expectedRevision: saved.revision,
          next: {
            ...pairList(f),
            pairs: FleetAccessPolicy.replaceExceptions(saved.pairs, [
              { machineId: anvil, standardOn: [spd, panda] },
            ]),
          },
        });
        const refused = yield* Effect.flip(ontoPanda);
        expect(refused.reason).toBe("configuration");
        expect(refused.refusal).toBe("exception-onto-standard");
        expect(refused.message).toContain("read-only");
        expect((yield* cryo.current).revision).toBe(saved.revision);
        // So is one onto a machine the same save makes standard.
        const lifted = yield* Effect.flip(
          cryo.change({
            ...f.input(f.cryo),
            expectedRevision: saved.revision,
            next: {
              defaultAccess: "standard",
              machines: [f.readOnly(f.anvil), f.readOnly(f.panda)],
              pairs: FleetAccessPolicy.replaceExceptions(saved.pairs, [
                { machineId: panda, standardOn: [spd] },
              ]),
            },
          }),
        );
        expect(lifted.refusal).toBe("exception-onto-standard");

        // SPDevMachine made standard keeps AnvilToad's stored exception onto it, inactive.
        const promoted = yield* f.change(cryo, f.cryo, saved.revision, [f.readOnly(f.anvil)]);
        expect(promoted.pairs).toEqual(saved.pairs);
        expect(FleetAccessPolicy.callerAccess({ ...promoted, machineId: spd }, anvil)).toBe(
          "read-only",
        );
        // A later save that keeps it, as Settings sends it, adds nothing and is accepted.
        const kept = yield* cryo.change({
          ...f.input(f.cryo),
          expectedRevision: promoted.revision,
          next: {
            defaultAccess: "standard",
            machines: [f.readOnly(f.anvil), f.readOnly(f.panda)],
            pairs: FleetAccessPolicy.replaceExceptions(promoted.pairs, [
              { machineId: anvil, standardOn: [spd] },
            ]),
          },
        });
        expect(kept.pairs).toEqual(saved.pairs);
        // Read-only again, it applies again.
        const restored = yield* f.change(cryo, f.cryo, kept.revision, [
          f.readOnly(f.anvil),
          f.readOnly(f.spd),
          f.readOnly(f.panda),
        ]);
        expect(FleetAccessPolicy.callerAccess({ ...restored, machineId: spd }, anvil)).toBe(
          "standard",
        );
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("keeps exceptions through a change that does not name them, unknown ones too", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const cryo = yield* f.machine();
      const build = syntheticFleetPeer("buildmachine");
      const later = FleetAccessPolicy.pairEntryId(f.anvil.peer.machineId, build.peer.machineId);
      const list = pairList(f);
      const members = [f.cryo.peer, f.panda.peer, f.anvil.peer, f.spd.peer];
      f.setPeers([...members, build.peer]);
      yield* cryo.change({
        ...f.input(f.cryo),
        expectedRevision: 0,
        // Read-only itself, or an exception onto it would not apply and could not be saved.
        next: {
          ...list,
          machines: [...list.machines, { machineId: build.peer.machineId, access: "read-only" }],
          pairs: [...list.pairs, later],
        },
      });
      // It leaves the fleet. A level change, as Settings sends it, names no exceptions.
      f.setPeers(members);
      const changed = yield* f.change(cryo, f.cryo, 1, [
        f.readOnly(f.anvil),
        f.readOnly(f.spd),
        f.readOnly(f.panda),
      ]);
      expect(changed.revision).toBe(2);
      expect(FleetAccessPolicy.callerAccess(changed, f.panda.peer.machineId)).toBe("read-only");
      expect(changed.pairs).toContain(later);
      // A machine the fleet does not know now is not shown, but its exception stays.
      expect(FleetAccessPolicy.exceptionsOf(changed, ids(f))).toHaveLength(2);
      expect(
        FleetAccessPolicy.exceptionsOf(changed, [...ids(f), build.peer.machineId]).find(
          (exception) => exception.machineId === f.anvil.peer.machineId,
        )?.standardOn,
      ).toEqual([build.peer.machineId, f.spd.peer.machineId].toSorted());
      // A new exception must name two machines the fleet knows, whatever their levels.
      for (const [caller, receiver] of [
        [build.peer.machineId, f.spd.peer.machineId],
        [f.spd.peer.machineId, build.peer.machineId],
      ] as const) {
        const refused = yield* Effect.flip(
          cryo.change({
            ...f.input(f.cryo),
            expectedRevision: changed.revision,
            next: {
              defaultAccess: "read-only",
              machines: [{ machineId: f.cryo.peer.machineId, access: "standard" }],
              pairs: [...changed.pairs!, FleetAccessPolicy.pairEntryId(caller, receiver)],
            },
          }),
        );
        expect(refused.refusal).toBe("exception-unknown-machine");
        expect(refused.message).toContain("two machines in this fleet");
      }
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "never lets a read-only machine grant one, and merges competing ones restrictively",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        const anvil = f.anvil.peer.machineId;
        const spd = f.spd.peer.machineId;
        const cryo = f.cryo.peer.machineId;
        yield* (yield* f.machine()).change({
          ...f.input(f.cryo),
          expectedRevision: 0,
          next: pairList(f),
        });
        const head = FleetAccessPolicy.entryDigest((yield* onlyEntry(f)).entry);
        const signed = (signer: Machine, pairs: ReadonlyArray<string>, createdAt: number) =>
          FleetAccessPolicy.signAccessEntry(
            {
              version: 1,
              fleetId: FLEET_ID,
              revision: 2,
              previous: head,
              signerMachineId: signer.peer.machineId,
              createdAt,
              defaultAccess: "standard",
              machines: [f.readOnly(f.anvil), f.readOnly(f.spd)],
              pairs,
            },
            signer.signingPrivateKey,
          );
        const fresh = () =>
          Effect.flatMap(f.machine(), (service) => service.refresh(f.input(f.panda)));

        // Through Settings, AnvilToad cannot save one for itself.
        const anvilService = yield* f.machine();
        const own = yield* anvilService.refresh(f.input(f.anvil));
        const grantItself = anvilService.change({
          ...f.input(f.anvil),
          expectedRevision: own.revision,
          next: {
            ...pairList(f),
            pairs: FleetAccessPolicy.replaceExceptions(own.pairs, [
              { machineId: anvil, standardOn: [spd, cryo] },
            ]),
          },
        });
        expect((yield* Effect.flip(grantItself)).reason).toBe("configuration");
        // Nor by signing a revision onto the share, for itself or anyone else, or by removing
        // another machine's.
        const listed = pairList(f).pairs;
        yield* f.writeEntry(
          signed(f.anvil, [...listed, FleetAccessPolicy.pairEntryId(anvil, cryo)], 1),
        );
        yield* f.writeEntry(
          signed(
            f.anvil,
            [...listed, FleetAccessPolicy.pairEntryId(f.panda.peer.machineId, cryo)],
            2,
          ),
        );
        yield* f.writeEntry(signed(f.anvil, [FleetAccessPolicy.pairEntryId(anvil, spd)], 3));
        const refused = yield* fresh();
        expect(refused.revision).toBe(1);
        expect(refused.pairs).not.toContain(FleetAccessPolicy.pairEntryId(anvil, cryo));
        expect(FleetAccessPolicy.pairAccess(refused, spd, anvil)).toBe("standard");
        // Nor by removing its own: 1.0.26 would not count that revision, nor any after it, so
        // neither does this version. Only a standard machine removes it.
        yield* f.writeEntry(signed(f.anvil, [FleetAccessPolicy.pairEntryId(spd, anvil)], 4));
        const kept = yield* fresh();
        expect(kept.revision).toBe(1);
        expect(FleetAccessPolicy.pairAccess(kept, anvil, spd)).toBe("standard");
        expect(FleetAccessPolicy.pairAccess(kept, spd, anvil)).toBe("standard");
        const dropOwn = anvilService.change({
          ...f.input(f.anvil),
          expectedRevision: own.revision,
          next: {
            ...pairList(f),
            pairs: FleetAccessPolicy.replaceExceptions(own.pairs, [
              { machineId: anvil, standardOn: [] },
            ]),
          },
        });
        expect((yield* Effect.flip(dropOwn)).reason).toBe("configuration");

        // Two standard machines save at once: an exception holds only where both grant it.
        const merge = yield* fleet();
        yield* (yield* merge.machine()).change({
          ...merge.input(merge.cryo),
          expectedRevision: 0,
          next: {
            defaultAccess: "standard",
            machines: [merge.readOnly(merge.anvil), merge.readOnly(merge.spd)],
          },
        });
        const base = FleetAccessPolicy.entryDigest((yield* onlyEntry(merge)).entry);
        const both = FleetAccessPolicy.pairEntryId(spd, anvil);
        const one = FleetAccessPolicy.pairEntryId(anvil, spd);
        for (const [signer, pairs] of [
          [merge.cryo, [both, one]],
          [merge.panda, [both]],
        ] as const)
          yield* merge.writeEntry(
            FleetAccessPolicy.signAccessEntry(
              {
                version: 1,
                fleetId: FLEET_ID,
                revision: 2,
                previous: base,
                signerMachineId: signer.peer.machineId,
                createdAt: 0,
                defaultAccess: "standard",
                machines: [merge.readOnly(merge.anvil), merge.readOnly(merge.spd)],
                pairs,
              },
              signer.signingPrivateKey,
            ),
          );
        const merged = yield* (yield* merge.machine()).refresh(merge.input(merge.spd));
        expect(merged.revision).toBe(2);
        expect(merged.pairs).toEqual([both]);
        expect(FleetAccessPolicy.pairAccess(merged, spd, anvil)).toBe("standard");
        expect(FleetAccessPolicy.pairAccess(merged, anvil, spd)).toBe("read-only");
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("writes revisions LAN 1.0.26 reads, and never widens one a 1.0.26 save copies", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const anvil = f.anvil.peer.machineId;
      const spd = f.spd.peer.machineId;
      yield* (yield* f.machine()).change({
        ...f.input(f.cryo),
        expectedRevision: 0,
        next: pairList(f),
      });
      const { name, file, entry } = yield* onlyEntry(f);
      // Only the fields 1.0.26 knows: it decodes revision files strictly and skips any other,
      // with every revision after it. The entry schema and signed fields are 1.0.26's.
      const raw = JSON.parse(yield* f.fs.readFileString(file)) as Record<string, unknown>;
      expect(Object.keys(raw).toSorted()).toEqual([
        "createdAt",
        "defaultAccess",
        "fleetId",
        "machines",
        "previous",
        "revision",
        "signature",
        "signerMachineId",
        "version",
      ]);
      expect(FleetAccessPolicy.entryFileName(entry)).toBe(name);
      // 1.0.26 reads both machines' own entries, plus three machines it does not know: the two
      // exceptions and their writer's mark.
      const listed = (machineId: string) =>
        entry.machines.find((machine) => machine.machineId === machineId)?.access;
      expect(listed(anvil)).toBe("read-only");
      expect(listed(spd)).toBe("read-only");
      expect(entry.machines).toHaveLength(5);

      // A 1.0.26 Settings save signs every entry it was shown, with one level changed.
      const legacySave = (
        revision: number,
        previous: FleetAccessPolicy.FleetAccessEntry,
        machines: FleetAccessPolicy.FleetAccessEntry["machines"],
      ) =>
        FleetAccessPolicy.signAccessEntry(
          {
            version: 1,
            fleetId: FLEET_ID,
            revision,
            previous: FleetAccessPolicy.entryDigest(previous),
            signerMachineId: f.panda.peer.machineId,
            createdAt: revision,
            defaultAccess: "standard",
            machines,
          },
          f.panda.signingPrivateKey,
        );
      // The exceptions it cannot see carry over.
      const kept = legacySave(2, entry, [...entry.machines, f.readOnly(f.cryo)]);
      yield* f.writeEntry(kept);
      const afterKept = yield* (yield* f.machine()).refresh(f.input(f.spd));
      expect(afterKept.revision).toBe(2);
      expect(FleetAccessPolicy.machineAccess(afterKept, f.cryo.peer.machineId)).toBe("read-only");
      expect(FleetAccessPolicy.callerAccess(afterKept, anvil)).toBe("standard");

      // One that lists an exception nothing before it granted, as a 1.0.26 merge of competing
      // revisions can, does not grant it.
      const widened = legacySave(3, kept, [
        ...kept.machines,
        {
          machineId: FleetAccessPolicy.pairEntryId(anvil, f.panda.peer.machineId),
          access: "standard",
        },
      ]);
      yield* f.writeEntry(widened);
      const afterWidened = yield* (yield* f.machine()).refresh(f.input(f.panda));
      expect(afterWidened.revision).toBe(3);
      expect(FleetAccessPolicy.callerAccess(afterWidened, anvil)).toBe("read-only");
      expect(FleetAccessPolicy.pairAccess(afterWidened, anvil, spd)).toBe("standard");

      // One that drops them removes them.
      yield* f.writeEntry(
        legacySave(4, widened, [f.readOnly(f.anvil), f.readOnly(f.spd), f.readOnly(f.cryo)]),
      );
      const afterDropped = yield* (yield* f.machine()).refresh(f.input(f.spd));
      expect(afterDropped.revision).toBe(4);
      expect(FleetAccessPolicy.callerAccess(afterDropped, anvil)).toBe("read-only");
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "reads exceptions the same whatever machines the fleet has: from cache, disabled, after a save",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        const anvil = f.anvil.peer.machineId;
        const spd = f.spd.peer.machineId;
        const standardOnSpd = FleetAccessPolicy.replaceExceptions(
          [],
          [{ machineId: anvil, standardOn: [spd] }],
        );
        // Only forged share files could bring in a machine whose ID is AnvilToad's exception entry.
        const odd = syntheticFleetPeer(FleetAccessPolicy.pairEntryId(anvil, spd));
        expect(FleetAccessPolicy.reservedMachineId(odd.peer.machineId)).toBe(true);
        expect(FleetAccessPolicy.reservedMachineId("machine-0123456789abcdef01234567")).toBe(false);
        const stateDir = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-state-" });
        const cryo = yield* f.machine(stateDir);
        const saved = yield* cryo.change({
          ...f.input(f.cryo),
          expectedRevision: 0,
          next: {
            defaultAccess: "standard",
            machines: [f.readOnly(f.anvil), f.readOnly(f.spd)],
            pairs: standardOnSpd,
          },
        });
        expect(saved.pairs).toEqual(standardOnSpd);
        const reads = (state: FleetAccessPolicy.FleetAccessState) => {
          expect(state.revision).toBe(saved.revision);
          expect(FleetAccessPolicy.pairAccess(state, anvil, spd)).toBe("standard");
          expect(FleetAccessPolicy.pairAccess(state, anvil, f.panda.peer.machineId)).toBe(
            "read-only",
          );
          // The forged machine is never a peer here, so nothing it holds is honoured.
          expect(state.peers.map((peer) => peer.machineId)).not.toContain(odd.peer.machineId);
        };
        // The forged machine enabled, disabled in the roster, or absent: the same reading.
        f.setPeers([f.cryo.peer, f.panda.peer, f.anvil.peer, f.spd.peer, odd.peer]);
        reads(yield* cryo.refresh(f.input(f.cryo)));
        reads(yield* (yield* f.machine()).refresh(f.input(f.spd)));
        f.setPeers([
          f.cryo.peer,
          f.panda.peer,
          f.anvil.peer,
          f.spd.peer,
          { ...odd.peer, enabled: false },
        ]);
        reads(yield* cryo.refresh({ ...f.input(f.cryo), rosterDisabled: [odd.peer.machineId] }));
        // A restart reads its cache before any fleet read, which knows only enabled peers.
        reads(yield* (yield* f.machine(stateDir)).current);
        // An access save passes no roster: it keeps the exception and reads it the same.
        f.setPeers([f.cryo.peer, f.panda.peer, f.anvil.peer, f.spd.peer, odd.peer]);
        const resaved = yield* cryo.change({
          ...f.input(f.cryo),
          expectedRevision: saved.revision,
          next: {
            defaultAccess: "standard",
            machines: [f.readOnly(f.anvil), f.readOnly(f.spd), f.readOnly(f.panda)],
          },
        });
        expect(resaved.revision).toBe(saved.revision + 1);
        expect(FleetAccessPolicy.pairAccess(resaved, anvil, spd)).toBe("standard");
        f.setPeers([f.cryo.peer, f.panda.peer, f.anvil.peer, f.spd.peer]);
        const after = yield* (yield* f.machine()).refresh(f.input(f.spd));
        expect(after.revision).toBe(resaved.revision);
        expect(FleetAccessPolicy.pairAccess(after, anvil, spd)).toBe("standard");
        // The forged machine's own server signs nothing: its ID is reserved.
        f.setPeers([f.cryo.peer, f.panda.peer, f.anvil.peer, f.spd.peer, odd.peer]);
        const oddService = yield* f.machine();
        const own = yield* oddService.refresh(f.input(odd));
        expect((yield* f.change(oddService, odd, own.revision, []).pipe(Effect.flip)).reason).toBe(
          "configuration",
        );
      }).pipe(Effect.provide(configLayer)),
  );

  /** A fleet with a list, then the same machines on a new fleet behind the switch roster. */
  const switchedFleet = Effect.fn("FleetAccessPolicyTest.switchedFleet")(function* () {
    const f = yield* fleet();
    const root = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-switched-" });
    const fleetId = "fleet-after-switch";
    const stateDirs = new Map<Machine, string>();
    const stateDirOf = Effect.fn("FleetAccessPolicyTest.stateDirOf")(function* (self: Machine) {
      const existing = stateDirs.get(self);
      if (existing !== undefined) return existing;
      const created = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-access-state-" });
      stateDirs.set(self, created);
      return created;
    });
    /** The machine as it ran before the switch, on the previous fleet's share. */
    const before = (self: Machine) =>
      stateDirOf(self).pipe(Effect.flatMap((stateDir) => f.machine(stateDir)));
    /** The same machine restarted on the switch roster: its new fleet's cache is separate. */
    const after = (self: Machine) =>
      stateDirOf(self).pipe(
        Effect.flatMap((stateDir) =>
          f.machine(stateDir).pipe(
            Effect.provideService(HostProcess.Environment, {
              [FLEET_ROSTER_ENV]: FLEET_SWITCH_ROSTER,
            }),
          ),
        ),
      );
    const input = (self: Machine, peers: ReadonlyArray<FleetPeer> = f.input(self).peers) => ({
      ...f.input(self),
      root,
      fleetId,
      peers,
      credentialAuthorityRevision: 1,
    });
    return { f, root, fleetId, before, after, input };
  });

  it.effect("carries the previous fleet's list to a switched roster that has none", () =>
    Effect.gen(function* () {
      const s = yield* switchedFleet();
      // Tonight's fleet: one list, every machine standard.
      const old = yield* s.before(s.f.cryo);
      expect((yield* s.f.change(old, s.f.cryo, 0, [])).revision).toBe(1);
      // Without a carried list the new fleet would never link: revision 0 links nothing.
      const switched = yield* s.after(s.f.cryo);
      const state = yield* switched.refresh(s.input(s.f.cryo));
      expect(state.revision).toBe(1);
      expect(state.defaultAccess).toBe("standard");
      expect(FleetAccessPolicy.fleetLinksApply(state)).toBe(true);
      // It is on the new share, signed by this machine for the new fleet, so every machine reads it.
      const written = yield* s.f.fs.readDirectory(s.f.path.join(s.root, "fleet-access"));
      expect(written).toHaveLength(1);
      const other = yield* (yield* s.after(s.f.panda)).refresh(s.input(s.f.panda));
      expect(other.revision).toBe(1);
      expect(FleetAccessPolicy.fleetLinksApply(other)).toBe(true);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "carries only the new roster's machines and exceptions, after every machine is ready",
    () =>
      Effect.gen(function* () {
        const s = yield* switchedFleet();
        const old = yield* s.before(s.f.cryo);
        // AnvilToad and SPDevMachine read-only, AnvilToad standard on SPDevMachine.
        yield* old.change({
          ...s.f.input(s.f.cryo),
          expectedRevision: 0,
          next: {
            defaultAccess: "standard",
            machines: [s.f.readOnly(s.f.anvil), s.f.readOnly(s.f.spd)],
            pairs: FleetAccessPolicy.replaceExceptions(
              [],
              [{ machineId: s.f.anvil.peer.machineId, standardOn: [s.f.spd.peer.machineId] }],
            ),
          },
        });
        // SPDevMachine is not on the new roster.
        const roster = s.f
          .input(s.f.cryo)
          .peers.filter((peer) => peer.machineId !== s.f.spd.peer.machineId);
        const switched = yield* s.after(s.f.cryo);
        // Lowering AnvilToad waits until every enabled machine says it takes a replaced credential.
        expect((yield* switched.refresh(s.input(s.f.cryo, roster))).revision).toBe(0);
        expect(yield* s.f.fs.exists(s.f.path.join(s.root, "fleet-access"))).toBe(false);
        for (const machine of [s.f.panda, s.f.anvil])
          yield* s.f.markReady(machine, machine, { root: s.root, fleetId: s.fleetId });
        const state = yield* switched.refresh(s.input(s.f.cryo, roster));
        expect(state.revision).toBe(1);
        expect(state.machines).toEqual([s.f.readOnly(s.f.anvil)]);
        expect(state.pairs).toEqual([]);
        expect(s.f.accessOf(state, s.f.panda)).toBe("standard");
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("never carries a list over for a machine it made read-only, or onto any list", () =>
    Effect.gen(function* () {
      const s = yield* switchedFleet();
      const old = yield* s.before(s.f.cryo);
      yield* s.f.change(old, s.f.cryo, 0, [s.f.readOnly(s.f.anvil)]);
      // AnvilToad accepted the list that made it read-only; it may not write it anywhere.
      yield* (yield* s.before(s.f.anvil)).refresh(s.f.input(s.f.anvil));
      const anvil = yield* (yield* s.after(s.f.anvil)).refresh(s.input(s.f.anvil));
      expect(anvil.revision).toBe(0);
      expect(yield* s.f.fs.exists(s.f.path.join(s.root, "fleet-access"))).toBe(false);
      // A starting list on the new share decides instead of the previous fleet's list.
      yield* s.f.fs.writeFileString(
        s.f.path.join(s.root, FleetAccessPolicy.SEED_FILE),
        JSON.stringify({
          version: 1,
          fleetId: s.fleetId,
          defaultAccess: "standard",
          readOnly: [s.f.panda.peer.machineId],
        }),
      );
      const seeded = yield* (yield* s.after(s.f.cryo)).refresh(s.input(s.f.cryo));
      expect(seeded.revision).toBe(0);
      expect(seeded.seed).toBe("waiting");
      // The same fleet never carries its own list onto itself.
      const same = yield* (yield* s.before(s.f.panda)).refresh(s.f.input(s.f.panda));
      expect(same.revision).toBe(1);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("an explicit roster path does not block a verified private-file fleet at startup", () =>
    Effect.gen(function* () {
      const f = yield* fleet();
      const stateDir = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-legacy-fleet-state-" });
      const path = yield* Path.Path;
      const makeService = (read?: Vault.FleetVault["Service"]["read"]) =>
        f.machine(stateDir, read).pipe(
          Effect.provideService(HostProcess.Environment, {
            [FLEET_ROSTER_ENV]: path.join(f.root, "roster.json"),
          }),
        );
      expect((yield* (yield* makeService()).current).credentialAuthorityReady).toBe(false);

      const legacy: Delivery.FleetPrivateConfig = {
        version: 1,
        machineId: f.cryo.peer.machineId,
        autoPickup: false,
        signingPrivateKey: f.cryo.signingPrivateKey,
        encryptionPrivateKey: f.cryo.encryptionPrivateKey,
        peers: [f.cryo.peer, f.anvil.peer],
      };
      yield* writeFleetJson(path.join(stateDir, "lan-fleet-private.json"), legacy);
      expect((yield* (yield* makeService()).current).credentialAuthorityReady).toBeUndefined();

      const enrolled = Authority.generateFleetIdentity(
        f.cryo.peer.environmentId,
        FLEET_ID,
        f.anvil.peer.signingPublicKey,
        false,
        { autoPickup: true, access: "standard" },
        f.cryo.peer.machineId,
      );
      const managed = yield* makeService(Effect.succeed(enrolled));
      expect((yield* managed.current).credentialAuthorityReady).toBe(false);
      const unavailable = yield* makeService(
        Effect.fail(new LanFleetError({ reason: "configuration" })),
      );
      expect((yield* unavailable.current).credentialAuthorityReady).toBe(false);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "keeps the latest fleet credential generation across delayed refreshes and restart",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet();
        const stateDir = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-key-state-" });
        const service = yield* f.machine(stateDir);
        const first = {
          ...f.input(f.cryo),
          credentialAuthorityRevision: 2,
          credentialKeyDigests: { [f.anvil.peer.machineId]: "1".repeat(64) },
        };
        const next = {
          ...first,
          credentialAuthorityRevision: 3,
          credentialKeyDigests: { [f.anvil.peer.machineId]: "2".repeat(64) },
        };
        yield* service.refresh(first);
        const failOnce = { pending: true };
        const interrupted = yield* f.machine(stateDir).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (source, destination) => {
              if (!failOnce.pending || !destination.endsWith("lan-fleet-access.json"))
                return f.fs.rename(source, destination);
              failOnce.pending = false;
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  description: "simulated durable cache failure",
                  pathOrDescriptor: destination,
                }),
              );
            },
          }),
        );
        const pending = yield* interrupted.refresh(next);
        expect(pending.credentialAuthorityReady).toBe(false);
        expect(pending.credentialKeyDigests).toEqual(next.credentialKeyDigests);
        const afterFailedWrite = yield* f.machine(stateDir);
        expect((yield* afterFailedWrite.current).credentialAuthorityReady).toBe(false);
        expect((yield* interrupted.refresh(next)).credentialAuthorityReady).toBe(true);
        yield* service.refresh(next);
        expect((yield* service.refresh(first)).credentialKeyDigests).toEqual(
          next.credentialKeyDigests,
        );
        const restarted = yield* f.machine(stateDir);
        expect((yield* restarted.current).credentialKeyDigests).toEqual(next.credentialKeyDigests);
        expect((yield* restarted.current).credentialAuthorityReady).toBe(false);
        expect((yield* restarted.refresh(first)).credentialAuthorityReady).toBe(false);
        expect((yield* restarted.refresh(next)).credentialAuthorityReady).toBe(true);
      }).pipe(Effect.provide(configLayer)),
  );
});
