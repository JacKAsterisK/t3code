import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "./desktopLocal";

export function resolveFleetEnvironmentId(
  targets: ReadonlyArray<ConnectionTarget>,
  isDesktopManagedPrimary: boolean,
) {
  // The desktop's main Windows server is the primary registration, not a secondary bearer.
  const primary = isDesktopManagedPrimary
    ? targets.find((target) => target._tag === "PrimaryConnectionTarget")
    : undefined;
  if (primary) return primary.environmentId;
  const local = targets.find(
    (target) => isDesktopLocalConnectionTarget(target) && !isWslConnectionTarget(target),
  );
  return local?.environmentId ?? null;
}
