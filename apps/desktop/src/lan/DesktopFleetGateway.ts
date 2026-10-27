import { FleetTlsGatewayInput, FleetTlsGatewayResult, LanFleetError } from "@t3tools/contracts";
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

const make = Effect.gen(function* () {
  const gateways = new Map<
    string,
    { identity: string; connectHost: string | undefined; proxy: FleetProxy }
  >();
  const mutex = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await Promise.all([...gateways.values()].map((entry) => entry.proxy.close()));
      gateways.clear();
    }),
  );
  const prepare = Effect.fn("DesktopFleetGateway.prepare")(
    function* (input: FleetTlsGatewayInput) {
      const identity = `${input.identity.origin}\n${input.identity.publicKeySha256}\n${input.identity.certificate}`;
      const existing = gateways.get(input.environmentId);
      if (existing !== undefined) {
        if (existing.identity !== identity)
          return yield* new LanFleetError({ reason: "configuration" });
        if (existing.connectHost === input.identity.connectHost)
          return { httpBaseUrl: existing.proxy.httpBaseUrl, wsBaseUrl: existing.proxy.wsBaseUrl };
      }
      if (existing === undefined && gateways.size >= 100)
        return yield* new LanFleetError({ reason: "unavailable" });
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
      if (existing !== undefined) yield* Effect.promise(() => existing.proxy.close());
      gateways.set(input.environmentId, {
        identity,
        connectHost: input.identity.connectHost,
        proxy,
      });
      return { httpBaseUrl: proxy.httpBaseUrl, wsBaseUrl: proxy.wsBaseUrl };
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );
  const disconnect = Effect.fn("DesktopFleetGateway.disconnect")(
    function* (environmentId: string) {
      const gateway = gateways.get(environmentId);
      if (gateway === undefined) return;
      yield* Effect.promise(() => gateway.proxy.close());
      gateways.delete(environmentId);
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );
  return DesktopFleetGateway.of({ prepare, disconnect });
});
export const layer = Layer.effect(DesktopFleetGateway, make);
