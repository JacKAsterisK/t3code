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
  replacement?: { previousIdentity: FleetTlsIdentity; gateway: Gateway };
  promotion?: { previous?: Gateway };
}

const closeSlot = (slot: GatewaySlot) =>
  Promise.all([
    slot.active?.proxy.close(),
    slot.replacement?.gateway.proxy.close(),
    slot.promotion?.previous?.proxy.close(),
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
  const prepare = Effect.fn("DesktopFleetGateway.prepare")(
    function* (input: FleetTlsGatewayInput) {
      const saved = gateways.get(input.environmentId);
      if (saved === undefined && gateways.size >= 100)
        return yield* new LanFleetError({ reason: "unavailable" });
      const slot = saved ?? {};
      let active = slot.active;
      let pending = slot.replacement;
      const matches = (gateway: Gateway | undefined) =>
        gateway !== undefined && sameFleetTlsRoute(gateway.identity, input.identity);
      const endpoint = ({ proxy }: Gateway) => ({
        httpBaseUrl: proxy.httpBaseUrl,
        wsBaseUrl: proxy.wsBaseUrl,
      });
      if (input.stagedReplacement === "promote") {
        if (
          slot.promotion === undefined &&
          active !== undefined &&
          matches(active) &&
          pending === undefined
        )
          return endpoint(active);
        if (slot.promotion !== undefined || pending === undefined || !matches(pending.gateway))
          return yield* new LanFleetError({ reason: "configuration" });
        slot.promotion = active === undefined ? {} : { previous: active };
        slot.active = pending.gateway;
        delete slot.replacement;
        return endpoint(pending.gateway);
      }
      if (input.stagedReplacement !== undefined) {
        if (slot.promotion === undefined || active === undefined || !matches(active))
          return yield* new LanFleetError({ reason: "configuration" });
        const previous = slot.promotion.previous;
        delete slot.promotion;
        if (input.stagedReplacement === "rollback") {
          if (previous === undefined) gateways.delete(input.environmentId);
          else slot.active = previous;
          const retiredProxy = active.proxy;
          yield* Effect.promise(() => retiredProxy.close());
        } else if (previous !== undefined) {
          yield* Effect.promise(() => previous.proxy.close());
        }
        return endpoint(active);
      }
      if (slot.promotion !== undefined) {
        const prepared = matches(active) ? active : slot.promotion.previous;
        if (prepared === undefined || !matches(prepared))
          return yield* new LanFleetError({ reason: "configuration" });
        return endpoint(prepared);
      }
      const retired = input.retiredIdentities;
      const current = active?.identity ?? pending?.previousIdentity;
      const previousIdentity =
        input.previousIdentity ??
        retired?.find(
          (identity) => current !== undefined && sameFleetTlsRoute(identity, current),
        ) ??
        retired?.[0];
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
      const activeMatches = matches(active);
      const pendingMatches = matches(pending?.gateway);
      const staged = previousIdentity !== undefined && !activeMatches;

      if (staged) {
        if (active !== undefined && !sameFleetTlsRoute(active.identity, previousIdentity))
          return yield* new LanFleetError({ reason: "configuration" });
        if (pending !== undefined && !sameFleetTlsRoute(pending.previousIdentity, previousIdentity))
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
      let next = reusable;
      if (next === undefined) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const proxy = yield* Effect.tryPromise({
          try: () =>
            startFleetProxy({
              listen: { address: "127.0.0.1", port: 0 },
              target: `${input.identity.origin}/`,
              peerTls: { identity: input.identity, now },
            }),
          catch: () => new LanFleetError({ reason: "configuration" }),
        });
        next = { identity: input.identity, proxy };
      }

      if (staged) {
        if (pending !== undefined && pending.gateway !== next)
          yield* Effect.promise(() => pending.gateway.proxy.close());
        slot.replacement = { previousIdentity, gateway: next };
      } else {
        if (active !== undefined && active !== next)
          yield* Effect.promise(() => active.proxy.close());
        // The resolver selects the new pin without a predecessor only after it is saved.
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
