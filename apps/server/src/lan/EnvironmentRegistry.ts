import { LanRoutingConfig, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly read: Effect.Effect<LanRoutingConfig, OrchestratorMcpFailure>;
  }
>()("t3/lan/EnvironmentRegistry") {}

const invalid = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "LAN routing is disabled or its administrator configuration is invalid.",
  });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, "lan-routing.json");
  // Re-read at the authorization boundary so removal/revocation needs no restart.
  const read = Effect.gen(function* () {
    const stat = yield* fs.stat(file);
    if (Number(stat.size) > 1024 * 1024) return yield* invalid();
    const parsed = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LanRoutingConfig))));
    const ids = parsed.environments.map((route) => route.environmentId);
    const grants = parsed.grants.map((grant) => `${grant.principalId}:${grant.environmentId}`);
    if (new Set(ids).size !== ids.length || new Set(grants).size !== grants.length) {
      return yield* invalid();
    }
    return parsed;
  }).pipe(Effect.mapError(invalid), Effect.withSpan("EnvironmentRegistry.read"));
  return EnvironmentRegistry.of({ read });
});

export const layer = Layer.effect(EnvironmentRegistry, make);
