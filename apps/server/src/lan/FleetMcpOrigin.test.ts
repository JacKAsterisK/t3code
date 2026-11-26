import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetMcpOrigin from "./FleetMcpOrigin.ts";
import * as FleetTransport from "./FleetTransport.ts";

const ENDPOINT = "https://192.168.40.25:3774";
const MARK = "synthetic-forwarded-mark";

/** Only the headers are read: whether the fleet endpoint marked it, and the host it named. */
const request = (headers: Record<string, string>) =>
  ({ headers }) as unknown as HttpServerRequest.HttpServerRequest;
const forwarded = request({ host: new URL(ENDPOINT).host, "x-synthetic-mark": MARK });
// A plain-http client can name the endpoint's host without going through it.
const spoofed = request({ host: new URL(ENDPOINT).host });

const originService = (active: boolean) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      FleetMcpOrigin.layer.pipe(
        Layer.provide(
          Layer.mock(FleetTransport.FleetTransport)({
            origin: Effect.succeed(ENDPOINT),
            forwarded: (headers) => headers["x-synthetic-mark"] === MARK,
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ fleetLinkedEnvironmentsActive: active } as never),
          }),
        ),
      ),
    );
    return Context.get(context, McpOAuth.McpOAuthPublicOrigin);
  });

describe("fleet MCP sign-in origin", () => {
  it.effect("names the https origin only for a forwarded request while fleet links are on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const on = yield* originService(true);
        expect(yield* on.forRequest(forwarded)).toBe(ENDPOINT);
        expect(yield* on.forRequest(spoofed)).toBeUndefined();
        expect(yield* on.withheldReason!(forwarded)).toBeUndefined();
      }),
    ),
  );

  it.effect("tells a forwarded agent card why fleet links give it no https audience yet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const off = yield* originService(false);
        expect(yield* off.forRequest(forwarded)).toBeUndefined();
        const note = yield* off.withheldReason!(forwarded);
        expect(note).toBe(FleetMcpOrigin.INACTIVE_FLEET_LINKS_NOTE);
        // Nothing is said to a request the fleet endpoint did not forward.
        expect(yield* off.withheldReason!(spoofed)).toBeUndefined();
      }),
    ),
  );
});
