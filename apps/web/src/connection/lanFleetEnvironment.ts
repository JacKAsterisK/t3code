import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopBridge } from "@t3tools/contracts";
import type { PrimaryEnvironmentTarget } from "../environments/primary/target";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "./desktopLocal";

export function resolveNativeWindowsPrimary(
  bridge: Pick<DesktopBridge, "getClientPlatform" | "getLocalEnvironmentBootstraps"> | undefined,
  primary: PrimaryEnvironmentTarget | null,
) {
  if (bridge?.getClientPlatform?.() !== "win32" || primary?.source !== "desktop-managed")
    return null;
  const bootstrap = bridge
    .getLocalEnvironmentBootstraps()
    .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  if (
    !bootstrap ||
    bootstrap.runningDistro !== null ||
    !bootstrap.httpBaseUrl ||
    !bootstrap.wsBaseUrl ||
    new URL(bootstrap.httpBaseUrl).href !== primary.target.httpBaseUrl ||
    new URL(bootstrap.wsBaseUrl).href !== primary.target.wsBaseUrl
  )
    return null;
  return primary.target;
}

export function resolveFleetEnvironmentId(
  targets: ReadonlyArray<ConnectionTarget>,
  nativePrimary: { readonly httpBaseUrl: string; readonly wsBaseUrl: string } | null,
  isWindows: boolean,
) {
  if (!isWindows) return null;
  // The desktop's main Windows server is the primary registration, not a secondary bearer.
  const primary =
    nativePrimary !== null
      ? targets.find((target) => target._tag === "PrimaryConnectionTarget")
      : undefined;
  if (
    primary &&
    nativePrimary !== null &&
    primary.httpBaseUrl === nativePrimary.httpBaseUrl &&
    primary.wsBaseUrl === nativePrimary.wsBaseUrl
  )
    return primary.environmentId;
  const local = targets.find(
    (target) => isDesktopLocalConnectionTarget(target) && !isWslConnectionTarget(target),
  );
  return local?.environmentId ?? null;
}
