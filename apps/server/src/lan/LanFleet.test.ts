import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type FleetRoster,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LanFleet from "./LanFleet.ts";
import * as Delivery from "./FleetDelivery.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { writeFleetJson, writeFleetRoster } from "./FleetFiles.ts";

const setup = Effect.fn("FleetTest.setup")(function* (
  autoPickup = true,
  failIssue = false,
  sharedFolder = false,
  tls = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* Config.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-synthetic-" });
  const a = syntheticFleetPeer("alpha");
  const b = syntheticFleetPeer("beta");
  if (tls)
    for (const identity of [a, b])
      identity.peer = {
        ...identity.peer,
        tls: {
          origin: identity.peer.origin,
          certificate: "synthetic-public-certificate",
          publicKeySha256: "a".repeat(64),
        },
      };
  const rosterPath = path.join(root, "roster.json");
  const deliveryDirectory = path.join(root, "deliveries");
  const roster: FleetRoster = {
    version: 1,
    machines: [a.peer, b.peer].map(
      ({ encryptionPublicKey: _e, signingPublicKey: _s, tls: _tls, ...machine }) => machine,
    ),
  };
  yield* writeFleetRoster(rosterPath, roster);
  const issued: string[] = [];
  const issuedScopes: Array<ReadonlyArray<AuthEnvironmentScope>> = [];
  const revoked: string[] = [];
  const active = new Map<string, AuthPairingLink[]>();
  // Pairing links a peer spent, as the sessions the issuing machine then holds for it.
  const sessions = new Map<string, AuthClientSession[]>();
  let policy: FleetAccessPolicy.FleetAccessState = {
    revision: 0,
    defaultAccess: "standard",
    machines: [],
    machineId: undefined,
    peers: [],
  };
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
      ...(sharedFolder ? { managed: true } : {}),
    };
    const privateFile = path.join(stateDir, "lan-fleet-private.json");
    yield* writeFleetJson(privateFile, config);
    const service = yield* LanFleet.LanFleet.pipe(
      Effect.provide(
        LanFleet.layerServices.pipe(
          Layer.provide(Layer.succeed(HostProcess.Hostname, `${identity.peer.machineId}.lan.test`)),
          Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
          Layer.provide(
            Layer.mock(FleetAccessPolicy.FleetAccess)({ current: Effect.sync(() => policy) }),
          ),
          Layer.provide(
            Layer.mock(FleetEnrollment.FleetEnrollment)({
              resolve: Effect.as(Effect.void, undefined),
              status: Effect.succeed({
                available: true,
                stage: "active",
                owner: false,
                ownerCode: null,
                deviceCode: null,
                sharedFolderTrust: sharedFolder,
                environmentId: identity.peer.environmentId,
                label: identity.peer.label,
                origin: identity.peer.origin,
                autoPickup,
                access: "standard",
                peers: [],
              }),
            }),
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
                  issuedScopes.push(input?.scopes ?? AuthStandardClientScopes);
                  if (failIssue)
                    return yield* new EnvironmentAuth.ServerAuthPairingLinkCreationError({
                      cause: "synthetic failure",
                    });
                  const createdAt = yield* DateTime.now;
                  const link = {
                    id: `synthetic-${issued.length}`,
                    credential: "synthetic-pairing-code",
                    subject: input?.subject ?? "fixture",
                    scopes: input?.scopes ?? AuthStandardClientScopes,
                    createdAt,
                    expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(createdAt) + 86_400_000),
                  };
                  active.set(identity.peer.machineId, [
                    ...(active.get(identity.peer.machineId) ?? []),
                    link,
                  ]);
                  return link;
                }),
              listPairingLinks: () => Effect.sync(() => active.get(identity.peer.machineId) ?? []),
              listSessions: () => Effect.sync(() => sessions.get(identity.peer.machineId) ?? []),
              revokeSession: (sessionId) =>
                Effect.sync(() => {
                  const held = sessions.get(identity.peer.machineId) ?? [];
                  sessions.set(
                    identity.peer.machineId,
                    held.filter((session) => session.sessionId !== sessionId),
                  );
                  revoked.push(sessionId);
                  return held.some((session) => session.sessionId === sessionId);
                }),
              revokePairingLink: (id) =>
                Effect.sync(() => {
                  const links = active.get(identity.peer.machineId) ?? [];
                  if (!links.some((link) => link.id === id)) return false;
                  active.set(
                    identity.peer.machineId,
                    links.filter((link) => link.id !== id),
                  );
                  revoked.push(id);
                  return true;
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
  return {
    a,
    b,
    roster,
    rosterPath,
    deliveryDirectory,
    sender,
    recipient,
    issued,
    revoked,
    sync,
    fs,
    path,
    rotate: Effect.fn("FleetTest.rotate")(function* (machineId: string) {
      const rotated = syntheticFleetPeer(machineId);
      const peers = [a.peer, b.peer].map((peer) =>
        peer.machineId === machineId ? rotated.peer : peer,
      );
      for (const local of [sender, recipient])
        yield* writeFleetJson(local.privateFile, {
          ...local.config,
          ...(local.config.machineId === machineId
            ? {
                encryptionPrivateKey: rotated.encryptionPrivateKey,
                signingPrivateKey: rotated.signingPrivateKey,
              }
            : {}),
          peers,
        });
    }),
    issuedScopes,
    setPolicy: (next: Partial<FleetAccessPolicy.FleetAccessState>) => {
      policy = { ...policy, ...next };
    },
    consume: (machineId: string) => {
      sessions.set(machineId, [
        ...(sessions.get(machineId) ?? []),
        ...(active.get(machineId) ?? []).map((link) => ({
          sessionId: AuthSessionId.make(`session-${link.id}`),
          subject: link.subject,
          scopes: link.scopes,
          method: "bearer-access-token" as const,
          client: { deviceType: "desktop" as const },
          issuedAt: link.createdAt,
          expiresAt: link.expiresAt,
          lastConnectedAt: null,
          connected: true,
          current: false,
        })),
      ]);
      active.set(machineId, []);
    },
  };
});
const testConfig = Config.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-config-" });

it.layer(NodeServices.layer)("LAN fleet isolated sync", (it) => {
  it.effect.each(["alpha", "beta"])(
    "replaces an obsolete %s identity delivery only after signed rejection and revoking its unused grant",
    (machineId) =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true);
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        yield* f.sync(f.recipient.service);
        const deliveryPath = f.path.join(
          f.deliveryDirectory,
          `${Delivery.deliveryFileName("alpha", "beta")}.json`,
        );
        const original = yield* f.fs.readFileString(deliveryPath);
        yield* f.rotate(machineId);
        yield* TestClock.adjust("1 second");
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        const replacement = yield* f.sync(f.recipient.service);
        assert.equal(replacement.incoming.length, 1);
        assert.deepEqual(f.revoked, ["synthetic-1"]);
        assert.deepEqual(f.issued, ["alpha", "alpha"]);
        assert.notEqual(yield* f.fs.readFileString(deliveryPath), original);
        const archived = (yield* f.fs.readDirectory(f.deliveryDirectory)).find((name) =>
          name.includes(".obsolete-"),
        );
        assert.isDefined(archived);
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.deliveryDirectory, archived!)),
          original,
        );
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        assert.deepEqual(f.issued, ["alpha", "alpha"]);
      }).pipe(Effect.provide(testConfig)),
  );
  it.effect.each(["consumed", "missing-journal", "tampered-rejection"])(
    "keeps obsolete delivery %s uncertain without revoking or minting",
    (failure) =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true);
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        yield* f.rotate("alpha");
        yield* TestClock.adjust("1 second");
        yield* f.sync(f.recipient.service);
        if (failure === "consumed") f.consume("alpha");
        if (failure === "missing-journal")
          yield* f.fs.remove(f.path.join(f.sender.stateDir, "lan-fleet-state.json"));
        if (failure === "tampered-rejection") {
          const file = f.path.join(
            f.deliveryDirectory,
            `${Delivery.deliveryFileName("beta", "beta")}.catalog.json`,
          );
          const raw = yield* f.fs.readFileString(file);
          yield* f.fs.writeFileString(file, raw.replace('"signature":"', '"signature":"tampered'));
        }
        const result = yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        if (failure !== "tampered-rejection") assert.equal(result.machines[1]?.status, "uncertain");
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        assert.deepEqual(f.issued, ["alpha"]);
        assert.deepEqual(f.revoked, []);
      }).pipe(Effect.provide(testConfig)),
  );
  it.effect(
    "uses only the verified sender catalog hostname while preserving the canonical TLS identity",
    () =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true, true);
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        const catalogPath = f.path.join(
          f.deliveryDirectory,
          `${Delivery.deliveryFileName("alpha", "alpha")}.catalog.json`,
        );
        const catalog = yield* f.fs.readFileString(catalogPath);
        const tampered = catalog.replace(
          '"connectHost":"alpha.lan.test"',
          '"connectHost":"another-machine"',
        );
        assert.notEqual(tampered, catalog);
        yield* f.fs.writeFileString(catalogPath, tampered);
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        yield* f.fs.writeFileString(catalogPath, catalog);
        const picked = (yield* f.sync(f.recipient.service)).incoming[0];
        assert.equal(picked?.tls?.connectHost, "alpha.lan.test");
        assert.equal(picked?.host, f.a.peer.origin);
        assert.equal(picked?.tls?.origin, f.a.peer.tls?.origin);
        assert.equal(picked?.tls?.certificate, f.a.peer.tls?.certificate);
        assert.equal(picked?.tls?.publicKeySha256, f.a.peer.tls?.publicKeySha256);
        assert.deepEqual(f.issued, ["alpha"]);
      }).pipe(Effect.provide(testConfig)),
  );
  it.effect(
    "recovers legacy claims and interrupted or lost sender journals without issuing another grant",
    () =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true);
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        const first = yield* f.sync(f.recipient.service);
        const senderJournal = f.path.join(f.sender.stateDir, "lan-fleet-state.json"),
          receiverJournal = f.path.join(f.recipient.stateDir, "lan-fleet-state.json");
        const sent = yield* f.fs.readFileString(senderJournal),
          received = yield* f.fs.readFileString(receiverJournal);
        const legacySent = sent
          .replace(/,"pairingLinkId":"[^"]*"/u, "")
          .replace('"status":"pending"', '"status":"publishing"');
        const legacyReceived = received.replace(/,"senderCatalogCreatedAt":\d+/u, "");
        assert.notEqual(legacySent, sent);
        assert.notEqual(legacyReceived, received);
        yield* f.fs.writeFileString(senderJournal, legacySent);
        yield* f.fs.writeFileString(receiverJournal, legacyReceived);
        yield* TestClock.adjust("1 second");
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        assert.deepEqual((yield* f.sync(f.recipient.service)).incoming[0], first.incoming[0]);
        yield* f.fs.remove(senderJournal);
        assert.equal(
          (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
          "pending",
        );
        assert.deepEqual(f.issued, ["alpha"]);
      }).pipe(Effect.provide(testConfig)),
  );
  it.effect(
    "keeps consumed or unauthenticated outgoing deliveries uncertain instead of minting replacements",
    () =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true);
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        f.consume("alpha");
        yield* f.fs.remove(f.path.join(f.sender.stateDir, "lan-fleet-state.json"));
        assert.equal(
          (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
          "uncertain",
        );
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        assert.deepEqual(f.issued, ["alpha"]);
        const other = yield* setup(true, false, true);
        yield* other.sync(other.recipient.service, { mode: "status" });
        yield* other.sync(other.sender.service, { sendMachineIds: ["beta"] });
        const deliveryPath = other.path.join(
          other.deliveryDirectory,
          `${Delivery.deliveryFileName("alpha", "beta")}.json`,
        );
        const wire = yield* other.fs.readFileString(deliveryPath);
        yield* other.fs.writeFileString(deliveryPath, wire.replace('"tag":"', '"tag":"tampered'));
        yield* other.fs.remove(other.path.join(other.sender.stateDir, "lan-fleet-state.json"));
        assert.equal(
          (yield* other.sync(other.sender.service, { sendMachineIds: ["beta"] })).machines[1]
            ?.status,
          "uncertain",
        );
        assert.deepEqual(other.issued, ["alpha"]);
      }).pipe(Effect.provide(testConfig)),
  );
  it.effect(
    "retries the same shared-folder pickup only after a newer sender confirms its grant is still unused",
    () =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true);
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        const first = yield* f.sync(f.recipient.service);
        assert.equal(first.incoming.length, 1);
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        yield* TestClock.adjust("1 second");
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        const retried = yield* f.sync(f.recipient.service);
        assert.equal(retried.incoming.length, 1);
        assert.deepEqual(retried.incoming[0], first.incoming[0]);
        f.consume("alpha");
        yield* TestClock.adjust("1 second");
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        assert.equal((yield* f.sync(f.recipient.service)).incoming.length, 0);
        yield* f.sync(f.recipient.service, { connectedEnvironmentIds: [f.a.peer.environmentId] });
        assert.equal(
          (yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] })).machines[1]?.status,
          "connected",
        );
        assert.deepEqual(f.issued, ["alpha"]);
      }).pipe(Effect.provide(testConfig)),
  );
  it.effect(
    "replaces a connected peer's credential when its fleet access changes, with no approval",
    () =>
      Effect.gen(function* () {
        const f = yield* setup(true, false, true);
        f.setPolicy({ revision: 1 });
        const connected = { connectedEnvironmentIds: [f.a.peer.environmentId] };
        yield* f.sync(f.recipient.service, { mode: "status" });
        yield* f.sync(f.sender.service, { sendMachineIds: ["beta"] });
        assert.equal((yield* f.sync(f.recipient.service)).incoming[0]?.replace, undefined);
        f.consume("alpha");
        yield* f.sync(f.recipient.service, connected);
        assert.equal((yield* f.sync(f.sender.service)).machines[1]?.status, "connected");

        f.setPolicy({ revision: 2, machines: [{ machineId: "beta", access: "read-only" }] });
        yield* TestClock.adjust("1 second");
        assert.equal((yield* f.sync(f.sender.service)).machines[1]?.status, "pending");
        // The standard session ends at once, and the replacement carries only read scopes.
        assert.deepEqual(f.revoked, ["session-synthetic-1"]);
        assert.deepEqual(
          f.issuedScopes.at(-1),
          FleetAccessPolicy.fleetCredentialScopes("read-only"),
        );
        const replacement = yield* f.sync(f.recipient.service, connected);
        assert.equal(replacement.incoming.length, 1);
        assert.equal(replacement.incoming[0]?.replace, true);
        // A saved connection is not proof of pickup while the replacement grant is unspent.
        yield* TestClock.adjust("1 second");
        yield* f.sync(f.sender.service);
        assert.equal((yield* f.sync(f.recipient.service, connected)).incoming[0]?.replace, true);

        f.consume("alpha");
        yield* TestClock.adjust("1 second");
        yield* f.sync(f.sender.service);
        assert.equal((yield* f.sync(f.recipient.service, connected)).incoming.length, 0);
        assert.equal((yield* f.sync(f.sender.service)).machines[1]?.status, "connected");
        assert.deepEqual(f.issued, ["alpha", "alpha"]);
        assert.deepEqual(f.revoked, ["session-synthetic-1"]);
      }).pipe(Effect.provide(testConfig)),
  );
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
