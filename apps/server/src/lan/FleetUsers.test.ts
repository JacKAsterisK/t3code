import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { FleetUsersDirectory } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as Config from "../config.ts";
import * as FleetUsers from "./FleetUsers.ts";

const DAN_MACHINE = "machine-319682d2fc67441f86be9b87";
const GAVIN_MACHINE = "machine-bf7ec7c77e1d602980833816";
const USERS_FILE = {
  version: 1,
  users: [
    { id: "dan", name: "Dan", color: "blue" },
    { id: "gavin", name: "Gavin", color: "green" },
  ],
  machineOwners: {
    "machine-bf7ec7c77e1d602980833816": "gavin",
    "machine-ea63af1a8a866ea2b6f84bff": "gavin",
    "machine-319682d2fc67441f86be9b87": "dan",
    "machine-4e3724fa9f1a63530f7fb465": "dan",
    "machine-53eed7cd926073000c15ddc1": "dan",
    "machine-d5d351798450e4044c3dfe2f": "dan",
  },
} as const;

const configLayer = Config.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fleet-users-config-",
});

// A temporary share holding the roster's directory, and machines with their own state directories.
const fixture = Effect.fn("FleetUsersTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* Config.ServerConfig;
  const share = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-users-share-" });
  const rosterPath = path.join(share, "roster.json");
  const usersFile = path.join(share, FleetUsers.FLEET_USERS_FILE);
  const machine = Effect.fn("FleetUsersTest.machine")(function* (
    existingStateDir?: string,
    fileSystem?: FileSystem.FileSystem,
  ) {
    const stateDir =
      existingStateDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-users-state-" }));
    const context = yield* Layer.build(
      FleetUsers.layer.pipe(
        Layer.provide(Config.layer({ ...base, stateDir })),
        Layer.provide(
          fileSystem === undefined ? Layer.empty : Layer.succeed(FileSystem.FileSystem)(fileSystem),
        ),
      ),
    );
    return { users: Context.get(context, FleetUsers.FleetUsers), stateDir };
  });
  return {
    fs,
    path,
    rosterPath,
    // The roster's directory does not exist: the share is away.
    unreachableRosterPath: path.join(share, "away", "roster.json"),
    usersFile,
    machine,
    writeUsers: (value: unknown) => fs.writeFileString(usersFile, JSON.stringify(value)),
  };
});

const danDirectory: FleetUsersDirectory = {
  users: USERS_FILE.users,
  machineId: DAN_MACHINE,
  defaultOwnerId: "dan",
};

it.layer(NodeServices.layer)("fleet users", (it) => {
  it.effect("reads the users and this machine's default owner, and caches them in userdata", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeUsers(USERS_FILE);
      const { users, stateDir } = yield* f.machine();
      assert.deepEqual(yield* users.current, FleetUsers.NO_FLEET_USERS);
      assert.deepEqual(
        yield* users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE }),
        danDirectory,
      );
      assert.deepEqual(yield* users.current, danDirectory);
      const cached = JSON.parse(
        yield* f.fs.readFileString(f.path.join(stateDir, "lan-fleet-users.json")),
      );
      assert.deepEqual(cached, { version: 1, machineId: DAN_MACHINE, file: USERS_FILE });

      // Another machine reading the same file gets its own default owner.
      const gavin = yield* f.machine();
      assert.strictEqual(
        (yield* gavin.users.refresh({ rosterPath: f.rosterPath, machineId: GAVIN_MACHINE }))
          .defaultOwnerId,
        "gavin",
      );
      // A machine the file does not name has the users but no default owner.
      const stranger = yield* f.machine();
      assert.deepEqual(
        yield* stranger.users.refresh({ rosterPath: f.rosterPath, machineId: "machine-unlisted" }),
        { users: USERS_FILE.users, machineId: "machine-unlisted", defaultOwnerId: null },
      );
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("keeps the last good copy while the share is away or its file is invalid", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeUsers(USERS_FILE);
      const { users } = yield* f.machine();
      const refresh = (rosterPath = f.rosterPath) =>
        users.refresh({ rosterPath, machineId: DAN_MACHINE });
      assert.deepEqual(yield* refresh(), danDirectory);

      assert.deepEqual(yield* refresh(f.unreachableRosterPath), danDirectory);

      const invalid: ReadonlyArray<[string, string]> = [
        ["bad JSON", "{not json"],
        [
          "a user named twice",
          JSON.stringify({
            ...USERS_FILE,
            users: [...USERS_FILE.users, { id: "dan", name: "Other Dan" }],
          }),
        ],
        [
          "a bad user id",
          JSON.stringify({ ...USERS_FILE, users: [{ id: "Dan Upper", name: "Dan" }] }),
        ],
        [
          "a bad owner id",
          JSON.stringify({ ...USERS_FILE, machineOwners: { [DAN_MACHINE]: "-dan" } }),
        ],
        [
          "a colour outside the theme",
          JSON.stringify({ ...USERS_FILE, users: [{ id: "dan", name: "Dan", color: "#00f" }] }),
        ],
        ["an unknown member", JSON.stringify({ ...USERS_FILE, extra: true })],
        [
          "a bad machine id",
          JSON.stringify({ ...USERS_FILE, machineOwners: { "Machine One": "gavin" } }),
        ],
      ];
      for (const [label, raw] of invalid) {
        yield* f.fs.writeFileString(f.usersFile, raw);
        assert.deepEqual(yield* refresh(), danDirectory, label);
      }

      // A valid change applies.
      yield* f.writeUsers({ ...USERS_FILE, machineOwners: { [DAN_MACHINE]: "gavin" } });
      assert.strictEqual((yield* refresh()).defaultOwnerId, "gavin");
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("clears the users when the share is reachable and has no users file", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeUsers(USERS_FILE);
      const { users, stateDir } = yield* f.machine();
      yield* users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE });
      yield* f.fs.remove(f.usersFile);
      const cleared = { users: [], machineId: DAN_MACHINE, defaultOwnerId: null };
      assert.deepEqual(
        yield* users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE }),
        cleared,
      );
      assert.deepEqual(yield* users.current, cleared);
      // Cleared stays cleared across a restart, and the share going away restores nothing.
      const restarted = yield* f.machine(stateDir);
      assert.deepEqual(yield* restarted.users.current, cleared);
      assert.deepEqual(
        yield* restarted.users.refresh({
          rosterPath: f.unreachableRosterPath,
          machineId: DAN_MACHINE,
        }),
        cleared,
      );
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("keeps the last good copy when checking for the users file fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeUsers(USERS_FILE);
      // The review's reproduction: the share is reachable, but checking for its users file fails
      // with an access error, not NotFound.
      let denied = false;
      const flaky = FileSystem.FileSystem.of({
        ...f.fs,
        exists: (requested) =>
          denied && requested === f.usersFile
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "access",
                  pathOrDescriptor: requested,
                }),
              )
            : f.fs.exists(requested),
      });
      const { users, stateDir } = yield* f.machine(undefined, flaky);
      const refresh = () => users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE });
      assert.deepEqual(yield* refresh(), danDirectory);
      denied = true;
      assert.deepEqual(yield* refresh(), danDirectory);
      assert.deepEqual(yield* users.current, danDirectory);
      // The saved copy is still the good one, so a restart keeps it too.
      const restarted = yield* f.machine(stateDir);
      assert.deepEqual(yield* restarted.users.current, danDirectory);
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("retries saving its cache after a failed save, so a restart has the newer copy", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeUsers(USERS_FILE);
      // The review's reproduction: the saved copy says Dan, the share changes, and one save fails.
      let failSaves = 0;
      const flaky = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) => {
          if (failSaves > 0 && to.endsWith("lan-fleet-users.json")) {
            failSaves -= 1;
            return Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: to,
              }),
            );
          }
          return f.fs.rename(from, to);
        },
      });
      const { users, stateDir } = yield* f.machine(undefined, flaky);
      const refresh = () => users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE });
      assert.deepEqual(yield* refresh(), danDirectory);
      const gavinOwnsDan = {
        ...USERS_FILE,
        machineOwners: { ...USERS_FILE.machineOwners, [DAN_MACHINE]: "gavin" },
      };
      yield* f.writeUsers(gavinOwnsDan);
      failSaves = 1;
      const gavinDirectory = { ...danDirectory, defaultOwnerId: "gavin" };
      assert.deepEqual(yield* refresh(), gavinDirectory);
      // The next identical refresh saves what the failed one could not.
      assert.deepEqual(yield* refresh(), gavinDirectory);
      const restarted = yield* f.machine(stateDir);
      assert.deepEqual(
        yield* restarted.users.refresh({
          rosterPath: f.unreachableRosterPath,
          machineId: DAN_MACHINE,
        }),
        gavinDirectory,
      );
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("starts from its cache after a restart, for the machine that wrote it only", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeUsers(USERS_FILE);
      const first = yield* f.machine();
      yield* first.users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE });

      // Before any read of the share, and while it is away.
      const restarted = yield* f.machine(first.stateDir);
      assert.deepEqual(yield* restarted.users.current, danDirectory);
      assert.deepEqual(
        yield* restarted.users.refresh({
          rosterPath: f.unreachableRosterPath,
          machineId: DAN_MACHINE,
        }),
        danDirectory,
      );

      // A different machine id never takes another machine's cached copy.
      const renamed = yield* f.machine(first.stateDir);
      assert.deepEqual(
        yield* renamed.users.refresh({
          rosterPath: f.unreachableRosterPath,
          machineId: GAVIN_MACHINE,
        }),
        { users: [], machineId: GAVIN_MACHINE, defaultOwnerId: null },
      );
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("ignores an unreadable cache and reads the share again", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const stateDir = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-fleet-users-state-" });
      yield* f.fs.writeFileString(f.path.join(stateDir, "lan-fleet-users.json"), "{broken");
      const { users } = yield* f.machine(stateDir);
      assert.deepEqual(yield* users.current, FleetUsers.NO_FLEET_USERS);
      yield* f.writeUsers(USERS_FILE);
      assert.deepEqual(
        yield* users.refresh({ rosterPath: f.rosterPath, machineId: DAN_MACHINE }),
        danDirectory,
      );
    }).pipe(Effect.provide(configLayer)),
  );
});

describe("fleet user names and inheritance", () => {
  it("names an owner by the users file, or by the raw id when it does not list them", () => {
    const directory = { users: USERS_FILE.users };
    assert.strictEqual(FleetUsers.ownerName(directory, "dan"), "Dan");
    assert.strictEqual(FleetUsers.ownerName(directory, "someone-else"), "someone-else");
    assert.strictEqual(FleetUsers.ownerName(directory, null), null);
    assert.strictEqual(FleetUsers.ownerName(directory, undefined), null);
    assert.strictEqual(FleetUsers.ownerName({ users: [] }, "dan"), "dan");
    assert.deepEqual(FleetUsers.threadOwnerFields(directory, "gavin"), {
      ownerId: "gavin",
      ownerName: "Gavin",
    });
    assert.deepEqual(FleetUsers.threadOwnerFields(directory, undefined), {
      ownerId: null,
      ownerName: null,
    });
  });

  it("gives a started thread the owner it names, else its parent's, else none", () => {
    assert.deepEqual(FleetUsers.inheritedOwner("gavin", "dan"), { ownerId: "gavin" });
    assert.deepEqual(FleetUsers.inheritedOwner(undefined, "dan"), { ownerId: "dan" });
    assert.deepEqual(FleetUsers.inheritedOwner(undefined, null), {});
    assert.deepEqual(FleetUsers.inheritedOwner(undefined, undefined), {});
  });

  it("refuses a users file that names one user twice", () => {
    assert.throws(() =>
      FleetUsers.validateFleetUsers({
        version: 1,
        users: [
          { id: "dan", name: "Dan" },
          { id: "dan", name: "Dan again" },
        ],
        machineOwners: {},
      }),
    );
  });
});
