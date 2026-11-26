import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
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
    projectId: ProjectId.make("web"),
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

it("dismisses a keyboard-opened list once and returns focus to the badge", async () => {
  const onOpenThread = vi.fn();
  const activity: MachineActivity[] = [
    {
      threadId: ThreadId.make("keyboard-delegate"),
      projectId: ProjectId.make("web"),
      title: "Keyboard delegate",
      status: "waiting",
      startedAt: null,
    },
  ];
  await using screen = await render(
    <>
      <button type="button">Before badge</button>
      <SidebarMachineActivity {...group} activity={activity} onOpenThread={onOpenThread} />
    </>,
  );
  const badge = screen.getByRole("button", { name: "1 running or waiting on BuildMachine" });
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(badge).toHaveFocus();
  const task = page.getByRole("button", { name: "Keyboard delegate Waiting" });
  await expect.element(task).toBeVisible();
  // Enter the portal's focus scope, then dismiss it with the keyboard.
  const row = task.element();
  if (!(row instanceof HTMLElement)) throw new Error("Activity row is missing");
  row.focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(task).not.toBeInTheDocument();
  await expect.element(badge).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(screen.getByRole("button", { name: "Before badge" })).toHaveFocus();
});

it("can tab into and select a task after a previous hover", async () => {
  const activity: MachineActivity[] = [
    {
      threadId: ThreadId.make("keyboard-choice"),
      projectId: ProjectId.make("web"),
      title: "Keyboard choice",
      status: "running",
      startedAt: null,
    },
  ];
  const onOpenThread = vi.fn();
  await using screen = await render(
    <SidebarMachineActivity {...group} activity={activity} onOpenThread={onOpenThread} />,
  );
  const badge = screen.getByRole("button", { name: "1 running or waiting on BuildMachine" });
  const task = page.getByRole("button", { name: "Keyboard choice Running" });
  await userEvent.hover(badge);
  await expect.element(task).toBeVisible();
  await userEvent.unhover(badge);
  await expect.element(task).not.toBeInTheDocument();

  await userEvent.keyboard("{Tab}");
  await expect.element(badge).toHaveFocus();
  await expect.element(task).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(task).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(task).not.toBeInTheDocument();
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    threadId: activity[0]!.threadId,
  });
});
