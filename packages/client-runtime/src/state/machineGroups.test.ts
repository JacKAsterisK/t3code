import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupThreadsByMachine, sortSidebarMachines } from "./machineGroups.ts";

const machine = (id: string, label: string, isPrimary = false) => ({
  environmentId: EnvironmentId.make(id),
  label,
  isPrimary,
});
const thread = (id: string, environment: string) => ({
  id,
  environmentId: EnvironmentId.make(environment),
});

describe("sortSidebarMachines", () => {
  it("lists the primary machine first, then the rest by label", () => {
    const sorted = sortSidebarMachines([
      machine("c", "render-vm"),
      machine("a", "Build-10"),
      machine("b", "SP-DESK", true),
      machine("d", "build-2"),
    ]);
    expect(sorted.map((entry) => entry.label)).toEqual([
      "SP-DESK",
      "build-2",
      "Build-10",
      "render-vm",
    ]);
  });

  it("keeps machines with the same label in a stable order", () => {
    const sorted = sortSidebarMachines([machine("b", "Laptop"), machine("a", "Laptop")]);
    expect(sorted.map((entry) => entry.environmentId)).toEqual(["a", "b"]);
  });
});

describe("groupThreadsByMachine", () => {
  const machines = [machine("remote", "BUILD-01"), machine("local", "SP-DESK", true)];

  it("groups threads by machine and keeps each machine's thread order", () => {
    const groups = groupThreadsByMachine(machines, [
      thread("t1", "remote"),
      thread("t2", "local"),
      thread("t3", "remote"),
    ]);
    expect(
      groups.map((group) => [group.machine.label, group.threads.map((entry) => entry.id)]),
    ).toEqual([
      ["SP-DESK", ["t2"]],
      ["BUILD-01", ["t1", "t3"]],
    ]);
  });

  it("drops machines without threads unless the caller keeps them", () => {
    const threads = [thread("t1", "remote")];
    expect(groupThreadsByMachine(machines, threads).map((group) => group.machine.label)).toEqual([
      "BUILD-01",
    ]);
    expect(
      groupThreadsByMachine(machines, threads, (entry) => entry.isPrimary).map(
        (group) => group.machine.label,
      ),
    ).toEqual(["SP-DESK", "BUILD-01"]);
  });
});
