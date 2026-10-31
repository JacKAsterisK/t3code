import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { proxyConfig } from "./proxy.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-eval-proxy-" });
  const file = path.join(directory, "private-config.json");
  const previous = process.env.T3_EVAL_PROXY_CONFIG;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.env.T3_EVAL_PROXY_CONFIG = file;
    }),
    () =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3_EVAL_PROXY_CONFIG;
        else process.env.T3_EVAL_PROXY_CONFIG = previous;
      }),
  );
  return { fs, file };
});

it.effect("uses an explicit private proxy config without the global Codex provider", () =>
  Effect.gen(function* () {
    const { fs, file } = yield* fixture;
    const headers = { Authorization: "Bearer synthetic-eval-credential", "x-test-client": "eval" };
    yield* fs.writeFileString(
      file,
      JSON.stringify({ url: "http://127.0.0.1:9091/v1///", headers }),
    );
    assert.deepEqual(proxyConfig(), { url: "http://127.0.0.1:9091/v1", headers });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a malformed explicit proxy config without falling back to another credential",
  () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      for (const invalid of [
        "not-json",
        JSON.stringify({ url: "http://127.0.0.1:9091", headers: { Authorization: 7 } }),
      ]) {
        yield* fs.writeFileString(file, invalid);
        assert.throws(proxyConfig);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
