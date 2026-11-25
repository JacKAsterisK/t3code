import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarMachineActivity } from "./SidebarMachineActivity";
import type { MachineActivity } from "./SidebarMachineActivity.logic";

const environmentId = EnvironmentId.make("build");
const group = { environmentId, machineLabel: "BuildMachine", rowId: "machine:build" };

it("opens the cached overflow on hover and routes to the executing machine", async () => {
  const activity = Array.from({ length: 9 }, (_, index): MachineActivity => ({
    threadId: ThreadId.make("thread-" + index),
    title: "Delegate " + index,
    status: index === 8 ? "waiting" : "running",
    startedAt: null,
  }));
  const onOpenThread = vi.fn();
  const badge = (value: typeof activity | null) => (
    <SidebarMachineActivity {...group} activity={value} onOpenThread={onOpenThread} />
  );
  await using screen = await render(badge(activity));
  await userEvent.hover(
    screen.getByRole("button", { name: "9 running or waiting on BuildMachine" }),
  );
  await expect.element(page.getByRole("button", { name: "Delegate 0 Running" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Next", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Delegate 8 Waiting" }));
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    threadId: activity[8]!.threadId,
  });

  await screen.rerender(badge(null));
  await expect.element(screen.getByText("Unknown", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("0", { exact: true })).not.toBeInTheDocument();
});
