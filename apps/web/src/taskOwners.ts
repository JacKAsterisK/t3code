import type { FleetUsersDirectory, ProjectIconColor, SidebarOwnerFilter } from "@t3tools/contracts";

import { PROJECT_ICON_COLORS } from "./projectIconColors";

export interface TaskOwnerPresentation {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly color: ProjectIconColor;
}

// Gray reads as "no owner", so derived colours skip it.
const DERIVED_OWNER_COLORS = PROJECT_ICON_COLORS.map(({ value }) => value).filter(
  (color) => color !== "gray",
);

const initialSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A colour that stays the same for an id on every device. */
export function taskOwnerColorFromId(id: string): ProjectIconColor {
  // FNV-1a, so neighbouring ids land on different colours.
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return DERIVED_OWNER_COLORS[(hash >>> 0) % DERIVED_OWNER_COLORS.length]!;
}

/** Unknown ids still render, as the raw id. */
export function presentTaskOwner(
  directory: FleetUsersDirectory | null,
  ownerId: string,
): TaskOwnerPresentation {
  const user = directory?.users.find((candidate) => candidate.id === ownerId);
  const name = user?.name ?? ownerId;
  const first = initialSegmenter.segment(name)[Symbol.iterator]().next().value?.segment ?? "?";
  return {
    id: ownerId,
    name,
    initial: first.toLocaleUpperCase(),
    color: user?.color ?? taskOwnerColorFromId(ownerId),
  };
}

export function resolveSelfOwnerId(
  taskOwnerSelf: string,
  directory: FleetUsersDirectory | null,
): string | null {
  return taskOwnerSelf || directory?.defaultOwnerId || null;
}

/** The owner whose threads the sidebar keeps, or null to keep every thread. */
export function resolveOwnerFilterId(input: {
  readonly filter: SidebarOwnerFilter;
  readonly selfOwnerId: string | null;
  readonly directory: FleetUsersDirectory | null;
}): string | null {
  // A filter left over from a fleet this device no longer sees must not hide threads.
  if (!input.directory || input.directory.users.length === 0) return null;
  if (input.filter === "mine") return input.selfOwnerId;
  return input.filter.startsWith("user:") ? input.filter.slice("user:".length) : null;
}

export interface OwnerFilterOption {
  readonly value: SidebarOwnerFilter;
  readonly label: string;
}

export function buildOwnerFilterOptions(
  directory: FleetUsersDirectory | null,
  selfOwnerId: string | null,
): ReadonlyArray<OwnerFilterOption> {
  if (!directory || directory.users.length === 0) return [];
  return [
    ...(selfOwnerId === null ? [] : [{ value: "mine" as const, label: "Mine" }]),
    ...directory.users
      .filter((user) => user.id !== selfOwnerId)
      .map((user) => ({ value: `user:${user.id}`, label: `${user.name}'s` })),
    { value: "all", label: "Everyone" },
  ];
}

/** The option a resolved filter shows as selected; a named self reads as Mine. */
export function selectedOwnerFilterOption(
  ownerFilterId: string | null,
  selfOwnerId: string | null,
): SidebarOwnerFilter {
  if (ownerFilterId === null) return "all";
  return ownerFilterId === selfOwnerId ? "mine" : `user:${ownerFilterId}`;
}
