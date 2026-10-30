// @effect-diagnostics nodeBuiltinImport:off -- Random request and delivery identifiers contain no machine or credential data.
import * as NodeCrypto from "node:crypto";
import {
  AuthMcpClientAccess,
  type AuthSessionId,
  EnvironmentId,
  FleetAccess as FleetAccessLevel,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as FleetContext from "./FleetContext.ts";
import * as Delivery from "./FleetDelivery.ts";
import { readFleetJson, writeFleetJson } from "./FleetFiles.ts";
import { FleetPeerTrust } from "./FleetPeerHttpClient.ts";

/** Overrides how long before expiry a link renews, as a duration such as `"31 days"`; for the live proof. */
export const RENEW_WITHIN_ENV = "T3CODE_LAN_PEER_LINK_RENEW_WITHIN";
const DEFAULT_RENEW_WITHIN = Duration.days(7);
const CODE_TTL = Duration.hours(1);
const REQUEST_TTL = Duration.hours(1);
const PASS_INTERVAL = Duration.minutes(10);
const LINK_TIMEOUT = Duration.minutes(1);
const SUBJECT_PREFIX = "lan-fleet-peer-link:";

type Level = FleetAccessLevel;

/**
 * What a fleet peer link may do here at each fleet access level. Standard matches what a fleet
 * connection allows, unfenced; read-only reads.
 */
const linkAccess = (level: Level): AuthMcpClientAccess =>
  level === "read-only" ? "read-only" : "full-access";
const rank = (level: Level) => (level === "read-only" ? 0 : 1);

const Linking = Schema.Struct({
  environmentId: EnvironmentId,
  link: Schema.optionalKey(
    Schema.Struct({
      access: AuthMcpClientAccess,
      deliveryId: Schema.String,
      linkedAt: Schema.String,
      // Linked below what the issuer offered, at this machine's own access at the time.
      clamped: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  request: Schema.optionalKey(
    Schema.Struct({ requestId: Schema.String, expiresAt: Schema.Number }),
  ),
  consumedDeliveryId: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
});
type Linking = typeof Linking.Type;
const Serving = Schema.Struct({
  offer: Schema.optionalKey(
    Schema.Struct({ deliveryId: Schema.String, level: FleetAccessLevel, expiresAt: Schema.Number }),
  ),
  answeredRequestId: Schema.optionalKey(Schema.String),
  linked: Schema.optionalKey(Schema.Struct({ deliveryId: Schema.String, level: FleetAccessLevel })),
  sessions: Schema.Array(
    Schema.Struct({ sessionId: Schema.String, deliveryId: Schema.String, level: FleetAccessLevel }),
  ),
});
type Serving = typeof Serving.Type;
const State = Schema.Struct({
  version: Schema.Literal(1),
  /** Links this machine made to fleet peers, by the peer's machine ID. */
  linking: Schema.Record(Schema.String, Linking),
  /** Links fleet peers made to this machine, by the peer's machine ID. */
  serving: Schema.Record(Schema.String, Serving),
});
type State = typeof State.Type;
const emptyState: State = { version: 1, linking: {}, serving: {} };
const emptyServing: Serving = { sessions: [] };

const codePrefix = (machineId: string) => `${SUBJECT_PREFIX}${machineId}:`;

/**
 * Links this machine to each trusted fleet peer as a linked environment, renews and forgets those
 * links; the machine linked to mints each code at its policy's access and revokes the sessions it
 * replaces or narrows. Off unless `fleetLinkedEnvironmentsEnabled` is set, and idle until the
 * fleet has a Machine access list.
 */
export class FleetPeerLinks extends Context.Service<
  FleetPeerLinks,
  {
    /** One pass over every fleet peer, both as the linking machine and as the one linked to. */
    readonly pass: Effect.Effect<void>;
    /** Asks for a pass soon without waiting for it. */
    readonly requestPass: Effect.Effect<void>;
    /** Runs requested passes until interrupted. */
    readonly run: Effect.Effect<never>;
    /** Records which fleet peer a new peer-link session belongs to; false when it could not. */
    readonly sessionIssued: McpOAuth.McpPeerLinkSessionObserver["Service"]["sessionIssued"];
  }
>()("t3/lan/FleetPeerLinks") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const launchEnvironment = yield* HostProcess.Environment;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
  const context = yield* FleetContext.FleetContext;
  const trust = yield* FleetPeerTrust;
  const stateFile = path.join(serverConfig.stateDir, "lan-fleet-peer-links.json");
  const passLock = yield* Semaphore.make(1);
  const writeLock = yield* Semaphore.make(1);
  const requests = yield* Queue.sliding<void>(1);
  const saved = yield* readFleetJson(stateFile, State).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.orElseSucceed(() => emptyState),
  );
  const state = yield* Ref.make<State>(saved);

  // Updates are applied to the latest state, never a pass's snapshot: a session can be
  // attributed while a pass runs, and that must never wait for the pass's network calls.
  const persist = writeLock.withPermits(1)(
    Ref.get(state).pipe(
      Effect.flatMap((current) => writeFleetJson(stateFile, current)),
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  );
  const updateServing = (machineId: string, f: (entry: Serving) => Serving | undefined) =>
    Ref.update(state, (current) => {
      const serving = { ...current.serving };
      const next = f(current.serving[machineId] ?? emptyServing);
      if (next === undefined) delete serving[machineId];
      else serving[machineId] = next;
      return { ...current, serving };
    }).pipe(Effect.andThen(persist));
  const setLinking = (machineId: string, entry: Linking | undefined) =>
    Ref.update(state, (current) => {
      const linking = { ...current.linking };
      if (entry === undefined) delete linking[machineId];
      else linking[machineId] = entry;
      return { ...current, linking };
    }).pipe(Effect.andThen(persist));

  const shareFile = (directory: string, name: string) => path.join(directory, name);
  const readShare = <A>(file: string, schema: Schema.Codec<A, unknown>) =>
    readFleetJson(file, schema).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.option,
    );
  const writeShare = (file: string, value: unknown) =>
    writeFleetJson(file, value).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const removeShare = (file: string) => fs.remove(file).pipe(Effect.ignore);

  const revokeCodes = (prefix: string) =>
    auth.listPairingLinks().pipe(
      Effect.flatMap((codes) =>
        Effect.forEach(
          codes.filter((code) => code.subject.startsWith(prefix)),
          (code) => auth.revokePairingLink(code.id),
          { discard: true },
        ),
      ),
    );

  const renewWithin = () => {
    const raw = launchEnvironment[RENEW_WITHIN_ENV];
    return raw === undefined
      ? DEFAULT_RENEW_WITHIN
      : Option.getOrElse(Duration.fromInput(raw as Duration.Input), () => DEFAULT_RENEW_WITHIN);
  };

  /** As the machine linked to: offers codes, attributes and revokes `peer`'s link sessions here. */
  const serve = Effect.fn("FleetPeerLinks.serve")(function* (
    fleet: FleetContext.FleetLinkContext,
    peer: Delivery.FleetPeer,
    now: number,
    active: ReadonlySet<string>,
  ) {
    const files = Delivery.peerLinkFileNames(fleet.self.machineId, peer.machineId);
    const offerFile = shareFile(fleet.deliveryDirectory, files.offer);
    const receiptFile = shareFile(fleet.deliveryDirectory, files.receipt);
    const level = yield* fleetAccess.accessFor(peer.environmentId);
    const entry = (yield* Ref.get(state)).serving[peer.machineId] ?? emptyServing;
    const known = new Set(entry.sessions.map((session) => session.sessionId));
    const revoked = new Set<string>();
    const revoke = (sessionId: string) =>
      auth
        .revokeSession(sessionId as AuthSessionId)
        .pipe(Effect.tap(() => Effect.sync(() => revoked.add(sessionId))));
    // Narrowed access ends at once; calls fail until the peer relinks, never with the old access.
    // A policy the share could not just give only caps each call.
    const policy = yield* fleetAccess.current;
    const narrows = FleetAccessPolicy.mayRevokeForAccess(policy);
    for (const session of entry.sessions)
      if (
        active.has(session.sessionId) &&
        (level === undefined || (narrows && rank(session.level) > rank(level)))
      )
        yield* revoke(session.sessionId);
    let offer = entry.offer;
    let linked = entry.linked;
    let answeredRequestId = entry.answeredRequestId;
    const dropOffer = Effect.gen(function* () {
      if (offer === undefined) return;
      yield* revokeCodes(`${codePrefix(peer.machineId)}${offer.deliveryId}`);
      yield* removeShare(offerFile);
      offer = undefined;
    });
    if (offer !== undefined) {
      const receipt = yield* readShare(receiptFile, Delivery.Receipt);
      if (
        Option.isSome(receipt) &&
        Delivery.verifyReceipt(receipt.value, offer.deliveryId, fleet.self, peer)
      ) {
        const current = offer;
        linked = { deliveryId: current.deliveryId, level: current.level };
        // The peer replaced its token: the sessions it held before are unused from now on.
        for (const session of entry.sessions)
          if (session.deliveryId !== current.deliveryId && !revoked.has(session.sessionId))
            yield* revoke(session.sessionId);
        yield* removeShare(offerFile);
        yield* removeShare(receiptFile);
        offer = undefined;
      } else if (offer.expiresAt <= now || offer.level !== level) yield* dropOffer;
    }
    const live = entry.sessions.filter(
      (session) => active.has(session.sessionId) && !revoked.has(session.sessionId),
    );
    const request = yield* readShare(
      shareFile(fleet.deliveryDirectory, files.request),
      Delivery.PeerLinkRequest,
    );
    const asked =
      Option.isSome(request) &&
      request.value.requestId !== answeredRequestId &&
      Delivery.verifyPeerLinkRequest(request.value, peer, fleet.self, now);
    // A linked peer whose access changed, or whose session ended here, gets a code unasked.
    const stale = linked !== undefined && (linked.level !== level || live.length === 0);
    // The list may have narrowed while this pass read the share: mint at no more than it says now.
    const mintPolicy = yield* fleetAccess.current;
    const mintLevel = yield* fleetAccess.accessFor(peer.environmentId);
    const granted =
      level === undefined || mintLevel === undefined
        ? undefined
        : rank(mintLevel) < rank(level)
          ? mintLevel
          : level;
    if (granted !== undefined && offer === undefined && (asked || stale)) {
      yield* revokeCodes(codePrefix(peer.machineId));
      const deliveryId = NodeCrypto.randomUUID();
      const issued = yield* auth.createPairingLink({
        ttl: CODE_TTL,
        subject: `${codePrefix(peer.machineId)}${deliveryId}`,
        scopes: mcpClientScopes(linkAccess(granted)),
      });
      const expiresAt = Math.min(
        DateTime.toEpochMillis(issued.expiresAt),
        now + Duration.toMillis(CODE_TTL),
      );
      yield* writeShare(
        offerFile,
        Delivery.sealDelivery({
          config: fleet.config,
          sender: fleet.self,
          recipient: peer,
          deliveryId,
          expiresAt,
          credential: issued.credential,
          // Tells the peer this code follows a Machine access list, unlike a 1.0.25 offer.
          peerLink: { access: linkAccess(granted), policyRevision: mintPolicy.revision },
        }),
      );
      offer = { deliveryId, level: granted, expiresAt };
      if (asked) answeredRequestId = request.value.requestId;
    } else if (granted === undefined) yield* revokeCodes(codePrefix(peer.machineId));
    yield* updateServing(peer.machineId, (current) => ({
      ...(offer === undefined ? {} : { offer }),
      ...(answeredRequestId === undefined ? {} : { answeredRequestId }),
      ...(linked === undefined ? {} : { linked }),
      // Keep sessions attributed while this pass ran; drop ended and revoked ones.
      sessions: current.sessions.filter(
        (session) =>
          !revoked.has(session.sessionId) &&
          (active.has(session.sessionId) || !known.has(session.sessionId)),
      ),
    }));
  });

  /** A peer left the fleet, or this adapter was turned off: nothing it was given here stays usable. */
  const forgetServed = Effect.fn("FleetPeerLinks.forgetServed")(function* (
    fleet: FleetContext.FleetLinkContext | undefined,
    machineId: string,
  ) {
    const entry = (yield* Ref.get(state)).serving[machineId] ?? emptyServing;
    for (const session of entry.sessions)
      yield* auth.revokeSession(session.sessionId as AuthSessionId);
    yield* revokeCodes(codePrefix(machineId));
    if (fleet !== undefined) {
      const files = Delivery.peerLinkFileNames(fleet.self.machineId, machineId);
      yield* removeShare(shareFile(fleet.deliveryDirectory, files.offer));
      yield* removeShare(shareFile(fleet.deliveryDirectory, files.receipt));
    }
    yield* updateServing(machineId, () => undefined);
  });

  /**
   * What this machine's own accepted list lets it do on its peers, read live each time: no link it
   * makes or keeps goes above it, whatever an issuer with another view of the list offers.
   */
  const ownCeiling = fleetAccess.current.pipe(
    Effect.map((policy) => linkAccess(FleetAccessPolicy.selfAccess(policy))),
  );
  /**
   * Unlinks `peer` at once when its link is above this machine's own access: its issuer may not
   * know the list that narrowed it. True when it did.
   */
  const dropOverAccess = Effect.fn("FleetPeerLinks.dropOverAccess")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* peerLinks.get(environmentId);
    if (
      Option.isNone(current) ||
      current.value.access === "read-only" ||
      (yield* ownCeiling) !== "read-only"
    )
      return false;
    yield* peerLinks.unlink(environmentId);
    yield* Ref.update(state, (latest) => ({
      ...latest,
      linking: Object.fromEntries(
        Object.entries(latest.linking).map(([machineId, entry]) => {
          if (entry.environmentId !== environmentId) return [machineId, entry];
          const { link: _dropped, ...rest } = entry;
          return [machineId, rest];
        }),
      ),
    })).pipe(Effect.andThen(persist));
    return true;
  });

  /** As the linking machine: links to `peer` with the code it offered, and asks for one when due. */
  const link = Effect.fn("FleetPeerLinks.link")(function* (
    fleet: FleetContext.FleetLinkContext,
    peer: Delivery.FleetPeer,
    origin: string,
    now: number,
  ) {
    const files = Delivery.peerLinkFileNames(peer.machineId, fleet.self.machineId);
    const requestFile = shareFile(fleet.deliveryDirectory, files.request);
    let entry: Linking = (yield* Ref.get(state)).linking[peer.machineId] ?? {
      environmentId: peer.environmentId,
    };
    const offered = yield* readShare(
      shareFile(fleet.deliveryDirectory, files.offer),
      Delivery.Delivery,
    );
    if (Option.isSome(offered) && offered.value.header.deliveryId !== entry.consumedDeliveryId) {
      const delivery = offered.value;
      const payload = yield* Effect.try(() =>
        Delivery.openDelivery(delivery, fleet.config, peer, fleet.self, now, "peer-link"),
      ).pipe(Effect.option);
      if (
        Option.isSome(payload) &&
        payload.value.access !== undefined &&
        payload.value.policyRevision === undefined
      ) {
        // A 1.0.25 issuer offers without a list at its setup access, normally full access, even
        // to a machine the fleet made read-only. Such an offer is never used.
        yield* Effect.logWarning(
          "Ignored a fleet peer link offer from a machine that does not follow the access list yet.",
          { peer: peer.machineId },
        );
        entry = {
          ...entry,
          lastError: "peer_needs_update",
          consumedDeliveryId: delivery.header.deliveryId,
        };
      } else if (Option.isSome(payload) && payload.value.access !== undefined) {
        // A code at a wider access also signs in at a narrower one, and the session gets only that.
        const access = (yield* ownCeiling) === "read-only" ? "read-only" : payload.value.access;
        const linked = yield* peerLinks
          .link({
            url: origin,
            expectedEnvironmentId: peer.environmentId,
            expectedLabel: peer.label,
            pairingCode: payload.value.credential,
            access,
          })
          .pipe(Effect.timeout(LINK_TIMEOUT), Effect.result);
        if (linked._tag === "Success") {
          // The list may have narrowed during the sign-in.
          const dropped = yield* dropOverAccess(peer.environmentId);
          yield* writeShare(
            shareFile(fleet.deliveryDirectory, files.receipt),
            Delivery.makeReceipt(delivery, fleet.config),
          );
          yield* removeShare(requestFile);
          entry = {
            environmentId: peer.environmentId,
            ...(dropped
              ? {}
              : {
                  link: {
                    access,
                    deliveryId: delivery.header.deliveryId,
                    linkedAt: DateTime.formatIso(linked.success.linkedAt),
                    ...(access === payload.value.access ? {} : { clamped: true }),
                  },
                }),
            consumedDeliveryId: delivery.header.deliveryId,
          };
        } else {
          const reason =
            linked.failure._tag === "PeerLinkError" ? linked.failure.reason : "unreachable";
          yield* Effect.logWarning("A fleet peer link could not be made.", {
            peer: peer.machineId,
            reason,
          });
          // A refused code stays refused; an unreachable peer may answer on a later pass.
          entry = {
            ...entry,
            lastError: reason,
            ...(reason === "unreachable" ? {} : { consumedDeliveryId: delivery.header.deliveryId }),
          };
        }
      }
    }
    if (yield* dropOverAccess(peer.environmentId)) {
      const { link: _dropped, ...rest } = entry;
      entry = rest;
    }
    const current = yield* peerLinks.get(peer.environmentId);
    const ceiling = yield* ownCeiling;
    const recorded = entry.link;
    const due =
      recorded === undefined ||
      Option.isNone(current) ||
      current.value.access !== recorded.access ||
      DateTime.formatIso(current.value.linkedAt) !== recorded.linkedAt ||
      current.value.urls[0] !== origin ||
      // Linked below the offer while this machine was read-only, and it no longer is.
      (recorded.clamped === true && ceiling !== "read-only") ||
      DateTime.toEpochMillis(current.value.expiresAt) - now <= Duration.toMillis(renewWithin());
    const outstanding =
      entry.request !== undefined &&
      entry.request.expiresAt > now &&
      (yield* fs.exists(requestFile).pipe(Effect.orElseSucceed(() => false)));
    if (due && !outstanding) {
      const requestId = NodeCrypto.randomUUID();
      const expiresAt = now + Duration.toMillis(REQUEST_TTL);
      yield* writeShare(
        requestFile,
        Delivery.makePeerLinkRequest({
          config: fleet.config,
          recipient: peer,
          requestId,
          now,
          expiresAt,
        }),
      );
      entry = { ...entry, request: { requestId, expiresAt } };
    }
    yield* setLinking(peer.machineId, entry);
  });

  /**
   * A peer left the fleet, or this adapter was turned off: forget the link this adapter made to
   * it. Other links are never touched.
   */
  const forgetLink = Effect.fn("FleetPeerLinks.forgetLink")(function* (
    fleet: FleetContext.FleetLinkContext | undefined,
    machineId: string,
    entry: Linking,
  ) {
    yield* peerLinks.unlink(entry.environmentId);
    if (fleet !== undefined) {
      const files = Delivery.peerLinkFileNames(machineId, fleet.self.machineId);
      yield* removeShare(shareFile(fleet.deliveryDirectory, files.request));
    }
    yield* setLinking(machineId, undefined);
  });

  /**
   * Turned off means off: the links this adapter made are forgotten, and every peer-link code and
   * session this machine issued is revoked, including any its state lost track of. Ordinary fleet
   * connections are not peer links and are left alone.
   */
  const switchOff = Effect.fn("FleetPeerLinks.switchOff")(function* () {
    yield* trust.replace([]);
    const current = yield* Ref.get(state);
    const tracked = Object.keys(current.linking).length + Object.keys(current.serving).length;
    const fleet =
      tracked === 0 ? undefined : yield* context.load.pipe(Effect.orElseSucceed(() => undefined));
    yield* forEachPeer(
      Object.entries(current.linking),
      ([machineId]) => machineId,
      ([machineId, entry]) => forgetLink(fleet, machineId, entry),
    );
    yield* forEachPeer(
      Object.keys(current.serving),
      (machineId) => machineId,
      (machineId) => forgetServed(fleet, machineId),
    );
    yield* revokeCodes(SUBJECT_PREFIX);
    for (const session of yield* auth.listSessions())
      if (
        CredentialAttribution.attributionRoot(session.subject)?.startsWith(SUBJECT_PREFIX) === true
      )
        yield* auth.revokeSession(session.sessionId);
  });

  /** On only when settings positively say so; a settings read error changes nothing. */
  const adapterSetting = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.fleetLinkedEnvironmentsEnabled),
    Effect.option,
  );

  const forEachPeer = <A, E>(
    items: ReadonlyArray<A>,
    machineId: (item: A) => string,
    f: (item: A) => Effect.Effect<void, E>,
  ) =>
    Effect.forEach(
      items,
      (item) =>
        f(item).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Fleet peer link pass failed for a peer.", {
              peer: machineId(item),
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const pass = passLock.withPermits(1)(
    Effect.gen(function* () {
      const enabled = yield* adapterSetting;
      if (Option.isNone(enabled)) return;
      if (!enabled.value) {
        yield* switchOff();
        return;
      }
      // Before anything reads the share or a peer, so a slow or failing one never keeps a link
      // above this machine's own access.
      const known = yield* fleetAccess.current;
      yield* forEachPeer(
        [
          ...new Set([
            ...known.peers.map((peer) => EnvironmentId.make(peer.environmentId)),
            ...Object.values((yield* Ref.get(state)).linking).map((entry) => entry.environmentId),
          ]),
        ],
        (environmentId) => environmentId,
        dropOverAccess,
      );
      const fleet = yield* context.load;
      if (fleet === undefined) {
        yield* trust.replace([]);
        return;
      }
      yield* trust.replace(
        fleet.peers.flatMap(({ peer, connectHost }) => {
          if (peer.tls === undefined) return [];
          const host = connectHost ?? peer.tls.connectHost;
          return [
            {
              origin: peer.tls.origin,
              certificate: peer.tls.certificate,
              publicKeySha256: peer.tls.publicKeySha256,
              ...(host === undefined ? {} : { connectHost: host }),
            },
          ];
        }),
      );
      const now = yield* Clock.currentTimeMillis;
      const members = new Set(fleet.peers.map(({ peer }) => peer.machineId));
      const current = yield* Ref.get(state);
      const active = new Set((yield* auth.listSessions()).map((session) => session.sessionId));
      yield* forEachPeer(
        Object.keys(current.serving).filter((machineId) => !members.has(machineId)),
        (machineId) => machineId,
        (machineId) => forgetServed(fleet, machineId),
      );
      // Until the fleet has a Machine access list, a code would carry each machine's setup access,
      // normally standard, even for a machine the fleet means to make read-only.
      const policy = yield* fleetAccess.current;
      if (!FleetAccessPolicy.policyApplies(policy)) return;
      yield* forEachPeer(
        fleet.peers,
        ({ peer }) => peer.machineId,
        ({ peer }) => serve(fleet, peer, now, active),
      );
      if (!(yield* peerLinks.enabled)) return;
      yield* forEachPeer(
        Object.entries(current.linking).filter(([machineId]) => !members.has(machineId)),
        ([machineId]) => machineId,
        ([machineId, entry]) => forgetLink(fleet, machineId, entry),
      );
      yield* forEachPeer(
        fleet.peers,
        ({ peer }) => peer.machineId,
        ({ peer }) =>
          peer.tls === undefined ? Effect.void : link(fleet, peer, peer.tls.origin, now),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Fleet peer link pass failed.", { cause })),
      Effect.withSpan("FleetPeerLinks.pass"),
    ),
  );

  const sessionIssued: FleetPeerLinks["Service"]["sessionIssued"] = ({ subject, sessionId }) => {
    if (!subject.startsWith(SUBJECT_PREFIX)) return Effect.succeed(true);
    const [machineId, deliveryId] = subject.slice(SUBJECT_PREFIX.length).split(":");
    if (machineId === undefined || deliveryId === undefined) return Effect.succeed(false);
    // A peer that still has the adapter on is refused here while this machine has it off.
    return adapterSetting.pipe(
      Effect.flatMap((enabled) =>
        Option.isSome(enabled) && enabled.value
          ? recordSession(machineId, deliveryId, sessionId)
          : Effect.succeed(false),
      ),
    );
  };
  const recordSession = (machineId: string, deliveryId: string, sessionId: string) =>
    updateServing(machineId, (current) => ({
      ...current,
      sessions: [
        ...current.sessions,
        {
          sessionId,
          deliveryId,
          // A code this machine no longer tracks is treated as the widest, so narrowing revokes it.
          level: current.offer?.deliveryId === deliveryId ? current.offer.level : "standard",
        },
      ],
    })).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("A fleet peer link session could not be recorded.", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  return FleetPeerLinks.of({
    pass,
    requestPass: Queue.offer(requests, undefined).pipe(Effect.asVoid),
    run: Queue.take(requests).pipe(Effect.andThen(pass), Effect.forever),
    sessionIssued,
  });
});

/** The adapter alone, for tests that drive passes themselves. */
export const layerServices = Layer.effect(FleetPeerLinks, make);

/** Passes at startup, every ten minutes, and whenever the fleet policy or settings change. */
const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const links = yield* FleetPeerLinks;
    const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    yield* Effect.forkScoped(links.run);
    yield* Effect.forkScoped(links.requestPass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL))));
    yield* Effect.forkScoped(Stream.runForEach(fleetAccess.changes, () => links.requestPass));
    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, () => links.requestPass),
    );
  }),
);

const layerSessionObserver = Layer.effect(
  McpOAuth.McpPeerLinkSessionObserver,
  FleetPeerLinks.pipe(
    Effect.map((links) =>
      McpOAuth.McpPeerLinkSessionObserver.of({ sessionIssued: links.sessionIssued }),
    ),
  ),
);

export const layer = Layer.mergeAll(layerWorker, layerSessionObserver).pipe(
  Layer.provideMerge(layerServices),
  Layer.provide(FleetContext.layer),
);
