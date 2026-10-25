// @effect-diagnostics nodeBuiltinImport:off -- Launch-time metadata paths follow native filesystem semantics.
import * as NodePath from "node:path";

export const FLEET_ROSTER_ENV = "T3CODE_LAN_FLEET_ROSTER_PATH";

export function resolveFleetBootstrap(
  environment: Readonly<Record<string, string | undefined>>,
  configuredRoster?: string,
  configuredDeliveries?: string,
) {
  const rosterPath = environment[FLEET_ROSTER_ENV] ?? configuredRoster;
  if (rosterPath === undefined || rosterPath === "") return undefined;
  if (!rosterPath.trim() || rosterPath !== rosterPath.trim() || !NodePath.isAbsolute(rosterPath))
    throw new Error("Fleet roster requires an explicit absolute JSON file path");
  const deliveryDirectory =
    configuredDeliveries ?? NodePath.join(NodePath.dirname(rosterPath), "fleet-deliveries");
  if (!NodePath.isAbsolute(deliveryDirectory))
    throw new Error("Fleet delivery directory must be absolute");
  return { rosterPath, deliveryDirectory };
}
