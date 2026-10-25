import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
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
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as Config from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import * as FleetVault from "./FleetVault.ts";
import * as Authority from "./FleetAuthority.ts";
import * as LanFleet from "./LanFleet.ts";
import { FLEET_ROSTER_ENV } from "./FleetBootstrap.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";

// Only this in-memory vault and temporary synthetic shares are used; the OS vault is never constructed.
const fixture = Effect.fn("FleetEnrollmentTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* Config.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-enrollment-synthetic-" });
  const rosterPath = path.join(root, "roster.json");
  const authorityFile = path.join(root, "fleet-authority.json");
  const issued: Array<{ issuer: string; scopes: ReadonlyArray<AuthEnvironmentScope> }> = [];
  const create = Effect.fn("FleetEnrollmentTest.create")(function* (name: string) {
    const environmentId = EnvironmentId.make(`environment:${name}`);
    const stateDir = path.join(root, name);
    yield* fs.makeDirectory(stateDir);
    let record: Authority.FleetVaultRecord | undefined;
    let saves = 0;
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
    const config = { ...base, stateDir };
    const enrollment = yield* FleetEnrollment.FleetEnrollment.pipe(
      Effect.provide(
        FleetEnrollment.layerServices.pipe(
          Layer.provide(Config.layer(config)),
          Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
          Layer.provide(Layer.succeed(FleetVault.FleetVault, vault)),
          Layer.provide(
            Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
          ),
          Layer.provide(Layer.succeed(HostProcess.Environment, { [FLEET_ROSTER_ENV]: rosterPath })),
        ),
      ),
    );
    const links = yield* LanFleet.LanFleet.pipe(
      Effect.provide(
        LanFleet.layerServices.pipe(
          Layer.provide(Config.layer(config)),
          Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
          Layer.provide(Layer.succeed(FleetEnrollment.FleetEnrollment, enrollment)),
          Layer.provide(Layer.succeed(HostProcess.Environment, { [FLEET_ROSTER_ENV]: rosterPath })),
          Layer.provide(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              createPairingLink: (input) =>
                Effect.sync(() => {
                  issued.push({ issuer: name, scopes: input?.scopes ?? AuthStandardClientScopes });
                  return {
                    id: `synthetic-${issued.length}`,
                    credential: `synthetic-${name}-credential`,
                    subject: "synthetic",
                    scopes: input?.scopes ?? AuthStandardClientScopes,
                    createdAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(86_400_000),
                  };
                }),
            }),
          ),
        ),
      ),
    );
    return { environmentId, enrollment, links, record: () => record, saves: () => saves };
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
  return { a, b, root, rosterPath, authorityFile, start, join, approve, sync, fs, path, issued };
});
const configLayer = Config.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fleet-enrollment-config-",
});

it.layer(NodeServices.layer)("explicit fleet setup", (it) => {
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
