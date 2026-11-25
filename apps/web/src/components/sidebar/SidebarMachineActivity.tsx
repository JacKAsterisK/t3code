import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { memo, useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Popover,
  PopoverClose,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import type { MachineActivity } from "./SidebarMachineActivity.logic";

const PAGE_SIZE = 8;

const badgeClass =
  "shrink-0 rounded-full border border-sidebar-border px-1.5 text-3xs leading-4 tabular-nums";

interface Props {
  environmentId: EnvironmentId;
  machineLabel: string;
  rowId: string;
  activity: ReadonlyArray<MachineActivity> | null;
  onOpenThread: (ref: ScopedThreadRef) => void;
}

export const SidebarMachineActivity = memo(function SidebarMachineActivity(props: Props) {
  const gt = useGT();
  if (props.activity === null) {
    return <span className={badgeClass}>{gt("Unknown")}</span>;
  }
  if (props.activity.length === 0) {
    return <span className={badgeClass}>0</span>;
  }
  return <MachineActivityPopover {...props} activity={props.activity} />;
});

function MachineActivityPopover({
  activity,
  environmentId,
  machineLabel,
  rowId,
  onOpenThread,
}: Props & { activity: ReadonlyArray<MachineActivity> }) {
  const gt = useGT();
  const m = useMessages();
  const [view, setView] = useState<{ openedAt: number; page: number } | null>(null);
  const [popover] = useState(() => PopoverCreateHandle());
  const triggerId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const suppressReturnFocusOpen = useRef(false);
  const title = gt("Active threads on {machine}", { machine: machineLabel });
  const lastPage = Math.floor((activity.length - 1) / PAGE_SIZE);
  const page = Math.min(view?.page ?? 0, lastPage);
  return (
    <Popover
      handle={popover}
      open={view !== null}
      onOpenChange={(open, { reason }) => {
        if (
          !open &&
          (reason === "escape-key" || reason === "close-press") &&
          popup.current?.contains(document.activeElement)
        ) {
          suppressReturnFocusOpen.current = true;
        }
        setView(open ? { openedAt: Date.now(), page: 0 } : null);
      }}
    >
      <PopoverTrigger
        aria-label={gt("{count} running or waiting on {machine}", {
          count: activity.length,
          machine: machineLabel,
        })}
        render={
          <button
            type="button"
            className="shrink-0 rounded-full border border-sidebar-border bg-sidebar-row-hover px-1.5 text-3xs leading-4 text-sidebar-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
        data-sidebar-action-for={rowId}
        id={triggerId}
        openOnHover
        onBlur={() => {
          suppressReturnFocusOpen.current = false;
        }}
        onFocus={(event) => {
          if (suppressReturnFocusOpen.current) {
            suppressReturnFocusOpen.current = false;
            return;
          }
          if (view === null && event.currentTarget.matches(":focus-visible")) {
            popover.open(triggerId);
          }
        }}
      >
        {activity.length}
      </PopoverTrigger>
      <PopoverPopup
        ref={popup}
        side="right"
        align="start"
        width="md"
        padding="compact"
        initialFocus={false}
      >
        {view !== null ? (
          <>
            <PopoverTitle className="mx-1 my-2">{title}</PopoverTitle>
            <ul className="space-y-0.5">
              {activity.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => (
                <li key={item.threadId}>
                  <PopoverClose
                    render={
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      />
                    }
                    onClick={() => onOpenThread(scopeThreadRef(environmentId, item.threadId))}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {item.status === "running" ? gt("Running") : gt("Waiting")}
                    </span>
                    {item.startedAt !== null ? (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatWorkingDurationLabel(view.openedAt - Date.parse(item.startedAt), m)}
                      </span>
                    ) : null}
                  </PopoverClose>
                </li>
              ))}
            </ul>
            {lastPage > 0 ? (
              <div className="flex justify-between gap-2 pt-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={page === 0}
                  onClick={() => setView({ ...view, page: page - 1 })}
                >
                  {gt("Previous")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={page === lastPage}
                  onClick={() => setView({ ...view, page: page + 1 })}
                >
                  {gt("Next")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
