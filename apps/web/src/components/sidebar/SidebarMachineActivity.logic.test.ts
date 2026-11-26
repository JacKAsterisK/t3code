import { groupThreadsByMachine } from "@t3tools/client-runtime/state/machine-groups";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { groupMachineActivity, hasMachineActivityInScope } from "./SidebarMachineActivity.logic";

it("counts delegated children on the executing machine before sidebar filters", () => {
  const cryo = EnvironmentId.make("cryo");
  const build = EnvironmentId.make("build");
  const id = ThreadId.make("same-thread-id");
  const parentId = ThreadId.make("cryo-parent");
  const parent = makeThreadFixture({ environmentId: cryo, id: parentId });
  const base = makeThreadFixture({ environmentId: build, id, title: "Build delegate" });
  const remote = {
    ...base,
    delegatedFrom: { environmentId: cryo, threadId: parentId, title: parent.title },
    source: { ...base.source, status: "queued" as const, activityRunStatus: "waiting" as const },
  };
  const child = makeThreadFixture({
    environmentId: cryo,
    id,
    title: "Local delegate",
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
  });
  const local = {
    ...child,
    source: {
      ...child.source,
      latestRunId: RunId.make("live"),
      activityRunStatus: "running" as const,
    },
  };
  const idle = makeThreadFixture({ environmentId: build });
  const shells = [parent, remote, remote, local, idle];
  expect(filterSidebarV2VisibleThreads(shells, null, new Set())).toEqual([parent, idle]);
  const activity = groupMachineActivity(shells);
  expect(activity.get(build)).toEqual([
    {
      threadId: id,
      projectId: remote.projectId,
      title: "Build delegate",
      status: "waiting",
      startedAt: null,
    },
  ]);
  expect(activity.get(cryo)).toEqual([
    {
      threadId: id,
      projectId: local.projectId,
      title: "Local delegate",
      status: "running",
      startedAt: null,
    },
  ]);
});

it("keeps a hidden active child in the selected project without showing unrelated machines", () => {
  const cryo = EnvironmentId.make("cryo");
  const build = EnvironmentId.make("build");
  const portal = ProjectId.make("portal");
  const other = ProjectId.make("other");
  const parent = makeThreadFixture({ environmentId: cryo, projectId: portal });
  const local = makeThreadFixture({
    environmentId: cryo,
    projectId: portal,
    id: ThreadId.make("delegated-local"),
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
    },
  });
  const unrelated = makeThreadFixture({
    environmentId: build,
    projectId: other,
    id: ThreadId.make("unrelated"),
  });
  const shells = [local, unrelated].map((shell) => ({
    ...shell,
    source: { ...shell.source, activityRunStatus: "running" as const },
  }));
  const projects = new Set(["cryo:portal"]);
  const visible = filterSidebarV2VisibleThreads(shells, projects, new Set());
  expect(visible).toEqual([]);
  const activity = groupMachineActivity(shells);
  const groups = groupThreadsByMachine(
    [
      { environmentId: cryo, label: "CryoFrog", isPrimary: true },
      { environmentId: build, label: "BuildMachine", isPrimary: false },
    ],
    visible,
    (machine) =>
      hasMachineActivityInScope(
        machine.environmentId,
        activity.get(machine.environmentId) ?? [],
        projects,
      ),
  );
  expect(groups.map(({ machine }) => machine.environmentId)).toEqual([cryo]);
  expect(activity.get(build)).toHaveLength(1);
});
