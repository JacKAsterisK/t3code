// @effect-diagnostics nodeBuiltinImport:off -- Random delivery identifiers contain no machine or credential data.
import * as NodeCrypto from "node:crypto";
import {
  FleetRoster,
  LanFleetError,
  type LanFleetSyncInput,
  type LanFleetSyncResult,
  type LanFleetSetupInput,
  type LanFleetSetupState,
  AuthStandardClientScopes,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Delivery from "./FleetDelivery.ts";
import { readFleetJson, validateRoster, writeFleetJson } from "./FleetFiles.ts";
import { FLEET_ROSTER_ENV, resolveFleetBootstrap } from "./FleetBootstrap.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";

const Record = Schema.Struct({
  deliveryId: Schema.String,
  expiresAt: Schema.Number,
  status: Schema.Literals(["publishing", "pending", "connecting", "connected"]),
});
const Journal = Schema.Record(Schema.String, Record);
type Journal = typeof Journal.Type;
const isFleetError = Schema.is(LanFleetError);

export class LanFleet extends Context.Service<
  LanFleet,
  {
    readonly sync: (input: LanFleetSyncInput) => Effect.Effect<LanFleetSyncResult, LanFleetError>;
    readonly setup: Effect.Effect<LanFleetSetupState, LanFleetError>;
    readonly configure: (
      input: LanFleetSetupInput,
    ) => Effect.Effect<LanFleetSetupState, LanFleetError>;
  }
>()("t3/lan/LanFleet") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const launchEnvironment = yield* HostProcess.Environment;
  const enrollment = yield* FleetEnrollment.FleetEnrollment;
  const privateFile = path.join(serverConfig.stateDir, "lan-fleet-private.json");
  const journalFile = path.join(serverConfig.stateDir, "lan-fleet-state.json");
  const lock = path.join(serverConfig.stateDir, "lan-fleet.lock");
  const disabled: LanFleetSyncResult = {
    enabled: false,
    autoPickup: false,
    machines: [],
    incoming: [],
  };

  const sync = Effect.fn("LanFleet.sync")(
    function* (input: LanFleetSyncInput) {
      if (launchEnvironment[FLEET_ROSTER_ENV] === "") return disabled;
      const enrolled = yield* enrollment.resolve;
      if (enrolled === null) return disabled;
      if (enrolled === undefined && !(yield* fs.exists(privateFile))) return disabled;
      // Every operation reloads trust and metadata; revocation takes effect without restarting.
      const privateConfig =
        enrolled ??
        (yield* readFleetJson(privateFile, Delivery.FleetPrivateConfig).pipe(
          Effect.mapError(() => new LanFleetError({ reason: "configuration" })),
        ));
      const bootstrap = yield* Effect.try(() =>
        resolveFleetBootstrap(
          launchEnvironment,
          privateConfig.rosterPath,
          privateConfig.deliveryDirectory,
        ),
      ).pipe(Effect.mapError(() => new LanFleetError({ reason: "configuration" })));
      if (bootstrap === undefined) return disabled;
      const config = { ...privateConfig, ...bootstrap };
      const roster = yield* readFleetJson(config.rosterPath, FleetRoster);
      const localId = yield* environment.getEnvironmentId;
      const self = config.peers.find((peer) => peer.machineId === config.machineId && peer.enabled);
      yield* Effect.try(() => {
        validateRoster(roster);
        if (
          !path.isAbsolute(config.rosterPath) ||
          !path.isAbsolute(config.deliveryDirectory) ||
          self === undefined ||
          self.environmentId !== localId ||
          new Set(config.peers.map((peer) => peer.machineId)).size !== config.peers.length ||
          new Set(config.peers.map((peer) => peer.environmentId)).size !== config.peers.length
        )
          throw new Error("Invalid local fleet identity");
        Delivery.validateFleetKeys(config, self);
      }).pipe(Effect.mapError(() => new LanFleetError({ reason: "configuration" })));
      if (self === undefined) return yield* new LanFleetError({ reason: "configuration" });
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
        return yield* new LanFleetError({ reason: "configuration" });
      if (
        input.sendMachineIds.some(
          (id) =>
            !roster.machines.some(
              (machine) =>
                machine.machineId === id && trusted(machine) !== undefined && id !== self.machineId,
            ),
        )
      )
        return yield* new LanFleetError({ reason: "configuration" });

      return yield* Effect.acquireUseRelease(
        fs.makeDirectory(lock).pipe(Effect.mapError(() => new LanFleetError({ reason: "busy" }))),
        () =>
          Effect.gen(function* () {
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const saved = (yield* fs.exists(journalFile))
              ? yield* readFleetJson(journalFile, Journal)
              : {};
            const journal: { -readonly [K in keyof Journal]: Journal[K] } = { ...saved };
            const machines: Array<LanFleetSyncResult["machines"][number]> = [];
            const incoming: Array<LanFleetSyncResult["incoming"][number]> = [];
            yield* fs.makeDirectory(config.deliveryDirectory, { recursive: true });
            const campaign = config.campaign;
            const campaignIds =
              campaign !== undefined &&
              campaign !== null &&
              campaign.expiresAt > now &&
              campaign.machineIds.includes(self.machineId) &&
              (input.mode === "manual" || (input.mode === "automatic" && config.autoPickup))
                ? campaign.machineIds
                : [];
            const requested = new Set([
              ...(input.mode === "status" ? [] : input.sendMachineIds),
              ...campaignIds,
            ]);
            if (config.managed)
              yield* writeFleetJson(
                path.join(
                  config.deliveryDirectory,
                  `${Delivery.deliveryFileName(self.machineId, self.machineId)}.catalog.json`,
                ),
                Delivery.makeFleetCatalog(config, self, input.connectedEnvironmentIds, now),
              );
            for (const machine of roster.machines.filter((item) => item.enabled)) {
              const peer = trusted(machine);
              let status: LanFleetSyncResult["machines"][number]["status"] =
                machine.machineId === self.machineId
                  ? "self"
                  : peer === undefined
                    ? "untrusted"
                    : "ready";
              if (peer !== undefined && peer.machineId !== self.machineId) {
                const outgoingKey = Delivery.deliveryFileName(self.machineId, peer.machineId);
                const outFile = path.join(config.deliveryDirectory, `${outgoingKey}.json`);
                let sent = journal[`sent:${outgoingKey}`];
                let recipientReady = !config.managed;
                let recipientConnected =
                  !config.managed && input.connectedEnvironmentIds.includes(peer.environmentId);
                if (config.managed) {
                  const catalogFile = path.join(
                    config.deliveryDirectory,
                    `${Delivery.deliveryFileName(peer.machineId, peer.machineId)}.catalog.json`,
                  );
                  if (yield* fs.exists(catalogFile)) {
                    const catalog = yield* readFleetJson(catalogFile, Delivery.FleetCatalog);
                    recipientReady = Delivery.verifyFleetCatalog(catalog, peer, now);
                    recipientConnected =
                      recipientReady &&
                      catalog.connectedEnvironmentIds.includes(self.environmentId);
                  }
                }
                if (recipientConnected) {
                  sent = {
                    deliveryId: sent?.deliveryId ?? "existing-connection",
                    expiresAt: sent?.expiresAt ?? now,
                    status: "connected",
                  };
                  journal[`sent:${outgoingKey}`] = sent;
                }
                if (sent === undefined && (yield* fs.exists(outFile))) {
                  // A lost local journal must never rotate a delivery still present on the share.
                  status = "uncertain";
                } else if (sent === undefined && recipientConnected) {
                  status = "connected";
                } else if (sent === undefined && requested.has(peer.machineId) && !recipientReady) {
                  status = "pending";
                } else if (sent === undefined && requested.has(peer.machineId)) {
                  sent = {
                    deliveryId: NodeCrypto.randomUUID(),
                    expiresAt: now + 24 * 60 * 60 * 1000,
                    status: "publishing",
                  };
                  journal[`sent:${outgoingKey}`] = sent;
                  // Reserve durably before minting. An interrupted issue needs review, never rotation.
                  yield* writeFleetJson(journalFile, journal);
                  const issued = yield* auth.createPairingLink({
                    ttl: Duration.hours(24),
                    subject: `lan-fleet:${outgoingKey}`,
                    scopes:
                      config.access === "read-only"
                        ? [
                            AuthOrchestrationReadScope,
                            AuthFilesystemReadScope,
                            AuthDiagnosticsReadScope,
                          ]
                        : AuthStandardClientScopes,
                  });
                  const delivery = yield* Effect.try(() =>
                    Delivery.sealDelivery({
                      config,
                      sender: self,
                      recipient: peer,
                      deliveryId: sent!.deliveryId,
                      expiresAt: sent!.expiresAt,
                      credential: issued.credential,
                    }),
                  );
                  yield* writeFleetJson(outFile, delivery);
                  sent = { ...sent, status: "pending" };
                  journal[`sent:${outgoingKey}`] = sent;
                  yield* writeFleetJson(journalFile, journal);
                }
                if (sent !== undefined) {
                  status =
                    sent.status === "connected"
                      ? "connected"
                      : sent.status === "publishing"
                        ? "uncertain"
                        : sent.expiresAt <= now
                          ? "expired"
                          : "pending";
                  const receiptFile = path.join(
                    config.deliveryDirectory,
                    `${outgoingKey}.receipt.json`,
                  );
                  if (yield* fs.exists(receiptFile)) {
                    const receipt = yield* readFleetJson(receiptFile, Delivery.Receipt);
                    if (Delivery.verifyReceipt(receipt, sent.deliveryId, self, peer))
                      status = "connected";
                  }
                }
                const incomingKey = Delivery.deliveryFileName(peer.machineId, self.machineId);
                const inFile = path.join(config.deliveryDirectory, `${incomingKey}.json`);
                if (yield* fs.exists(inFile)) {
                  const delivery = yield* readFleetJson(inFile, Delivery.Delivery);
                  const received = journal[`received:${incomingKey}`];
                  if (
                    delivery.header.expiresAt > now &&
                    (received === undefined || received.deliveryId === delivery.header.deliveryId)
                  ) {
                    const payload = yield* Effect.try(() =>
                      Delivery.openDelivery(delivery, config, peer, self, now),
                    ).pipe(Effect.mapError(() => new LanFleetError({ reason: "configuration" })));
                    if (input.connectedEnvironmentIds.includes(peer.environmentId)) {
                      yield* writeFleetJson(
                        path.join(config.deliveryDirectory, `${incomingKey}.receipt.json`),
                        Delivery.makeReceipt(delivery, config),
                      );
                      journal[`received:${incomingKey}`] = {
                        deliveryId: delivery.header.deliveryId,
                        expiresAt: delivery.header.expiresAt,
                        status: "connected",
                      };
                    } else if (
                      received === undefined &&
                      incoming.length < 1 &&
                      (input.mode === "manual" || (input.mode === "automatic" && config.autoPickup))
                    ) {
                      journal[`received:${incomingKey}`] = {
                        deliveryId: delivery.header.deliveryId,
                        expiresAt: delivery.header.expiresAt,
                        status: "connecting",
                      };
                      yield* writeFleetJson(journalFile, journal);
                      incoming.push({
                        deliveryId: delivery.header.deliveryId,
                        environmentId: peer.environmentId,
                        host: payload.origin,
                        pairingCode: payload.credential,
                        ...(peer.tls === undefined ? {} : { tls: peer.tls }),
                      });
                    }
                    if (
                      received?.status === "connecting" &&
                      !input.connectedEnvironmentIds.includes(peer.environmentId)
                    )
                      status = "uncertain";
                  }
                }
              }
              machines.push({
                machineId: machine.machineId,
                environmentId: machine.environmentId,
                label: machine.label,
                status,
              });
            }
            yield* writeFleetJson(journalFile, journal);
            return {
              enabled: true,
              autoPickup: config.autoPickup,
              machines,
              incoming,
            } satisfies LanFleetSyncResult;
          }),
        () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
      );
    },
    Effect.mapError((error) =>
      isFleetError(error) ? error : new LanFleetError({ reason: "unavailable" }),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  return LanFleet.of({ sync, setup: enrollment.status, configure: enrollment.configure });
});

export const layerServices = Layer.effect(LanFleet, make);
export const layer = layerServices.pipe(Layer.provide(FleetEnrollment.layer));
