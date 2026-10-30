import type { FleetUsersDirectory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOwnerFilterOptions,
  presentTaskOwner,
  resolveOwnerFilterId,
  resolveSelfOwnerId,
  selectedOwnerFilterOption,
  taskOwnerColorFromId,
} from "./taskOwners";

const DIRECTORY: FleetUsersDirectory = {
  users: [
    { id: "dan", name: "Dan", color: "sky" },
    { id: "gavin", name: "Gavin" },
  ],
  machineId: "anviltoad",
  defaultOwnerId: "gavin",
};

describe("presentTaskOwner", () => {
  it("uses a user's own colour, else one derived from the id, and shows unknown ids raw", () => {
    expect(presentTaskOwner(DIRECTORY, "dan")).toEqual({
      id: "dan",
      name: "Dan",
      initial: "D",
      color: "sky",
    });
    const gavin = presentTaskOwner(DIRECTORY, "gavin");
    expect(gavin.color).toBe(taskOwnerColorFromId("gavin"));
    expect(presentTaskOwner(null, "gavin").color).toBe(gavin.color);
    expect(presentTaskOwner(DIRECTORY, "zoe")).toMatchObject({ name: "zoe", initial: "Z" });
  });

  it("derives colours that differ between ids and never read as unowned gray", () => {
    const ids = ["dan", "gavin", "zoe", "sam", "alex", "kim", "lee", "max"];
    const colors = ids.map(taskOwnerColorFromId);
    expect(colors).not.toContain("gray");
    expect(new Set(colors).size).toBeGreaterThan(ids.length / 2);
  });
});

describe("owner filter", () => {
  it("resolves Mine through this device's choice, else the machine default", () => {
    expect(resolveSelfOwnerId("", DIRECTORY)).toBe("gavin");
    expect(resolveSelfOwnerId("dan", DIRECTORY)).toBe("dan");
    expect(resolveSelfOwnerId("", null)).toBeNull();
    const resolve = (filter: string, selfOwnerId: string | null, directory = DIRECTORY) =>
      resolveOwnerFilterId({ filter, selfOwnerId, directory });
    expect(resolve("all", "dan")).toBeNull();
    expect(resolve("mine", "dan")).toBe("dan");
    expect(resolve("user:gavin", "dan")).toBe("gavin");
    // Without a self, Mine keeps everything rather than nothing.
    expect(resolve("mine", null)).toBeNull();
    // A filter left from a fleet this device no longer sees hides nothing.
    expect(resolve("user:gavin", "dan", { ...DIRECTORY, users: [] })).toBeNull();
  });

  it("offers Mine, each other user and Everyone, and shows a named self as Mine", () => {
    expect(buildOwnerFilterOptions(DIRECTORY, "dan")).toEqual([
      { value: "mine", label: "Mine" },
      { value: "user:gavin", label: "Gavin's" },
      { value: "all", label: "Everyone" },
    ]);
    expect(buildOwnerFilterOptions(DIRECTORY, null).map((option) => option.value)).toEqual([
      "user:dan",
      "user:gavin",
      "all",
    ]);
    expect(buildOwnerFilterOptions(null, "dan")).toEqual([]);
    expect(selectedOwnerFilterOption("dan", "dan")).toBe("mine");
    expect(selectedOwnerFilterOption("gavin", "dan")).toBe("user:gavin");
    expect(selectedOwnerFilterOption(null, "dan")).toBe("all");
  });
});
