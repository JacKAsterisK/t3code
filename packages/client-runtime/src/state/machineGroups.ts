import type { EnvironmentId } from "@t3tools/contracts";

/** One environment is one machine: the sidebar groups threads by the environment they run on. */
export interface SidebarMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The environment serving this client, listed first. */
  readonly isPrimary: boolean;
}

export interface SidebarMachineGroup<TMachine extends SidebarMachine, TThread> {
  readonly machine: TMachine;
  readonly threads: TThread[];
}

/**
 * The primary machine first, then by label. Activity never reorders machines,
 * so a group stays where the user last saw it.
 */
export function sortSidebarMachines<TMachine extends SidebarMachine>(
  machines: readonly TMachine[],
): TMachine[] {
  return [...machines].sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    const byLabel = left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (byLabel !== 0) return byLabel;
    return left.environmentId < right.environmentId
      ? -1
      : left.environmentId > right.environmentId
        ? 1
        : 0;
  });
}

/**
 * Splits threads into machine groups in machine order; each group keeps the
 * threads' given order. `machines` must cover every thread's environment. A
 * machine with no threads is kept only when `keepEmpty` accepts it, so callers
 * can still offer a way to start a thread there.
 */
export function groupThreadsByMachine<
  TMachine extends SidebarMachine,
  TThread extends { readonly environmentId: EnvironmentId },
>(
  machines: readonly TMachine[],
  threads: readonly TThread[],
  keepEmpty: (machine: TMachine) => boolean = () => false,
): Array<SidebarMachineGroup<TMachine, TThread>> {
  const groups = sortSidebarMachines(machines).map(
    (machine): SidebarMachineGroup<TMachine, TThread> => ({ machine, threads: [] }),
  );
  const groupByEnvironment = new Map(groups.map((group) => [group.machine.environmentId, group]));
  for (const thread of threads) groupByEnvironment.get(thread.environmentId)?.threads.push(thread);
  return groups.filter((group) => group.threads.length > 0 || keepEmpty(group.machine));
}
