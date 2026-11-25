import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { groupMachineActivity } from "./SidebarMachineActivity.logic";

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
    { threadId: id, title: "Build delegate", status: "waiting", startedAt: null },
  ]);
  expect(activity.get(cryo)).toEqual([
    { threadId: id, title: "Local delegate", status: "running", startedAt: null },
  ]);
});
