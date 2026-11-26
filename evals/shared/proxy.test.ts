// @effect-diagnostics processEnvInEffect:off -- This fixture temporarily sets and restores the startup-only proxy environment.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it as viteIt, vi } from "vite-plus/test";
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

const config = `model_provider = "cliproxy"

[model_providers.cliproxy]
base_url = "https://proxy.example/v1"
requires_openai_auth = true
`;

describe("proxyConfig", () => {
  viteIt.each([
    ["no auth.json", undefined],
    ["a ChatGPT-login auth.json", { OPENAI_API_KEY: null, tokens: { access_token: "t" } }],
  ])("fails when the provider requires OpenAI auth and %s has no key", (_, auth) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evals-proxy-"));
    using _home = {
      [Symbol.dispose]: () => {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true });
      },
    };
    NodeFS.writeFileSync(NodePath.join(home, "config.toml"), config);
    if (auth) NodeFS.writeFileSync(NodePath.join(home, "auth.json"), JSON.stringify(auth));
    vi.stubEnv("CODEX_HOME", home);
    expect(() => proxyConfig()).toThrow(/requires_openai_auth/);
  });
});
