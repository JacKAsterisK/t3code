// @effect-diagnostics-next-line nodeBuiltinImport:off -- This external Promise adapter must generate PKCE without an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import {
  AuthMcpAuthorizationServerMetadata,
  AuthMcpRegisteredClient,
  AuthMcpTokenResult,
} from "@t3tools/contracts";

class GatewayOAuthError extends Error {
  readonly reason:
    | "configuration"
    | "unsupported"
    | "authorization-required"
    | "invalid-callback"
    | "unavailable"
    | "invalid-response"
    | "tool-denied"
    | "outcome-unknown";
  constructor(reason: GatewayOAuthError["reason"]) {
    super(`T3 gateway OAuth failed (${reason}).`);
    this.name = "GatewayOAuthError";
    this.reason = reason;
  }
}

export const secureOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayOAuthError("configuration");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    value.includes("#") ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/u.test(value)
      ))
  ) {
    throw new GatewayOAuthError("configuration");
  }
  return url.origin;
};

export const GatewayOAuthState = Schema.Struct({
  issuer: Schema.String,
  resource: Schema.String,
  clientId: Schema.String,
  pending: Schema.optionalKey(
    Schema.Struct({
      state: Schema.String,
      verifier: Schema.String,
      redirectUri: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
  tokens: Schema.optionalKey(
    Schema.Struct({
      accessToken: Schema.String,
      refreshToken: Schema.String,
      grantId: Schema.String,
      accessExpiresAt: Schema.Number,
      refreshExpiresAt: Schema.Number,
    }),
  ),
  renewalRequired: Schema.optionalKey(Schema.Boolean),
});
export type GatewayOAuthState = typeof GatewayOAuthState.Type;

/** The owner provides an OS-backed, atomic, single-writer store. No file fallback. */
export interface GatewayCredentialStore {
  readonly load: () => Promise<GatewayOAuthState | undefined>;
  readonly save: (state: GatewayOAuthState) => Promise<void>;
  readonly clear: () => Promise<void>;
}

const taskTools = new Set([
  "t3_lan_environments",
  "t3_lan_task_launch",
  "t3_lan_task_list",
  "t3_lan_task_read",
  "t3_lan_task_send",
  "t3_lan_task_interrupt",
  "t3_lan_task_requests",
  "t3_lan_task_respond",
  "t3_lan_task_observe",
  "t3_lan_events_ack",
]);
const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  ),
});
const InitializeResult = Schema.Struct({ protocolVersion: Schema.String });
const protocolVersion = "2025-06-18";
const maxResponseBytes = 4 * 1024 * 1024;

/** Promise adapter for an external gateway; importing it never registers a client or opens a listener. */
export const makeGatewayT3OAuthClient = (options: {
  readonly origin: string;
  readonly redirectUri: string;
  readonly credentials: GatewayCredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}) => {
  const origin = secureOrigin(options.origin);
  const resource = `${origin}/mcp`;
  const redirect = new URL(options.redirectUri);
  secureOrigin(redirect.origin);
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    options.redirectUri.includes("#")
  )
    throw new GatewayOAuthError("configuration");
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let refreshing: Promise<string> | undefined;
  let initializing: Promise<void> | undefined;
  let sessionId: string | undefined;
  let sessionToken: string | undefined;
  let initialized = false;
  let rpcId = 0;
  let lifecycleTail = Promise.resolve();
  const lifecycle = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = lifecycleTail.then(operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resetSession = () => {
    initialized = false;
    sessionId = undefined;
    sessionToken = undefined;
  };

  const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A => {
    try {
      return Schema.decodeUnknownSync(schema)(value);
    } catch {
      throw new GatewayOAuthError("invalid-response");
    }
  };
  const read = async (response: Response): Promise<string> => {
    const reader = response.body?.getReader();
    if (!reader) throw new GatewayOAuthError("invalid-response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResponseBytes) throw new GatewayOAuthError("invalid-response");
        chunks.push(chunk.value);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
  const readEventResponse = async (
    response: Response,
    id: number,
  ): Promise<typeof RpcResponse.Type> => {
    const reader = response.body?.getReader();
    if (!reader) throw new GatewayOAuthError("invalid-response");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new GatewayOAuthError("invalid-response");
        size += chunk.value.byteLength;
        if (size > maxResponseBytes) throw new GatewayOAuthError("invalid-response");
        pending += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const separator = /\r\n\r\n|\n\n|\r\r/u.exec(pending);
          if (!separator) break;
          const event = pending.slice(0, separator.index);
          pending = pending.slice(separator.index + separator[0].length);
          const data = event
            .split(/\r\n|\r|\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const frame = decode(RpcResponse, JSON.parse(data));
          if (frame.id === id) return frame;
        }
      }
    } catch {
      throw new GatewayOAuthError("invalid-response");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      const response = await fetch(`${origin}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status >= 300 && response.status < 400)
        throw new GatewayOAuthError("invalid-response");
      return response;
    } catch {
      throw new GatewayOAuthError("unavailable");
    }
  };
  const json = async (response: Response): Promise<unknown> => {
    if (
      !response.ok ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
    )
      throw new GatewayOAuthError("invalid-response");
    try {
      return JSON.parse(await read(response)) as unknown;
    } catch {
      throw new GatewayOAuthError("invalid-response");
    }
  };
  const load = async (): Promise<GatewayOAuthState | undefined> => {
    let saved: GatewayOAuthState | undefined;
    try {
      const raw = await options.credentials.load();
      saved = raw === undefined ? undefined : decode(GatewayOAuthState, raw);
    } catch {
      throw new GatewayOAuthError("authorization-required");
    }
    if (saved && (saved.issuer !== origin || saved.resource !== resource))
      throw new GatewayOAuthError("configuration");
    return saved;
  };
  const save = async (state: GatewayOAuthState) => {
    try {
      await options.credentials.save(state);
    } catch {
      throw new GatewayOAuthError("authorization-required");
    }
  };
  const metadata = async () => {
    const found = decode(
      AuthMcpAuthorizationServerMetadata,
      await json(await request("/.well-known/oauth-authorization-server")),
    );
    if (
      found.issuer !== origin ||
      found.authorization_endpoint !== `${origin}/oauth/mcp/authorize` ||
      found.token_endpoint !== `${origin}/oauth/mcp/token` ||
      found.registration_endpoint !== `${origin}/oauth/mcp/register` ||
      found.revocation_endpoint !== `${origin}/oauth/mcp/revoke` ||
      !found.grant_types_supported.includes("refresh_token") ||
      !found.code_challenge_methods_supported.includes("S256")
    )
      throw new GatewayOAuthError("unsupported");
  };
  const postForm = (path: string, fields: Record<string, string>) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
    });
  const tokensFrom = (
    raw: unknown,
    expectedGrantId?: string,
  ): NonNullable<GatewayOAuthState["tokens"]> => {
    const result = decode(AuthMcpTokenResult, raw);
    if (
      result.task_only !== true ||
      !result.grant_id ||
      !result.refresh_token ||
      !result.refresh_expires_in ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0 ||
      result.expires_in > 3600 ||
      !Number.isFinite(result.refresh_expires_in) ||
      result.refresh_expires_in > 90 * 24 * 3600 ||
      (expectedGrantId !== undefined && result.grant_id !== expectedGrantId) ||
      result.scope
        .split(" ")
        .some((scope) => !["orchestration:read", "orchestration:operate"].includes(scope))
    ) {
      throw new GatewayOAuthError("invalid-response");
    }
    const observed = now();
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      grantId: result.grant_id,
      accessExpiresAt: observed + result.expires_in * 1000,
      refreshExpiresAt: observed + result.refresh_expires_in * 1000,
    };
  };

  const beginAuthorization = async (): Promise<string> => {
    const existing = await load();
    if (existing?.tokens && existing.tokens.refreshExpiresAt > now())
      throw new GatewayOAuthError("configuration");
    await metadata();
    const client = decode(
      AuthMcpRegisteredClient,
      await json(
        await request("/oauth/mcp/register", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            client_name: "dot T3 gateway",
            redirect_uris: [options.redirectUri],
            token_endpoint_auth_method: "none",
          }),
        }),
      ),
    );
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    await save({
      issuer: origin,
      resource,
      clientId: client.client_id,
      pending: { state, verifier, redirectUri: options.redirectUri, createdAt: now() },
    });
    const authorization = new URL(`${origin}/oauth/mcp/authorize`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: options.redirectUri,
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      resource,
      task_only: "true",
      offline_access: "true",
    }).toString();
    return authorization.toString();
  };

  const completeAuthorization = async (
    callbackUrl: string,
  ): Promise<{ readonly grantId: string }> => {
    const state = await load();
    const pending = state?.pending;
    let callback: URL;
    try {
      callback = new URL(callbackUrl);
    } catch {
      throw new GatewayOAuthError("invalid-callback");
    }
    if (
      !state ||
      !pending ||
      now() - pending.createdAt > 10 * 60_000 ||
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.hash ||
      callback.searchParams.get("state") !== pending.state ||
      callback.searchParams.get("iss") !== origin ||
      !callback.searchParams.get("code") ||
      callback.searchParams.has("error") ||
      ["state", "iss", "code"].some((field) => callback.searchParams.getAll(field).length !== 1)
    )
      throw new GatewayOAuthError("invalid-callback");
    await save({ issuer: origin, resource, clientId: state.clientId, renewalRequired: true });
    const tokens = tokensFrom(
      await json(
        await postForm("/oauth/mcp/token", {
          grant_type: "authorization_code",
          client_id: state.clientId,
          code: callback.searchParams.get("code")!,
          code_verifier: pending.verifier,
          redirect_uri: pending.redirectUri,
          resource,
        }),
      ),
    );
    await save({ issuer: origin, resource, clientId: state.clientId, tokens });
    initialized = false;
    return { grantId: tokens.grantId };
  };

  const currentToken = async (): Promise<string> => {
    const state = await load();
    if (!state?.tokens || state.renewalRequired)
      throw new GatewayOAuthError("authorization-required");
    if (state.tokens.refreshExpiresAt <= now())
      throw new GatewayOAuthError("authorization-required");
    if (state.tokens.accessExpiresAt > now() + 60_000) return state.tokens.accessToken;
    // Persist uncertainty first: a lost rotated response must never replay the old
    // refresh token after a process restart and revoke an otherwise healthy family.
    await save({ ...state, renewalRequired: true });
    const tokens = tokensFrom(
      await json(
        await postForm("/oauth/mcp/token", {
          grant_type: "refresh_token",
          client_id: state.clientId,
          refresh_token: state.tokens.refreshToken,
          resource,
        }),
      ),
      state.tokens.grantId,
    );
    await save({ issuer: origin, resource, clientId: state.clientId, tokens });
    initialized = false;
    return tokens.accessToken;
  };
  const token = (): Promise<string> => {
    if (refreshing) return refreshing;
    refreshing = lifecycle(currentToken).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  const rpc = async (
    bearer: string,
    method: string,
    params: unknown,
    notification = false,
  ): Promise<unknown> => {
    const id = ++rpcId;
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    if (!response.ok) {
      if (response.status === 404) resetSession();
      throw new GatewayOAuthError("outcome-unknown");
    }
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId !== null) sessionId = nextSessionId;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    let raw: unknown;
    try {
      if (contentType === "application/json") raw = JSON.parse(await read(response));
      else if (contentType === "text/event-stream") raw = await readEventResponse(response, id);
      else throw new GatewayOAuthError("invalid-response");
    } catch {
      throw new GatewayOAuthError("invalid-response");
    }
    const message = decode(RpcResponse, raw);
    if (message.id !== id || message.error !== undefined || message.result === undefined)
      throw new GatewayOAuthError("outcome-unknown");
    return message.result;
  };

  const callTaskTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!taskTools.has(name)) throw new GatewayOAuthError("tool-denied");
    const bearer = await token();
    if (!initialized || sessionToken !== bearer) {
      initializing ??= (async () => {
        sessionId = undefined;
        const init = decode(
          InitializeResult,
          await rpc(bearer, "initialize", {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "dot-t3-gateway", version: "1" },
          }),
        );
        if (init.protocolVersion !== protocolVersion) throw new GatewayOAuthError("unsupported");
        await rpc(bearer, "notifications/initialized", {}, true);
        initialized = true;
        sessionToken = bearer;
      })().finally(() => {
        initializing = undefined;
      });
      await initializing;
    }
    const result = decode(ToolResult, await rpc(bearer, "tools/call", { name, arguments: args }));
    if (result.isError) throw new GatewayOAuthError("tool-denied");
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("");
    try {
      return JSON.parse(text ?? "") as unknown;
    } catch {
      throw new GatewayOAuthError("invalid-response");
    }
  };

  const revoke = async (): Promise<void> => {
    const state = await load();
    if (!state) return;
    if (!state.tokens) {
      try {
        await options.credentials.clear();
      } catch {
        throw new GatewayOAuthError("authorization-required");
      }
      resetSession();
      return;
    }
    await save({ ...state, renewalRequired: true });
    const response = await postForm("/oauth/mcp/revoke", {
      client_id: state.clientId,
      token: state.tokens.refreshToken,
      resource,
    });
    if (!response.ok) throw new GatewayOAuthError("unavailable");
    try {
      await options.credentials.clear();
    } catch {
      throw new GatewayOAuthError("authorization-required");
    }
    resetSession();
  };

  const disableLocal = async (): Promise<void> => {
    const state = await load();
    if (state?.tokens !== undefined) await save({ ...state, renewalRequired: true });
    else if (state !== undefined) {
      try {
        await options.credentials.clear();
      } catch {
        throw new GatewayOAuthError("authorization-required");
      }
    }
    resetSession();
  };

  return {
    beginAuthorization: () => lifecycle(beginAuthorization),
    completeAuthorization: (callbackUrl: string) =>
      lifecycle(() => completeAuthorization(callbackUrl)),
    callTaskTool,
    disableLocal: () => lifecycle(disableLocal),
    revoke: () => lifecycle(revoke),
  };
};
