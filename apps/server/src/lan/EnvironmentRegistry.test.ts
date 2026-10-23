import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type LanRoutingConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import * as Registry from "./EnvironmentRegistry.ts";

const environmentId = EnvironmentId.make("environment:approved");
const config = (): LanRoutingConfig => ({
  version: 1,
  environments: [
    {
      environmentId,
      label: "Approved target",
      origin: "https://approved.example",
      credentialRef: "mock-enrollment",
      enabled: true,
      protocolVersion: 2,
      routingVersion: 1,
      runtimeCeiling: "auto",
    },
  ],
  grants: [
    {
      principalId: "grant:approved",
      environmentId,
      enabled: true,
      projectIds: [ProjectId.make("project:approved")],
      threadIds: [],
      allowLaunch: true,
      allowOperate: true,
      runtimeCeiling: "auto",
    },
  ],
});
const testLayer = () =>
  Registry.layer.pipe(
    Layer.provideMerge(
      Config.ServerConfig.layerTest(process.cwd(), { prefix: "t3-lan-registry-test-" }),
    ),
  );

it.layer(NodeServices.layer)("EnvironmentRegistry isolated configuration", (it) => {
  it.effect("denies missing configuration and re-reads removal/revocation without a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* Config.ServerConfig;
      const registry = yield* Registry.EnvironmentRegistry;
      const file = path.join(serverConfig.stateDir, "lan-routing.json");
      assert.equal((yield* registry.read.pipe(Effect.flip)).code, "capability_denied");
      yield* fs.writeFileString(file, JSON.stringify(config()));
      assert.deepEqual(yield* registry.read, config());
      yield* fs.writeFileString(file, JSON.stringify({ ...config(), grants: [] }));
      assert.deepEqual((yield* registry.read).grants, []);
      yield* fs.remove(file);
      assert.equal((yield* registry.read.pipe(Effect.flip)).code, "capability_denied");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "denies malformed, oversized, duplicate and incompatible administrator configuration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* Config.ServerConfig;
        const registry = yield* Registry.EnvironmentRegistry;
        const file = path.join(serverConfig.stateDir, "lan-routing.json");
        for (const contents of [
          "{invalid",
          " ".repeat(1024 * 1024 + 1),
          JSON.stringify({ ...config(), version: 2 }),
          JSON.stringify({
            ...config(),
            environments: [...config().environments, ...config().environments],
          }),
          JSON.stringify({ ...config(), grants: [...config().grants, ...config().grants] }),
          JSON.stringify({
            ...config(),
            environments: [{ ...config().environments[0], protocolVersion: 1 }],
          }),
        ]) {
          yield* fs.writeFileString(file, contents);
          const error = yield* registry.read.pipe(Effect.flip);
          assert.equal(error.code, "capability_denied");
          assert.notInclude(error.message, "mock-enrollment");
        }
      }).pipe(Effect.provide(testLayer())),
  );
});
