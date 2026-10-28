import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupThreadsByMachine, moveSidebarMachine, sortSidebarMachines } from "./machineGroups.ts";

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

describe("saved machine order", () => {
  const machines = [
    machine("local", "SP-DESK", true),
    machine("build", "BUILD-01"),
    machine("laptop", "JA-LAPTOP"),
    machine("vm", "RENDER-VM"),
  ];

  it("puts the device's saved order first and the rest in the default order", () => {
    const sorted = sortSidebarMachines(machines, ["laptop", "build"]);
    expect(sorted.map((entry) => entry.environmentId)).toEqual(["laptop", "build", "local", "vm"]);
  });

  it("ignores saved machines that no longer exist", () => {
    const sorted = sortSidebarMachines(machines, ["gone", "vm"]);
    expect(sorted.map((entry) => entry.environmentId)).toEqual(["vm", "local", "build", "laptop"]);
  });

  it("orders machine groups by the saved order", () => {
    const groups = groupThreadsByMachine(
      machines,
      [thread("t1", "local"), thread("t2", "vm")],
      () => false,
      ["vm"],
    );
    expect(groups.map((group) => group.machine.environmentId)).toEqual(["vm", "local"]);
  });
});

describe("moveSidebarMachine", () => {
  const order = ["local", "build", "laptop", "vm"];

  it("moves a machine one place up or down", () => {
    expect(moveSidebarMachine(order, order, "laptop", "up")).toEqual([
      "local",
      "laptop",
      "build",
      "vm",
    ]);
    expect(moveSidebarMachine(order, order, "local", "down")).toEqual([
      "build",
      "local",
      "laptop",
      "vm",
    ]);
  });

  it("moves a machine to the top or bottom", () => {
    expect(moveSidebarMachine(order, order, "vm", "top")).toEqual([
      "vm",
      "local",
      "build",
      "laptop",
    ]);
    expect(moveSidebarMachine(order, order, "local", "bottom")).toEqual([
      "build",
      "laptop",
      "vm",
      "local",
    ]);
  });

  it("steps past hidden machines, which keep their places", () => {
    // `build` has no threads on screen, so moving `laptop` up passes it.
    const visible = ["local", "laptop", "vm"];
    expect(moveSidebarMachine(order, visible, "laptop", "up")).toEqual([
      "laptop",
      "local",
      "build",
      "vm",
    ]);
    expect(moveSidebarMachine(order, visible, "local", "down")).toEqual([
      "build",
      "laptop",
      "local",
      "vm",
    ]);
  });

  it("leaves the order alone at either end or for an unknown machine", () => {
    expect(moveSidebarMachine(order, order, "local", "up")).toEqual(order);
    expect(moveSidebarMachine(order, order, "vm", "bottom")).toEqual(order);
    expect(moveSidebarMachine(order, order, "missing", "top")).toEqual(order);
  });
});
