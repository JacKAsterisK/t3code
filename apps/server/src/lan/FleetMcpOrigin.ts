import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetTransport from "./FleetTransport.ts";

/** Why a forwarded fleet request gets this server's plain-http audience, for the person to fix. */
export const INACTIVE_FLEET_LINKS_NOTE =
  "This machine's fleet links are not active: either the fleet has no Machine access list yet, which T3 Settings → Machine access can save, or fleet links are turned off on this machine. While they are active, fleet peers link to each other automatically, with no agent link card.";

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
    // A request the fleet endpoint marked as forwarded, to the host that endpoint serves.
    const forwardedFleetOrigin = Effect.fnUntraced(function* (
      request: Parameters<McpOAuth.McpOAuthPublicOrigin["Service"]["forRequest"]>[0],
    ) {
      const origin = yield* transport.origin;
      return origin !== undefined &&
        transport.forwarded(request.headers) &&
        request.headers.host === new URL(origin).host
        ? origin
        : undefined;
    });
    // A settings read error counts as inactive, as it always has.
    const active = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.fleetLinkedEnvironmentsActive),
      Effect.orElseSucceed(() => false),
    );
    return McpOAuth.McpOAuthPublicOrigin.of({
      // Per request; the OAuth handler's span already covers it.
      forRequest: Effect.fnUntraced(function* (request) {
        if (!(yield* active)) return undefined;
        return yield* forwardedFleetOrigin(request);
      }),
      withheldReason: Effect.fnUntraced(function* (request) {
        if (yield* active) return undefined;
        return (yield* forwardedFleetOrigin(request)) === undefined
          ? undefined
          : INACTIVE_FLEET_LINKS_NOTE;
      }),
    });
  }),
);
