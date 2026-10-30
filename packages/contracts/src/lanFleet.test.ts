import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { FleetUsersFile } from "./lanFleet.ts";

const decodeUsersFile = Schema.decodeUnknownSync(FleetUsersFile);

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
};

describe("fleet users file", () => {
  it("decodes the fleet's users file, a user without a colour among them", () => {
    expect(decodeUsersFile(USERS_FILE)).toEqual(USERS_FILE);
    const plain = { version: 1, users: [{ id: "dan", name: "Dan" }], machineOwners: {} };
    expect(decodeUsersFile(plain)).toEqual(plain);
  });

  it.each([
    ["an upper-case user id", { users: [{ id: "Dan", name: "Dan" }] }],
    ["a user id with a space", { users: [{ id: "dan smith", name: "Dan" }] }],
    ["a user id starting with a dash", { users: [{ id: "-dan", name: "Dan" }] }],
    ["a user id over 32 characters", { users: [{ id: "d".repeat(33), name: "Dan" }] }],
    ["an empty name", { users: [{ id: "dan", name: "  " }] }],
    ["a colour outside the theme", { users: [{ id: "dan", name: "Dan", color: "#0000ff" }] }],
    ["a colour name the theme lacks", { users: [{ id: "dan", name: "Dan", color: "chartreuse" }] }],
    ["a bad owner id", { machineOwners: { "machine-319682d2fc67441f86be9b87": "Dan" } }],
    ["another version", { version: 2 }],
  ])("rejects %s", (_label, change) => {
    expect(() => decodeUsersFile({ ...USERS_FILE, ...change })).toThrow();
  });
});
