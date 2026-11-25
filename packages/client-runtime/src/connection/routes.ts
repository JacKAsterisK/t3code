import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import {
  sameFleetTlsIdentity,
  sameFleetTlsRoute,
  type DesktopSshEnvironmentTarget,
  type FleetTlsIdentity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { BearerConnectionTarget, type ConnectionTarget } from "./model.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type ConnectionRouteKind =
  | "relay"
  | "loopback"
  | "lan"
  | "tailnet"
  | "vpn"
  | "public"
  | "ssh";

export const RELAY_ROUTE_ID = "relay";

export function connectionRouteId(target: ConnectionTarget): string {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "primary";
    case "RelayConnectionTarget":
      return RELAY_ROUTE_ID;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

export function fleetTlsOfRoute(route: ConnectionRoute) {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? profile.fleetTls : undefined;
}

export function fleetDeliveryRoutes(
  entry: ConnectionCatalogEntry | undefined,
  fleetId: string | undefined,
) {
  if (entry === undefined || fleetId === undefined) return { saved: entry, retired: [] };
  const routes = connectionRoutes(entry);
  const retired = routes.filter(({ profile }) => {
    const saved = Option.getOrUndefined(profile);
    return (
      saved?._tag === "BearerConnectionProfile" &&
      saved.fleetId !== undefined &&
      saved.fleetId !== fleetId
    );
  });
  if (retired.length === 0) return { saved: entry, retired };
  const retained = retired.reduce(
    (routes, route) => routesAfterRemoving(routes, connectionRouteId(route.target)),
    routes,
  );
  return { retired, saved: retained.length === 0 ? undefined : entryWithRoutes(entry, retained) };
}

type FleetRouteCandidate = {
  readonly connectionId: string;
  readonly httpBaseUrl: string;
  readonly fleetTls?: FleetTlsIdentity;
  readonly fleetId?: string;
  readonly fleetDeliveryId?: string;
  readonly fleetReplacementDeliveryId?: string;
};

const SEPARATE_FLEET_CONNECTION_PREFIX = "fleet-bearer:";
const SEPARATE_MANUAL_CONNECTION_PREFIX = "manual-bearer:";

export function isFleetBearerProfile(profile: BearerConnectionProfile): boolean {
  return (
    profile.fleetId !== undefined ||
    profile.fleetTls !== undefined ||
    profile.fleetDeliveryId !== undefined
  );
}

export function manualPairingConnectionId(
  routes: ReadonlyArray<ConnectionRoute>,
  candidate: BearerConnectionProfile,
): string {
  const id = candidate.connectionId;
  const alternateId = SEPARATE_MANUAL_CONNECTION_PREFIX + id;
  const existing = routes.find((route) => {
    const existingId = connectionRouteId(route.target);
    const profile = Option.getOrUndefined(route.profile);
    return (
      (existingId === alternateId || existingId.startsWith(alternateId + ":")) &&
      sameFleetCandidateAddress(route, candidate) &&
      profile?._tag === "BearerConnectionProfile" &&
      !isFleetBearerProfile(profile)
    );
  });
  if (existing !== undefined) return connectionRouteId(existing.target);
  const collision = routes.some((route) => {
    const profile = Option.getOrUndefined(route.profile);
    return (
      connectionRouteId(route.target) === id &&
      profile?._tag === "BearerConnectionProfile" &&
      isFleetBearerProfile(profile)
    );
  });
  return collision ? availableRouteId(routes, alternateId) : id;
}

function availableRouteId(routes: ReadonlyArray<ConnectionRoute>, base: string): string {
  const occupied = new Set(routes.map((route) => connectionRouteId(route.target)));
  let available = base;
  for (let index = 1; occupied.has(available); index++) available = `${base}:${index}`;
  return available;
}

function sameFleetCandidateAddress(route: ConnectionRoute, candidate: FleetRouteCandidate) {
  return (
    routeHttpBaseUrl(route)?.replace(/\/+$/u, "") === candidate.httpBaseUrl.replace(/\/+$/u, "")
  );
}

function keepsSeparateFleetCredential(route: ConnectionRoute, candidate: FleetRouteCandidate) {
  const profile = Option.getOrUndefined(route.profile);
  return (
    (candidate.fleetId !== undefined || candidate.fleetTls !== undefined) &&
    connectionRouteId(route.target) !== candidate.connectionId &&
    profile?._tag === "BearerConnectionProfile" &&
    !isFleetBearerProfile(profile)
  );
}

function canRenewUnpinnedFleetRoute(route: ConnectionRoute, candidate: FleetRouteCandidate) {
  const profile = Option.getOrUndefined(route.profile);
  return (
    profile?._tag === "BearerConnectionProfile" &&
    profile.fleetId !== undefined &&
    profile.fleetId === candidate.fleetId &&
    profile.fleetTls === undefined &&
    (candidate.fleetTls !== undefined ||
      candidate.fleetDeliveryId !== undefined ||
      candidate.fleetReplacementDeliveryId !== undefined) &&
    profile.connectionId === candidate.connectionId &&
    connectionRouteId(route.target) === candidate.connectionId &&
    profile.learned !== true &&
    profile.authorization === undefined &&
    sameFleetCandidateAddress(route, candidate)
  );
}

export function fleetDeliveryConnectionId(
  routes: ReadonlyArray<ConnectionRoute>,
  candidate: FleetRouteCandidate,
): string {
  const existingFleet = routes.find((route) => {
    const profile = Option.getOrUndefined(route.profile);
    if (
      profile?._tag !== "BearerConnectionProfile" ||
      profile.learned === true ||
      !sameFleetCandidateAddress(route, candidate)
    )
      return false;
    if (candidate.fleetId !== undefined && profile.fleetId === candidate.fleetId) return true;
    return (
      (candidate.fleetId === undefined || profile.fleetId === undefined) &&
      candidate.fleetTls !== undefined &&
      profile.fleetTls !== undefined &&
      sameFleetTlsIdentity(profile.fleetTls, candidate.fleetTls)
    );
  });
  if (existingFleet !== undefined) return connectionRouteId(existingFleet.target);
  if (candidate.fleetId === undefined) return candidate.connectionId;
  const separateId =
    SEPARATE_FLEET_CONNECTION_PREFIX + JSON.stringify([candidate.fleetId, candidate.connectionId]);
  const needsSeparateId = routes.some((route) => {
    const id = connectionRouteId(route.target);
    const profile = Option.getOrUndefined(route.profile);
    return (
      (id === candidate.connectionId || sameFleetCandidateAddress(route, candidate)) &&
      profile?._tag === "BearerConnectionProfile" &&
      profile.fleetTls === undefined &&
      profile.fleetId !== candidate.fleetId
    );
  });
  if (!needsSeparateId) return candidate.connectionId;
  return availableRouteId(routes, separateId);
}

export function conflictsWithSavedFleetRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  candidate: FleetRouteCandidate,
  predecessor?: FleetTlsIdentity,
): boolean {
  return routes.some((route) => {
    if (
      connectionRouteId(route.target) !== candidate.connectionId &&
      !sameFleetCandidateAddress(route, candidate)
    )
      return false;
    if (keepsSeparateFleetCredential(route, candidate)) return false;
    const profile = Option.getOrUndefined(route.profile);
    if (profile?._tag !== "BearerConnectionProfile" || !sameFleetCandidateAddress(route, candidate))
      return true;
    if (
      profile.fleetId !== undefined &&
      candidate.fleetId !== undefined &&
      profile.fleetId !== candidate.fleetId
    )
      return true;
    if (profile.fleetTls !== undefined && candidate.fleetTls !== undefined) {
      return (
        !sameFleetTlsIdentity(profile.fleetTls, candidate.fleetTls) &&
        (profile.fleetId !== candidate.fleetId ||
          predecessor === undefined ||
          !sameFleetTlsRoute(profile.fleetTls, predecessor))
      );
    }
    return !canRenewUnpinnedFleetRoute(route, candidate);
  });
}

export function savedFleetIdentity(
  entry: ConnectionCatalogEntry | undefined,
  candidate?: FleetTlsIdentity,
) {
  if (entry === undefined) return undefined;
  const identities = connectionRoutes(entry).flatMap((route) => fleetTlsOfRoute(route) ?? []);
  if (identities.length === 1) return identities[0];
  if (identities.length === 0) return undefined;
  if (candidate === undefined) return null;
  const exact = identities.filter((identity) => sameFleetTlsIdentity(identity, candidate));
  return exact.length === 1 ? exact[0]! : null;
}

export function fleetReplacementRoutes(
  entry: ConnectionCatalogEntry | undefined,
  candidate: FleetRouteCandidate,
  predecessor: FleetTlsIdentity | undefined,
): ReadonlyArray<ConnectionRoute> | null {
  const current = savedFleetIdentity(entry, candidate.fleetTls);
  if (current === null || (current === undefined) !== (predecessor === undefined)) return null;
  if (
    current !== undefined &&
    (predecessor === undefined ||
      !sameFleetTlsRoute(current, predecessor) ||
      candidate.fleetTls === undefined)
  )
    return null;
  const retained =
    entry === undefined
      ? []
      : connectionRoutes(entry).filter((route) => {
          const tls = fleetTlsOfRoute(route);
          if (
            tls === undefined ||
            predecessor === undefined ||
            !sameFleetTlsRoute(tls, predecessor)
          )
            return true;
          const profile = Option.getOrUndefined(route.profile);
          // A legacy pin proves membership in this fleet only when the delivery presents the same identity.
          return (
            profile?._tag === "BearerConnectionProfile" &&
            (candidate.fleetId === undefined) !== (profile.fleetId === undefined) &&
            (candidate.fleetTls === undefined || !sameFleetTlsIdentity(tls, candidate.fleetTls))
          );
        });
  return retained.some(
    (route) =>
      !canRenewUnpinnedFleetRoute(route, candidate) &&
      (connectionRouteId(route.target) === candidate.connectionId ||
        (sameFleetCandidateAddress(route, candidate) &&
          !keepsSeparateFleetCredential(route, candidate))),
  )
    ? null
    : retained;
}

export function connectionRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [{ target: entry.target, profile: entry.profile }, ...(entry.alternateRoutes ?? [])];
}

export function entryWithRoutes(
  entry: ConnectionCatalogEntry,
  routes: ReadonlyArray<ConnectionRoute>,
): ConnectionCatalogEntry {
  const [first, ...rest] = routes;
  if (first === undefined) {
    throw new Error("A saved environment needs at least one route.");
  }
  const { alternateRoutes: _previous, ...base } = entry;
  return {
    ...base,
    target: first.target,
    profile: first.profile,
    ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
  };
}

export function routeEntry(
  entry: ConnectionCatalogEntry,
  route: ConnectionRoute,
): ConnectionCatalogEntry {
  return entryWithRoutes(entry, [route]);
}

export function routeHttpBaseUrl(route: ConnectionRoute): string | null {
  if (route.target._tag === "PrimaryConnectionTarget") return route.target.httpBaseUrl;
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? profile.httpBaseUrl : null;
}

function routeHostname(route: ConnectionRoute): string | null {
  const httpBaseUrl = routeHttpBaseUrl(route);
  if (httpBaseUrl === null) return null;
  try {
    return new URL(httpBaseUrl).hostname;
  } catch {
    return null;
  }
}

function directAddressKind(hostname: string, tailscale = false) {
  if (isLocalLoopbackHost(hostname)) return "loopback";
  if (tailscale || isTailnetHost(hostname)) return "tailnet";
  if (isSharedAddressSpaceHost(hostname)) return "vpn";
  return isPrivateNetworkHost(hostname) ? "lan" : "public";
}

export function connectionRouteKind(route: ConnectionRoute): ConnectionRouteKind {
  switch (route.target._tag) {
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
    case "PrimaryConnectionTarget":
    case "BearerConnectionTarget": {
      const hostname = routeHostname(route);
      if (hostname === null) return "public";
      const profile = Option.getOrNull(route.profile);
      return directAddressKind(
        hostname,
        profile?._tag === "BearerConnectionProfile" && profile.network === "tailscale",
      );
    }
  }
}

/**
 * Whether the route's address reaches the same machine on every network: TLS
 * proves who answers, and loopback cannot move. Any other plain http address,
 * a tailnet one too once Tailscale is down, can belong to another machine after
 * a network change, so an answer from it is not kept.
 */
export function routeKeepsItsHost(route: ConnectionRoute): boolean {
  if (routeHttpBaseUrl(route)?.startsWith("https:") === true) return true;
  return connectionRouteKind(route) === "loopback";
}

/** A loopback or LAN host answers within a few seconds or is not there. */
export function isNearbyAddress(httpBaseUrl: string): boolean {
  try {
    const kind = directAddressKind(new URL(httpBaseUrl).hostname);
    return kind === "loopback" || kind === "lan";
  } catch {
    return false;
  }
}

const ROUTE_KIND_RANK: Record<ConnectionRouteKind, number> = {
  loopback: 0,
  lan: 1,
  tailnet: 2,
  vpn: 2,
  public: 3,
  ssh: 4,
  relay: 5,
};

export function insertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  { aheadOfSameKind = false }: { readonly aheadOfSameKind?: boolean } = {},
): ReadonlyArray<ConnectionRoute> {
  const kind = connectionRouteKind(route);
  const rank = ROUTE_KIND_RANK[kind];
  const index = routes.findIndex((existing) => {
    const existingKind = connectionRouteKind(existing);
    return ROUTE_KIND_RANK[existingKind] > rank || (aheadOfSameKind && existingKind === kind);
  });
  return index === -1
    ? [...routes, route]
    : [...routes.slice(0, index), route, ...routes.slice(index)];
}

export function upsertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const id = connectionRouteId(route.target);
  return routes.some((existing) => connectionRouteId(existing.target) === id)
    ? routes.map((existing) => (connectionRouteId(existing.target) === id ? route : existing))
    : // A route paired at a new address, such as localhost beside a saved
      // 127.0.0.1, goes first among its kind so its fresh credential connects.
      insertRoute(routes, route, { aheadOfSameKind: true });
}

export function findRouteToSameAddress(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  mode: "lookup" | "replace" = "lookup",
): ConnectionRoute | undefined {
  const key = routeAddressKey(route);
  const id = connectionRouteId(route.target);
  return key === null
    ? undefined
    : routes.find((existing) => {
        if (routeAddressKey(existing) !== key) return false;
        const existingId = connectionRouteId(existing.target);
        if (mode === "lookup" || existingId === id) return true;
        const existingProfile = Option.getOrUndefined(existing.profile);
        const candidateProfile = Option.getOrUndefined(route.profile);
        return (
          !(
            existingProfile?._tag === "BearerConnectionProfile" &&
            isFleetBearerProfile(existingProfile)
          ) &&
          !(
            candidateProfile?._tag === "BearerConnectionProfile" &&
            isFleetBearerProfile(candidateProfile)
          )
        );
      });
}

function routeAddressKey(route: ConnectionRoute): string | null {
  const profile = Option.getOrNull(route.profile);
  switch (profile?._tag) {
    case "BearerConnectionProfile":
      return `bearer:${profile.httpBaseUrl.replace(/\/+$/, "")}`;
    case "SshConnectionProfile":
      return `ssh:${sshTargetKey(profile.target)}`;
    default:
      return null;
  }
}

const T3_CONNECT_NAME = "T3 Connect";

/** The route's label in English. Display sites use `connectionRouteLabelText`. */
export function connectionRouteLabel(route: ConnectionRoute): string {
  switch (connectionRouteKind(route)) {
    case "relay":
      return T3_CONNECT_NAME;
    case "loopback":
      return msg("This device");
    case "lan":
      return "LAN";
    case "tailnet":
      // Tailscale Serve answers over HTTPS on the machine's name; the same machine's
      // plain address is another route, so the two are told apart.
      return routeHttpBaseUrl(route)?.startsWith("https:") === true
        ? msg("Tailscale HTTPS")
        : "Tailscale";
    case "vpn":
      return "VPN";
    case "ssh": {
      const profile = Option.getOrNull(route.profile);
      return profile?._tag === "SshConnectionProfile"
        ? `SSH ${profile.target.username ? `${profile.target.username}@` : ""}${profile.target.hostname}`
        : "SSH";
    }
    case "public":
      return routeHostname(route) ?? msg("Remote link");
  }
}

/** @public */
export function connectionRouteLabelText(
  route: ConnectionRoute,
  resolve: MFunctionType = mFallback,
): string {
  switch (connectionRouteKind(route)) {
    case "loopback":
      return resolve(msg("This device"));
    case "public":
      return routeHostname(route) ?? resolve(msg("Remote link"));
    default:
      return connectionRouteLabel(route);
  }
}

export function connectionRouteAddress(route: ConnectionRoute): string | null {
  if (route.target._tag === "SshConnectionTarget") {
    const profile = Option.getOrNull(route.profile);
    return profile?._tag === "SshConnectionProfile" ? profile.target.alias : null;
  }
  return routeHttpBaseUrl(route);
}

/** Learned routes alone must not make relay environments manually retryable. */
export const hasSavedBearerRoute = (entry: ConnectionCatalogEntry) =>
  connectionRoutes(entry).some((r) => !isLearned(r) && r.target._tag === "BearerConnectionTarget");

export function hasRelayRoute(
  entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">,
): boolean {
  return [entry.target, ...(entry.alternateRoutes ?? []).map((route) => route.target)].some(
    (target) => target._tag === "RelayConnectionTarget",
  );
}

export function mergeLearnedRoutes(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly activeRoute: ConnectionRoute;
  readonly reported: ReadonlyArray<ReportedEndpoint>;
  /** Plain HTTP routes are unusable from an HTTPS page (mixed content). */
  readonly allowInsecure: boolean;
}): ReadonlyArray<ConnectionRoute> | null {
  const { entry } = input;
  const active = input.activeRoute.target;
  const saved = connectionRoutes(entry);
  if (active._tag !== "RelayConnectionTarget" && active._tag !== "BearerConnectionTarget") {
    return null;
  }
  const activeProfile = Option.getOrNull(input.activeRoute.profile);
  // A pinned fleet credential belongs to its approved endpoint, including
  // when a peer advertises another HTTPS or VPN route after authentication.
  if (activeProfile?._tag === "BearerConnectionProfile" && activeProfile.fleetTls !== undefined)
    return null;
  const authorization =
    active._tag === "RelayConnectionTarget" ||
    (activeProfile?._tag === "BearerConnectionProfile" &&
      activeProfile.authorization === "t3-connect")
      ? ("t3-connect" as const)
      : undefined;

  const reported = new Map<string, URL>();
  const tailscaleOrigins = new Set<string>();
  for (const endpoint of input.reported) {
    let url: URL;
    try {
      url = new URL(endpoint.httpBaseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.protocol === "http:" && !input.allowInsecure) continue;
    // A loopback address names whichever device opens it, never the server.
    if (isLocalLoopbackHost(url.hostname)) continue;
    reported.set(url.origin, url);
    if (endpoint.kind === "tailnet") tailscaleOrigins.add(url.origin);
  }
  const normalized = (url: string) => url.replace(/\/+$/, "");
  const known = new Set(
    saved.flatMap((route) => {
      const url = routeHttpBaseUrl(route);
      return url === null || isLearned(route) ? [] : [normalized(url)];
    }),
  );
  const kept = saved.flatMap((route): ReadonlyArray<ConnectionRoute> => {
    const url = routeHttpBaseUrl(route);
    if (!isLearned(route)) {
      return [
        url === null || !reported.has(normalized(url))
          ? route
          : withNetwork(route, tailscaleOrigins.has(normalized(url))),
      ];
    }
    if (url === null || !reported.has(normalized(url)) || known.has(normalized(url))) return [];
    if (isLegacyBorrowedRoute(route)) return [];
    known.add(normalized(url));
    return [withNetwork(route, tailscaleOrigins.has(normalized(url)))];
  });
  let next: ReadonlyArray<ConnectionRoute> = kept;
  for (const url of reported.values()) {
    if (known.has(url.origin)) continue;
    if (authorization === undefined) continue;
    const httpBaseUrl = `${url.origin}/`;
    const connectionId = `learned:${entry.target.environmentId}:${url.origin}`;
    next = insertRoute(next, {
      target: new BearerConnectionTarget({
        environmentId: entry.target.environmentId,
        label: entry.target.label,
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: entry.target.environmentId,
          label: entry.target.label,
          httpBaseUrl,
          wsBaseUrl: `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/`,
          learned: true,
          authorization,
          ...(tailscaleOrigins.has(url.origin) ? { network: "tailscale" as const } : {}),
        }),
      ),
    });
  }
  const signature = (routes: ReadonlyArray<ConnectionRoute>) =>
    routes
      .map(
        (route) =>
          `${connectionRouteId(route.target)} ${routeHttpBaseUrl(route) ?? ""} ${connectionRouteKind(route)}`,
      )
      .join("\n");
  return signature(saved) === signature(next) ? null : next;
}

export function isLegacyBorrowedRoute(route: ConnectionRoute): boolean {
  const id = connectionRouteId(route.target);
  const prefix = `learned:${route.target.environmentId}:`;
  return id.startsWith(prefix) && id.indexOf("@", prefix.length) !== -1;
}

export function usableRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  const saved = connectionRoutes(entry).filter((route) => !isLegacyBorrowedRoute(route));
  const routes = [...saved];
  for (const route of saved) {
    const profile = Option.getOrUndefined(route.profile);
    if (profile?._tag !== "BearerConnectionProfile" || !isFleetBearerProfile(profile)) continue;
    const index = routes.indexOf(route);
    const address = routeAddressKey(route);
    const manual = routes.findIndex((other) => {
      const profile = Option.getOrUndefined(other.profile);
      return (
        profile?._tag === "BearerConnectionProfile" &&
        !isFleetBearerProfile(profile) &&
        routeAddressKey(other) === address
      );
    });
    if (manual !== -1 && manual < index) {
      routes.splice(index, 1);
      routes.splice(manual, 0, route);
    }
  }
  return routes;
}

export interface ReportedEndpoint {
  readonly httpBaseUrl: string;
  readonly kind?: string;
}

function withNetwork(route: ConnectionRoute, tailscale: boolean): ConnectionRoute {
  const profile = Option.getOrNull(route.profile);
  if (profile?._tag !== "BearerConnectionProfile") return route;
  if ((profile.network === "tailscale") === tailscale) return route;
  const { network: _network, ...saved } = profile;
  return {
    target: route.target,
    profile: Option.some(
      new BearerConnectionProfile({
        ...saved,
        ...(tailscale ? { network: "tailscale" as const } : {}),
      }),
    ),
  };
}

export function isLearned(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" && profile.learned === true;
}

/**
 * Removing T3 Connect also removes routes learned through it.
 */
export function routesAfterRemoving(
  routes: ReadonlyArray<ConnectionRoute>,
  removedId: string,
): ReadonlyArray<ConnectionRoute> {
  const removed = routes.find((route) => connectionRouteId(route.target) === removedId);
  if (removed === undefined) return routes;
  return routes.filter((route) => {
    if (route === removed) return false;
    if (!isLearned(route)) return true;
    const profile = Option.getOrNull(route.profile);
    if (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {
      return removed.target._tag !== "RelayConnectionTarget";
    }
    return !isLegacyBorrowedRoute(route);
  });
}

/**
 * A dragged route order shows until the saved routes catch up with it. It is
 * stale, and returns null, once the saved order matches it or the saved routes
 * are no longer the same set: kept any longer, it would hide a route added
 * later whenever the count happened to match again.
 */
export function pendingRouteOrder(
  pending: ReadonlyArray<string> | null,
  savedIds: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  if (pending === null || pending.length !== savedIds.length) return null;
  const saved = new Set(savedIds);
  if (!pending.every((id) => saved.has(id))) return null;
  return pending.some((id, index) => id !== savedIds[index]) ? pending : null;
}

export function removedWithRelay(entry: ConnectionCatalogEntry): boolean {
  return routesAfterRemoving(connectionRoutes(entry), RELAY_ROUTE_ID).length === 0;
}

export function sshTargetKey(target: DesktopSshEnvironmentTarget): string {
  return JSON.stringify([target.alias, target.hostname, target.username, target.port]);
}
