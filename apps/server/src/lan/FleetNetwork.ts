// @effect-diagnostics nodeBuiltinImport:off -- Native interface discovery and scoped sockets are isolated at this adapter boundary.
import * as NodeOS from "node:os";
import { LanFleetError } from "@t3tools/contracts";
import { startFleetProxy, type FleetProxy } from "@t3tools/shared/fleetTlsProxy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveBoundEndpoints } from "../environment/DirectEndpoints.ts";

export class FleetNetwork extends Context.Service<
  FleetNetwork,
  {
    readonly addresses: Effect.Effect<readonly string[]>;
    readonly listen: (
      input: Parameters<typeof startFleetProxy>[0],
    ) => Effect.Effect<FleetProxy, LanFleetError>;
  }
>()("t3/lan/FleetNetwork") {}

export const layer = Layer.succeed(
  FleetNetwork,
  FleetNetwork.of({
    addresses: Effect.sync(() =>
      resolveBoundEndpoints({ host: "0.0.0.0", port: 1, interfaces: NodeOS.networkInterfaces() })
        .filter((entry) => entry.kind === "lan")
        .map((entry) => new URL(entry.httpBaseUrl).hostname),
    ),
    listen: Effect.fn("FleetNetwork.listen")((input) =>
      Effect.tryPromise({
        try: () => startFleetProxy(input),
        catch: () => new LanFleetError({ reason: "transport" }),
      }),
    ),
  }),
);
