import { lanBuildIdentity } from "@t3tools/shared/distribution";
import {
  discoverLanUpdateChannel,
  type LanUpdateDiscovery,
  type LanUpdateDiscoveryError,
} from "@t3tools/shared/lanUpdateChannel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

export class ForkUpdateDistributionRequiredError extends Schema.TaggedError<ForkUpdateDistributionRequiredError>()(
  "ForkUpdateDistributionRequiredError",
  {},
) {
  override get message() {
    return "Fork update discovery requires a compiled LAN distribution identity.";
  }
}

export class ForkUpdateDiscovery extends Context.Service<
  ForkUpdateDiscovery,
  {
    readonly check: Effect.Effect<LanUpdateDiscovery, LanUpdateDiscoveryError>;
  }
>()("t3/lan/ForkUpdateDiscovery") {}

const make = Effect.gen(function* () {
  if (lanBuildIdentity === undefined) return yield* new ForkUpdateDistributionRequiredError({});
  const httpClient = yield* HttpClient.HttpClient;
  return ForkUpdateDiscovery.of({
    check: discoverLanUpdateChannel(lanBuildIdentity).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  });
});

export const layer = Layer.effect(ForkUpdateDiscovery, make);
