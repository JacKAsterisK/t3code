import {
  FleetTlsGatewayInput,
  FleetTlsGatewayResult,
  LanFleetError,
  sameFleetTlsIdentity,
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
}

const closeSlot = (slot: GatewaySlot) =>
  Promise.all([slot.active?.proxy.close(), slot.replacement?.gateway.proxy.close()]);

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
      const active = slot.active;
      const pending = slot.replacement;
      const matches = (gateway: Gateway | undefined) =>
        gateway !== undefined && sameFleetTlsIdentity(gateway.identity, input.identity);
      const activeMatches = matches(active);
      const pendingMatches = matches(pending?.gateway);
      const previousIdentity = input.previousIdentity;
      const staged = previousIdentity !== undefined && !activeMatches;

      if (staged) {
        if (active !== undefined && !sameFleetTlsIdentity(active.identity, previousIdentity))
          return yield* new LanFleetError({ reason: "configuration" });
        if (
          pending !== undefined &&
          !sameFleetTlsIdentity(pending.previousIdentity, previousIdentity)
        )
          return yield* new LanFleetError({ reason: "configuration" });
      } else if (
        !activeMatches &&
        !pendingMatches &&
        (active !== undefined ||
          (pending !== undefined &&
            !sameFleetTlsIdentity(pending.previousIdentity, input.identity)))
      ) {
        return yield* new LanFleetError({ reason: "configuration" });
      }

      const reusable = activeMatches ? active : pendingMatches ? pending?.gateway : undefined;
      let next = reusable;
      if (next === undefined || next.identity.connectHost !== input.identity.connectHost) {
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
