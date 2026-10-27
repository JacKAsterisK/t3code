// @effect-diagnostics nodeBuiltinImport:off -- A transient loopback request proves the native gateway's socket is actually closed.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as DesktopFleetGateway from "./DesktopFleetGateway.ts";

const request = (url: string) =>
  new Promise<number>((resolve, reject) => {
    const pending = NodeHttp.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    pending.once("error", reject);
  });

it.live(
  "reuses an exact peer gateway, refuses changed trust, and closes it on removal and scope shutdown",
  () =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const key = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const input = {
        environmentId: EnvironmentId.make("environment-synthetic"),
        identity: {
          origin: "https://127.0.0.1:9",
          certificate: key.certificate,
          publicKeySha256: key.publicKeySha256,
        },
      };
      const last = yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(DesktopFleetGateway.layer);
          const gateway = Context.get(services, DesktopFleetGateway.DesktopFleetGateway);
          const first = yield* gateway.prepare(input);
          expect(yield* gateway.prepare(input)).toEqual(first);
          expect(
            yield* gateway
              .prepare({
                ...input,
                identity: { ...input.identity, publicKeySha256: "0".repeat(64) },
              })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "configuration" });
          const routed = yield* gateway.prepare({
            ...input,
            identity: { ...input.identity, connectHost: "localhost" },
          });
          expect(routed.httpBaseUrl).not.toBe(first.httpBaseUrl);
          yield* Effect.promise(() =>
            expect(request(first.httpBaseUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
          );
          expect(
            yield* gateway.prepare({
              ...input,
              identity: { ...input.identity, connectHost: "localhost" },
            }),
          ).toEqual(routed);
          yield* gateway.disconnect(input.environmentId);
          yield* Effect.promise(() =>
            expect(request(routed.httpBaseUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
          );
          yield* Effect.promise(() =>
            expect(request(first.httpBaseUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
          );
          const reopened = yield* gateway.prepare(input);
          return reopened.httpBaseUrl;
        }),
      );
      yield* Effect.promise(() =>
        expect(request(last)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
      );
    }),
);
