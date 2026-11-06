import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { cloudEnabled } from "@t3tools/shared/distribution";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import { loadOrCreateProofKey } from "./dpop";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

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
            listEnvironments: Effect.fn("ManagedRelay.ManagedRelayClient.listEnvironments")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            listDevices: Effect.fn("ManagedRelay.ManagedRelayClient.listDevices")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            createEnvironmentLinkChallenge: Effect.fn(
              "ManagedRelay.ManagedRelayClient.createEnvironmentLinkChallenge",
            )(() => Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" }))),
            linkEnvironment: Effect.fn("ManagedRelay.ManagedRelayClient.linkEnvironment")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            unlinkEnvironment: Effect.fn("ManagedRelay.ManagedRelayClient.unlinkEnvironment")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            getEnvironmentStatus: Effect.fn("ManagedRelay.ManagedRelayClient.getEnvironmentStatus")(
              () => Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            connectEnvironment: Effect.fn("ManagedRelay.ManagedRelayClient.connectEnvironment")(
              () => Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            registerDevice: Effect.fn("ManagedRelay.ManagedRelayClient.registerDevice")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            unregisterDevice: Effect.fn("ManagedRelay.ManagedRelayClient.unregisterDevice")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            registerLiveActivity: Effect.fn("ManagedRelay.ManagedRelayClient.registerLiveActivity")(
              () => Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            getAgentActivitySnapshot: Effect.fn(
              "ManagedRelay.ManagedRelayClient.getAgentActivitySnapshot",
            )(() => Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" }))),
            getT3ChatLink: Effect.fn("ManagedRelay.ManagedRelayClient.getT3ChatLink")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
            createT3ChatLinkRequest: Effect.fn(
              "ManagedRelay.ManagedRelayClient.createT3ChatLinkRequest",
            )(() => Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" }))),
            unlinkT3Chat: Effect.fn("ManagedRelay.ManagedRelayClient.unlinkT3Chat")(() =>
              Effect.fail(new ManagedRelay.ManagedRelayUrlInvalidError({ relayUrl: "" })),
            ),
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
            createProof: Effect.fn("ManagedRelay.ManagedRelayDpopSigner.createProof")((input) =>
              Effect.fail(
                new ManagedRelay.ManagedRelayDpopProofCreationError({
                  method: input.method,
                  url: input.url,
                  cause: new Error("T3 Connect is disabled in this LAN distribution."),
                }),
              ),
            ),
          }),
        ),
      );
