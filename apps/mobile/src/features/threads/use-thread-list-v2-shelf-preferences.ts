import { useAtomSet, useAtomValue } from "@effect/atom-react";
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

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    threadGrouping,
    collapsedMachines,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    setThreadGrouping,
    toggleMachineCollapsed,
  } as const;
}
