import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type LanEnvironmentRoute,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { GatewayOAuthState } from "./GatewayT3OAuthClient.ts";
import * as Transport from "./RemoteTaskTransport.ts";

const origin = "https://approved.example";
const credentialRef = "mock-enrollment";
const environmentId = EnvironmentId.make("environment:approved");
const route: LanEnvironmentRoute = {
  environmentId,
  label: "Approved target",
  origin,
  credentialRef,
  enabled: true,
  protocolVersion: 2,
  routingVersion: 1,
  runtimeCeiling: "auto",
};
const descriptor = (): ExecutionEnvironmentDescriptor => ({
  environmentId,
  label: "Approved target",
  platform: { os: "windows", arch: "x64" },
  serverVersion: "0.1.2",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: false, lanTaskRouting: 1 },
});
const state = (): GatewayOAuthState => ({
  issuer: origin,
  resource: `${origin}/mcp`,
  clientId: "mock-client",
  tokens: {
    accessToken: "mock-access",
    refreshToken: "mock-refresh",
    grantId: "mock-grant",
    accessExpiresAt: Number.MAX_SAFE_INTEGER,
    refreshExpiresAt: Number.MAX_SAFE_INTEGER,
  },
});
const RpcRequest = Schema.Struct({
  method: Schema.String,
  id: Schema.optional(Schema.Number),
  params: Schema.optional(Schema.Unknown),
});
const decodeRpc = Schema.decodeUnknownSync(Schema.fromJsonString(RpcRequest));

function setup(
  options: {
    readonly discover?: () => Response | Promise<Response>;
    readonly taskStatus?: number;
  } = {},
) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  const credentialBindings: Array<readonly [string, string]> = [];
  let loads = 0;
  const request: typeof globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target === `${origin}/.well-known/t3/environment`)
      return options.discover?.() ?? Response.json(descriptor());
    assert.equal(target, `${origin}/mcp`);
    const rpc = decodeRpc(String(init?.body));
    if (rpc.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { protocolVersion: "2025-06-18" },
      });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(rpc.method, "tools/call");
    if (options.taskStatus !== undefined) return new Response(null, { status: options.taskStatus });
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { structuredContent: { environmentId, result: { native: true } } },
    });
  };
  const credentials = Layer.succeed(Transport.RoutingCredentials, {
    forRoute: (target: string, reference: string) => {
      credentialBindings.push([target, reference]);
      return {
        load: async () => {
          loads++;
          return state();
        },
        save: async () => {
          throw new Error("Unexpected credential write");
        },
        clear: async () => {
          throw new Error("Unexpected credential deletion");
        },
      };
    },
  });
  return {
    calls,
    credentialBindings,
    loads: () => loads,
    layer: Transport.layerServices.pipe(
      Layer.provide(Layer.merge(credentials, Layer.succeed(Transport.RoutingFetch, request))),
    ),
  };
}

it.effect(
  "rejects insecure or noncanonical configured routes before fetching or loading credentials",
  () =>
    Effect.gen(function* () {
      for (const invalid of [
        "http://192.168.2.25:3773",
        "https://user:mock@approved.example",
        "https://approved.example/env/target",
        "http://127.1:3773",
        "https://approved.example/?token=mock",
        "https://approved.example/#fragment",
      ]) {
        const test = setup();
        yield* Effect.gen(function* () {
          const service = yield* Transport.RemoteTaskTransport;
          assert.equal(
            (yield* service
              .call({ ...route, origin: invalid }, "t3_lan_task_list", {})
              .pipe(Effect.asVoid, Effect.flip)).code,
            "orchestration_error",
          );
        }).pipe(Effect.provide(test.layer));
        assert.equal(test.calls.length, 0);
        assert.equal(test.credentialBindings.length, 0);
        assert.equal(test.loads(), 0);
      }
    }),
);

it.effect(
  "requires matching destination identity, protocol and routing capability before any credential access",
  () =>
    Effect.gen(function* () {
      for (const metadata of [
        { ...descriptor(), environmentId: "environment:unapproved" },
        { ...descriptor(), orchestrationProtocolVersion: 1 },
        { ...descriptor(), orchestrationProtocolVersion: undefined },
        { ...descriptor(), capabilities: { repositoryIdentity: false } },
        { ...descriptor(), capabilities: { lanTaskRouting: 2 } },
        { label: "malformed" },
      ]) {
        const test = setup({ discover: () => Response.json(metadata) });
        yield* Effect.gen(function* () {
          const service = yield* Transport.RemoteTaskTransport;
          assert.equal(
            (yield* service.call(route, "t3_lan_task_list", {}).pipe(Effect.asVoid, Effect.flip))
              .code,
            "orchestration_error",
          );
        }).pipe(Effect.provide(test.layer));
        assert.equal(test.calls.length, 1);
        assert.equal(test.calls[0]?.init?.headers, undefined);
        assert.equal(test.credentialBindings.length, 0);
        assert.equal(test.loads(), 0);
      }
    }),
);

it.effect(
  "refuses redirects and discovery/TLS failures without loading a token or calling a task",
  () =>
    Effect.gen(function* () {
      const discoveryFailures = [
        () =>
          new Response(null, { status: 302, headers: { location: "https://unapproved.example" } }),
        () => new Response(null, { status: 401 }),
        () => new Response("not-json", { status: 200 }),
        () => Promise.reject(new Error("Mock TLS trust failure")),
      ];
      for (const discover of discoveryFailures) {
        const test = setup({ discover });
        yield* Effect.gen(function* () {
          const service = yield* Transport.RemoteTaskTransport;
          const error = yield* service
            .call(route, "t3_lan_task_launch", { clientRequestId: "stable" })
            .pipe(Effect.asVoid, Effect.flip);
          assert.equal(error.code, "orchestration_error");
          assert.include(error.message, "no local fallback");
        }).pipe(Effect.provide(test.layer));
        assert.deepEqual(
          test.calls.map((call) => call.url),
          [`${origin}/.well-known/t3/environment`],
        );
        assert.equal(test.calls[0]?.init?.redirect, "error");
        assert.equal(test.loads(), 0);
        assert.equal(test.credentialBindings.length, 0);
      }
    }),
);

it.effect(
  "uses only the configured origin and checks identity again before using a cached client",
  () =>
    Effect.gen(function* () {
      let matches = true;
      const test = setup({
        discover: () =>
          Response.json(
            matches ? descriptor() : { ...descriptor(), environmentId: "environment:changed" },
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* Transport.RemoteTaskTransport;
        const result = yield* service.call(route, "t3_lan_task_list", {
          environmentId,
          origin: "https://user-supplied.example",
          url: "http://user-supplied.example",
        });
        assert.deepEqual(result, { environmentId, result: { native: true } });
        assert.deepEqual(test.credentialBindings, [[environmentId, credentialRef]]);
        assert.equal(test.loads(), 1);
        assert.isTrue(
          test.calls.every(
            (call) => call.url.startsWith(`${origin}/`) && call.init?.redirect === "error",
          ),
        );
        assert.equal(test.calls.filter((call) => call.url.endsWith("/mcp")).length, 3);
        matches = false;
        yield* service.call(route, "t3_lan_task_list", {}).pipe(Effect.asVoid, Effect.flip);
        assert.equal(test.loads(), 1);
        assert.equal(test.calls.filter((call) => call.url.endsWith("/mcp")).length, 3);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("keeps a remote mutation error uncertain and does not retry or fall back", () =>
  Effect.gen(function* () {
    const test = setup({ taskStatus: 503 });
    yield* Effect.gen(function* () {
      const service = yield* Transport.RemoteTaskTransport;
      const error = yield* service
        .call(route, "t3_lan_task_interrupt", {
          environmentId,
          threadId: "native-thread",
          clientRequestId: "stable-request",
        })
        .pipe(Effect.asVoid, Effect.flip);
      assert.equal(error.code, "orchestration_error");
      assert.include(error.message, "same request ID");
      assert.equal(
        test.calls.filter(
          (call) =>
            call.url.endsWith("/mcp") && decodeRpc(String(call.init?.body)).method === "tools/call",
        ).length,
        1,
      );
      assert.isTrue(test.calls.every((call) => call.url.startsWith(`${origin}/`)));
    }).pipe(Effect.provide(test.layer));
  }),
);
