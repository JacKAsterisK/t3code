import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { cloudEnabled } from "@t3tools/shared/distribution";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import {
  createBrowserDpopProof,
  generateBrowserDpopKey,
  readStoredBrowserDpopKey,
  writeStoredBrowserDpopKey,
  type BrowserDpopKey,
} from "./dpop";

const layerRelayDpopSigner = Layer.effect(
  ManagedRelay.ManagedRelayDpopSigner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const keyLoadSemaphore = yield* Semaphore.make(1);
    let loadedKey: BrowserDpopKey | null = null;
    const loadOrCreateBrowserDpopKey = keyLoadSemaphore.withPermit(
      Effect.gen(function* () {
        if (loadedKey) {
          return loadedKey;
        }
        const stored = yield* readStoredBrowserDpopKey();
        if (stored) {
          loadedKey = stored;
          return stored;
        }
        const generated = yield* generateBrowserDpopKey;
        yield* writeStoredBrowserDpopKey(generated);
        loadedKey = generated;
        return generated;
      }),
    );

    return ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: loadOrCreateBrowserDpopKey.pipe(
        Effect.map((proofKey) => proofKey.thumbprint),
        Effect.mapError(
          (error) =>
            new ManagedRelay.ManagedRelayDpopKeyLoadError({
              keyStore: "indexed-db",
              cause: error,
            }),
        ),
        Effect.withSpan("web.managedRelayDpopSigner.loadThumbprint"),
      ),
      createProof: Effect.fn("web.managedRelayDpopSigner.createProof")(function* (input) {
        const proofKey = yield* loadOrCreateBrowserDpopKey.pipe(
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
        return yield* createBrowserDpopProof({ ...input, proofKey }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((proof) => proof.proof),
          Effect.mapError(
            (error) =>
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method: input.method,
                url: input.url,
                cause: error,
              }),
          ),
        );
      }),
    });
  }),
);

export const layer = (relayUrl: string) =>
  cloudEnabled
    ? ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
        Layer.provideMerge(layerRelayDpopSigner),
      )
    : Layer.mergeAll(
        Layer.succeed(
          ManagedRelay.ManagedRelayClient,
          ManagedRelay.ManagedRelayClient.of({
            relayUrl: "",
            listEnvironments: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            listDevices: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            createEnvironmentLinkChallenge: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            linkEnvironment: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            unlinkEnvironment: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            getEnvironmentStatus: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            connectEnvironment: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            registerDevice: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            unregisterDevice: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            registerLiveActivity: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            getAgentActivitySnapshot: () =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            resetTokenCache: Effect.void,
          }),
        ),
        Layer.succeed(
          ManagedRelay.ManagedRelayDpopSigner,
          ManagedRelay.ManagedRelayDpopSigner.of({
            thumbprint: Effect.fail(
              new ManagedRelay.ManagedRelayDpopKeyLoadError({
                keyStore: "indexed-db",
                cause: new Error("T3 Connect is disabled in this LAN distribution."),
              }),
            ),
            createProof: (input) =>
              Effect.fail(
                new ManagedRelay.ManagedRelayDpopProofCreationError({
                  method: input.method,
                  url: input.url,
                  cause: new Error("T3 Connect is disabled in this LAN distribution."),
                }),
              ),
          }),
        ),
      );
