import {
  AuthOrchestrationApproveScope,
  type FleetAccess as FleetAccessLevel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ApprovalPeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as Option from "effect/Option";
import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ApprovalSigning from "./FleetApprovalPolicySigning.ts";
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
    readonly administersFleet: CredentialAttribution.CredentialAccessCap["Service"]["administersFleet"];
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
  const gate = yield* Gate.ApprovalAdmissionGate;
  const approvalPeers = yield* Effect.serviceOption(ApprovalPeerAccess.ApprovalPeerAccess);
  const trusted = yield* Ref.make<ReadonlySet<string> | undefined>(undefined);

  const machineOf = (root: string, state: FleetAccessPolicy.FleetAccessState) => {
    if (root.startsWith(PEER_LINK_PREFIX)) return root.slice(PEER_LINK_PREFIX.length).split(":")[0];
    const key = root.slice(FLEET_CREDENTIAL_PREFIX.length);
    return state.peers.find(
      (peer) => Delivery.deliveryFileName(state.machineId!, peer.machineId) === key,
    )?.machineId;
  };

  /** The machine behind a credential here, and what it may do now. */
  const attribution = Effect.fn("FleetCredentialAccess.attribution")(function* (
    subject: string,
    taskGrant: boolean,
  ) {
    const state = yield* fleetAccess.current;
    if (state.machineId === undefined) return { state, level: undefined };
    const root = CredentialAttribution.attributionRoot(subject);
    if (root === undefined)
      // A task grant from before grants recorded their approver could be any machine's.
      return {
        state,
        level:
          taskGrant &&
          subject === CredentialAttribution.MCP_CLIENT_SUBJECT &&
          restrictsAnyone(state)
            ? ("read-only" as const)
            : undefined,
      };
    const machineId = machineOf(root, state);
    const trust = yield* Ref.get(trusted);
    if (
      machineId === undefined ||
      // An ID an access-list exception could take is never a machine here, whatever the share says.
      FleetAccessPolicy.reservedMachineId(machineId) ||
      !state.peers.some((peer) => peer.machineId === machineId) ||
      (trust !== undefined && !trust.has(machineId))
    )
      return { state, level: "none" as const };
    return {
      state,
      machineId,
      level: FleetAccessPolicy.policyApplies(state)
        ? FleetAccessPolicy.callerAccess(state, machineId)
        : ("standard" as const),
    };
  });

  const limit: FleetCredentialAccess["Service"]["limit"] = (subject, taskGrant) =>
    attribution(subject, taskGrant).pipe(Effect.map(({ level }) => level));

  const administersFleet: FleetCredentialAccess["Service"]["administersFleet"] = (credential) =>
    attribution(credential.subject, credential.taskGrant === true).pipe(
      Effect.map(({ state, machineId, level }) =>
        level === undefined
          ? true
          : level === "standard" &&
            machineId !== undefined &&
            // Its own level, before any exception: an exception lets it work here, never
            // administer the fleet as this machine.
            (!FleetAccessPolicy.policyApplies(state) ||
              FleetAccessPolicy.machineAccess(state, machineId) === "standard"),
      ),
    );

  const readOnly = FleetAccessPolicy.fleetCredentialScopes("read-only");
  const scopes: FleetCredentialAccess["Service"]["scopes"] = Effect.fn(
    "FleetCredentialAccess.scopes",
  )(function* (credential) {
    const { level, state, machineId } = yield* attribution(
      credential.subject,
      credential.taskGrant === true,
    );
    if (level === "none") return undefined;
    let current =
      level === "read-only"
        ? credential.scopes.filter((scope) => readOnly.includes(scope))
        : credential.scopes;
    if (!current.includes(AuthOrchestrationApproveScope)) return current;
    const classification =
      credential.sessionId !== undefined && Option.isSome(approvalPeers)
        ? yield* approvalPeers.value
            .classification(credential.sessionId)
            .pipe(
              Effect.mapError(
                (cause) => new CredentialAttribution.CredentialAccessUnavailable({ cause }),
              ),
            )
        : undefined;
    const linked =
      credential.peerLink === true ||
      (CredentialAttribution.attributionRoot(credential.subject) !== undefined &&
        classification !== "local") ||
      (CredentialAttribution.isMcpClientSubject(credential.subject) && classification !== "local");
    if (linked || credential.taskGrant === true) {
      const enabled =
        credential.taskGrant !== true &&
        credential.sessionId !== undefined &&
        Option.isSome(approvalPeers)
          ? yield* approvalPeers.value
              .permits(credential.sessionId)
              .pipe(
                Effect.mapError(
                  (cause) => new CredentialAttribution.CredentialAccessUnavailable({ cause }),
                ),
              )
          : false;
      const bindingResult =
        credential.sessionId !== undefined && Option.isSome(approvalPeers)
          ? yield* approvalPeers.value.fleetIdentity(credential.sessionId).pipe(
              Effect.map((binding) => ({ valid: true, binding })),
              Effect.mapError(
                (cause) => new CredentialAttribution.CredentialAccessUnavailable({ cause }),
              ),
            )
          : { valid: false, binding: undefined };
      const binding = bindingResult.binding;
      const destination = state.approvalTrust?.peers.find((p) => p.machineId === state.machineId);
      const trust = yield* Ref.get(trusted);
      const fleetPermits =
        bindingResult.valid &&
        (binding === undefined ||
          (destination !== undefined &&
            state.approvalTrust?.fleetId === binding.fleetId &&
            ApprovalSigning.verify(binding.signedPolicy, {
              fleetId: binding.fleetId,
              destinationMachineId: binding.destinationMachineId,
              publicKey: destination.signingPublicKey,
            }) &&
            binding.signedPolicy.grants.some(
              (g) => g.callerMachineId === binding.callerMachineId && g.enabled,
            ) &&
            state.machineId === binding.destinationMachineId &&
            (machineId === undefined || machineId === binding.callerMachineId) &&
            state.member !== false &&
            state.unavailable !== true &&
            state.peers.some(
              (p) =>
                p.machineId === binding.callerMachineId &&
                p.environmentId === binding.sourceEnvironmentId,
            ) &&
            (trust === undefined || trust.has(binding.callerMachineId)) &&
            FleetAccessPolicy.callerAccess(state, binding.callerMachineId) === "standard"));
      if (!enabled || !fleetPermits)
        current = current.filter((scope) => scope !== AuthOrchestrationApproveScope);
    }
    return current;
  });

  return FleetCredentialAccess.of({
    limit,
    scopes,
    administersFleet,
    setTrusted: Effect.fn("FleetCredentialAccess.setTrusted")((machineIds) =>
      gate.withGate(Ref.set(trusted, new Set(machineIds))),
    ),
  });
});

export const layerServices = Layer.effect(FleetCredentialAccess, make).pipe(
  Layer.provideMerge(Gate.layer),
);

/** The cap EnvironmentAuth and the WebSocket RPC apply to every credential they verify. */
export const layerCapServices = Layer.effect(
  CredentialAttribution.CredentialAccessCap,
  FleetCredentialAccess.pipe(
    Effect.map((access) =>
      CredentialAttribution.CredentialAccessCap.of({
        scopes: access.scopes,
        administersFleet: access.administersFleet,
      }),
    ),
  ),
);

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
export const layerRevocationServices = Layer.effectDiscard(
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
);
