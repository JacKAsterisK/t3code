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

export type SidebarMachineMove = "up" | "down" | "top" | "bottom";

function compareByDefault(left: SidebarMachine, right: SidebarMachine): number {
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
}

/**
 * The device's saved order first, then any machine it doesn't name, primary
 * first and then by label. Activity never reorders machines, so a group stays
 * where the user last saw or put it.
 */
export function sortSidebarMachines<TMachine extends SidebarMachine>(
  machines: readonly TMachine[],
  savedOrder: readonly string[] = [],
): TMachine[] {
  const rank = new Map(savedOrder.map((environmentId, index) => [environmentId, index]));
  return [...machines].sort((left, right) => {
    const leftRank = rank.get(left.environmentId);
    const rightRank = rank.get(right.environmentId);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return compareByDefault(left, right);
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
  savedOrder: readonly string[] = [],
): Array<SidebarMachineGroup<TMachine, TThread>> {
  const groups = sortSidebarMachines(machines, savedOrder).map(
    (machine): SidebarMachineGroup<TMachine, TThread> => ({ machine, threads: [] }),
  );
  const groupByEnvironment = new Map(groups.map((group) => [group.machine.environmentId, group]));
  for (const thread of threads) groupByEnvironment.get(thread.environmentId)?.threads.push(thread);
  return groups.filter((group) => group.threads.length > 0 || keepEmpty(group.machine));
}

/**
 * The order to save after moving one machine. `order` is every known machine
 * in its current order; moves step past the machines on screen, so a hidden
 * machine never swallows a click, and hidden machines keep their places.
 */
export function moveSidebarMachine(
  order: readonly string[],
  visible: readonly string[],
  environmentId: string,
  move: SidebarMachineMove,
): string[] {
  const shown = new Set(visible);
  const from = order.indexOf(environmentId);
  if (from === -1 || !shown.has(environmentId)) return [...order];
  const rest = order.filter((id) => id !== environmentId);
  const before = order.slice(0, from).filter((id) => shown.has(id));
  const after = order.slice(from + 1).filter((id) => shown.has(id));
  const anchor =
    move === "up"
      ? before[before.length - 1]
      : move === "top"
        ? before[0]
        : move === "down"
          ? after[0]
          : after[after.length - 1];
  // Already first or last on screen.
  if (anchor === undefined) return [...order];
  const index = rest.indexOf(anchor) + (move === "up" || move === "top" ? 0 : 1);
  return [...rest.slice(0, index), environmentId, ...rest.slice(index)];
}
