// @effect-diagnostics nodeBuiltinImport:off -- Random delivery identifiers contain no machine or credential data.
import * as NodeCrypto from "node:crypto";
import {
  FleetRoster,
  FleetConnectHost,
  LanFleetError,
  type LanFleetSyncInput,
  type LanFleetSyncResult,
  type LanFleetSetupInput,
  type LanFleetSetupState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Delivery from "./FleetDelivery.ts";
import { readFleetJson, validateRoster, writeFleetJson } from "./FleetFiles.ts";
import { FLEET_ROSTER_ENV, resolveFleetBootstrap } from "./FleetBootstrap.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as FleetPeerLinks from "./FleetPeerLinks.ts";

const Record = Schema.Struct({
  deliveryId: Schema.String,
  expiresAt: Schema.Number,
  status: Schema.Literals(["publishing", "pending", "connecting", "connected"]),
  pairingLinkId: Schema.optionalKey(Schema.String),
  senderCatalogCreatedAt: Schema.optionalKey(Schema.Number),
  // A pickup that replaces a credential this machine already holds for the sender.
  replacing: Schema.optionalKey(Schema.Boolean),
});
const Journal = Schema.Record(Schema.String, Record);
type Journal = typeof Journal.Type;
const isFleetError = Schema.is(LanFleetError);
const isConnectHost = Schema.is(FleetConnectHost);
// Fleet credentials become sessions with the default 30-day lifetime; replace them a week early.
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
// A connection the peer already had before this machine sent it a fleet credential.
const EXISTING_CONNECTION = "existing-connection";
// The same cadence as a client's automatic pickup.
const BACKGROUND_SYNC_INTERVAL = Duration.minutes(5);

export class LanFleet extends Context.Service<
  LanFleet,
  {
    readonly sync: (input: LanFleetSyncInput) => Effect.Effect<LanFleetSyncResult, LanFleetError>;
    /**
     * A sync with no window open: it issues, replaces and revokes this machine's credentials,
     * but collects nothing, since only a client can save a connection.
     */
    readonly backgroundSync: Effect.Effect<void, LanFleetError>;
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
  const hostname = yield* HostProcess.Hostname;
  const platform = yield* HostProcess.Platform;
  const connectHost = platform === "win32" && isConnectHost(hostname) ? hostname : undefined;
  const enrollment = yield* FleetEnrollment.FleetEnrollment;
  const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
  const peerLinks = yield* Effect.serviceOption(FleetPeerLinks.FleetPeerLinks);
  // A sync may bring new catalogs, trust or peer-link requests for the peer-link adapter.
  const requestPeerLinkPass = Option.isSome(peerLinks) ? peerLinks.value.requestPass : Effect.void;
  const privateFile = path.join(serverConfig.stateDir, "lan-fleet-private.json");
  const journalFile = path.join(serverConfig.stateDir, "lan-fleet-state.json");
  const lock = path.join(serverConfig.stateDir, "lan-fleet.lock");
  const disabled: LanFleetSyncResult = {
    enabled: false,
    autoPickup: false,
    machines: [],
    incoming: [],
  };

  const run = Effect.fn("LanFleet.sync")(
    function* (request: LanFleetSyncInput | "background") {
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
      const sharedFolder =
        config.managed === true && (yield* enrollment.status).sharedFolderTrust === true;
      // Resolving the enrollment just refreshed the policy from the share.
      const policy = config.managed ? yield* fleetAccess.current : undefined;
      const policyActive = policy !== undefined && policy.revision > 0;
      // Only a shared folder tells this machine which grants a peer still holds, so it can replace
      // them: to renew them, and once a policy is saved, to match each peer's access.
      const enforcePolicy = sharedFolder && policyActive;
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
      const ownCatalogFile = path.join(
        config.deliveryDirectory,
        `${Delivery.deliveryFileName(self.machineId, self.machineId)}.catalog.json`,
      );
      // A background sync republishes the connections this machine's client last published, so
      // peers keep seeing them, and waits until a client has published any.
      const published =
        request === "background" && sharedFolder && (yield* fs.exists(ownCatalogFile))
          ? yield* readFleetJson(ownCatalogFile, Delivery.FleetCatalog).pipe(
              // Its own signature, checked as of when it was written.
              Effect.map((catalog) =>
                Delivery.verifyFleetCatalog(catalog, self, catalog.createdAt) ? catalog : undefined,
              ),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
      if (request === "background" && published === undefined) return disabled;
      const input: LanFleetSyncInput =
        request !== "background"
          ? request
          : {
              mode: "status",
              sendMachineIds: [],
              connectedEnvironmentIds: published?.connectedEnvironmentIds ?? [],
            };
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
            const activeLinks = sharedFolder ? [...(yield* auth.listPairingLinks())] : [];
            const activeSessions = sharedFolder ? yield* auth.listSessions() : [];
            const availableDeliveryIds = new Set<string>();
            const rejectedDeliveryIds = new Set<string>();
            const activeGrant = (
              outgoingKey: string,
              expiresAt: number,
              pairingLinkId?: string,
            ) => {
              const matches = activeLinks.filter(
                (link) =>
                  link.subject === `lan-fleet:${outgoingKey}` &&
                  (pairingLinkId === undefined || link.id === pairingLinkId) &&
                  DateTime.toEpochMillis(link.expiresAt) > now &&
                  Math.abs(DateTime.toEpochMillis(link.expiresAt) - expiresAt) <= 60_000,
              );
              return matches.length === 1 ? matches[0] : undefined;
            };
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
                let peerCatalog: typeof Delivery.FleetCatalog.Type | undefined;
                if (config.managed) {
                  const catalogFile = path.join(
                    config.deliveryDirectory,
                    `${Delivery.deliveryFileName(peer.machineId, peer.machineId)}.catalog.json`,
                  );
                  if (yield* fs.exists(catalogFile)) {
                    const catalog = yield* readFleetJson(catalogFile, Delivery.FleetCatalog);
                    recipientReady = Delivery.verifyFleetCatalog(catalog, peer, now);
                    if (recipientReady) peerCatalog = catalog;
                    recipientConnected =
                      recipientReady &&
                      catalog.connectedEnvironmentIds.includes(self.environmentId);
                  }
                }
                let outgoingExists = yield* fs.exists(outFile);
                let outgoingRejected = false;
                const access =
                  policy !== undefined && policyActive
                    ? FleetAccessPolicy.machineAccess(policy, peer.machineId)
                    : config.access === "read-only"
                      ? "read-only"
                      : "standard";
                if (sharedFolder) {
                  // What this machine actually issued the peer is the truth, not the journal.
                  const subject = `lan-fleet:${outgoingKey}`;
                  const held = [
                    ...activeSessions
                      .filter((session) => session.subject === subject)
                      .map((session) => ({
                        access: FleetAccessPolicy.credentialAccess(session),
                        session: true,
                        expiresAt: DateTime.toEpochMillis(session.expiresAt),
                        used: session.connected || session.lastConnectedAt !== null,
                        revoke: auth.revokeSession(session.sessionId),
                        link: undefined,
                      })),
                    ...activeLinks
                      .filter((link) => link.subject === subject)
                      .map((link) => ({
                        access: FleetAccessPolicy.credentialAccess(link),
                        session: false,
                        expiresAt: DateTime.toEpochMillis(link.expiresAt),
                        used: false,
                        revoke: auth.revokePairingLink(link.id),
                        link,
                      })),
                  ];
                  // Lost access ends at once; gained access waits until the peer can collect it.
                  if (enforcePolicy && (access === "read-only" || recipientReady))
                    for (const credential of held.filter((item) => item.access !== access)) {
                      yield* credential.revoke;
                      if (credential.link !== undefined)
                        activeLinks.splice(activeLinks.indexOf(credential.link), 1);
                    }
                  // Before the first saved policy, a credential keeps the access it was issued at.
                  const current = (item: (typeof held)[number]) =>
                    !enforcePolicy || item.access === access;
                  // An unspent grant is a replacement in flight; a session lasts until renewal is due.
                  const fresh = (item: (typeof held)[number]) =>
                    current(item) && (!item.session || item.expiresAt - now > RENEW_BEFORE_MS);
                  // Without a policy, only a peer that took a fleet credential is renewed.
                  const renewable =
                    enforcePolicy ||
                    held.some((item) => item.session) ||
                    (sent !== undefined && sent.deliveryId !== EXISTING_CONNECTION);
                  const catalogConnected = recipientConnected;
                  if (renewable)
                    recipientConnected =
                      recipientConnected && held.some((item) => item.session && fresh(item));
                  // Once the peer uses its renewed session, the one it replaced is retired.
                  if (held.some((item) => item.session && item.used && fresh(item)))
                    for (const credential of held.filter(
                      (item) => item.session && current(item) && !fresh(item),
                    ))
                      yield* credential.revoke;
                  if (catalogConnected && recipientReady && renewable && !held.some(fresh)) {
                    // The peer keeps a connection here with no credential at its access, or one
                    // that is about to expire or already has: replace it.
                    if (outgoingExists) {
                      const replaced = yield* readFleetJson(outFile, Delivery.Delivery).pipe(
                        Effect.map((delivery) => delivery.header.deliveryId),
                        Effect.orElseSucceed(() => NodeCrypto.randomUUID()),
                      );
                      yield* fs.rename(outFile, `${outFile}.obsolete-${replaced}`);
                    }
                    delete journal[`sent:${outgoingKey}`];
                    yield* writeFleetJson(journalFile, journal);
                    sent = undefined;
                    outgoingExists = false;
                    requested.add(peer.machineId);
                  }
                }
                if (sharedFolder && outgoingExists && !recipientConnected) {
                  const existing = yield* readFleetJson(outFile, Delivery.Delivery);
                  const valid = yield* Effect.try(() =>
                    Delivery.verifyDelivery(existing, self, peer, now),
                  );
                  const grant = activeGrant(
                    outgoingKey,
                    existing.header.expiresAt,
                    sent?.pairingLinkId,
                  );
                  outgoingRejected =
                    peerCatalog?.rejectedDeliveryIds?.includes(existing.header.deliveryId) === true;
                  if (
                    requested.has(peer.machineId) &&
                    recipientReady &&
                    outgoingRejected &&
                    existing.header.senderId === self.machineId &&
                    existing.header.recipientId === peer.machineId &&
                    sent !== undefined &&
                    sent.status !== "connected" &&
                    sent.deliveryId === existing.header.deliveryId &&
                    sent.expiresAt === existing.header.expiresAt &&
                    grant !== undefined &&
                    (yield* auth.revokePairingLink(grant.id))
                  ) {
                    // Only the issuing server can retire the exact still-unused grant before replacement.
                    yield* fs.rename(outFile, `${outFile}.obsolete-${existing.header.deliveryId}`);
                    activeLinks.splice(activeLinks.indexOf(grant), 1);
                    delete journal[`sent:${outgoingKey}`];
                    yield* writeFleetJson(journalFile, journal);
                    sent = undefined;
                    outgoingExists = false;
                    outgoingRejected = false;
                  }
                  if (
                    outgoingExists &&
                    valid &&
                    grant !== undefined &&
                    (sent === undefined || sent.deliveryId === existing.header.deliveryId)
                  ) {
                    if (sent === undefined || sent.status === "publishing") {
                      sent = {
                        deliveryId: existing.header.deliveryId,
                        expiresAt: existing.header.expiresAt,
                        pairingLinkId: grant.id,
                        status: "pending",
                      };
                      journal[`sent:${outgoingKey}`] = sent;
                    }
                    if (sent.status === "pending")
                      availableDeliveryIds.add(existing.header.deliveryId);
                  }
                }
                if (recipientConnected) {
                  sent = {
                    deliveryId: sent?.deliveryId ?? EXISTING_CONNECTION,
                    expiresAt: sent?.expiresAt ?? now,
                    status: "connected",
                  };
                  journal[`sent:${outgoingKey}`] = sent;
                }
                if (sent === undefined && outgoingExists) {
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
                    scopes: FleetAccessPolicy.fleetCredentialScopes(access),
                  });
                  if (sharedFolder) {
                    sent = { ...sent, pairingLinkId: issued.id };
                    journal[`sent:${outgoingKey}`] = sent;
                    yield* writeFleetJson(journalFile, journal);
                    activeLinks.push(issued);
                  }
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
                  if (sharedFolder) availableDeliveryIds.add(sent.deliveryId);
                }
                if (sent !== undefined) {
                  status = outgoingRejected
                    ? "uncertain"
                    : sent.status === "connected"
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
                  const grantAvailable =
                    sharedFolder &&
                    peerCatalog?.availableDeliveryIds?.includes(delivery.header.deliveryId) ===
                      true;
                  // The sender only offers a new grant to a connected machine to replace its credential.
                  const replacement =
                    grantAvailable &&
                    received?.status === "connected" &&
                    received.deliveryId !== delivery.header.deliveryId;
                  // A grant that follows an unspent replacement, such as one that lapsed while
                  // this machine was offline, still replaces.
                  const replacing =
                    replacement ||
                    (received?.replacing === true && received.status === "connecting");
                  if (
                    delivery.header.expiresAt > now &&
                    (received === undefined ||
                      received.deliveryId === delivery.header.deliveryId ||
                      (grantAvailable && received.status !== "connected") ||
                      replacement)
                  ) {
                    const open = Effect.try(() =>
                      Delivery.openDelivery(delivery, config, peer, self, now),
                    ).pipe(Effect.mapError(() => new LanFleetError({ reason: "configuration" })));
                    const payload = yield* sharedFolder
                      ? open.pipe(Effect.orElseSucceed(() => undefined))
                      : open;
                    if (payload === undefined) {
                      rejectedDeliveryIds.add(delivery.header.deliveryId);
                      status = "uncertain";
                    } else if (
                      input.connectedEnvironmentIds.includes(peer.environmentId) &&
                      // A saved connection proves nothing until the replacement grant is spent.
                      !(replacing && grantAvailable)
                    ) {
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
                      (!sharedFolder ||
                        peerCatalog?.availableDeliveryIds?.includes(delivery.header.deliveryId) ===
                          true) &&
                      (received === undefined ||
                        replacement ||
                        (sharedFolder &&
                          received.status === "connecting" &&
                          peerCatalog?.availableDeliveryIds?.includes(
                            delivery.header.deliveryId,
                          ) === true &&
                          (received.deliveryId !== delivery.header.deliveryId ||
                            received.senderCatalogCreatedAt === undefined ||
                            peerCatalog.createdAt > received.senderCatalogCreatedAt))) &&
                      incoming.length < 1 &&
                      (input.mode === "manual" || (input.mode === "automatic" && config.autoPickup))
                    ) {
                      journal[`received:${incomingKey}`] = {
                        deliveryId: delivery.header.deliveryId,
                        expiresAt: delivery.header.expiresAt,
                        status: "connecting",
                        ...(sharedFolder && peerCatalog !== undefined
                          ? { senderCatalogCreatedAt: peerCatalog.createdAt }
                          : {}),
                        ...(replacing ? { replacing: true } : {}),
                      };
                      yield* writeFleetJson(journalFile, journal);
                      const tls =
                        peer.tls === undefined
                          ? undefined
                          : {
                              origin: peer.tls.origin,
                              certificate: peer.tls.certificate,
                              publicKeySha256: peer.tls.publicKeySha256,
                              ...(peerCatalog?.connectHost === undefined
                                ? {}
                                : { connectHost: peerCatalog.connectHost }),
                            };
                      incoming.push({
                        deliveryId: delivery.header.deliveryId,
                        environmentId: peer.environmentId,
                        host: payload.origin,
                        pairingCode: payload.credential,
                        ...(tls === undefined ? {} : { tls }),
                        ...(replacing ? { replace: true } : {}),
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
            if (config.managed)
              yield* writeFleetJson(
                ownCatalogFile,
                Delivery.makeFleetCatalog(
                  config,
                  self,
                  input.connectedEnvironmentIds,
                  now,
                  sharedFolder ? [...availableDeliveryIds] : undefined,
                  sharedFolder ? connectHost : undefined,
                  sharedFolder && rejectedDeliveryIds.size > 0
                    ? [...rejectedDeliveryIds]
                    : undefined,
                ),
              );
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
    Effect.tap(() => requestPeerLinkPass),
  );
  const configure = Effect.fn("LanFleet.configure")(function* (input: LanFleetSetupInput) {
    const state = yield* enrollment.configure(input);
    yield* requestPeerLinkPass;
    return state;
  });
  return LanFleet.of({
    sync: run,
    backgroundSync: Effect.asVoid(run("background")),
    setup: enrollment.status,
    configure,
  });
});

export const layerServices = Layer.effect(LanFleet, make);
export const layer = layerServices.pipe(Layer.provide(FleetEnrollment.layer));

/**
 * Runs fleet sync from the server every five minutes, so renewal, access changes and revocation
 * do not wait for an open window. A client's sync is an extra nudge; the lock keeps one at a time.
 */
export const layerBackground = Layer.effectDiscard(
  Effect.gen(function* () {
    const fleet = yield* LanFleet;
    yield* Effect.forkScoped(
      fleet.backgroundSync.pipe(
        Effect.catch((error) =>
          error.reason === "busy"
            ? Effect.void
            : Effect.logWarning("Background LAN fleet sync failed.", { reason: error.reason }),
        ),
        Effect.repeat(Schedule.spaced(BACKGROUND_SYNC_INTERVAL)),
      ),
    );
  }),
).pipe(Layer.provide(layer));
