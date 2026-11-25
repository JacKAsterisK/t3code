import {
  FleetTlsGatewayInput,
  FleetTlsGatewayResult,
  LanFleetError,
  sameFleetTlsIdentity,
  sameFleetTlsRoute,
  type FleetTlsIdentity,
} from "@t3tools/contracts";
import { startFleetProxy, type FleetProxy } from "@t3tools/shared/fleetTlsProxy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class DesktopFleetGateway extends Context.Service<
  DesktopFleetGateway,
  {
    readonly disconnect: (environmentId: string) => Effect.Effect<void>;
    readonly prepare: (
      input: FleetTlsGatewayInput,
    ) => Effect.Effect<FleetTlsGatewayResult, LanFleetError>;
  }
>()("@t3tools/desktop/lan/DesktopFleetGateway") {}

interface Gateway {
  readonly identity: FleetTlsIdentity;
  readonly proxy: FleetProxy;
}

interface GatewaySlot {
  active?: Gateway;
  alternate?: Gateway;
  replacement?: { previousIdentity: FleetTlsIdentity; gateway: Gateway };
}

const closeSlot = (slot: GatewaySlot) =>
  Promise.all([
    slot.active?.proxy.close(),
    slot.alternate?.proxy.close(),
    slot.replacement?.gateway.proxy.close(),
  ]);

const make = Effect.gen(function* () {
  const gateways = new Map<string, GatewaySlot>();
  const mutex = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await Promise.all([...gateways.values()].map(closeSlot));
      gateways.clear();
    }),
  );
  const createGateway = Effect.fn("DesktopFleetGateway.createGateway")(function* (
    identity: FleetTlsIdentity,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const proxy = yield* Effect.tryPromise({
      try: () =>
        startFleetProxy({
          listen: { address: "127.0.0.1", port: 0 },
          target: identity.origin + "/",
          peerTls: { identity, now },
        }),
      catch: () => new LanFleetError({ reason: "configuration" }),
    });
    return { identity, proxy };
  });
  const prepare = Effect.fn("DesktopFleetGateway.prepare")(
    function* (input: FleetTlsGatewayInput) {
      const saved = gateways.get(input.environmentId);
      if (saved === undefined && gateways.size >= 100)
        return yield* new LanFleetError({ reason: "unavailable" });
      const slot = saved ?? {};
      let active = slot.active;
      let pending = slot.replacement;
      const predecessors = [
        ...(input.previousIdentity === undefined ? [] : [input.previousIdentity]),
        ...(input.retiredIdentities ?? []),
      ];
      const previousIdentity =
        predecessors.find(
          (identity) =>
            (pending !== undefined && sameFleetTlsRoute(identity, pending.gateway.identity)) ||
            (active !== undefined && sameFleetTlsRoute(identity, active.identity)),
        ) ?? predecessors[0];
      // A later saved predecessor can confirm a stage even if the resolver chose a manual route.
      if (
        previousIdentity !== undefined &&
        pending !== undefined &&
        sameFleetTlsRoute(previousIdentity, pending.gateway.identity)
      ) {
        const retired = active;
        active = pending.gateway;
        slot.active = active;
        delete slot.replacement;
        pending = undefined;
        if (retired !== undefined) yield* Effect.promise(() => retired.proxy.close());
      }
      const matches = (gateway: Gateway | undefined) =>
        gateway !== undefined && sameFleetTlsRoute(gateway.identity, input.identity);
      const activeMatches = matches(active);
      const pendingMatches = matches(pending?.gateway);
      const staged = previousIdentity !== undefined && !activeMatches;

      if (
        input.savedRoute === true &&
        previousIdentity === undefined &&
        !activeMatches &&
        active !== undefined
      ) {
        const alternate = slot.alternate;
        if (pendingMatches && pending !== undefined) {
          if (alternate !== undefined) yield* Effect.promise(() => alternate.proxy.close());
          slot.alternate = active;
          slot.active = pending.gateway;
          delete slot.replacement;
          return {
            httpBaseUrl: pending.gateway.proxy.httpBaseUrl,
            wsBaseUrl: pending.gateway.proxy.wsBaseUrl,
          };
        }
        if (alternate !== undefined && matches(alternate))
          return { httpBaseUrl: alternate.proxy.httpBaseUrl, wsBaseUrl: alternate.proxy.wsBaseUrl };
        if (
          active.identity.origin === input.identity.origin &&
          !sameFleetTlsIdentity(active.identity, input.identity)
        )
          return yield* new LanFleetError({ reason: "configuration" });
        const next = yield* createGateway(input.identity);
        if (alternate !== undefined) yield* Effect.promise(() => alternate.proxy.close());
        slot.alternate = next;
        return { httpBaseUrl: next.proxy.httpBaseUrl, wsBaseUrl: next.proxy.wsBaseUrl };
      }

      if (staged) {
        if (
          active !== undefined &&
          !sameFleetTlsRoute(active.identity, previousIdentity) &&
          input.savedRoute !== true
        )
          return yield* new LanFleetError({ reason: "configuration" });
        if (
          pending !== undefined &&
          !sameFleetTlsRoute(pending.previousIdentity, previousIdentity) &&
          input.savedRoute !== true
        )
          return yield* new LanFleetError({ reason: "configuration" });
      } else if (
        !activeMatches &&
        !pendingMatches &&
        (active !== undefined
          ? !sameFleetTlsIdentity(active.identity, input.identity)
          : pending !== undefined &&
            !sameFleetTlsIdentity(pending.previousIdentity, input.identity))
      ) {
        return yield* new LanFleetError({ reason: "configuration" });
      }

      const reusable = activeMatches ? active : pendingMatches ? pending?.gateway : undefined;
      const next = reusable ?? (yield* createGateway(input.identity));

      if (staged) {
        if (pending !== undefined && pending.gateway !== next)
          yield* Effect.promise(() => pending.gateway.proxy.close());
        slot.replacement = { previousIdentity, gateway: next };
      } else {
        if (active !== undefined && active !== next)
          yield* Effect.promise(() => active.proxy.close());
        // Older clients select a replacement without the saved-route flag.
        if (pendingMatches && pending !== undefined) {
          if (pending.gateway !== next) yield* Effect.promise(() => pending.gateway.proxy.close());
          delete slot.replacement;
        }
        slot.active = next;
      }
      gateways.set(input.environmentId, slot);
      return { httpBaseUrl: next.proxy.httpBaseUrl, wsBaseUrl: next.proxy.wsBaseUrl };
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );
  const disconnect = Effect.fn("DesktopFleetGateway.disconnect")(
    function* (environmentId: string) {
      const gateway = gateways.get(environmentId);
      if (gateway === undefined) return;
      yield* Effect.promise(() => closeSlot(gateway));
      gateways.delete(environmentId);
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );
  return DesktopFleetGateway.of({ prepare, disconnect });
});
export const layer = Layer.effect(DesktopFleetGateway, make);
