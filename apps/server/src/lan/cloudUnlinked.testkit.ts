import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CloudLink from "../cloud/CloudLink.ts";

/** OAuth HTTP reads the T3 Connect link; LAN builds are never linked. */
export const layerCloudUnlinked = Layer.mock(CloudLink.CloudLink)({
  linkState: () =>
    Effect.succeed({
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    }),
});
