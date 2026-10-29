import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetTransport from "./FleetTransport.ts";

/**
 * The encrypted fleet endpoint forwards to this server over plain http and keeps the `Host`
 * header, so a peer link's sign-in there must name the endpoint's https origin. Setting
 * `x-forwarded-proto` in the proxy instead would change every existing fleet connection.
 */
export const layer = Layer.effect(
  McpOAuth.McpOAuthPublicOrigin,
  Effect.gen(function* () {
    const transport = yield* FleetTransport.FleetTransport;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return McpOAuth.McpOAuthPublicOrigin.of({
      // Per request; the OAuth handler's span already covers it.
      forRequest: Effect.fnUntraced(function* (request) {
        const settings = yield* serverSettings.getSettings.pipe(Effect.option);
        if (settings._tag === "None" || !settings.value.fleetLinkedEnvironmentsEnabled)
          return undefined;
        const origin = yield* transport.origin;
        return origin !== undefined && request.headers.host === new URL(origin).host
          ? origin
          : undefined;
      }),
    });
  }),
);
