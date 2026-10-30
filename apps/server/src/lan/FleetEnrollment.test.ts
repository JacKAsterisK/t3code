import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  FleetRoster,
  AuthStandardClientScopes,
  AuthFilesystemWriteScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as FleetTransport from "./FleetTransport.ts";
import { DEPARTURE_CHECKS, DEPARTURE_GRACE_MS } from "./FleetMembership.ts";
import * as FleetNetwork from "./FleetNetwork.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as Config from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import * as FleetVault from "./FleetVault.ts";
import * as Authority from "./FleetAuthority.ts";
import * as LanFleet from "./LanFleet.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import { FLEET_ROSTER_ENV, WINDOWS_FLEET_SHARE_ROOT } from "./FleetBootstrap.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

// Only this in-memory vault and temporary synthetic shares are used; the OS vault is never constructed.
const fixture = Effect.fn("FleetEnrollmentTest.fixture")(function* (
  managedTls = false,
  share: false | "accessible" | "inaccessible" = false,
  platform: NodeJS.Platform = "win32",
) {
  const diskFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* Config.ServerConfig;
  const diskRoot = yield* diskFs.makeTempDirectoryScoped({
    prefix: "t3-fleet-enrollment-synthetic-",
  });
  const root = share ? WINDOWS_FLEET_SHARE_ROOT : diskRoot;
  let sharedFolderAccessible = share === "accessible";
  // Paths that briefly read as not found, as a share can.
  const absent = new Set<string>();
  const localPath = (file: string) =>
    share && (file === root || file.startsWith(root + "\\"))
      ? path.join(diskRoot, file.slice(root.length))
      : file;
  // The virtual UNC share is mapped entirely to a fresh temp directory. No real SMB path is touched.
  const fs = FileSystem.FileSystem.of({
    ...diskFs,
    exists: (file) => (absent.has(file) ? Effect.succeed(false) : diskFs.exists(localPath(file))),
    stat: (file) => diskFs.stat(localPath(file)),
    readFileString: (file, options) => diskFs.readFileString(localPath(file), options),
    makeDirectory: (file, options) => diskFs.makeDirectory(localPath(file), options),
    open: (file, options) => diskFs.open(localPath(file), options),
    rename: (from, to) => diskFs.rename(localPath(from), localPath(to)),
    remove: (file, options) => diskFs.remove(localPath(file), options),
    readDirectory: (file, options) =>
      diskFs.readDirectory(
        file === WINDOWS_FLEET_SHARE_ROOT && !sharedFolderAccessible
          ? path.join(diskRoot, "denied-share-root")
          : localPath(file),
        options,
      ),
  });
  const rosterPath = path.join(root, "roster.json");
  const authorityFile = path.join(root, "fleet-authority.json");
  const issued: Array<{ issuer: string; scopes: ReadonlyArray<AuthEnvironmentScope> }> = [];
  const create = Effect.fn("FleetEnrollmentTest.create")(function* (name: string) {
    const environmentId = EnvironmentId.make(`environment:${name}`);
    const stateDir = path.join(diskRoot, name);
    yield* fs.makeDirectory(stateDir);
    let record: Authority.FleetVaultRecord | undefined;
    let saves = 0;
    const activeLinks: Array<EnvironmentAuth.IssuedPairingLink> = [];
    const vault = FleetVault.FleetVault.of({
      read: Effect.sync(() => record),
      save: (next) =>
        Effect.sync(() => {
          saves++;
          record = {
            ...next,
            lastRevision: Math.max(record?.lastRevision ?? 0, next.lastRevision),
          };
        }),
    });
    const environment = ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label: `Test ${name}`,
        platform: { os: "windows", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: 2,
        capabilities: { repositoryIdentity: true },
      }),
    });
    const config = { ...base, stateDir, port: 4000 };
    const launchEnvironment: Record<string, string> = { [FLEET_ROSTER_ENV]: rosterPath };
    let starts = 0;
    let closes = 0;
    const transportLayer = managedTls
      ? FleetTransport.layerServices.pipe(
          Layer.provide(Config.layer(config)),
          Layer.provide(Layer.succeed(FleetVault.FleetVault, vault)),
          Layer.provide(
            Layer.succeed(FleetNetwork.FleetNetwork, {
              addresses: Effect.succeed([name === "alpha" ? "192.168.40.10" : "192.168.40.11"]),
              listen: (input) =>
                Effect.sync(() => {
                  starts++;
                  return {
                    httpBaseUrl: `https://${input.listen.address}:${input.listen.port}/`,
                    wsBaseUrl: "wss://synthetic-only/",
                    close: () => {
                      closes++;
                      return Promise.resolve();
                    },
                  };
                }),
            }),
          ),
        )
      : Layer.empty;
    let serverScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit));
    const build = Effect.fn("FleetEnrollmentTest.build")(
      function* () {
        const enrollmentServices = yield* Layer.build(
          FleetEnrollment.layerServices.pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
            Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
            Layer.provide(transportLayer),
            Layer.provide(Config.layer(config)),
            Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
            Layer.provide(Layer.succeed(FleetVault.FleetVault, vault)),
            Layer.provide(
              Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
            ),
            Layer.provide(Layer.succeed(HostProcess.Environment, launchEnvironment)),
            Layer.provideMerge(
              FleetAccessPolicy.layer.pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
                Layer.provide(Config.layer(config)),
              ),
            ),
          ),
        );
        const enrollment = Context.get(enrollmentServices, FleetEnrollment.FleetEnrollment);
        const fleetAccess = Context.get(enrollmentServices, FleetAccessPolicy.FleetAccess);
        const links = yield* LanFleet.LanFleet.pipe(
          Effect.provide(
            LanFleet.layerServices.pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
              Layer.provide(Config.layer(config)),
              Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
              Layer.provide(Layer.succeed(FleetEnrollment.FleetEnrollment, enrollment)),
              Layer.provide(Layer.succeed(FleetAccessPolicy.FleetAccess, fleetAccess)),
              Layer.provide(Layer.succeed(HostProcess.Environment, launchEnvironment)),
              Layer.provide(
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                  createPairingLink: (input) =>
                    Effect.sync(() => {
                      issued.push({
                        issuer: name,
                        scopes: input?.scopes ?? AuthStandardClientScopes,
                      });
                      const link = {
                        id: `synthetic-${issued.length}`,
                        credential: `synthetic-${name}-credential`,
                        subject: input?.subject ?? "synthetic",
                        scopes: input?.scopes ?? AuthStandardClientScopes,
                        createdAt: DateTime.makeUnsafe(0),
                        expiresAt: DateTime.makeUnsafe(86_400_000),
                      };
                      activeLinks.push(link);
                      return link;
                    }),
                  listPairingLinks: () => Effect.succeed(activeLinks),
                  listSessions: () => Effect.succeed([]),
                  revokePairingLink: (id) =>
                    Effect.sync(() => {
                      const index = activeLinks.findIndex((link) => link.id === id);
                      if (index === -1) return false;
                      activeLinks.splice(index, 1);
                      return true;
                    }),
                }),
              ),
            ),
          ),
        );
        return { enrollment, links, fleetAccess };
      },
      (effect) => Effect.provideService(effect, Scope.Scope, serverScope),
    );
    let services = yield* build();
    return {
      environmentId,
      get enrollment() {
        return services.enrollment;
      },
      get links() {
        return services.links;
      },
      get fleetAccess() {
        return services.fleetAccess;
      },
      restart: Effect.gen(function* () {
        yield* Scope.close(serverScope, Exit.succeed(undefined));
        serverScope = yield* Scope.make();
        services = yield* build();
      }),
      /** As if Hub launched this server with the fleet switched off. */
      disableBootstrap: () => {
        launchEnvironment[FLEET_ROSTER_ENV] = "";
      },
      record: () => record,
      replaceRecord: (next: Authority.FleetVaultRecord | undefined) => {
        record = next;
      },
      saves: () => saves,
      network: () => ({ starts, closes }),
    };
  });
  const a = yield* create("alpha");
  const b = yield* create("beta");
  const start = () =>
    a.enrollment.configure({
      operation: "start",
      confirmed: true,
      origin: "https://alpha.example.test",
      autoPickup: true,
      access: "read-only",
    });
  const join = (ownerCode: string) =>
    b.enrollment.configure({
      operation: "join",
      confirmed: true,
      origin: "https://beta.example.test",
      ownerCode,
      autoPickup: true,
      access: "standard",
    });
  const approve = (machineId: string, verificationCode: string) =>
    a.enrollment.configure({ operation: "approve", confirmed: true, machineId, verificationCode });
  const sync = (peer: typeof a, connectedEnvironmentIds: ReadonlyArray<EnvironmentId>) =>
    peer.links.sync({ mode: "automatic", connectedEnvironmentIds, sendMachineIds: [] });
  return {
    a,
    b,
    root,
    rosterPath,
    authorityFile,
    start,
    join,
    approve,
    sync,
    fs,
    path,
    issued,
    setSharedFolderAccessible: (value: boolean) => {
      sharedFolderAccessible = value;
    },
    setAbsent: (file: string, value: boolean) => {
      if (value) absent.add(file);
      else absent.delete(file);
    },
  };
});
const configLayer = Config.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fleet-enrollment-config-",
});

it.layer(NodeServices.layer)("explicit fleet setup", (it) => {
  it.effect("does not replace an enrolled identity when its vault is temporarily missing", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, "accessible");
      yield* f.start();
      const originalAuthority = yield* f.fs.readFileString(f.authorityFile);
      f.a.replaceRecord(undefined);
      const failed = yield* f.a.enrollment
        .configure({
          operation: "join",
          confirmed: true,
          origin: "https://alpha.example.test",
          autoPickup: true,
          access: "standard",
        })
        .pipe(Effect.flip);
      assert.equal(failed.reason, "configuration");
      assert.equal(f.a.record(), undefined);
      assert.equal(yield* f.fs.readFileString(f.authorityFile), originalAuthority);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "recovers a saved replacement enrollment and missing TLS through the Windows share",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, "accessible");
        const origin = "https://192.168.40.10:4001";
        yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin,
          managedTls: true,
          autoPickup: true,
          access: "read-only",
        });
        const original = f.a.record()!;
        yield* f.b.enrollment.configure({
          operation: "join",
          confirmed: true,
          origin: "https://192.168.40.11:4001",
          managedTls: true,
          autoPickup: true,
          access: "standard",
        });
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.b.environmentId]);
        assert.equal((yield* f.sync(f.a, [f.a.environmentId])).incoming.length, 1);
        assert.equal(f.issued.length, 2);
        const authorityBytes = yield* f.fs.readFileString(f.authorityFile);
        const replacement = Authority.generateFleetIdentity(
          f.a.environmentId,
          original.fleetId,
          original.rootPublicKey,
          false,
          { autoPickup: true, access: "read-only" },
          original.machineId,
        );
        f.a.replaceRecord(replacement);
        const peer = Authority.identityPeer(replacement, "Test alpha", origin);
        yield* f.fs.makeDirectory(f.path.join(f.root, "fleet-enrollment"), { recursive: true });
        yield* writeFleetJson(
          f.path.join(f.root, "fleet-enrollment", `${peer.machineId}.json`),
          Authority.enrollmentRequest(replacement, peer),
        ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        yield* f.a.restart;
        const pending = yield* f.a.enrollment.status;
        assert.equal(pending.managedTls, true);
        const resolved = yield* f.a.enrollment.resolve;
        assert.equal(
          resolved?.peers.find((p) => p.environmentId === f.a.environmentId)?.signingPublicKey,
          peer.signingPublicKey,
        );
        assert.equal((yield* f.a.enrollment.status).stage, "active");
        assert.equal((yield* f.a.enrollment.status).tlsReady, true);
        assert.equal(f.a.record()!.encryptionPrivateKey, replacement.encryptionPrivateKey);
        assert.equal(f.a.record()!.signingPrivateKey, replacement.signingPrivateKey);
        assert.equal(f.a.record()!.access, "read-only");
        assert.equal(yield* f.fs.readFileString(f.authorityFile), authorityBytes);
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.b.environmentId]);
        const receivedA = yield* f.sync(f.a, [f.a.environmentId]);
        const receivedB = yield* f.sync(f.b, [f.b.environmentId]);
        assert.equal(receivedA.incoming[0]?.environmentId, f.b.environmentId);
        assert.equal(receivedB.incoming[0]?.environmentId, f.a.environmentId);
        assert.equal(
          receivedB.incoming[0]?.tls?.publicKeySha256,
          f.a.record()!.tls!.publicKeySha256,
        );
        assert.equal(f.issued.length, 4);
        const saved = f.a.record()!;
        yield* writeFleetJson(
          f.path.join(f.root, "fleet-enrollment", `${peer.machineId}.json`),
          Authority.enrollmentRequest(replacement, peer),
        ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        yield* f.a.restart;
        yield* f.a.enrollment.resolve;
        assert.equal((yield* f.a.enrollment.status).stage, "active");
        assert.deepEqual(f.a.record()!.tls, saved.tls);
        assert.equal(f.a.record()!.signingPrivateKey, saved.signingPrivateKey);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "links effective SMB peers from owner and non-owner without rewriting signed authority",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        yield* f.start();
        yield* f.b.enrollment.configure({
          operation: "join",
          confirmed: true,
          origin: "https://beta.example.test",
          autoPickup: true,
          access: "standard",
        });
        const original = yield* f.fs.readFileString(f.authorityFile);
        assert.equal(
          (yield* f.a.enrollment.status).peers.find(
            (peer) => peer.environmentId === f.b.environmentId,
          )?.status,
          "approved",
        );
        assert.equal(
          (yield* f.a.enrollment.configure({
            operation: "link",
            confirmed: true,
            machineIds: [f.b.record()!.machineId],
          })).stage,
          "active",
        );
        assert.equal(
          (yield* f.b.enrollment.configure({
            operation: "link",
            confirmed: true,
            machineIds: [f.a.record()!.machineId],
          })).stage,
          "active",
        );
        assert.equal(yield* f.fs.readFileString(f.authorityFile), original);
        assert.equal((yield* f.b.enrollment.resolve)?.campaign?.machineIds.length, 2);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "refuses shared-folder links for disabled roster peers, paused local machines and revoked peers",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        yield* f.start();
        yield* f.b.enrollment.configure({
          operation: "join",
          confirmed: true,
          origin: "https://beta.example.test",
          autoPickup: true,
          access: "standard",
        });
        const aId = f.a.record()!.machineId,
          bId = f.b.record()!.machineId;
        const linkA = f.a.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [bId],
        });
        const linkB = f.b.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [aId],
        });
        const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* writeFleetJson(f.rosterPath, {
          ...roster,
          machines: roster.machines.map((peer) =>
            peer.machineId === bId ? { ...peer, enabled: false } : peer,
          ),
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        assert.equal((yield* linkA.pipe(Effect.flip)).reason, "configuration");
        yield* writeFleetJson(f.rosterPath, roster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* f.b.enrollment.configure({
          operation: "settings",
          confirmed: true,
          enabled: false,
          autoPickup: true,
          access: "standard",
        });
        assert.equal((yield* linkB.pipe(Effect.flip)).reason, "configuration");
        yield* f.b.enrollment.configure({
          operation: "settings",
          confirmed: true,
          enabled: true,
          autoPickup: true,
          access: "standard",
        });
        yield* f.a.enrollment.configure({ operation: "revoke", confirmed: true, machineId: bId });
        const revoked = yield* f.fs.readFileString(f.authorityFile);
        assert.equal((yield* linkA.pipe(Effect.flip)).reason, "configuration");
        assert.equal((yield* linkB.pipe(Effect.flip)).reason, "configuration");
        assert.equal(yield* f.fs.readFileString(f.authorityFile), revoked);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "joins through the accessible Windows share without codes or owner approval and uses existing encrypted delivery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        const owner = yield* f.start();
        assert.equal(owner.sharedFolderTrust, true);
        const joined = yield* f.b.enrollment.configure({
          operation: "join",
          confirmed: true,
          origin: "https://beta.example.test",
          autoPickup: true,
          access: "standard",
        });
        assert.equal(joined.stage, "active");
        assert.equal(joined.sharedFolderTrust, true);
        // Joining reads only the already signed authority; its owner need not execute an approval turn.
        const raw = yield* readFleetJson(f.authorityFile, Authority.FleetAuthority).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        assert.equal(raw.peers.length, 1);
        assert.equal((yield* f.b.enrollment.resolve)?.peers.length, 2);
        assert.equal(
          (yield* f.a.enrollment.status).peers.find(
            (peer) => peer.environmentId === f.b.environmentId,
          )?.status,
          "approved",
        );
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.b.environmentId]);
        assert.equal((yield* f.sync(f.a, [f.a.environmentId])).incoming.length, 1);
        assert.equal((yield* f.sync(f.b, [f.b.environmentId])).incoming.length, 1);
        assert.equal(f.issued.length, 2);

        // The enrollment folder briefly reads as absent. Leaving would revoke everything beta
        // holds on alpha, so one miss, or several within the grace period, is not leaving.
        const requests = f.path.join(f.root, "fleet-enrollment");
        const peersOf = Effect.map(f.a.enrollment.resolve, (config) =>
          (config?.peers ?? []).filter((peer) => peer.enabled).map((peer) => peer.machineId),
        );
        const beta = (yield* f.b.enrollment.resolve)!.machineId;
        f.setAbsent(requests, true);
        for (let check = 0; check < 5; check++) assert.include(yield* peersOf, beta);
        yield* TestClock.adjust(Duration.millis(DEPARTURE_GRACE_MS - 1));
        assert.include(yield* peersOf, beta);
        // The folder comes back before the grace runs out: nothing was lost, and a later miss
        // starts its grace again.
        f.setAbsent(requests, false);
        assert.include(yield* peersOf, beta);
        f.setAbsent(requests, true);
        assert.include(yield* peersOf, beta);
        yield* TestClock.adjust(Duration.millis(DEPARTURE_GRACE_MS - 1));
        assert.include(yield* peersOf, beta);
        // Missing for the whole grace period, over several checks, it has left.
        yield* TestClock.adjust(Duration.millis(1));
        for (let check = 0; check < DEPARTURE_CHECKS; check++) yield* peersOf;
        assert.notInclude(yield* peersOf, beta);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "automatically trusts an existing matching request and preserves explicit authority revocation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "inaccessible");
        const owner = yield* f.start();
        const pending = yield* f.join(owner.ownerCode!);
        assert.equal(pending.stage, "pending");
        const before = f.b.record();
        f.setSharedFolderAccessible(true);
        const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* writeFleetJson(f.rosterPath, {
          ...roster,
          machines: roster.machines.map((machine) =>
            machine.environmentId === f.b.environmentId ? { ...machine, enabled: false } : machine,
          ),
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        assert.equal((yield* f.b.enrollment.status).stage, "pending");
        assert.equal(yield* f.b.enrollment.resolve, null);
        yield* writeFleetJson(f.rosterPath, roster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        assert.equal((yield* f.b.enrollment.status).stage, "active");
        assert.equal((yield* f.b.enrollment.resolve)?.peers.length, 2);
        assert.equal(f.b.record()?.signingPrivateKey, before?.signingPrivateKey);
        yield* f.a.enrollment.configure({
          operation: "revoke",
          confirmed: true,
          machineId: before!.machineId,
        });
        assert.equal(yield* f.b.enrollment.resolve, null);
        assert.equal(
          (yield* f.b.enrollment.status).peers.find((peer) => peer.machineId === before!.machineId)
            ?.status,
          "revoked",
        );
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "requires the legacy owner code outside the trusted share or when exact-share access fails",
    () =>
      Effect.gen(function* () {
        for (const [share, platform] of [
          [false, "win32"],
          ["inaccessible", "win32"],
          ["accessible", "linux"],
        ] as const) {
          const f = yield* fixture(false, share, platform);
          yield* f.start();
          assert.equal((yield* f.b.enrollment.status).sharedFolderTrust, false);
          const failure = yield* f.b.enrollment
            .configure({
              operation: "join",
              confirmed: true,
              origin: "https://beta.example.test",
              autoPickup: true,
              access: "standard",
            })
            .pipe(Effect.flip);
          assert.equal(failure.reason, "configuration");
          assert.equal(f.b.record(), undefined);
        }
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "binds encrypted endpoints to explicit setup, approved peer codes and recipient-specific delivery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        assert.deepEqual((yield* f.a.enrollment.status).suggestedTlsOrigins, [
          "https://192.168.40.10:4001",
        ]);
        assert.deepEqual(f.a.network(), { starts: 0, closes: 0 });
        const input = {
          operation: "start" as const,
          confirmed: true,
          origin: "https://192.168.40.10:4001",
          managedTls: true,
          autoPickup: true,
          access: "read-only" as const,
        };
        yield* f.a.enrollment.configure({ ...input, confirmed: false }).pipe(Effect.flip);
        assert.equal(f.a.record(), undefined);
        assert.equal(f.a.network().starts, 0);
        const owner = yield* f.a.enrollment.configure(input);
        const before = f.a.record()!.tls;
        yield* f.a.enrollment.configure(input);
        assert.deepEqual(f.a.record()!.tls, before);
        assert.equal(f.a.network().starts, 1);
        assert.equal(owner.tlsReady, true);
        const pending = yield* f.b.enrollment.configure({
          ...input,
          operation: "join",
          origin: "https://192.168.40.11:4001",
          ownerCode: owner.ownerCode!,
        });
        const peer = Authority.identityPeer(
          f.b.record()!,
          "Test beta",
          "https://192.168.40.11:4001",
        );
        assert.notEqual(
          Authority.peerVerificationCode({
            ...peer,
            tls: { ...peer.tls!, publicKeySha256: "0".repeat(64) },
          }),
          pending.deviceCode,
        );
        yield* f.approve(peer.machineId, pending.deviceCode!);
        const roster = yield* f.fs.readFileString(f.rosterPath);
        assert.equal(roster.includes("certificate"), false);
        assert.equal(roster.includes("privateKey"), false);
        const authority = yield* f.fs.readFileString(f.authorityFile);
        assert.equal(authority.includes("BEGIN PRIVATE KEY"), false);
        yield* f.b.enrollment
          .configure({ operation: "link", confirmed: true, machineIds: [f.a.record()!.machineId] })
          .pipe(Effect.flip);
        yield* f.a.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [peer.machineId],
        });
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.b.environmentId]);
        const received = (yield* f.sync(f.a, [f.a.environmentId])).incoming[0]!;
        assert.deepEqual(received.tls, peer.tls);
        yield* f.a.enrollment.configure({
          operation: "transport",
          confirmed: true,
          enabled: false,
        });
        assert.equal((yield* f.a.enrollment.status).tlsReady, false);
        assert.equal(f.a.network().closes, 1);
        assert.equal(yield* f.a.enrollment.resolve, null);
        yield* f.a.enrollment.configure({ operation: "transport", confirmed: true, enabled: true });
        assert.deepEqual(f.a.record()!.tls, before);
        assert.equal(f.a.network().starts, 2);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "automatically restores both peers, preserves read-only access and keeps stop and revocation across restarts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        const owner = yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin: "https://192.168.40.10:4001",
          managedTls: true,
          autoPickup: true,
          access: "read-only",
        });
        const pending = yield* f.b.enrollment.configure({
          operation: "join",
          confirmed: true,
          origin: "https://192.168.40.11:4001",
          ownerCode: owner.ownerCode!,
          managedTls: true,
          autoPickup: true,
          access: "standard",
        });
        const beforeA = f.a.record()!;
        const beforeB = f.b.record()!;
        yield* f.a.restart;
        yield* f.b.restart;
        assert.equal((yield* f.a.enrollment.status).tlsReady, true);
        assert.equal((yield* f.b.enrollment.status).tlsReady, true);
        assert.equal((yield* f.b.enrollment.status).stage, "pending");
        assert.equal(yield* f.b.enrollment.resolve, null);
        assert.deepEqual(f.issued, []);
        assert.deepEqual(f.a.network(), { starts: 2, closes: 1 });
        assert.deepEqual(f.b.network(), { starts: 2, closes: 1 });
        assert.deepEqual(f.a.record()!.tls, beforeA.tls);
        assert.deepEqual(f.b.record()!.tls, beforeB.tls);
        assert.equal(f.a.record()!.access, "read-only");
        assert.equal(f.b.record()!.access, "standard");
        yield* f.approve(beforeB.machineId, pending.deviceCode!);
        yield* f.a.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [beforeB.machineId],
        });
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.b.environmentId]);
        assert.equal((yield* f.sync(f.a, [f.a.environmentId])).incoming.length, 1);
        assert.equal((yield* f.sync(f.b, [f.b.environmentId])).incoming.length, 1);
        assert.equal(f.issued.length, 2);
        assert.equal(
          f.issued
            .find((grant) => grant.issuer === "alpha")!
            .scopes.includes(AuthFilesystemWriteScope),
          false,
        );
        assert.deepEqual(
          f.issued.find((grant) => grant.issuer === "beta")!.scopes,
          AuthStandardClientScopes,
        );
        yield* f.a.restart;
        yield* f.b.restart;
        yield* f.sync(f.a, [f.a.environmentId, f.b.environmentId]);
        yield* f.sync(f.b, [f.a.environmentId, f.b.environmentId]);
        assert.equal(f.issued.length, 2);
        yield* f.a.enrollment.configure({
          operation: "transport",
          confirmed: true,
          enabled: false,
        });
        const stopped = f.a.network();
        yield* f.a.restart;
        assert.equal((yield* f.a.enrollment.status).tlsReady, false);
        assert.deepEqual(f.a.network(), stopped);
        assert.equal(yield* f.a.enrollment.resolve, null);
        yield* f.a.enrollment.configure({ operation: "transport", confirmed: true, enabled: true });
        yield* f.a.enrollment.configure({
          operation: "revoke",
          confirmed: true,
          machineId: beforeB.machineId,
        });
        yield* f.b.restart;
        assert.equal(yield* f.b.enrollment.resolve, null);
        assert.deepEqual(f.a.record()!.tls, beforeA.tls);
        assert.equal(f.issued.length, 2);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "syncs the fleet access policy and refuses a read-only machine lifting its own restriction",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin: "https://alpha.example.test",
          autoPickup: true,
          access: "standard",
        });
        yield* f.join("");
        const alpha = f.a.record()!.machineId;
        const beta = f.b.record()!.machineId;
        const change = (
          peer: typeof f.a,
          revision: number,
          machines: ReadonlyArray<{ machineId: string; access: "read-only" | "standard" }>,
        ) =>
          peer.enrollment.configure({
            operation: "access",
            confirmed: true,
            revision,
            defaultAccess: "standard",
            machines,
          });
        assert.equal((yield* f.b.enrollment.status).accessPolicy?.revision, 0);
        yield* change(f.a, 0, [{ machineId: beta, access: "read-only" }]);
        const synced = (yield* f.b.enrollment.status).accessPolicy;
        assert.equal(synced?.revision, 1);
        assert.equal(synced?.selfAccess, "read-only");
        assert.equal(synced?.canChange, false);

        for (const machines of [[], [{ machineId: alpha, access: "read-only" as const }]])
          assert.equal((yield* change(f.b, 1, machines).pipe(Effect.flip)).reason, "configuration");
        // A signed file a read-only machine writes straight to the share is not accepted either.
        const head = (yield* f.fs.readDirectory(f.path.join(f.root, "fleet-access")))[0]!;
        const forged = FleetAccessPolicy.signAccessEntry(
          {
            version: 1,
            fleetId: f.b.record()!.fleetId,
            revision: 2,
            previous: FleetAccessPolicy.entryDigest(
              yield* readFleetJson(
                f.path.join(f.root, "fleet-access", head),
                FleetAccessPolicy.FleetAccessEntry,
              ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs)),
            ),
            signerMachineId: beta,
            createdAt: 0,
            defaultAccess: "standard",
            machines: [],
          },
          f.b.record()!.signingPrivateKey,
        );
        yield* writeFleetJson(
          f.path.join(f.root, "fleet-access", FleetAccessPolicy.entryFileName(forged)),
          forged,
        ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        // Nor does deleting the share's history roll back what a machine already accepted.
        yield* f.fs.remove(f.path.join(f.root, "fleet-access", head));
        for (const peer of [f.a, f.b]) {
          const policy = (yield* peer.enrollment.status).accessPolicy;
          assert.equal(policy?.revision, 1);
          assert.deepEqual(policy?.machines, [{ machineId: beta, access: "read-only" }]);
        }
        // The last standard machine cannot restrict itself, or no one could lift the policy.
        assert.equal(
          (yield* change(f.a, 1, [
            { machineId: alpha, access: "read-only" },
            { machineId: beta, access: "read-only" },
          ]).pipe(Effect.flip)).reason,
          "configuration",
        );
        yield* change(f.a, 1, [{ machineId: beta, access: "standard" }]);
        assert.equal((yield* f.b.enrollment.status).accessPolicy?.selfAccess, "standard");
        // A machine may always restrict itself.
        yield* change(f.b, 2, [{ machineId: beta, access: "read-only" }]);
        assert.equal((yield* f.a.enrollment.status).accessPolicy?.revision, 3);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "stops linking a machine whose roster row is disabled, while its list still governs credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin: "https://alpha.example.test",
          autoPickup: true,
          access: "standard",
        });
        yield* f.join("");
        const alpha = f.a.record()!.machineId;
        const beta = f.b.record()!.machineId;
        yield* f.a.enrollment.configure({
          operation: "access",
          confirmed: true,
          revision: 0,
          defaultAccess: "standard",
          machines: [{ machineId: beta, access: "read-only" }],
        });
        yield* f.a.enrollment.status;
        assert.isTrue(FleetAccessPolicy.fleetLinksApply(yield* f.a.fleetAccess.current));

        // The owner's roster row is disabled; its signed authority entry stays enabled.
        const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* writeFleetJson(f.rosterPath, {
          ...roster,
          machines: roster.machines.map((machine) =>
            machine.machineId === alpha ? { ...machine, enabled: false } : machine,
          ),
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        yield* f.a.enrollment.status;
        const state = yield* f.a.fleetAccess.current;
        assert.isFalse(FleetAccessPolicy.fleetLinksApply(state));
        // The list it accepted is kept for credential enforcement.
        assert.equal(state.revision, 1);
        assert.isTrue(state.peers.some((peer) => peer.machineId === alpha));
        assert.equal(FleetAccessPolicy.machineAccess(state, beta), "read-only");

        // Enabled again, the fleet links it again.
        yield* writeFleetJson(f.rosterPath, roster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* f.a.enrollment.status;
        assert.isTrue(FleetAccessPolicy.fleetLinksApply(yield* f.a.fleetAccess.current));

        // Its enrollment record goes: it stops linking, and the list still governs credentials.
        const record = f.a.record();
        f.a.replaceRecord(undefined);
        assert.isUndefined(yield* f.a.enrollment.resolve);
        const absent = yield* f.a.fleetAccess.current;
        assert.isFalse(FleetAccessPolicy.fleetLinksApply(absent));
        assert.equal(absent.revision, 1);
        assert.equal(FleetAccessPolicy.machineAccess(absent, beta), "read-only");
        f.a.replaceRecord(record);
        yield* f.a.enrollment.status;
        assert.isTrue(FleetAccessPolicy.fleetLinksApply(yield* f.a.fleetAccess.current));
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "preserves saved access and pickup choices after interrupted enrollment publication",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        const input = {
          operation: "start" as const,
          confirmed: true,
          origin: "https://192.168.40.10:4001",
          managedTls: true,
          autoPickup: false,
          access: "read-only" as const,
        };
        yield* f.a.enrollment.configure(input);
        const before = f.a.record()!;
        yield* f.fs.remove(f.authorityFile);
        yield* f.a.restart;
        const status = yield* f.a.enrollment.status;
        assert.equal(status.stage, "unconfigured");
        assert.equal(status.access, "read-only");
        assert.equal(status.autoPickup, false);
        yield* f.a.enrollment.configure({ ...input, access: "standard", autoPickup: true });
        assert.equal(f.a.record()!.access, "read-only");
        assert.equal(f.a.record()!.autoPickup, false);
        assert.deepEqual(f.a.record()!.tls, before.tls);
        assert.deepEqual(f.issued, []);
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "does not issue a duplicate when only the recipient already has the source identity",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const owner = yield* f.start();
        const pending = yield* f.join(owner.ownerCode!);
        yield* f.approve(f.b.record()!.machineId, pending.deviceCode!);
        yield* f.a.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [f.b.record()!.machineId],
        });
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.a.environmentId, f.b.environmentId]);
        yield* f.sync(f.a, [f.a.environmentId]);
        yield* f.sync(f.b, [f.a.environmentId, f.b.environmentId]);
        assert.deepEqual(
          f.issued.map((grant) => grant.issuer),
          ["beta"],
        );
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "does not generate or save keys without confirmation, including passive setup inspection",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* f.a.enrollment.status).stage, "unconfigured");
        assert.equal(f.a.saves(), 0);
        assert.equal(
          (yield* f.a.enrollment
            .configure({
              operation: "start",
              confirmed: false,
              origin: "https://alpha.example.test",
              autoPickup: true,
              access: "standard",
            })
            .pipe(Effect.flip)).reason,
          "configuration",
        );
        assert.equal(f.a.record(), undefined);
        assert.equal(yield* f.fs.exists(f.authorityFile), false);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "assigns detected environment IDs, verifies both ends, and reuses keys on repeated join requests",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const owner = yield* f.start();
        assert.equal(owner.owner, true);
        assert.equal(owner.stage, "active");
        yield* f.join("000000000000").pipe(Effect.flip);
        assert.equal(f.b.record(), undefined);
        const pending = yield* f.join(owner.ownerCode!);
        assert.equal(pending.stage, "pending");
        assert.equal(yield* f.b.enrollment.resolve, null);
        const before = f.b.record();
        yield* f.join(owner.ownerCode!);
        assert.equal(f.b.record()?.encryptionPrivateKey, before?.encryptionPrivateKey);
        assert.equal(f.b.record()?.signingPrivateKey, before?.signingPrivateKey);
        const request = (yield* f.a.enrollment.status).peers.find(
          (peer) => peer.status === "pending",
        )!;
        assert.equal(request.environmentId, f.b.environmentId);
        yield* f.approve(request.machineId, owner.deviceCode!).pipe(Effect.flip);
        yield* f.approve(request.machineId, pending.deviceCode!);
        assert.equal((yield* f.b.enrollment.status).stage, "active");
        assert.equal((yield* f.b.enrollment.resolve)?.peers.length, 2);
        const rosterBytes = yield* f.fs.readFileString(f.rosterPath);
        assert.notInclude(rosterBytes, "PRIVATE KEY");
        assert.notInclude(rosterBytes, "PublicKey");
        assert.deepEqual(f.issued, []);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "rejects replayed authority metadata and unapproved key replacement, and honors revocation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const owner = yield* f.start();
        const original = yield* f.fs.readFileString(f.authorityFile);
        const pending = yield* f.join(owner.ownerCode!);
        yield* f.approve(f.b.record()!.machineId, pending.deviceCode!);
        yield* f.b.enrollment.status;
        const current = yield* f.fs.readFileString(f.authorityFile);
        yield* f.fs.writeFileString(f.authorityFile, original);
        assert.equal((yield* f.b.enrollment.resolve.pipe(Effect.flip)).reason, "configuration");
        yield* f.fs.writeFileString(f.authorityFile, current);
        const authority = yield* readFleetJson(f.authorityFile, Authority.FleetAuthority);
        const replacement = Authority.generateFleetIdentity(
          f.b.environmentId,
          authority.fleetId,
          authority.rootPublicKey,
          false,
          { autoPickup: true, access: "standard" },
        );
        const peer = Authority.identityPeer(replacement, "Test beta", "https://beta.example.test");
        yield* writeFleetJson(
          f.path.join(f.root, "fleet-enrollment", `${peer.machineId}.json`),
          Authority.enrollmentRequest(replacement, peer),
        );
        yield* f.approve(peer.machineId, Authority.peerVerificationCode(peer)).pipe(Effect.flip);
        yield* f.a.enrollment.configure({
          operation: "revoke",
          confirmed: true,
          machineId: peer.machineId,
        });
        assert.equal(yield* f.b.enrollment.resolve, null);
        assert.deepEqual(f.issued, []);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "links both directions from one owner action and skips existing recipient identities without rotating credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const owner = yield* f.start();
        const pending = yield* f.join(owner.ownerCode!);
        yield* f.approve(f.b.record()!.machineId, pending.deviceCode!);
        yield* f.a.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [f.b.record()!.machineId],
        });
        yield* f.sync(f.a, [f.a.environmentId]);
        assert.equal(f.issued.length, 0);
        yield* f.sync(f.b, [f.b.environmentId]);
        assert.equal((yield* f.sync(f.a, [f.a.environmentId])).incoming.length, 1);
        assert.equal((yield* f.sync(f.b, [f.b.environmentId])).incoming.length, 1);
        yield* f.sync(f.a, [f.a.environmentId, f.b.environmentId]);
        yield* f.sync(f.b, [f.a.environmentId, f.b.environmentId]);
        yield* f.a.enrollment.configure({
          operation: "link",
          confirmed: true,
          machineIds: [f.b.record()!.machineId],
        });
        yield* f.sync(f.a, [f.a.environmentId, f.b.environmentId]);
        yield* f.sync(f.b, [f.a.environmentId, f.b.environmentId]);
        assert.equal(f.issued.length, 2);
        assert.equal(
          f.issued
            .find((grant) => grant.issuer === "alpha")
            ?.scopes.includes(AuthFilesystemWriteScope),
          false,
        );
        assert.deepEqual(
          f.issued.find((grant) => grant.issuer === "beta")?.scopes,
          AuthStandardClientScopes,
        );
      }).pipe(Effect.provide(configLayer)),
  );
});

it.layer(NodeServices.layer)("leaving the fleet and the starting list", (it) => {
  it.effect("a server relaunched with the fleet switched off no longer links", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, "accessible");
      yield* f.a.enrollment.configure({
        operation: "start",
        confirmed: true,
        origin: "https://alpha.example.test",
        autoPickup: true,
        access: "standard",
      });
      yield* f.join("");
      yield* f.a.enrollment.configure({
        operation: "access",
        confirmed: true,
        revision: 0,
        defaultAccess: "standard",
        machines: [{ machineId: f.b.record()!.machineId, access: "read-only" }],
      });
      assert.isTrue(FleetAccessPolicy.fleetLinksApply(yield* f.a.fleetAccess.current));

      // Sync and the fleet context return before reading enrollment, so startup must clear it.
      f.a.disableBootstrap();
      yield* f.a.restart;
      yield* f.a.links.backgroundSync;
      const state = yield* f.a.fleetAccess.current;
      assert.isFalse(FleetAccessPolicy.fleetLinksApply(state));
      // The accepted list still governs the credentials this machine issued.
      assert.equal(state.revision, 1);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect.each([false, true])(
    "adopts the starting list without a machine the roster disables (authority entry: %s)",
    (approved) =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin: "https://alpha.example.test",
          autoPickup: true,
          access: "standard",
        });
        yield* f.join("");
        const beta = f.b.record()!.machineId;
        if (approved)
          yield* f.a.enrollment.configure({
            operation: "approve",
            confirmed: true,
            machineId: beta,
            verificationCode: (yield* f.b.enrollment.status).deviceCode!,
          });
        yield* f.a.enrollment.resolve;
        const files = Effect.provideService(FileSystem.FileSystem, f.fs);
        const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(files);
        yield* writeFleetJson(f.rosterPath, {
          ...roster,
          machines: roster.machines.map((machine) =>
            machine.machineId === beta ? { ...machine, enabled: false } : machine,
          ),
        }).pipe(files);
        // The list still names the disabled machine, but never waits for its marker.
        yield* writeFleetJson(f.path.join(f.root, FleetAccessPolicy.SEED_FILE), {
          version: 1,
          fleetId: f.a.record()!.fleetId,
          defaultAccess: "standard",
          readOnly: [beta],
        }).pipe(files);
        yield* f.a.enrollment.resolve;
        assert.equal((yield* f.a.fleetAccess.current).revision, 1);
      }).pipe(Effect.provide(configLayer)),
  );
});
