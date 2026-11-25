import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

export interface MachineActivity {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: "running" | "waiting";
  readonly startedAt: string | null;
}

export const EMPTY_MACHINE_ACTIVITY: ReadonlyArray<MachineActivity> = [];

export function groupMachineActivity(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<EnvironmentId, ReadonlyArray<MachineActivity>> {
  const byEnvironment = new Map<EnvironmentId, Map<ThreadId, MachineActivity>>();
  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    const status =
      thread.source.activityRunStatus === undefined
        ? thread.runtime?.status
        : thread.source.activityRunStatus;
    if (status !== "running" && status !== "waiting") continue;

    let entries = byEnvironment.get(thread.environmentId);
    if (entries === undefined) {
      entries = new Map();
      byEnvironment.set(thread.environmentId, entries);
    }
    if (entries.has(thread.id)) continue;
    entries.set(thread.id, {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      status,
      startedAt: resolveThreadWorkingStartedAt(thread),
    });
  }
  return new Map(
    Array.from(byEnvironment, ([environmentId, threads]) => [
      environmentId,
      Array.from(threads.values()),
    ]),
  );
}

export function hasMachineActivityInScope(
  environmentId: EnvironmentId,
  activity: ReadonlyArray<MachineActivity>,
  scopedProjectKeys: ReadonlySet<string> | null,
): boolean {
  return scopedProjectKeys === null
    ? activity.length > 0
    : activity.some(({ projectId }) => scopedProjectKeys.has(`${environmentId}:${projectId}`));
}
