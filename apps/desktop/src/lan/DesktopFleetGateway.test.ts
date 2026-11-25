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

it.live("stages a fleet gateway without disrupting the saved route until selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const prior = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const next = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const origin = "https://127.0.0.1:9";
      const previousIdentity = {
        origin,
        certificate: prior.certificate,
        publicKeySha256: prior.publicKeySha256,
      };
      const identity = {
        origin,
        certificate: next.certificate,
        publicKeySha256: next.publicKeySha256,
      };
      const environmentId = EnvironmentId.make("fleet-replacement-synthetic");
      const gateway = yield* DesktopFleetGateway.DesktopFleetGateway;
      const oldGateway = yield* gateway.prepare({ environmentId, identity: previousIdentity });

      expect(
        yield* gateway
          .prepare({
            environmentId,
            identity,
            previousIdentity: { ...previousIdentity, publicKeySha256: "0".repeat(64) },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "configuration" });

      const hostOnly = { ...previousIdentity, connectHost: "localhost" };
      const failed = yield* gateway.prepare({
        environmentId,
        identity: hostOnly,
        previousIdentity,
      });
      expect(failed.httpBaseUrl).not.toBe(oldGateway.httpBaseUrl);
      expect(yield* gateway.prepare({ environmentId, identity: previousIdentity })).toEqual(
        oldGateway,
      );
      expect(yield* Effect.promise(() => request(oldGateway.httpBaseUrl))).toBe(502);

      const retry = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const retryIdentity = {
        origin,
        certificate: retry.certificate,
        publicKeySha256: retry.publicKeySha256,
      };
      const savedStage = yield* gateway.prepare({
        environmentId,
        identity,
        retiredIdentities: [{ ...previousIdentity, connectHost: "other.test" }, previousIdentity],
      });
      expect(savedStage.httpBaseUrl).not.toBe(oldGateway.httpBaseUrl);
      yield* Effect.promise(() =>
        expect(request(failed.httpBaseUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
      );
      // The prior replacement is saved, but a manual route was selected before the next rotation.
      const staged = yield* gateway.prepare({
        environmentId,
        identity: retryIdentity,
        previousIdentity: identity,
      });
      expect(yield* gateway.prepare({ environmentId, identity })).toEqual(savedStage);
      yield* Effect.promise(() =>
        expect(request(oldGateway.httpBaseUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
      );
      expect(yield* gateway.prepare({ environmentId, identity: retryIdentity })).toEqual(staged);
      yield* Effect.promise(() =>
        expect(request(savedStage.httpBaseUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" }),
      );
    }).pipe(Effect.provide(DesktopFleetGateway.layer)),
  ),
);
