import type { FleetAccess as FleetAccessLevel } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as FleetContext from "./FleetContext.ts";
import * as Delivery from "./FleetDelivery.ts";

const FLEET_CREDENTIAL_PREFIX = "lan-fleet:";
const PEER_LINK_PREFIX = "lan-fleet-peer-link:";
const PASS_INTERVAL = Duration.minutes(10);

/** What a credential may do here now: a fleet access level, or nothing at all. */
type Limit = FleetAccessLevel | "none";

/**
 * The receiving side of the fleet access policy. Every credential a fleet machine holds here, its
 * own or one minted or approved through it, is limited to that machine's current access each time
 * it is used, so a narrowed policy applies before anything is revoked. A machine that left the
 * fleet, or that this machine no longer trusts, may use nothing.
 */
export class FleetCredentialAccess extends Context.Service<
  FleetCredentialAccess,
  {
    /** The limit for a credential's subject; undefined when no fleet machine is behind it. */
    readonly limit: (subject: string, taskGrant: boolean) => Effect.Effect<Limit | undefined>;
    readonly scopes: CredentialAttribution.CredentialAccessCap["Service"]["scopes"];
    /** The machines a full trust check last found; anything outside them is refused. */
    readonly setTrusted: (machineIds: ReadonlySet<string>) => Effect.Effect<void>;
  }
>()("t3/lan/FleetCredentialAccess") {}

const restrictsAnyone = (state: FleetAccessPolicy.FleetAccessState) =>
  FleetAccessPolicy.policyApplies(state) &&
  (state.defaultAccess === "read-only" ||
    state.machines.some((machine) => machine.access === "read-only"));

const make = Effect.gen(function* () {
  const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
  const trusted = yield* Ref.make<ReadonlySet<string> | undefined>(undefined);

  const machineOf = (root: string, state: FleetAccessPolicy.FleetAccessState) => {
    if (root.startsWith(PEER_LINK_PREFIX)) return root.slice(PEER_LINK_PREFIX.length).split(":")[0];
    const key = root.slice(FLEET_CREDENTIAL_PREFIX.length);
    return state.peers.find(
      (peer) => Delivery.deliveryFileName(state.machineId!, peer.machineId) === key,
    )?.machineId;
  };

  const limit: FleetCredentialAccess["Service"]["limit"] = Effect.fn("FleetCredentialAccess.limit")(
    function* (subject, taskGrant) {
      const state = yield* fleetAccess.current;
      if (state.machineId === undefined) return undefined;
      const root = CredentialAttribution.attributionRoot(subject);
      if (root === undefined)
        // A task grant from before grants recorded their approver could be any machine's.
        return taskGrant &&
          subject === CredentialAttribution.MCP_CLIENT_SUBJECT &&
          restrictsAnyone(state)
          ? "read-only"
          : undefined;
      const machineId = machineOf(root, state);
      const trust = yield* Ref.get(trusted);
      if (
        machineId === undefined ||
        !state.peers.some((peer) => peer.machineId === machineId) ||
        (trust !== undefined && !trust.has(machineId))
      )
        return "none";
      return FleetAccessPolicy.policyApplies(state)
        ? FleetAccessPolicy.callerAccess(state, machineId)
        : "standard";
    },
  );

  const readOnly = FleetAccessPolicy.fleetCredentialScopes("read-only");
  const scopes: FleetCredentialAccess["Service"]["scopes"] = (credential) =>
    limit(credential.subject, credential.taskGrant === true).pipe(
      Effect.map((level) =>
        level === undefined || level === "standard"
          ? credential.scopes
          : level === "none"
            ? undefined
            : credential.scopes.filter((scope) => readOnly.includes(scope)),
      ),
    );

  return FleetCredentialAccess.of({
    limit,
    scopes,
    setTrusted: Effect.fn("FleetCredentialAccess.setTrusted")((machineIds) =>
      Ref.set(trusted, machineIds),
    ),
  });
});

export const layerServices = Layer.effect(FleetCredentialAccess, make);
const layer = layerServices.pipe(Layer.provide(FleetAccessPolicy.layer));

/** The cap EnvironmentAuth and the WebSocket RPC apply to every credential they verify. */
export const layerCap = Layer.effect(
  CredentialAttribution.CredentialAccessCap,
  FleetCredentialAccess.pipe(
    Effect.map((access) => CredentialAttribution.CredentialAccessCap.of({ scopes: access.scopes })),
  ),
).pipe(Layer.provide(layer));

/**
 * Revokes the unused pairing codes fleet machines hold here above their access, and every session
 * and code of a departed or untrusted machine. A trusted machine's sessions are only capped where
 * they are used: revoking a downgraded machine's task grant would leave it unable to read until
 * someone approved it again. Its own fleet credential is replaced by the fleet sync.
 */
export const revokeExcess = Effect.fn("FleetCredentialAccess.revokeExcess")(function* () {
  const access = yield* FleetCredentialAccess;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const context = yield* FleetContext.FleetContext;
  const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
  // Only a full trust check against the share decides that a machine lost its trust.
  const fleet = yield* context.load.pipe(Effect.orElseSucceed(() => undefined));
  if (fleet === undefined) return;
  yield* access.setTrusted(new Set(fleet.peers.map(({ peer }) => peer.machineId)));
  // A policy this pass could not read only caps; it never costs a credential recovery would not
  // give back. The machines' trust above came from a successful check.
  const forAccess = FleetAccessPolicy.mayRevokeForAccess(yield* fleetAccess.current);
  const excess = Effect.fn("FleetCredentialAccess.excess")(function* (
    credential: { readonly subject: string } & Parameters<
      typeof FleetAccessPolicy.credentialAccess
    >[0],
    kind: "session" | "pairing-link",
  ) {
    const root = CredentialAttribution.attributionRoot(credential.subject);
    if (root === undefined) return false;
    const allowed = yield* access.limit(credential.subject, false);
    if (allowed === undefined) return false;
    if (allowed === "none") return true;
    return (
      kind === "pairing-link" &&
      forAccess &&
      allowed === "read-only" &&
      FleetAccessPolicy.credentialAccess(credential) === "standard"
    );
  });
  for (const session of yield* auth.listSessions())
    if (yield* excess(session, "session")) yield* auth.revokeSession(session.sessionId);
  for (const link of yield* auth.listPairingLinks())
    if (yield* excess(link, "pairing-link")) yield* auth.revokePairingLink(link.id);
});

/** Revocation at startup, every ten minutes, and whenever the fleet policy or peers change. */
export const layerRevocation = Layer.effectDiscard(
  Effect.gen(function* () {
    const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
    const services = yield* Effect.context<
      | FleetCredentialAccess
      | EnvironmentAuth.EnvironmentAuth
      | FleetContext.FleetContext
      | FleetAccessPolicy.FleetAccess
    >();
    const requests = yield* Queue.sliding<void>(1);
    const request = Queue.offer(requests, undefined).pipe(Effect.asVoid);
    const pass = revokeExcess().pipe(
      Effect.provide(services),
      Effect.catchCause((cause) =>
        Effect.logWarning("Fleet credential revocation failed.", { cause }),
      ),
    );
    yield* Effect.forkScoped(Queue.take(requests).pipe(Effect.andThen(pass), Effect.forever));
    yield* Effect.forkScoped(request.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL))));
    yield* Effect.forkScoped(Stream.runForEach(fleetAccess.changes, () => request));
  }),
).pipe(
  Layer.provide(Layer.merge(layer, FleetContext.layer)),
  Layer.provide(FleetAccessPolicy.layer),
);
