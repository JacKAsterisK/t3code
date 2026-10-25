import { FleetTlsGatewayInput, FleetTlsGatewayResult, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DesktopFleetGateway from "../../lan/DesktopFleetGateway.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const prepareFleetGateway = DesktopIpc.makeIpcMethod({
  channel: Channels.PREPARE_FLEET_GATEWAY_CHANNEL,
  payload: FleetTlsGatewayInput,
  result: FleetTlsGatewayResult,
  handler: Effect.fn("desktop.ipc.fleetGateway.prepare")(function* (input) {
    const gateway = yield* DesktopFleetGateway.DesktopFleetGateway;
    return yield* gateway.prepare(input);
  }),
});

export const disconnectFleetGateway = DesktopIpc.makeIpcMethod({
  channel: Channels.DISCONNECT_FLEET_GATEWAY_CHANNEL,
  payload: EnvironmentId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.fleetGateway.disconnect")(function* (environmentId) {
    const gateway = yield* DesktopFleetGateway.DesktopFleetGateway;
    yield* gateway.disconnect(environmentId);
  }),
});
