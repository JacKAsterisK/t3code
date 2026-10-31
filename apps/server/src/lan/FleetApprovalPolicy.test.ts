import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { FleetApprovalPolicy as Entry } from "../../../../packages/contracts/src/fleetApprovalPolicy.ts";
import * as PeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as FleetContext from "./FleetContext.ts";
import * as FleetVault from "./FleetVault.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { writeFleetJson } from "./FleetFiles.ts";
import * as Policy from "./FleetApprovalPolicy.ts";
import * as Signing from "./FleetApprovalPolicySigning.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* runMigrations();
  const root = yield* fs.makeTempDirectoryScoped();
  const destination = syntheticFleetPeer("destination");
  const source = syntheticFleetPeer("source");
  let current = {
    config: {
      version: 1 as const,
      machineId: "destination",
      rosterPath: path.join(root, "roster.json"),
      deliveryDirectory: root,
      autoPickup: false,
      encryptionPrivateKey: destination.encryptionPrivateKey,
      signingPrivateKey: destination.signingPrivateKey,
      peers: [destination.peer, source.peer],
    },
    self: destination.peer,
    deliveryDirectory: root,
    peers: [{ peer: source.peer, connectHost: undefined }],
  };
  let available = true;
  let beforeOwner: Effect.Effect<void> = Effect.void;
  let beforeDistribution: ReturnType<typeof fs.rename> = Effect.void;
  const policyFs = {
    ...fs,
    rename: (from: string, to: string) =>
      beforeDistribution.pipe(Effect.andThen(fs.rename(from, to))),
  };
  const record = {
    version: 1 as const,
    fleetId: "fleet",
    machineId: "destination",
    environmentId: destination.peer.environmentId,
    encryptionPrivateKey: destination.encryptionPrivateKey,
    signingPrivateKey: destination.signingPrivateKey,
    rootPublicKey: destination.peer.signingPublicKey,
    lastRevision: 1,
    enabled: true,
    autoPickup: false,
    access: "standard" as const,
  };
  const policyLayer = Policy.layer.pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, policyFs)),
    Layer.provide(
      Layer.mock(PeerAccess.ApprovalPeerAccess)({
        owner: (sessionId: string) =>
          beforeOwner.pipe(
            Effect.as(sessionId === "owner" ? { subject: "destination-owner" } : undefined),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(FleetContext.FleetContext)({
        load: Effect.sync(() => (available ? current : undefined)),
      }),
    ),
    Layer.provide(Layer.mock(FleetVault.FleetVault)({ read: Effect.succeed(record) })),
  );
  const built = yield* Layer.build(policyLayer);
  const service = Context.get(built, Policy.FleetApprovalPolicy);
  yield* sql`INSERT INTO agent_approval_destination_links(link_identity_id, source_environment_id, created_by, created_at) VALUES ('link', ${source.peer.environmentId}, 'owner', 0)`;
  yield* sql`INSERT INTO agent_approval_link_policies VALUES ('link', 1, 1, 'owner', 0)`;
  yield* service.bindLink("owner", "link", "source");
  const file = path.join(root, Signing.DIRECTORY, "destination.json");
  const enabled = Effect.gen(function* () {
    const row = (yield* sql<{
      enabled: number;
      valid: number;
    }>`SELECT g.enabled, h.valid FROM agent_approval_fleet_policy_heads h JOIN agent_approval_fleet_policy_grants g USING(fleet_id, destination_machine_id) WHERE g.caller_machine_id = 'source'`)[0];
    return row?.enabled === 1 && row.valid === 1;
  });
  const head = sql<{
    revision: number;
    digest: string;
    entry_json: string;
    valid: number;
  }>`SELECT * FROM agent_approval_fleet_policy_heads`;
  const write = (entry: unknown) => writeFleetJson(file, entry);
  return {
    sql,
    fs,
    path,
    root,
    service,
    restart: Layer.build(Layer.fresh(policyLayer)).pipe(
      Effect.map((context) => Context.get(context, Policy.FleetApprovalPolicy)),
    ),
    destination,
    source,
    enabled,
    head,
    write,
    pauseDistribution: (effect: ReturnType<typeof fs.rename>) => {
      beforeDistribution = effect;
    },
    observeOwner: (effect: Effect.Effect<void>) => {
      beforeOwner = effect;
    },
    setTrust: (trusted: boolean) => {
      current = {
        ...current,
        peers: trusted ? [{ peer: source.peer, connectHost: undefined }] : [],
      };
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    rotateDestination: () => {
      current = { ...current, self: syntheticFleetPeer("destination").peer };
    },
  };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(database, Gate.layer, NodeServices.layer)),
    Effect.scoped,
  );

it.effect(
  "signs only the separate strict destination snapshot and refuses wrong identities, duplicates and excess fields",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const next = {
        version: 1 as const,
        fleetId: "fleet",
        destinationMachineId: "destination",
        revision: 1,
        previousDigest: null,
        createdAt: 1,
        grants: [{ callerMachineId: "source", enabled: true }],
      };
      const entry = Signing.sign(next, f.destination.signingPrivateKey);
      const identity = {
        fleetId: "fleet",
        destinationMachineId: "destination",
        publicKey: f.destination.peer.signingPublicKey,
      };
      assert.equal(Signing.verify(entry, identity), true);
      for (const invalid of [
        { ...entry, approvals: true },
        { ...entry, version: 2 },
        { ...entry, destinationMachineId: "source" },
        { ...entry, signature: "bad" },
        Signing.sign(
          { ...next, grants: [next.grants[0]!, next.grants[0]!] },
          f.destination.signingPrivateKey,
        ),
      ])
        assert.equal(Signing.verify(invalid, identity), false);
      assert.equal(
        Signing.verify(entry, { ...identity, publicKey: f.source.peer.signingPublicKey }),
        false,
      );
      yield* f.service.publish("source", 0, next.grants).pipe(Effect.flip);
      assert.deepEqual(yield* f.head, []);
    }).pipe(run),
);

it.effect(
  "owner publication is locally authoritative before distribution, with durable high-watermark and fail-closed rollback/conflict",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.service.publish("owner", 0, [
        { callerMachineId: "source", enabled: true },
      ]);
      assert.equal(first.distributed, true);
      assert.equal(yield* f.enabled, true);
      const old = JSON.parse((yield* f.head)[0]!.entry_json) as Entry;
      yield* f.service.publish("owner", 1, []);
      assert.equal(yield* f.enabled, false);
      yield* f.write(old);
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.revision, 2);
      assert.equal(yield* f.enabled, false);
      yield* f.service.publish("owner", 1, old.grants).pipe(Effect.flip);
      yield* f.service.publish("owner", 2, old.grants);
      assert.equal(yield* f.enabled, true);
      const sameRevision = Signing.sign(
        {
          version: 1,
          fleetId: "fleet",
          destinationMachineId: "destination",
          revision: 3,
          previousDigest: (yield* f.head)[0]!.digest,
          createdAt: 2,
          grants: [],
        },
        f.destination.signingPrivateKey,
      );
      yield* f.write(sameRevision);
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.valid, 0);
      assert.equal(yield* f.enabled, false);
      const retained = JSON.parse((yield* f.head)[0]!.entry_json) as Entry;
      yield* f.write(retained);
      yield* f.service.refresh;
      assert.equal(yield* f.enabled, false);
      yield* f.service.publish("owner", 3, old.grants);
      assert.equal(yield* f.enabled, true);
    }).pipe(run),
);

it.effect(
  "invalid, unavailable and currently untrusted policies never grant and restored old files cannot undo removal",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.publish("owner", 0, [{ callerMachineId: "source", enabled: true }]);
      f.setTrust(false);
      yield* f.service.refresh;
      assert.equal(yield* f.enabled, false);
      f.setTrust(true);
      yield* f.service.refresh;
      assert.equal(yield* f.enabled, false);
      yield* f.service.publish("owner", 1, [{ callerMachineId: "source", enabled: true }]);
      yield* f.fs.remove(f.path.join(f.root, Signing.DIRECTORY, "destination.json"));
      yield* f.service.refresh;
      assert.equal(yield* f.enabled, false);
      yield* f.service.publish("owner", 2, [{ callerMachineId: "source", enabled: true }]);
      f.rotateDestination();
      yield* f.service.refresh;
      assert.equal(yield* f.enabled, false);
      f.setAvailable(false);
      yield* f.service.refresh;
      assert.equal(yield* f.enabled, false);
    }).pipe(run),
);

it.effect(
  "shared gate orders policy publication after native admission without holding it during distribution I/O",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const gate = yield* Gate.ApprovalAdmissionGate;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const admission = yield* gate
        .withGate(
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            assert.deepEqual(yield* f.head, []);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const publication = yield* Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* f.service.publish("owner", 0, [{ callerMachineId: "source", enabled: true }]);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(admission);
      assert.equal((yield* Fiber.join(publication)).revision, 1);
      assert.equal(yield* f.enabled, true);
      const distributing = yield* Deferred.make<void>();
      const finishDistribution = yield* Deferred.make<void>();
      f.pauseDistribution(
        Deferred.succeed(distributing, undefined).pipe(
          Effect.andThen(Deferred.await(finishDistribution)),
        ),
      );
      const removal = yield* f.service.publish("owner", 1, []).pipe(Effect.forkChild);
      yield* Deferred.await(distributing);
      yield* gate.withGate(
        Effect.gen(function* () {
          assert.equal(yield* f.enabled, false);
          assert.equal((yield* f.head)[0]!.revision, 2);
        }),
      );
      yield* Deferred.succeed(finishDistribution, undefined);
      assert.equal((yield* Fiber.join(removal)).distributed, true);
    }).pipe(run),
);

it.effect(
  "a signed higher revision with an unknown chain advances the durable refusal watermark",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.publish("owner", 0, [{ callerMachineId: "source", enabled: true }]);
      const old = JSON.parse((yield* f.head)[0]!.entry_json) as Entry;
      const higher = Signing.sign(
        { ...old, revision: 7, previousDigest: Signing.digest(old) },
        f.destination.signingPrivateKey,
      );
      yield* f.write(higher);
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.revision, 7);
      assert.equal(yield* f.enabled, false);
      yield* f.write(
        Signing.sign(
          { ...old, revision: 2, previousDigest: Signing.digest(old) },
          f.destination.signingPrivateKey,
        ),
      );
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.revision, 7);
      assert.equal(yield* f.enabled, false);
      yield* f.service.publish("owner", 7, [{ callerMachineId: "source", enabled: true }]);
      assert.equal(yield* f.enabled, true);
    }).pipe(run),
);

it.effect.each(["refresh", "restart"] as const)(
  "an undistributed policy survives %s without revoking unchanged delegations",
  (recovery) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const grants = [{ callerMachineId: "source", enabled: true }];
      yield* f.service.publish("owner", 0, grants);
      const before = (yield* f.sql<{
        revision: number;
      }>`SELECT revision FROM agent_approval_link_policies WHERE link_identity_id = 'link'`)[0]!
        .revision;
      f.pauseDistribution(
        f.fs.rename(f.path.join(f.root, "missing.tmp"), f.path.join(f.root, "missing.json")),
      );
      const published = yield* f.service.publish("owner", 1, grants);
      assert.equal(published.distributed, false);
      assert.equal(published.revision, 2);
      assert.equal(yield* f.enabled, true);
      const latest = yield* f.service.publish("owner", 2, grants);
      assert.equal(latest.distributed, false);
      assert.equal(latest.revision, 3);
      f.pauseDistribution(Effect.void);
      if (recovery === "restart") yield* f.restart;
      else yield* f.service.refresh;
      const recovered = (yield* f.head)[0]!;
      assert.equal(recovered.valid, 1);
      assert.equal(recovered.revision, 3);
      assert.equal(yield* f.enabled, true);
      const revision = (yield* f.sql<{
        revision: number;
      }>`SELECT revision FROM agent_approval_link_policies WHERE link_identity_id = 'link'`)[0]!
        .revision;
      assert.equal(revision, before);
      const distributed = JSON.parse(
        yield* f.fs.readFileString(f.path.join(f.root, Signing.DIRECTORY, "destination.json")),
      ) as Entry;
      assert.equal(distributed.revision, 3);
      assert.equal(Signing.digest(distributed), latest.digest);
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_approval_fleet_policy_publications`, []);
      f.pauseDistribution(
        f.fs.rename(f.path.join(f.root, "missing.tmp"), f.path.join(f.root, "missing.json")),
      );
      assert.equal((yield* f.service.publish("owner", 3, grants)).distributed, false);
      const intent = JSON.parse((yield* f.head)[0]!.entry_json) as Entry;
      yield* f.write(Signing.sign({ ...intent, grants: [] }, f.destination.signingPrivateKey));
      f.pauseDistribution(Effect.void);
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.valid, 0);
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_approval_fleet_policy_publications`, []);
      yield* f.write(intent);
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.valid, 0);
      yield* f.service.publish("owner", 4, grants);
      assert.equal(yield* f.enabled, true);
    }).pipe(run),
);

it.effect(
  "a newer local revocation commits while older distribution waits and wins the shared file",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const gate = yield* Gate.ApprovalAdmissionGate;
      const distributing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.pauseDistribution(
        Deferred.succeed(distributing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const first = yield* f.service
        .publish("owner", 0, [{ callerMachineId: "source", enabled: true }])
        .pipe(Effect.forkChild);
      yield* Deferred.await(distributing);
      const nextOwner = yield* Deferred.make<void>();
      f.observeOwner(Deferred.succeed(nextOwner, undefined));
      const removal = yield* f.service.publish("owner", 1, []).pipe(Effect.forkChild);
      yield* Deferred.await(nextOwner);
      yield* gate.withGate(
        Effect.gen(function* () {
          assert.equal((yield* f.head)[0]!.revision, 2);
          assert.equal(yield* f.enabled, false);
        }),
      );
      f.observeOwner(Effect.void);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(first)).distributed, false);
      assert.equal((yield* Fiber.join(removal)).distributed, true);
      const shared = JSON.parse(
        yield* f.fs.readFileString(f.path.join(f.root, Signing.DIRECTORY, "destination.json")),
      ) as Entry;
      assert.equal(shared.revision, 2);
      assert.deepEqual(shared.grants, []);
      assert.deepEqual(yield* f.sql`SELECT * FROM agent_approval_fleet_policy_publications`, []);
      yield* f.service.refresh;
      assert.equal((yield* f.head)[0]!.valid, 1);
      assert.equal(yield* f.enabled, false);
    }).pipe(run),
);
