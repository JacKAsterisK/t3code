import { FleetRoster, LanFleetError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Delivery from "./FleetDelivery.ts";
import { FLEET_ROSTER_ENV, resolveFleetBootstrap } from "./FleetBootstrap.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import { readFleetJson, validateRoster } from "./FleetFiles.ts";

export interface FleetLinkPeer {
  readonly peer: Delivery.FleetPeer;
  /** The hostname its current catalog asks peers to route to, if any. */
  readonly connectHost: string | undefined;
}

/** This machine's fleet identity and the peers it trusts, read fresh from the share. */
export interface FleetLinkContext {
  readonly config: Delivery.FleetPrivateConfig;
  readonly self: Delivery.FleetPeer;
  readonly deliveryDirectory: string;
  readonly peers: ReadonlyArray<FleetLinkPeer>;
}

export class FleetContext extends Context.Service<
  FleetContext,
  {
    /** Nothing unless this machine is enrolled in a managed fleet with shared-folder trust. */
    readonly load: Effect.Effect<FleetLinkContext | undefined, LanFleetError>;
  }
>()("t3/lan/FleetContext") {}

const isFleetError = Schema.is(LanFleetError);
const configurationError = () => new LanFleetError({ reason: "configuration" });

// The same trust checks LanFleet.sync makes before it delivers anything.
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const launchEnvironment = yield* HostProcess.Environment;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const enrollment = yield* FleetEnrollment.FleetEnrollment;

  const load = Effect.gen(function* () {
    if (launchEnvironment[FLEET_ROSTER_ENV] === "") return undefined;
    const enrolled = yield* enrollment.resolve;
    if (enrolled === null || enrolled === undefined) return undefined;
    if ((yield* enrollment.status).sharedFolderTrust !== true) return undefined;
    const bootstrap = yield* Effect.try({
      try: () =>
        resolveFleetBootstrap(launchEnvironment, enrolled.rosterPath, enrolled.deliveryDirectory),
      catch: configurationError,
    });
    if (bootstrap === undefined) return undefined;
    const config = { ...enrolled, ...bootstrap };
    const roster = yield* readFleetJson(config.rosterPath, FleetRoster);
    const localId = yield* environment.getEnvironmentId;
    const self = config.peers.find((peer) => peer.machineId === config.machineId && peer.enabled);
    yield* Effect.try({
      try: () => {
        validateRoster(roster);
        if (
          !path.isAbsolute(config.deliveryDirectory) ||
          self === undefined ||
          self.environmentId !== localId ||
          new Set(config.peers.map((peer) => peer.machineId)).size !== config.peers.length ||
          new Set(config.peers.map((peer) => peer.environmentId)).size !== config.peers.length
        )
          throw new Error("Invalid local fleet identity");
        Delivery.validateFleetKeys(config, self);
      },
      catch: configurationError,
    });
    if (self === undefined) return yield* configurationError();
    const trusted = (machine: FleetRoster["machines"][number]) =>
      config.peers.find(
        (peer) =>
          peer.enabled &&
          machine.enabled &&
          peer.machineId === machine.machineId &&
          peer.environmentId === machine.environmentId &&
          peer.origin === machine.origin,
      );
    const selfEntry = roster.machines.find((machine) => machine.machineId === self.machineId);
    if (selfEntry === undefined || trusted(selfEntry) === undefined)
      return yield* configurationError();
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const peers: Array<FleetLinkPeer> = [];
    for (const machine of roster.machines) {
      const peer = trusted(machine);
      if (peer === undefined || peer.machineId === self.machineId) continue;
      const catalogFile = path.join(
        config.deliveryDirectory,
        `${Delivery.deliveryFileName(peer.machineId, peer.machineId)}.catalog.json`,
      );
      const catalog = yield* readFleetJson(catalogFile, Delivery.FleetCatalog).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      peers.push({
        peer,
        connectHost:
          catalog !== undefined && Delivery.verifyFleetCatalog(catalog, peer, now)
            ? catalog.connectHost
            : undefined,
      });
    }
    return { config, self, deliveryDirectory: config.deliveryDirectory, peers };
  }).pipe(
    Effect.mapError((error) =>
      isFleetError(error) ? error : new LanFleetError({ reason: "unavailable" }),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  return FleetContext.of({ load });
});

export const layer = Layer.effect(FleetContext, make).pipe(Layer.provide(FleetEnrollment.layer));
