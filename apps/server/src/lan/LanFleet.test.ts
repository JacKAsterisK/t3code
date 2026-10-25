import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthStandardClientScopes, type FleetRoster } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LanFleet from "./LanFleet.ts";
import * as Delivery from "./FleetDelivery.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { writeFleetJson, writeFleetRoster } from "./FleetFiles.ts";

const setup = Effect.fn("FleetTest.setup")(function* (autoPickup = true, failIssue = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* Config.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-synthetic-" });
  const a = syntheticFleetPeer("alpha");
  const b = syntheticFleetPeer("beta");
  const rosterPath = path.join(root, "roster.json");
  const deliveryDirectory = path.join(root, "deliveries");
  const roster: FleetRoster = {
    version: 1,
    machines: [a.peer, b.peer].map(
      ({ encryptionPublicKey: _e, signingPublicKey: _s, ...machine }) => machine,
    ),
  };
  yield* writeFleetRoster(rosterPath, roster);
  const issued: string[] = [];
  const create = Effect.fn("FleetTest.create")(function* (identity: typeof a) {
    const stateDir = path.join(root, identity.peer.machineId);
    yield* fs.makeDirectory(stateDir);
    const config: Delivery.FleetPrivateConfig = {
      version: 1,
      machineId: identity.peer.machineId,
      rosterPath,
      deliveryDirectory,
      autoPickup,
      encryptionPrivateKey: identity.encryptionPrivateKey,
      signingPrivateKey: identity.signingPrivateKey,
      peers: [a.peer, b.peer],
    };
    const privateFile = path.join(stateDir, "lan-fleet-private.json");
    yield* writeFleetJson(privateFile, config);
    const service = yield* LanFleet.LanFleet.pipe(
      Effect.provide(
        LanFleet.layerServices.pipe(
          Layer.provide(
            Layer.mock(FleetEnrollment.FleetEnrollment)({ resolve: Effect.succeed(undefined) }),
          ),
          Layer.provide(Config.layer({ ...base, stateDir })),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(identity.peer.environmentId),
            }),
          ),
          Layer.provide(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              createPairingLink: (input) =>
                Effect.gen(function* () {
                  issued.push(identity.peer.machineId);
                  if (failIssue)
                    return yield* new EnvironmentAuth.ServerAuthPairingLinkCreationError({
                      cause: "synthetic failure",
                    });
                  return {
                    id: `synthetic-${issued.length}`,
                    credential: "synthetic-pairing-code",
                    subject: input?.subject ?? "fixture",
                    scopes: AuthStandardClientScopes,
                    createdAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(86_400_000),
                  };
                }),
            }),
          ),
        ),
      ),
    );
    return { service, stateDir, config, privateFile };
  });
  const sender = yield* create(a);
  const recipient = yield* create(b);
  const sync = (
    service: LanFleet.LanFleet["Service"],
    overrides: Partial<Parameters<LanFleet.LanFleet["Service"]["sync"]>[0]> = {},
  ) =>
    service.sync({ mode: "manual", sendMachineIds: [], connectedEnvironmentIds: [], ...overrides });
  return { a, b, roster, rosterPath, deliveryDirectory, sender, recipient, issued, sync, fs, path };
});
const testConfig = Config.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-config-" });

it.layer(NodeServices.layer)("LAN fleet isolated sync", (it) => {
  it.effect("keeps interrupted credential issuance reserved instead of minting again", () =>
    Effect.gen(function* () {
      const f = yield* setup(true, true);
      yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] }).pipe(Effect.flip);
      const result = yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
      assert.equal(result.machines[1]?.status, "uncertain");
      assert.deepEqual(f.issued, ["alpha"]);
    }).pipe(Effect.provide(testConfig)),
  );

  it.effect("expires without rotating and serializes sync across separate connections", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
      yield* TestClock.adjust("25 hours");
      assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
      assert.equal(
        (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
        "expired",
      );
      assert.deepEqual(f.issued, ["alpha"]);
      const lock = f.path.join(f.sender.stateDir, "lan-fleet.lock");
      yield* f.fs.makeDirectory(lock);
      assert.equal((yield* f.sync(f.sender.service).pipe(Effect.flip)).reason, "busy");
      assert.equal(yield* f.fs.exists(lock), true);
    }).pipe(Effect.provide(testConfig)),
  );

  it.effect("fails closed for a replaced local environment or revoked recipient binding", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* writeFleetJson(f.sender.privateFile, {
        ...f.sender.config,
        peers: f.sender.config.peers.map((peer) =>
          peer.machineId === "beta" ? { ...peer, enabled: false } : peer,
        ),
      });
      assert.equal(
        (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] }).pipe(Effect.flip)).reason,
        "configuration",
      );
      yield* writeFleetJson(f.sender.privateFile, { ...f.sender.config, machineId: "beta" });
      assert.equal((yield* f.sync(f.sender.service).pipe(Effect.flip)).reason, "configuration");
      assert.deepEqual(f.issued, []);
    }).pipe(Effect.provide(testConfig)),
  );
  it.effect(
    "publishes once, claims once, acknowledges and skips repeats without credential rotation",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        assert.equal(
          (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
          "pending",
        );
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        assert.deepEqual(f.issued, ["alpha"]);
        const first = yield* f.sync(f.recipient.service);
        assert.equal(first.incoming.length, 1);
        assert.equal(first.incoming[0]?.environmentId, f.a.peer.environmentId);
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        assert.equal((yield* f.sync(f.recipient.service)).machines[0]?.status, "uncertain");
        yield* f.sync(f.recipient.service, { connectedEnvironmentIds: [f.a.peer.environmentId] });
        assert.equal(
          (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
          "connected",
        );
        assert.deepEqual(f.issued, ["alpha"]);
        const raw = yield* f.fs.readFileString(
          f.path.join(f.deliveryDirectory, `${Delivery.deliveryFileName("alpha", "beta")}.json`),
        );
        assert.notInclude(raw, "synthetic-pairing-code");
        assert.notInclude(raw, "PRIVATE KEY");
      }).pipe(Effect.provide(testConfig)),
  );

  it.effect("skips existing environment identities and refuses guessed recipients", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const result = yield* f.sync(f.sender.service, {
        sendMachineIds: ["beta"],
        connectedEnvironmentIds: [f.b.peer.environmentId],
      });
      assert.equal(result.machines[1]?.status, "connected");
      assert.deepEqual(f.issued, []);
      assert.equal(
        (yield* f.sync(f.sender.service, { sendMachineIds: ["guessed"] }).pipe(Effect.flip)).reason,
        "configuration",
      );
    }).pipe(Effect.provide(testConfig)),
  );

  it.effect("keeps status reads passive and automatic pickup off until explicitly configured", () =>
    Effect.gen(function* () {
      const f = yield* setup(false);
      yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
      assert.equal((yield* f.sync(f.recipient.service, { mode: "status" })).incoming.length, 0);
      assert.equal((yield* f.sync(f.recipient.service, { mode: "automatic" })).incoming.length, 0);
      assert.equal((yield* f.sync(f.recipient.service, { mode: "manual" })).incoming.length, 1);
      yield* f.fs.remove(f.recipient.privateFile);
      assert.equal((yield* f.sync(f.recipient.service)).enabled, false);
    }).pipe(Effect.provide(testConfig)),
  );

  it.effect(
    "reloads shared metadata without trusting new entries or changed identity bindings",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        const gamma = syntheticFleetPeer("gamma").peer;
        const { encryptionPublicKey: _e, signingPublicKey: _s, ...machine } = gamma;
        yield* writeFleetRoster(f.rosterPath, {
          ...f.roster,
          machines: [...f.roster.machines, machine],
        });
        const result = yield* f.sync(f.sender.service);
        assert.equal(result.machines[2]?.status, "untrusted");
        assert.equal(
          (yield* f.sync(f.sender.service, { sendMachineIds: ["gamma"] }).pipe(Effect.flip)).reason,
          "configuration",
        );
        yield* writeFleetRoster(f.rosterPath, {
          ...f.roster,
          machines: f.roster.machines.map((m) =>
            m.machineId === "beta" ? { ...m, origin: "https://changed.example.test" } : m,
          ),
        });
        assert.equal((yield* f.sync(f.sender.service)).machines[1]?.status, "untrusted");
        assert.deepEqual(f.issued, []);
      }).pipe(Effect.provide(testConfig)),
  );

  it.effect("does not replace a delivery when its local journal is missing", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
      yield* f.fs.remove(f.path.join(f.sender.stateDir, "lan-fleet-state.json"));
      assert.equal(
        (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
        "uncertain",
      );
      assert.deepEqual(f.issued, ["alpha"]);
    }).pipe(Effect.provide(testConfig)),
  );
});
