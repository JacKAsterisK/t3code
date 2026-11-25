import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  FleetRoster,
  LanFleetError,
  AuthStandardClientScopes,
  AuthFilesystemWriteScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
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
import {
  approveFleetCredentialRecovery,
  fleetCredentialRecoveryCode,
  prepareFleetCredentialRecovery,
} from "./FleetCredentialRecovery.ts";
import * as LanFleet from "./LanFleet.ts";
import * as FleetUsers from "./FleetUsers.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import {
  FLEET_ROSTER_ENV,
  FLEET_SWITCH_ROSTER,
  WINDOWS_FLEET_SHARE_ROOT,
} from "./FleetBootstrap.ts";
import * as Delivery from "./FleetDelivery.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";
import { recoverFleetCredential } from "./fleetCredentialRecoveryEntry.ts";

const decodeVaultRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Authority.FleetVaultRecord),
);

vi.mock("./FleetVault.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./FleetVault.ts")>()),
  layer: Layer.empty,
}));
vi.mock("./FleetNetwork.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./FleetNetwork.ts")>()),
  layer: Layer.empty,
}));

// Only this in-memory vault and temporary synthetic shares are used; the OS vault is never constructed.
const fixture = Effect.fn("FleetEnrollmentTest.fixture")(function* (
  managedTls = false,
  share: false | "accessible" | "inaccessible" = false,
  platform: NodeJS.Platform = "win32",
  switchFleet = false,
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
  const unreadable = new Set<string>();
  const localPath = (file: string) =>
    share && (file === root || file.startsWith(root + "\\"))
      ? path.join(diskRoot, file.slice(root.length))
      : file;
  // The virtual UNC share is mapped entirely to a fresh temp directory. No real SMB path is touched.
  const fs = FileSystem.FileSystem.of({
    ...diskFs,
    exists: (file) => (absent.has(file) ? Effect.succeed(false) : diskFs.exists(localPath(file))),
    stat: (file) => diskFs.stat(localPath(file)),
    readFileString: (file, options) =>
      unreadable.has(file)
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readFileString",
              description: "simulated unreadable share file",
              pathOrDescriptor: file,
            }),
          )
        : diskFs.readFileString(localPath(file), options),
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
  const rosterPath = switchFleet ? FLEET_SWITCH_ROSTER : path.join(root, "roster.json");
  const authorityFile = path.join(path.dirname(rosterPath), "fleet-authority.json");
  const issued: Array<{ issuer: string; scopes: ReadonlyArray<AuthEnvironmentScope> }> = [];
  const create = Effect.fn("FleetEnrollmentTest.create")(function* (name: string) {
    const environmentId = EnvironmentId.make(`environment:${name}`);
    const stateDir = path.join(diskRoot, name);
    yield* fs.makeDirectory(stateDir);
    let record: Authority.FleetVaultRecord | undefined;
    let saves = 0;
    let beforeNextVaultRead: Effect.Effect<void, LanFleetError> | undefined;
    const activeLinks: Array<EnvironmentAuth.IssuedPairingLink> = [];
    const vault = FleetVault.FleetVault.of({
      read: Effect.gen(function* () {
        const observed = record;
        const before = beforeNextVaultRead;
        beforeNextVaultRead = undefined;
        if (before !== undefined) yield* before;
        return observed;
      }),
      advanceRevision: (_expected, revision) =>
        Effect.sync(() => {
          if (record === undefined || record.lastRevision >= revision) return;
          saves++;
          record = { ...record, lastRevision: revision };
        }),
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
    let portBusy = false;
    const networkLayer = Layer.succeed(FleetNetwork.FleetNetwork, {
      addresses: Effect.succeed([name === "alpha" ? "192.168.40.10" : "192.168.40.11"]),
      listen: (input) =>
        Effect.gen(function* () {
          if (portBusy) return yield* new LanFleetError({ reason: "transport" });
          starts++;
          return {
            httpBaseUrl: "https://" + input.listen.address + ":" + input.listen.port + "/",
            wsBaseUrl: "wss://synthetic-only/",
            close: () => {
              closes++;
              return Promise.resolve();
            },
          };
        }),
    });
    const transportLayer = managedTls
      ? FleetTransport.layerServices.pipe(
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(Config.layer(config)),
          Layer.provide(Layer.succeed(FleetVault.FleetVault, vault)),
          Layer.provide(networkLayer),
        )
      : Layer.empty;
    let productionEnrollment = false;
    let serverScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit));
    const build = Effect.fn("FleetEnrollmentTest.build")(
      function* () {
        const enrollmentServices = yield* Layer.build(
          (productionEnrollment
            ? FleetEnrollment.layer.pipe(Layer.provide(ManagedPolicy.layerTest()))
            : FleetEnrollment.layerServices
          ).pipe(
            Layer.provide(networkLayer),
            Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
            Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
            Layer.provide(
              Layer.succeed(HostProcess.Hostname, name === "alpha" ? "BUILDMACHINE" : "OTHER"),
            ),
            Layer.provide(productionEnrollment ? Layer.empty : transportLayer),
            Layer.provide(Config.layer(config)),
            Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
            Layer.provide(Layer.succeed(FleetVault.FleetVault, vault)),
            Layer.provide(
              Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
            ),
            Layer.provide(Layer.succeed(HostProcess.Environment, launchEnvironment)),
            Layer.provideMerge(
              FleetAccessPolicy.layerWithCredentialReader(vault.read).pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
                Layer.provide(Config.layer(config)),
              ),
            ),
          ),
        );
        const enrollment = Context.get(enrollmentServices, FleetEnrollment.FleetEnrollment);
        const fleetAccess = Context.get(enrollmentServices, FleetAccessPolicy.FleetAccess);
        const users = yield* FleetUsers.FleetUsers.pipe(
          Effect.provide(
            FleetUsers.layer.pipe(
              Layer.provide(Config.layer(config)),
              Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
            ),
          ),
        );
        const links = yield* LanFleet.LanFleet.pipe(
          Effect.provide(
            LanFleet.layerServices.pipe(
              Layer.provide(Layer.succeed(FleetUsers.FleetUsers, users)),
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
        return { enrollment, links, fleetAccess, users };
      },
      (effect) => Effect.provideService(effect, Scope.Scope, serverScope),
    );
    let services = yield* build();
    return {
      environmentId,
      stateDir,
      get enrollment() {
        return services.enrollment;
      },
      get links() {
        return services.links;
      },
      get users() {
        return services.users;
      },
      useProductionEnrollment: () => {
        productionEnrollment = true;
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
      pauseNextVaultRead: (before: Effect.Effect<void, LanFleetError>) => {
        beforeNextVaultRead = before;
      },
      replaceRecord: (next: Authority.FleetVaultRecord | undefined) => {
        record = next;
      },
      saves: () => saves,
      network: () => ({ starts, closes }),
      setPortBusy: (busy: boolean) => {
        portBusy = busy;
      },
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
    unreadable,
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
  it.effect(
    "refuses to start a fleet with a saved member credential before publishing a roster",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, "accessible");
        const oldMember = Authority.generateFleetIdentity(
          f.a.environmentId,
          "old-fleet",
          "old-owner",
          false,
          { autoPickup: true, access: "read-only" },
        );
        f.a.replaceRecord(oldMember);
        assert.equal((yield* f.start().pipe(Effect.flip)).refusal, "already-member");
        assert.equal(yield* f.fs.exists(f.rosterPath), false);
        assert.equal(yield* f.fs.exists(f.authorityFile), false);
        assert.deepEqual(f.a.record(), oldMember);
        assert.equal(f.a.saves(), 0);
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "founds the replacement fleet only on BuildMachine and enrolls the same environments",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, "accessible", "win32", true);
        const founding = {
          operation: "start",
          confirmed: true,
          origin: "https://192.168.40.10:4001",
          managedTls: true,
          autoPickup: true,
          access: "standard",
        } as const;
        yield* f.b.enrollment.configure(founding).pipe(Effect.flip);
        assert.equal(yield* f.fs.exists(f.rosterPath), false);
        assert.equal(f.b.saves(), 0);
        yield* f.a.enrollment.configure(founding);
        const authority = yield* readFleetJson(f.authorityFile, Authority.FleetAuthority).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        Authority.verifyAuthority(authority);
        assert.equal(authority.ownerEnvironmentId, f.a.environmentId);
        assert.equal(authority.revision, 1);
        yield* f.b.enrollment.configure({
          ...founding,
          operation: "join",
          origin: "https://192.168.40.11:4001",
          ownerCode: Authority.ownerVerificationCode(authority),
        });
        const member = yield* f.b.enrollment.resolve;
        assert.equal(member?.credentialScope, authority.fleetId);
        assert.equal(f.b.record()?.environmentId, f.b.environmentId);
        assert.equal((yield* f.b.enrollment.status).stage, "active");
        assert.equal((yield* f.a.enrollment.status).owner, true);
        assert.equal((yield* f.a.enrollment.status).tlsReady, true);
        assert.equal((yield* f.b.enrollment.status).tlsReady, true);
        // The old desktop still lists the owner as connected. The new fleet
        // requires a new credential and must explicitly offer a replacement.
        yield* f.sync(f.b, [f.b.environmentId, f.a.environmentId]);
        yield* f.sync(f.a, [f.a.environmentId]);
        const picked = yield* f.sync(f.b, [f.b.environmentId, f.a.environmentId]);
        assert.deepEqual(
          picked.incoming.map(
            ({ environmentId, replace, preserveManualConnection, pairingCode }) => ({
              environmentId,
              replace,
              preserveManualConnection,
              pairingCode,
            }),
          ),
          [
            {
              environmentId: f.a.environmentId,
              replace: true,
              preserveManualConnection: true,
              pairingCode: "synthetic-alpha-credential",
            },
          ],
        );
        assert.equal(
          yield* f.fs.exists(f.path.join(f.root, "T3CodeLAN", "fleet-roster.json")),
          false,
        );
      }).pipe(Effect.provide(configLayer)),
  );
  it.effect(
    "restores fleet sync and the owner directory when enrollment initializes before routes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, "accessible");
        yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin: "https://192.168.40.10:4001",
          managedTls: true,
          autoPickup: true,
          access: "standard",
        });
        const before = f.a.record()!;
        const previousSaves = f.a.saves();
        const users = [{ id: "dan", name: "Dan", color: "blue" as const }];
        yield* writeFleetJson(f.path.join(f.root, FleetUsers.FLEET_USERS_FILE), {
          version: 1,
          users,
          machineOwners: { [before.machineId]: "dan" },
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        f.a.useProductionEnrollment();
        yield* f.a.restart;
        yield* f.sync(f.a, [f.a.environmentId]);
        assert.equal((yield* f.a.enrollment.status).tlsReady, true);
        assert.deepEqual(yield* f.a.users.current, {
          users,
          machineId: before.machineId,
          defaultOwnerId: "dan",
        });
        assert.deepEqual(f.a.record(), before);
        assert.equal(f.a.saves(), previousSaves);
        assert.deepEqual(f.a.network(), { starts: 2, closes: 1 });
      }).pipe(Effect.provide(configLayer)),
  );

  it.effect("names why joining is refused, not only that setup failed", () =>
    Effect.gen(function* () {
      // Without shared-folder trust, joining needs the owner code.
      const f = yield* fixture(false, "inaccessible");
      const owner = yield* f.start();
      const wrongCode = yield* f.join("0".repeat(12)).pipe(Effect.flip);
      assert.equal(wrongCode.refusal, "owner-code-mismatch");
      const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
        Effect.provideService(FileSystem.FileSystem, f.fs),
      );
      const withRow = (row: { readonly enabled: boolean; readonly origin: string }) =>
        writeFleetJson(f.rosterPath, {
          ...roster,
          machines: [
            ...roster.machines,
            {
              machineId: "machine-beta-row",
              environmentId: f.b.environmentId,
              label: "beta",
              ...row,
            },
          ],
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
      // SPDevMachine's case: a disabled row for this machine left in the roster.
      yield* withRow({ enabled: false, origin: "https://beta.example.test" });
      const disabled = yield* f.join(owner.ownerCode!).pipe(Effect.flip);
      assert.equal(disabled.refusal, "roster-row-disabled");
      assert.match(disabled.message, /disabled row for this machine/);
      yield* withRow({ enabled: true, origin: "https://elsewhere.example.test" });
      assert.equal(
        (yield* f.join(owner.ownerCode!).pipe(Effect.flip)).refusal,
        "roster-origin-mismatch",
      );
      assert.equal(f.b.record(), undefined);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("never recreates revision one over an established fleet owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, "accessible");
      yield* f.start();
      const initial = yield* readFleetJson(f.authorityFile, Authority.FleetAuthority).pipe(
        Effect.provideService(FileSystem.FileSystem, f.fs),
      );
      assert.equal(initial.revision, 1);
      Authority.verifyAuthority(initial, f.a.record());
      f.a.replaceRecord({ ...f.a.record()!, lastRevision: 2 });
      yield* f.fs.remove(f.authorityFile);
      const beforeSaves = f.a.saves();
      const refusal = yield* f.start().pipe(Effect.flip);
      assert.equal(refusal.reason, "configuration");
      assert.equal(refusal.refusal, "owner-authority-missing");
      assert.isFalse(yield* f.fs.exists(f.authorityFile));
      assert.equal(f.a.record()?.lastRevision, 2);
      assert.equal(f.a.saves(), beforeSaves);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("does not replace an enrolled identity when its vault is temporarily missing", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, "accessible");
      yield* f.start();
      const originalAuthority = yield* f.fs.readFileString(f.authorityFile);
      assert.isUndefined((yield* f.a.enrollment.status).credentialUnavailable);
      const retained = f.a.record();
      const readError = new LanFleetError({ reason: "configuration" });
      f.a.pauseNextVaultRead(Effect.fail(readError));
      assert.isTrue((yield* f.a.enrollment.status).credentialUnavailable);
      assert.deepEqual(f.a.record(), retained);
      f.a.replaceRecord(undefined);
      assert.isTrue((yield* f.a.enrollment.status).credentialUnavailable);
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

  it.effect("replaces only the matching approved fleet credential through the stopped helper", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true, "accessible");
      const initial = yield* f.a.enrollment.configure({
        operation: "start",
        confirmed: true,
        origin: "https://192.168.40.10:4001",
        managedTls: true,
        autoPickup: true,
        access: "read-only",
      });
      yield* f.b.enrollment.configure({
        operation: "join",
        confirmed: true,
        origin: "https://192.168.40.11:4001",
        ownerCode: initial.ownerCode!,
        managedTls: true,
        autoPickup: true,
        access: "read-only",
      });
      yield* f.a.enrollment.resolve;
      yield* f.b.enrollment.resolve;

      const owner = f.a.record()!;
      const predecessor = f.b.record()!;
      const copyHome = Effect.fn("FleetRecoveryTest.copyHome")(function* (stateDir: string) {
        const root = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-recovery-home-" });
        const state = f.path.join(root, "userdata");
        yield* f.fs.makeDirectory(state);
        yield* f.fs.copyFile(
          f.path.join(stateDir, "lan-fleet-members.json"),
          f.path.join(state, "lan-fleet-members.json"),
        );
        return root;
      });
      const ownerHome = yield* copyHome(f.a.stateDir);
      const targetHome = yield* copyHome(f.b.stateDir);
      const values = new Map<string, Uint8Array>();
      class InMemoryVault {
        readonly target: string;
        constructor(service: string, account: string) {
          this.target = service + ":" + account;
        }
        getSecret() {
          return values.get(this.target) ?? null;
        }
        getPassword() {
          return null;
        }
        setSecret(bytes: Uint8Array) {
          values.set(this.target, bytes.slice());
        }
        deleteCredential() {
          values.delete(this.target);
        }
      }
      const ownerKey = "T3 Code LAN fleet:" + f.a.environmentId;
      const targetKey = "T3 Code LAN fleet:" + f.b.environmentId;
      const ownerBytes = new TextEncoder().encode("T3F1:" + JSON.stringify(owner));
      values.set(ownerKey, ownerBytes);
      const run = (
        root: string,
        environmentId: EnvironmentId,
        credentialState: "missing" | "present",
        comparisonCode?: string,
      ) =>
        recoverFleetCredential(
          {
            schemaVersion: 1,
            operation: "fleet-credential-recovery",
            nonce: "a".repeat(64),
            homeDirectory: root,
            environmentId,
            journalPath: f.path.join(root, "activation.json"),
            rosterPath: f.rosterPath,
            credentialState,
            ...(comparisonCode === undefined ? {} : { comparisonCode }),
          },
          () => InMemoryVault,
        ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
      const readAuthority = readFleetJson(f.authorityFile, Authority.FleetAuthority).pipe(
        Effect.provideService(FileSystem.FileSystem, f.fs),
      );
      const before = yield* readAuthority;
      const prepared = yield* run(targetHome, f.b.environmentId, "missing");
      assert.equal(prepared.status, "awaiting-approval");
      const code = prepared.comparisonCode!;
      assert.isFalse(values.has(targetKey));
      assert.deepEqual(yield* readAuthority, before);
      assert.deepEqual(yield* run(targetHome, f.b.environmentId, "missing"), prepared);

      const approved = yield* run(ownerHome, f.a.environmentId, "present", code);
      assert.equal(approved.status, "approved");
      const current = yield* readAuthority;
      assert.equal(current.revision, before.revision + 1);
      assert.strictEqual(values.get(ownerKey), ownerBytes);
      assert.isFalse(values.has(targetKey));
      const installed = yield* run(targetHome, f.b.environmentId, "missing");
      assert.equal(installed.status, "installed");
      const saved = values.get(targetKey)!;
      assert.isDefined(saved);
      assert.deepEqual(yield* run(targetHome, f.b.environmentId, "present"), installed);
      assert.strictEqual(values.get(targetKey), saved);
      assert.deepEqual(yield* run(ownerHome, f.a.environmentId, "present", code), approved);
      assert.deepEqual(yield* readAuthority, current);
      const record = yield* decodeVaultRecord(
        new TextDecoder().decode(saved).slice("T3F1:".length),
      );
      assert.equal(record.machineId, predecessor.machineId);
      assert.equal(record.access, "read-only");
      assert.notEqual(record.signingPrivateKey, predecessor.signingPrivateKey);
      assert.equal(
        current.credentialKeyDigests?.[record.machineId],
        Authority.fleetSigningKeyDigest(
          Authority.identityPeer(record, "test", "https://192.168.40.11:4001").signingPublicKey,
        ),
      );
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect(
    "keeps the owner-approved member keys when a prior enrollment remains on the share",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, "accessible");
        const initial = yield* f.a.enrollment.configure({
          operation: "start",
          confirmed: true,
          origin: "https://192.168.40.10:4001",
          managedTls: true,
          autoPickup: true,
          access: "read-only",
        });
        const origin = "https://192.168.40.11:4001";
        const enrolled = yield* f.b.enrollment.configure({
          operation: "join",
          confirmed: true,
          origin,
          ownerCode: initial.ownerCode!,
          managedTls: true,
          autoPickup: true,
          access: "read-only",
        });
        yield* f.sync(f.b, [f.b.environmentId]);
        yield* f.sync(f.a, [f.a.environmentId]);
        const previousDelivery = (yield* f.sync(f.b, [f.b.environmentId])).incoming.find(
          (delivery) => delivery.environmentId === f.a.environmentId,
        );
        assert.isDefined(previousDelivery);
        const owner = f.a.record()!;
        const prior = f.b.record()!;
        const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        const row = roster.machines.find((machine) => machine.machineId === prior.machineId)!;
        const oldPeer = Authority.identityPeer(prior, row.label, row.origin);
        assert.equal(enrolled.deviceCode, Authority.peerVerificationCode(oldPeer));

        const updated = Authority.generateFleetIdentity(
          prior.environmentId,
          prior.fleetId,
          prior.rootPublicKey,
          false,
          { autoPickup: prior.autoPickup, access: prior.access },
          prior.machineId,
        );
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const authority = yield* readFleetJson(f.authorityFile, Authority.FleetAuthority).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        const review = {
          authority,
          predecessor: oldPeer,
          accessCeiling: prior.access,
          accessPolicyDigest: "e".repeat(64),
          now,
        };
        const candidate = {
          ...updated,
          tls: { origin, ...createFleetTlsCertificate({ address: "192.168.40.11", now }) },
          tlsEnabled: true,
        };
        const request = prepareFleetCredentialRecovery(
          "f0ddb5dc-6531-4d9f-8dc8-f1c5d2db01ab",
          candidate,
          review,
        );
        const code = fleetCredentialRecoveryCode(request);
        assert.throws(() => approveFleetCredentialRecovery(request, code, prior, review));
        assert.throws(() =>
          approveFleetCredentialRecovery(request, code, owner, {
            ...review,
            accessCeiling: "standard",
          }),
        );
        assert.throws(() =>
          approveFleetCredentialRecovery(request, code, owner, {
            ...review,
            now: request.expiresAt,
          }),
        );
        const approved = approveFleetCredentialRecovery(request, code, owner, review);
        yield* writeFleetJson(f.authorityFile, approved).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        const updatedPeer = request.enrollment.peer;
        // The BuildShare enrollment still contains the old keys when a peer reloads.
        const resolved = yield* f.a.enrollment.resolve;
        assert.deepEqual(
          resolved?.peers.find((peer) => peer.environmentId === prior.environmentId),
          updatedPeer,
        );
        assert.isNull(yield* f.b.enrollment.resolve);
        f.b.replaceRecord({ ...candidate, lastRevision: approved.revision });
        yield* f.b.restart;
        const ownerPeer = authority.peers.find((peer) => peer.machineId === owner.machineId)!;
        const previousIssuer = Authority.generateFleetIdentity(
          owner.environmentId,
          owner.fleetId,
          owner.rootPublicKey,
          false,
          { autoPickup: true, access: owner.access },
          owner.machineId,
        );
        const previousIssuerPeer = Authority.identityPeer(
          previousIssuer,
          ownerPeer.label,
          ownerPeer.origin,
        );
        const deliveries = f.path.join(f.root, "fleet-deliveries");
        const offerPath = f.path.join(
          deliveries,
          Delivery.deliveryFileName(owner.machineId, prior.machineId) + ".json",
        );
        const previousOffer = yield* readFleetJson(offerPath, Delivery.Delivery).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        const catalogFor = (peer: Delivery.FleetPeer) =>
          readFleetJson(
            f.path.join(
              deliveries,
              Delivery.deliveryFileName(peer.machineId, peer.machineId) + ".catalog.json",
            ),
            Delivery.FleetCatalog,
          ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        f.unreadable.add(offerPath);
        const issuerSync = yield* f.sync(f.a, [f.a.environmentId]);
        assert.equal(
          issuerSync.machines.find((machine) => machine.machineId === prior.machineId)?.status,
          "uncertain",
        );
        const recipientSync = yield* f.sync(f.b, [f.b.environmentId]);
        assert.equal(
          recipientSync.machines.find((machine) => machine.machineId === owner.machineId)?.status,
          "uncertain",
        );
        assert.isTrue(Delivery.verifyFleetCatalog(yield* catalogFor(ownerPeer), ownerPeer, now));
        assert.isTrue(
          Delivery.verifyFleetCatalog(yield* catalogFor(updatedPeer), updatedPeer, now),
        );
        f.unreadable.delete(offerPath);
        assert.deepEqual(
          yield* readFleetJson(offerPath, Delivery.Delivery).pipe(
            Effect.provideService(FileSystem.FileSystem, f.fs),
          ),
          previousOffer,
        );
        const olderSignedOffer = Delivery.sealDelivery({
          config: { ...previousIssuer, peers: [previousIssuerPeer, oldPeer] },
          sender: previousIssuerPeer,
          recipient: oldPeer,
          deliveryId: previousOffer.header.deliveryId,
          expiresAt: previousOffer.header.expiresAt,
          credential: "synthetic-retired-offer",
        });
        assert.isFalse(Delivery.verifyDelivery(olderSignedOffer, ownerPeer, oldPeer, now));
        yield* writeFleetJson(offerPath, {
          ...olderSignedOffer,
          header: { ...olderSignedOffer.header, senderId: "unrelated" },
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        const uncertain = yield* f.sync(f.a, [f.a.environmentId]);
        assert.equal(
          uncertain.machines.find((machine) => machine.machineId === prior.machineId)?.status,
          "uncertain",
        );
        assert.isTrue(yield* f.fs.exists(offerPath));
        yield* writeFleetJson(offerPath, olderSignedOffer).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* f.sync(f.a, [f.a.environmentId]);
        assert.isTrue(
          yield* f.fs.exists(offerPath + ".obsolete-" + previousOffer.header.deliveryId),
        );
        const renewed = (yield* f.sync(f.b, [f.b.environmentId])).incoming.find(
          (delivery) => delivery.environmentId === f.a.environmentId,
        );
        assert.isDefined(renewed);
        assert.notEqual(renewed?.deliveryId, previousDelivery?.deliveryId);

        for (const [index, invalidBytes] of ['{"header":', '{"header":null}'].entries()) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const output = yield* f.fs.open(offerPath, { flag: "w" });
              yield* output.writeAll(new TextEncoder().encode(invalidBytes));
            }),
          );
          yield* f.sync(f.a, [f.a.environmentId]);
          const quarantined = (yield* f.fs.readDirectory(deliveries)).filter((file) =>
            file.startsWith(f.path.basename(offerPath) + ".invalid-"),
          );
          assert.lengthOf(quarantined, index + 1);
          assert.include(
            yield* Effect.forEach(quarantined, (file) =>
              f.fs.readFileString(f.path.join(deliveries, file)),
            ),
            invalidBytes,
          );
          const replacement = yield* readFleetJson(offerPath, Delivery.Delivery).pipe(
            Effect.provideService(FileSystem.FileSystem, f.fs),
          );
          assert.notEqual(replacement.header.deliveryId, renewed!.deliveryId);
          assert.isTrue(Delivery.verifyDelivery(replacement, ownerPeer, updatedPeer, now));
        }

        yield* f.a.enrollment.configure({
          operation: "revoke",
          confirmed: true,
          machineId: prior.machineId,
        });
        const revoked = yield* f.fs.readFileString(f.authorityFile);
        const refused = yield* f
          .approve(prior.machineId, Authority.peerVerificationCode(oldPeer))
          .pipe(Effect.flip);
        assert.equal(refused.reason, "configuration");
        assert.equal(yield* f.fs.readFileString(f.authorityFile), revoked);
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
        assert.equal((yield* f.b.enrollment.resolve)?.fleetId, raw.fleetId);
        assert.equal(yield* f.b.enrollment.savedFleetId, raw.fleetId);
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
        f.a.setPortBusy(true);
        yield* f.a.restart;
        yield* f.b.restart;
        assert.equal((yield* f.a.enrollment.status).tlsReady, false);
        f.a.setPortBusy(false);
        const beforeDisable = f.a.network();
        f.setAbsent(f.rosterPath, true);
        assert.equal((yield* f.a.enrollment.resolve.pipe(Effect.flip)).reason, "unavailable");
        assert.deepEqual(f.a.network(), beforeDisable);
        f.setAbsent(f.rosterPath, false);
        const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* writeFleetJson(f.rosterPath, {
          ...roster,
          machines: roster.machines.map((machine) =>
            machine.machineId === beforeA.machineId ? { ...machine, enabled: false } : machine,
          ),
        }).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
        assert.equal(yield* f.a.enrollment.resolve, null);
        assert.deepEqual(f.a.network(), beforeDisable);
        yield* writeFleetJson(f.rosterPath, roster).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        yield* f.sync(f.a, [f.a.environmentId, f.b.environmentId]);
        yield* f.sync(f.b, [f.a.environmentId, f.b.environmentId]);
        assert.equal((yield* f.a.enrollment.status).tlsReady, true);
        assert.deepEqual(f.a.record()!.tls, beforeA.tls);
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
  it.effect("keeps a confirmed Stop when a shared-folder repair read older consent", () =>
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
      const saved = f.a.record()!;
      const { tls: _tls, ...oldPublicRecord } = saved;
      const oldPeer = Authority.identityPeer(oldPublicRecord, "Test alpha", origin);
      yield* f.fs.makeDirectory(f.path.join(f.root, "fleet-enrollment"), { recursive: true });
      const enrollmentFile = f.path.join(f.root, "fleet-enrollment", saved.machineId + ".json");
      yield* writeFleetJson(
        enrollmentFile,
        Authority.enrollmentRequest(oldPublicRecord, oldPeer),
      ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs));
      const originalEnrollment = yield* f.fs.readFileString(enrollmentFile);
      f.a.setPortBusy(true);
      yield* f.a.restart;
      f.a.setPortBusy(false);
      const read = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      f.a.pauseNextVaultRead(
        Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      );
      const repair = yield* f.a.enrollment.resolve.pipe(Effect.forkScoped);
      yield* Deferred.await(read);
      yield* f.a.enrollment.configure({ operation: "transport", confirmed: true, enabled: false });
      const afterStop = f.a.network();
      yield* Deferred.succeed(resume, undefined);
      assert.isNull(yield* Fiber.join(repair));
      yield* f.a.restart;
      assert.deepEqual(f.a.network(), afterStop);
      assert.deepEqual(f.a.record()?.tls, saved.tls);
      assert.isFalse(f.a.record()?.tlsEnabled);
      assert.equal(yield* f.fs.readFileString(enrollmentFile), originalEnrollment);
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
        const authority = yield* readFleetJson(f.authorityFile, Authority.FleetAuthority).pipe(
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
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

  it.effect("re-arms an acknowledged delivery through the Link both ways action", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const owner = yield* f.start();
      const pending = yield* f.join(owner.ownerCode!);
      const machineId = f.b.record()!.machineId;
      yield* f.approve(machineId, pending.deviceCode!);
      const ownerSync = (
        connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
        completedDeliveryIds: ReadonlyArray<string> = [],
      ) =>
        f.a.links.sync({
          mode: "manual",
          sendMachineIds: [],
          connectedEnvironmentIds,
          completedDeliveryIds,
        });
      const linkBothWays = Effect.fn("FleetEnrollmentTest.linkBothWays")(function* (
        saved: ReadonlyArray<EnvironmentId>,
        completed: ReadonlyArray<string> = [],
      ) {
        yield* f.a.links.configure({ operation: "link", confirmed: true, machineIds: [machineId] });
        return yield* ownerSync(saved, completed);
      });
      const recipientSync = (
        connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
        completedDeliveryIds: ReadonlyArray<string> = [],
      ) =>
        f.b.links.sync({
          mode: "automatic",
          sendMachineIds: [],
          connectedEnvironmentIds,
          completedDeliveryIds,
        });
      yield* recipientSync([]);
      const firstOwner = yield* linkBothWays([]);
      const first = (yield* recipientSync([])).incoming[0]!;
      const reciprocal = firstOwner.incoming[0] ?? (yield* ownerSync([])).incoming[0]!;
      yield* ownerSync([f.b.environmentId], [reciprocal.deliveryId]);
      yield* recipientSync([f.a.environmentId], [first.deliveryId]);
      assert.equal(
        (yield* ownerSync([f.b.environmentId], [reciprocal.deliveryId])).machines[1]?.status,
        "connected",
      );

      yield* recipientSync([]);
      yield* TestClock.adjust("1 second");
      assert.equal(
        (yield* ownerSync([f.b.environmentId], [reciprocal.deliveryId])).machines[1]?.status,
        "connected",
      );
      assert.equal(
        (yield* linkBothWays([f.b.environmentId], [reciprocal.deliveryId])).machines[1]?.status,
        "pending",
      );
      const resent = (yield* recipientSync([])).incoming[0];
      assert.isDefined(resent);
      assert.notEqual(resent.deliveryId, first.deliveryId);
      assert.deepEqual(f.issued.map(({ issuer }) => issuer).sort(), ["alpha", "alpha", "beta"]);
      assert.equal(
        (yield* ownerSync([f.b.environmentId], [reciprocal.deliveryId])).machines[1]?.status,
        "pending",
      );
      yield* recipientSync([f.a.environmentId], [resent.deliveryId]);
      assert.equal(
        (yield* ownerSync([f.b.environmentId], [reciprocal.deliveryId])).machines[1]?.status,
        "connected",
      );
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

  it.effect.each([false, true])(
    "never enrolls a new machine whose ID could read as an access-list exception (shared folder: %s)",
    (shared) =>
      Effect.gen(function* () {
        const f = yield* fixture(false, shared ? "accessible" : false);
        yield* f.start();
        const owner = f.a.record()!;
        // A request as a machine on another build could write: its own keys, a chosen ID.
        const request = Effect.fn("FleetEnrollmentTest.request")(
          function* (name: string, machineId: string) {
            const record = Authority.generateFleetIdentity(
              EnvironmentId.make(`environment:${name}`),
              owner.fleetId,
              owner.rootPublicKey,
              false,
              { autoPickup: true, access: "standard" },
              machineId,
            );
            const peer = Authority.identityPeer(
              record,
              `Test ${name}`,
              `https://${name}.example.test`,
            );
            const { encryptionPublicKey: _e, signingPublicKey: _s, tls: _tls, ...metadata } = peer;
            const roster = yield* readFleetJson(f.rosterPath, FleetRoster).pipe(
              Effect.provideService(FileSystem.FileSystem, f.fs),
            );
            yield* writeFleetJson(f.rosterPath, {
              ...roster,
              machines: [...roster.machines, metadata],
            });
            yield* f.fs.makeDirectory(f.path.join(f.root, "fleet-enrollment"), { recursive: true });
            yield* writeFleetJson(
              f.path.join(f.root, "fleet-enrollment", `${machineId}.json`),
              Authority.enrollmentRequest(record, peer),
            );
            return Authority.peerVerificationCode(peer);
          },
          Effect.provideService(FileSystem.FileSystem, f.fs),
        );
        const reserved = FleetAccessPolicy.pairEntryId("anviltoad", "spdevmachine");
        const reservedCode = yield* request("odd", reserved);
        const ordinaryCode = yield* request("plain", "plain-machine");
        if (shared) {
          const enabled = ((yield* f.a.enrollment.resolve)?.peers ?? []).map(
            (peer) => peer.machineId,
          );
          assert.include(enabled, "plain-machine");
          assert.notInclude(enabled, reserved);
        } else {
          const refused = yield* f.approve(reserved, reservedCode).pipe(Effect.flip);
          assert.equal(refused.reason, "configuration");
          yield* f.approve("plain-machine", ordinaryCode);
          const approved = (yield* f.a.enrollment.status).peers
            .filter((peer) => peer.status === "approved")
            .map((peer) => peer.machineId);
          assert.include(approved, "plain-machine");
          assert.notInclude(approved, reserved);
        }
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
