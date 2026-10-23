// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Promise gateway test independently verifies its wire PKCE challenge.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";

import {
  type GatewayOAuthState,
  makeGatewayT3OAuthClient,
  secureOrigin,
} from "./GatewayT3OAuthClient.ts";

const origin = "https://anvil.example";
const redirectUri = "http://127.0.0.1:9911/callback";
const metadata = {
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/mcp/authorize`,
  token_endpoint: `${origin}/oauth/mcp/token`,
  registration_endpoint: `${origin}/oauth/mcp/register`,
  revocation_endpoint: `${origin}/oauth/mcp/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["orchestration:read", "orchestration:operate"],
  authorization_response_iss_parameter_supported: true,
};
const tokenResult = {
  access_token: "mock-access",
  refresh_token: "mock-refresh",
  grant_id: "stable-grant",
  task_only: true,
  token_type: "Bearer",
  expires_in: 3600,
  refresh_expires_in: 90 * 24 * 3600,
  scope: "orchestration:read orchestration:operate",
};
const state = (): GatewayOAuthState => ({
  issuer: origin,
  resource: `${origin}/mcp`,
  clientId: "registered",
  tokens: {
    accessToken: "mock-access",
    refreshToken: "mock-refresh",
    grantId: "stable-grant",
    accessExpiresAt: 3_600_000,
    refreshExpiresAt: 90 * 24 * 3_600_000,
  },
});

const setup = (initial?: GatewayOAuthState) => {
  let saved = initial;
  let observed = 0;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let respond: (url: string, init?: RequestInit) => Response | Promise<Response> = (url, init) => {
    if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
    if (url.endsWith("/register"))
      return Response.json({
        client_id: "registered",
        client_name: "dot T3 gateway",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    if (url.endsWith("/token")) return Response.json(tokenResult);
    if (url.endsWith("/revoke")) return Response.json({});
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (body.method === "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "mock-session" } },
      );
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { environmentId: "target", tasks: [] } } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const normalResponse = respond;
  const client = makeGatewayT3OAuthClient({
    origin,
    redirectUri,
    now: () => observed,
    credentials: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
      clear: async () => {
        saved = undefined;
      },
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    },
  });
  return {
    client,
    calls,
    saved: () => saved,
    setNow: (value: number) => {
      observed = value;
    },
    respondWith: (next: typeof respond) => {
      respond = next;
    },
    normalResponse,
  };
};

it("refuses insecure remote transport, noncanonical loopback, credentials and path proxies", () => {
  for (const refused of [
    "http://192.168.2.25:3773",
    "http://127.1:3773",
    "http://2130706433:3773",
    "https://user:secret@anvil.example",
    "https://anvil.example/env/id",
    "https://anvil.example/#",
  ]) {
    expect(() => secureOrigin(refused)).toThrow("configuration");
  }
  expect(secureOrigin("http://127.0.0.1:3773/")).toBe("http://127.0.0.1:3773");
  expect(secureOrigin("http://[::1]:3773")).toBe("http://[::1]:3773");
});

it("persists PKCE before opening a task-only renewable authorization and checks callback binding", async () => {
  const test = setup();
  const authorization = new URL(await test.client.beginAuthorization());
  expect(authorization.searchParams.get("task_only")).toBe("true");
  expect(authorization.searchParams.get("offline_access")).toBe("true");
  expect(authorization.searchParams.get("code_challenge")).toBe(
    NodeCrypto.createHash("sha256").update(test.saved()!.pending!.verifier).digest("base64url"),
  );
  await expect(
    test.client.completeAuthorization(`${redirectUri}?code=mock&state=wrong&iss=${origin}`),
  ).rejects.toThrow("invalid-callback");
  expect(test.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(0);
  const callback = new URL(redirectUri);
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state")!,
    iss: origin,
    code: "mock-code",
  }).toString();
  await expect(test.client.completeAuthorization(callback.toString())).resolves.toEqual({
    grantId: "stable-grant",
  });
  expect(test.saved()!.pending).toBeUndefined();
  expect(test.saved()!.tokens?.refreshToken).toBe("mock-refresh");
  expect(test.calls.every((call) => call.init?.redirect === "error")).toBe(true);
});

it("initializes native MCP once, decodes SSE with notifications and blocks broader native tools", async () => {
  const test = setup(state());
  await expect(
    test.client.callTaskTool("t3_lan_task_list", { environmentId: "target" }),
  ).resolves.toEqual({ environmentId: "target", tasks: [] });
  await expect(
    test.client.callTaskTool("t3_lan_task_list", { environmentId: "target" }),
  ).resolves.toEqual({ environmentId: "target", tasks: [] });
  expect(
    test.calls.filter((call) => JSON.parse(String(call.init?.body)).method === "initialize"),
  ).toHaveLength(1);
  const before = test.calls.length;
  await expect(test.client.callTaskTool("t3_thread_launch", {})).rejects.toThrow("tool-denied");
  await expect(test.client.callTaskTool("t3_lan_maintenance", {})).rejects.toThrow("tool-denied");
  expect(test.calls).toHaveLength(before);
  const headers = test.calls.at(-1)!.init!.headers as Record<string, string>;
  expect(headers.accept).toBe("application/json, text/event-stream");
  expect(headers["mcp-session-id"]).toBe("mock-session");
});

it("single-flights renewal and never retries an uncertain rotated token or task launch", async () => {
  const expired = state();
  const test = setup({ ...expired, tokens: { ...expired.tokens!, accessExpiresAt: 0 } });
  let tokenCalls = 0;
  test.respondWith(async (url) => {
    if (url.endsWith("/token")) {
      tokenCalls++;
      throw new Error("mock network failure");
    }
    throw new Error("unexpected request");
  });
  await Promise.all([
    expect(test.client.callTaskTool("t3_lan_task_launch", {})).rejects.toThrow("unavailable"),
    expect(test.client.callTaskTool("t3_lan_task_read", {})).rejects.toThrow("unavailable"),
  ]);
  expect(tokenCalls).toBe(1);
  expect(test.saved()!.renewalRequired).toBe(true);
  await expect(test.client.callTaskTool("t3_lan_task_read", {})).rejects.toThrow(
    "authorization-required",
  );
  expect(tokenCalls).toBe(1);
});

it("refuses forged issuer metadata and broad or identity-changing token responses", async () => {
  const test = setup();
  test.respondWith(() =>
    Response.json({ ...metadata, token_endpoint: "https://evil.example/token" }),
  );
  await expect(test.client.beginAuthorization()).rejects.toThrow("unsupported");
  expect(test.calls).toHaveLength(1);
  const expired = state();
  const rotated = setup({ ...expired, tokens: { ...expired.tokens!, accessExpiresAt: 0 } });
  rotated.respondWith(() => Response.json({ ...tokenResult, grant_id: "different-grant" }));
  await expect(rotated.client.callTaskTool("t3_lan_task_read", {})).rejects.toThrow(
    "invalid-response",
  );
  expect(rotated.saved()!.renewalRequired).toBe(true);
});

it("explicitly revokes before clearing protected credentials", async () => {
  const test = setup(state());
  await test.client.revoke();
  expect(test.calls).toHaveLength(1);
  expect(test.calls[0]!.url).toBe(`${origin}/oauth/mcp/revoke`);
  expect(test.saved()).toBeUndefined();
  await expect(test.client.callTaskTool("t3_lan_task_read", {})).rejects.toThrow(
    "authorization-required",
  );
});

it("persists local denial before any revocation identity probe or network request", async () => {
  const test = setup(state());
  await test.client.disableLocal();
  expect(test.calls).toHaveLength(0);
  expect(test.saved()!.renewalRequired).toBe(true);
  await expect(test.client.callTaskTool("t3_lan_task_read", {})).rejects.toThrow(
    "authorization-required",
  );
  expect(test.calls).toHaveLength(0);
  await test.client.revoke();
  expect(test.saved()).toBeUndefined();
  expect(test.calls).toHaveLength(1);
});

it("reinitializes after a lost native MCP session without replaying the failed call", async () => {
  const test = setup(state());
  await test.client.callTaskTool("t3_lan_task_read", { environmentId: "target" });
  let rejectNext = true;
  test.respondWith((url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "tools/call" && rejectNext) {
      rejectNext = false;
      return new Response(null, { status: 404 });
    }
    return test.normalResponse(url, init);
  });
  await expect(
    test.client.callTaskTool("t3_lan_task_send", { clientRequestId: "same-request" }),
  ).rejects.toThrow("outcome-unknown");
  const requestsAfterFailure = test.calls.length;
  await test.client.callTaskTool("t3_lan_task_send", { clientRequestId: "same-request" });
  expect(test.calls.length - requestsAfterFailure).toBe(3);
  expect(
    test.calls.filter((call) => JSON.parse(String(call.init?.body)).method === "initialize"),
  ).toHaveLength(2);
});

it("serializes revocation with pending authorization so a later callback cannot restore credentials", async () => {
  const test = setup();
  const authorization = new URL(await test.client.beginAuthorization());
  const callback = new URL(redirectUri);
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state")!,
    iss: origin,
    code: "mock-code",
  }).toString();
  const revoked = test.client.revoke();
  const completion = test.client.completeAuthorization(callback.toString());
  await revoked;
  await expect(completion).rejects.toThrow("invalid-callback");
  expect(test.saved()).toBeUndefined();
  expect(test.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(0);
});

it("returns a matching split SSE reply and cancels a stream that remains open", async () => {
  const test = setup(state());
  let cancelled = false;
  test.respondWith((url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    if (body.method !== "tools/call") return test.normalResponse(url, init);
    const bytes = new TextEncoder().encode(
      `: keepalive\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { completed: true } } })}\r\n\r\n`,
    );
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 25));
          controller.enqueue(bytes.subarray(25));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  await expect(test.client.callTaskTool("t3_lan_task_observe", {})).resolves.toEqual({
    completed: true,
  });
  expect(cancelled).toBe(true);
});
