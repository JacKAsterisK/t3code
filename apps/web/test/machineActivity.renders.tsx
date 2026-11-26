import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { SidebarMachineActivity } from "~/components/sidebar/SidebarMachineActivity";
import { groupMachineActivity } from "~/components/sidebar/SidebarMachineActivity.logic";
import { makeThreadFixture } from "~/test-fixtures";
import { act, render } from "./render";
import { commitsSoFar, startCounting, stopCounting } from "./renderCounter";

const environmentId = EnvironmentId.make("build");
const group = { environmentId, machineLabel: "BuildMachine", rowId: "machine:build" };

it("keeps activity stable across streaming shell updates with the list closed and open", async () => {
  const threadCount = 1_200;
  const activeCount = 24;
  const ticks = 120;
  const at = DateTime.makeUnsafe("2026-11-24T18:00:00Z");
  const snapshot: OrchestrationV2ShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    archivedThreads: [],
    threads: Array.from({ length: threadCount }, (_, index) => {
      const threadId = ThreadId.make("stream-fixture-" + index);
      const shell = makeThreadFixture({
        environmentId,
        id: threadId,
        title: "Thread " + index,
      }).source;
      if (index >= activeCount) return shell;
      const runId = RunId.make("run-" + index);
      return {
        ...shell,
        latestRunId: runId,
        activeRunId: runId,
        status: "running",
        activityRunStatus: "running",
        activityRunStartedAt: at,
        itemCount: 1,
        visibleItemCount: 1,
      };
    }),
  };
  const source = Atom.make<OrchestrationV2ShellSnapshot | null>(snapshot);
  const registry = AtomRegistry.make();
  using disposal = new DisposableStack();
  disposal.defer(() => registry.dispose());
  const shells = createEnvironmentThreadShellAtoms({
    snapshotAtom: () => source,
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([
        [
          environmentId,
          {
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "BuildMachine",
              httpBaseUrl: "http://example.test",
              wsBaseUrl: "ws://example.test",
            }),
            profile: Option.none(),
            enabled: true,
          },
        ],
      ]),
    }),
    hiddenThreadTagsAtom: () => Atom.make(null),
  });
  const quiet = shells.quietThreadShellsAtom;
  const noNavigate = () => undefined;
  function MeasuredBadge() {
    const threads = useAtomValue(quiet);
    const activity = groupMachineActivity(threads).get(environmentId) ?? [];
    return <SidebarMachineActivity {...group} activity={activity} onOpenThread={noNavigate} />;
  }
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <MeasuredBadge />
    </RegistryContext.Provider>,
  );
  const original = registry.get(quiet);
  const badge = screen.getByRole("button", { name: "24 running or waiting on BuildMachine" });
  await expect.element(badge).toBeVisible();
  expect(commitsSoFar()).toBeGreaterThan(0);

  // Use the same quiet-window rule as the other render scenarios so the
  // popover's opening layout commits do not land in the streaming sample.
  async function waitForRenderQuiet() {
    let previous = -1;
    await vi.waitFor(
      () => {
        const current = commitsSoFar();
        const settled = current === previous;
        previous = current;
        expect(settled).toBe(true);
      },
      { interval: 100, timeout: 10_000 },
    );
  }

  let sequence = 0;
  async function stream() {
    await waitForRenderQuiet();
    startCounting();
    for (let tick = 0; tick < ticks; tick += 1) {
      sequence += 1;
      const streamedIndex = tick % activeCount;
      const threads = [...snapshot.threads];
      threads[streamedIndex] = {
        ...snapshot.threads[streamedIndex]!,
        updatedAt: DateTime.add(at, { milliseconds: sequence }),
        visibleItemCount: 2,
        itemCount: 2,
      };
      await act(() => registry.set(source, { ...snapshot, threads, snapshotSequence: sequence }));
      expect(registry.get(quiet)).toBe(original);
    }
    await waitForRenderQuiet();
    return stopCounting();
  }

  const closed = await stream();
  await userEvent.hover(badge);
  await expect.element(page.getByRole("button", { name: /Thread 0 Running/ })).toBeVisible();
  const open = await stream();
  await commands.writeRenderReport("d213-streaming-list-closed", JSON.stringify(closed));
  await commands.writeRenderReport("d213-streaming-list-open", JSON.stringify(open));
  expect(closed.commits).toBe(0);
  expect(open.commits).toBe(0);

  // A genuine activity transition still reaches the badge.
  await act(() =>
    registry.set(source, {
      ...snapshot,
      threads: snapshot.threads.slice(1),
      snapshotSequence: sequence + 1,
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "23 running or waiting on BuildMachine" }))
    .toBeVisible();
});
