import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  moveSidebarMachine,
  sortSidebarMachines,
  type SidebarMachine,
  type SidebarMachineMove,
} from "@t3tools/client-runtime/state/machine-groups";
import type { EnvironmentId, SidebarThreadGrouping } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_MACHINES: ReadonlyArray<string> = [];

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const threadGrouping =
    loaded && preferencesResult.value.threadListGrouping === "machine" ? "machine" : "none";
  const collapsedMachines: ReadonlyArray<string> =
    (loaded ? preferencesResult.value.threadListCollapsedMachines : undefined) ?? NO_MACHINES;
  const machineOrder: ReadonlyArray<string> =
    (loaded ? preferencesResult.value.threadListMachineOrder : undefined) ?? NO_MACHINES;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const setThreadGrouping = (grouping: SidebarThreadGrouping) => {
    if (!loaded) return;
    savePreferences({ threadListGrouping: grouping });
  };
  const toggleMachineCollapsed = (environmentId: EnvironmentId) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.threadListCollapsedMachines ?? [];
        return {
          threadListCollapsedMachines: collapsed.includes(environmentId)
            ? collapsed.filter((id) => id !== environmentId)
            : [...collapsed, environmentId],
        };
      },
    });
  };
  /**
   * Saves every known machine's place, so later moves and new machines keep a
   * stable order. `visibleEnvironmentIds` are the groups on screen.
   */
  const moveMachine = (input: {
    readonly environmentId: EnvironmentId;
    readonly move: SidebarMachineMove;
    readonly machines: ReadonlyArray<SidebarMachine>;
    readonly visibleEnvironmentIds: ReadonlyArray<string>;
  }) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListMachineOrder: moveSidebarMachine(
          sortSidebarMachines(input.machines, current.threadListMachineOrder).map(
            (machine) => machine.environmentId,
          ),
          input.visibleEnvironmentIds,
          input.environmentId,
          input.move,
        ),
      }),
    });
  };
  const resetMachineOrder = () => {
    if (!loaded) return;
    savePreferences({ threadListMachineOrder: [] });
  };

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    threadGrouping,
    collapsedMachines,
    machineOrder,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    setThreadGrouping,
    toggleMachineCollapsed,
    moveMachine,
    resetMachineOrder,
  } as const;
}
