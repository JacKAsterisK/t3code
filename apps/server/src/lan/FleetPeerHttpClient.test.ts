// @effect-diagnostics nodeBuiltinImport:off -- Loopback HTTPS fixtures exercise real Node TLS validation.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { expect, it } from "@effect/vitest";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import * as FleetPeerHttpClient from "./FleetPeerHttpClient.ts";

const serve = (server: NodeHttp.Server | NodeHttps.Server, scheme: "http" | "https") =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<string>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") reject(new Error("No port"));
            else resolve(`${scheme}://127.0.0.1:${address.port}`);
          });
        }),
    ),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const handler: NodeHttp.RequestListener = (request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
    response.end();
    return;
  }
  response.end("reached");
};

it.live("reaches a trusted fleet peer only at its pinned key and leaves other origins alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const approved = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const impostor = createFleetTlsCertificate({ address: "127.0.0.1", now });
      const origin = yield* serve(
        NodeHttps.createServer({ key: approved.privateKey, cert: approved.certificate }, handler),
        "https",
      );
      const plain = yield* serve(NodeHttp.createServer(handler), "http");
      const context = yield* FleetPeerHttpClient.layer.pipe(
        Layer.provideMerge(FleetPeerHttpClient.layerTrust),
        Layer.provide(FetchHttpClient.layer),
        Layer.build,
      );
      const client = Context.get(context, HttpClient.HttpClient);
      const trust = Context.get(context, FleetPeerHttpClient.FleetPeerTrust);
      const text = (url: string) =>
        client.get(url).pipe(Effect.flatMap((response) => response.text));

      // Without trust, the self-signed endpoint is refused exactly as before.
      expect((yield* Effect.result(text(origin)))._tag).toBe("Failure");
      expect(yield* text(plain)).toBe("reached");

      yield* trust.replace([
        { origin, certificate: approved.certificate, publicKeySha256: approved.publicKeySha256 },
      ]);
      expect(yield* text(origin)).toBe("reached");
      expect(yield* text(plain)).toBe("reached");
      // Peer links forbid redirects, so the code and token never leave the pinned origin.
      const redirected = yield* client
        .get(`${origin}/redirect`)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      expect(redirected.status).toBe(302);

      yield* trust.replace([
        { origin, certificate: impostor.certificate, publicKeySha256: impostor.publicKeySha256 },
      ]);
      expect((yield* Effect.result(text(origin)))._tag).toBe("Failure");
    }),
  ),
);
