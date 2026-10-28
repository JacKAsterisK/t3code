import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import type { SidebarMachine } from "@t3tools/client-runtime/state/machine-groups";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";

export interface SidebarMachineEntry extends SidebarMachine {
  readonly kind: EnvironmentMachineKind;
  /** Runs on the device showing this sidebar. */
  readonly isLocal: boolean;
  readonly connection: "connected" | "connecting" | "offline";
}

/** The machine's sidebar tree row; its thread rows name it as their parent. */
export function sidebarMachineRowId(environmentId: EnvironmentId) {
  return `machine:${environmentId}`;
}

/**
 * A machine when the sidebar groups threads by machine. It mirrors the boring
 * sidebar's project folder: a closed machine shows its hidden count and a status
 * dot, so a hidden thread that needs you still shows.
 */
export const SidebarMachineGroupHeader = memo(function SidebarMachineGroupHeader(props: {
  machine: SidebarMachineEntry;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  canStartThread: boolean;
  onToggle: (environmentId: EnvironmentId) => void;
  onNewThread: (environmentId: EnvironmentId) => void;
}) {
  const { machine, collapsed, hiddenThreads } = props;
  const rowId = sidebarMachineRowId(machine.environmentId);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-machine-group"
      className="group/machine-group relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(machine.environmentId)}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          machine.connection === "offline" && "opacity-60",
        )}
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={machine.kind}
          className="size-4 shrink-0 text-sidebar-muted-foreground"
        />
        <span className="min-w-0 truncate text-sm font-medium text-sidebar-foreground/90">
          {machine.label}
        </span>
        {machine.isLocal ? (
          <span className="shrink-0 rounded-full border border-sidebar-border px-1.5 text-3xs leading-4 text-sidebar-muted-foreground">
            This PC
          </span>
        ) : null}
        {machine.connection === "connected" ? null : (
          <span className="shrink-0 truncate text-xs text-sidebar-muted-foreground">
            {machine.connection === "connecting" ? "Connecting…" : "Offline"}
          </span>
        )}
        <span className="flex-1" />
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/machine-group:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {props.canStartThread ? (
        // Sits over the count, which hides on hover, and left of the chevron.
        <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/machine-group:opacity-100 pointer-coarse:opacity-100">
          <Button
            data-sidebar-action-for={rowId}
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`New thread on ${machine.label}`}
            onClick={() => props.onNewThread(machine.environmentId)}
          >
            <SquarePenIcon aria-hidden />
          </Button>
        </span>
      ) : null}
    </li>
  );
});
