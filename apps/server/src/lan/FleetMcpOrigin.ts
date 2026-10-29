import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetTransport from "./FleetTransport.ts";

/**
 * The encrypted fleet endpoint forwards over plain http, so a peer link's sign-in there must
 * name its https origin; `x-forwarded-proto` would change every fleet connection. Only requests
 * the endpoint marked get it: a plain-http client can send any `Host`.
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
        if (settings._tag === "None" || !settings.value.fleetLinkedEnvironmentsActive)
          return undefined;
        const origin = yield* transport.origin;
        return origin !== undefined &&
          transport.forwarded(request.headers) &&
          request.headers.host === new URL(origin).host
          ? origin
          : undefined;
      }),
    });
  }),
);
