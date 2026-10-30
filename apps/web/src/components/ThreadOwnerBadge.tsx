import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SyntheticEvent } from "react";

import { useFleetUsersDirectory, useSetThreadOwner } from "../hooks/useTaskOwners";
import { cn } from "../lib/utils";
import { presentTaskOwner } from "../taskOwners";
import { ProjectMonogram } from "./ProjectMonogram";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Rows navigate on click and portaled menu clicks bubble through React to them.
const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

/** Who manages a thread, as a coloured initial; clicking it reassigns the thread. */
export function ThreadOwnerBadge(props: {
  readonly threadRef: ScopedThreadRef;
  readonly ownerId: string;
  readonly showName?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const { threadRef, ownerId, showName = false } = props;
  const directory = useFleetUsersDirectory();
  const setThreadOwner = useSetThreadOwner();
  const owner = presentTaskOwner(directory, ownerId);
  const users = directory?.users ?? [];
  const content = (
    <>
      <ProjectMonogram round text={owner.initial} color={owner.color} className="size-3.5" />
      {showName ? <span className="min-w-0 truncate">{owner.name}</span> : null}
    </>
  );
  const className = cn(
    "inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted-foreground",
    props.className,
  );

  if (users.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span role="img" aria-label={`Managed by ${owner.name}`} className={className} />}
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup side="top">Managed by {owner.name}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Managed by ${owner.name}`}
                  onClick={stopPropagation}
                  onDoubleClick={stopPropagation}
                  className={cn(
                    className,
                    "cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                />
              }
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup side="top">Managed by {owner.name}. Click to reassign.</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end" onClick={stopPropagation}>
        <MenuGroup>
          <MenuGroupLabel>Assign to</MenuGroupLabel>
          <MenuRadioGroup
            value={ownerId}
            onValueChange={(value: string) => {
              if (value !== ownerId) void setThreadOwner(threadRef, value);
            }}
          >
            {users.map((user) => {
              const presented = presentTaskOwner(directory, user.id);
              return (
                <MenuRadioItem key={user.id} value={user.id} closeOnClick>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProjectMonogram
                      round
                      text={presented.initial}
                      color={presented.color}
                      className="size-3.5"
                    />
                    <span className="min-w-0 flex-1 truncate">{user.name}</span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
