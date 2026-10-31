import * as ApprovalAuthority from "./ApprovalAuthority.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationApproveScope,
  type AuthMcpApprovalDecision,
  type AuthMcpAuthorizationRequest,
  type AuthMcpAuthorizationServerMetadata,
  type AuthMcpClientRegistration,
  type AuthMcpProtectedResourceMetadata,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  type AuthMcpTokenRequest,
  type AuthMcpTokenResult,
  type AuthMcpRevokeRequest,
  type AuthMcpClientAccess,
  type AuthEnvironmentScope,
  type AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MCP_PEER_LINK_SOFTWARE_ID,
  mcpClientScopes,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as CredentialAttribution from "./CredentialAttribution.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuthGrants from "./McpOAuthGrants.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  deriveAuthClientMetadata,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

// Request-derived origins support loopback, Tailscale and tunnels.
// Signed client metadata keeps unauthenticated registration stateless.

const SIGNING_SECRET_NAME = "mcp-oauth-signing-key";
const AUTHORIZATION_CODE_TTL_MS = 60_000;
const GRANT_ATTRIBUTION_TIMEOUT_MS = 5_000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const DEFAULT_CLIENT_NAME = "MCP client";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const MCP_OAUTH_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationApproveScope,
];

export interface McpOAuthUrls {
  readonly issuer: string;
  readonly resource: string;
}

export const requestUrls = (
  request: HttpServerRequest.HttpServerRequest,
  publicOrigin?: string,
): McpOAuthUrls => {
  const origin =
    publicOrigin ??
    Option.match(HttpServerRequest.toURL(request), {
      onNone: () => "http://localhost",
      onSome: (url) => url.origin,
    });
  return { issuer: origin, resource: `${origin}/mcp` };
};

/**
 * Optional: the https origin a request reached this server at, when a TLS front forwards it
 * over plain http with its `Host` kept, so the issuer and resource name what the client used.
 */
export class McpOAuthPublicOrigin extends Context.Service<
  McpOAuthPublicOrigin,
  {
    readonly forRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<string | undefined>;
  }
>()("t3/auth/McpOAuth/McpOAuthPublicOrigin") {}

/**
 * Optional: told which pairing code's subject each new peer-link session came from, so the
 * code's issuer can revoke that session later. A session it could not record is refused.
 */
export class McpPeerLinkSessionObserver extends Context.Service<
  McpPeerLinkSessionObserver,
  {
    readonly sessionIssued: (input: {
      readonly subject: string;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<boolean>;
  }
>()("t3/auth/McpOAuth/McpPeerLinkSessionObserver") {}

export const protectedResourceMetadata = (
  urls: McpOAuthUrls,
): AuthMcpProtectedResourceMetadata => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  scopes_supported: MCP_OAUTH_SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "T3 Code",
});

export const authorizationServerMetadata = (
  urls: McpOAuthUrls,
): AuthMcpAuthorizationServerMetadata => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  revocation_endpoint: `${urls.issuer}/oauth/mcp/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: MCP_OAUTH_SCOPES,
  authorization_response_iss_parameter_supported: true,
});

const parseRedirect = (value: string): URL | undefined => {
  // URL.hash misses empty fragments, which RFC 6749 §3.1.2 also forbids.
  if (value.length > MAX_REDIRECT_URI_LENGTH || value.includes("#")) return undefined;
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
    return allowed && url.username === "" && url.password === "" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** Loopback redirects ignore port (RFC 8252 §7.3); HTTPS redirects match exactly. */
export const redirectMatches = (registered: string, presented: string): boolean => {
  const left = parseRedirect(registered);
  const right = parseRedirect(presented);
  if (left === undefined || right === undefined) return false;
  if (left.protocol === "https:" || right.protocol === "https:") return left.href === right.href;
  return (
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
};

const sameResource = (urls: McpOAuthUrls, presented: string | undefined): boolean => {
  if (presented === undefined) return true;
  try {
    const url = new URL(presented);
    return url.hash === "" && `${url.origin}${url.pathname.replace(/\/+$/u, "")}` === urls.resource;
  } catch {
    return false;
  }
};

const ClientIdPayload = Schema.Struct({
  v: Schema.Literal(1),
  n: Schema.String,
  r: Schema.Array(Schema.String),
  /** Registered as another T3 Code environment's peer link. */
  p: Schema.optionalKey(Schema.Literal(1)),
});
const decodeClientIdPayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClientIdPayload));

export interface McpOAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly peerLink: boolean;
}

export class McpOAuthPageError extends Schema.TaggedError<McpOAuthPageError>()(
  "McpOAuthPageError",
  { description: Schema.String },
) {
  override get message(): string {
    return this.description;
  }
}

export class McpOAuthRedirectError extends Schema.TaggedError<McpOAuthRedirectError>()(
  "McpOAuthRedirectError",
  {
    error: Schema.Literals(["invalid_request", "unsupported_response_type", "invalid_target"]),
    description: Schema.String,
    redirectUri: Schema.String,
    state: Schema.optional(Schema.RedactedFromValue(Schema.String)),
  },
) {}

export interface AuthorizationRequest {
  readonly client: McpOAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: Redacted.Redacted<string> | undefined;
  readonly resource: string;
  readonly issuer: string;
  readonly taskOnly: boolean;
  readonly renewable: boolean;
}

interface PendingCode {
  readonly clientId: string;
  readonly clientName: string;
  readonly peerLink: boolean;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly access: AuthMcpClientAccess;
  readonly expiresAtMs: number;
  readonly taskOnly: boolean;
  readonly renewable: boolean;
  /** The subject of the pairing code or browser session that approved it. */
  readonly approvalSubject: string | undefined;
  readonly approvals: boolean;
}

export type ApprovalDecision = Exclude<AuthMcpApprovalDecision, { readonly _tag: "deny" }>;

export class McpOAuth extends Context.Service<
  McpOAuth,
  {
    readonly register: (
      input: AuthMcpClientRegistration,
    ) => Effect.Effect<McpOAuthClient, AuthMcpRegistrationError>;
    /** Page errors must never redirect. */
    readonly validateAuthorization: (input: {
      readonly urls: McpOAuthUrls;
      readonly request: AuthMcpAuthorizationRequest;
    }) => Effect.Effect<AuthorizationRequest, McpOAuthPageError | McpOAuthRedirectError>;
    readonly approvingBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
      authorization: AuthorizationRequest,
    ) => Effect.Effect<
      | {
          readonly csrfToken: string;
          readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
          readonly subject: string;
        }
      | undefined
    >;
    readonly approve: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly authorization: AuthorizationRequest;
      readonly decision: ApprovalDecision;
    }) => Effect.Effect<string, EnvironmentAuth.ServerAuthMcpApprovalCodeError | McpOAuthPageError>;
    readonly deny: (authorization: AuthorizationRequest) => string;
    readonly exchangeCode: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly urls: McpOAuthUrls;
      readonly token: AuthMcpTokenRequest;
    }) => Effect.Effect<AuthMcpTokenResult, AuthMcpTokenError>;
    readonly revoke: (input: {
      readonly urls: McpOAuthUrls;
      readonly token: AuthMcpRevokeRequest;
    }) => Effect.Effect<void, AuthMcpTokenError>;
  }
>()("t3/auth/McpOAuth") {}

const redirectWith = (
  redirectUri: string,
  params: Record<string, string | Redacted.Redacted<string> | undefined>,
) => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(name, Redacted.isRedacted(value) ? Redacted.value(value) : value);
    }
  }
  return url.toString();
};

export const redirectForError = (error: McpOAuthRedirectError, issuer: string) =>
  redirectWith(error.redirectUri, {
    error: error.error,
    error_description: error.description,
    state: error.state,
    iss: issuer,
  });

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const approvalAuthority = yield* ApprovalAuthority.ApprovalAuthority;
  const grants = yield* McpOAuthGrants.McpOAuthGrants;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sessionObserver = yield* Effect.serviceOption(McpPeerLinkSessionObserver);
  const grantAttribution = yield* Effect.serviceOption(CredentialAttribution.McpGrantAttribution);
  const linksEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  const signingKey = yield* secretStore
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(Effect.orDie);
  const codes = yield* Ref.make<ReadonlyMap<string, PendingCode>>(new Map());

  const sign = (domain: string, payload: string) => signPayload(`${domain}.${payload}`, signingKey);

  const signClientId = (name: string, redirectUris: ReadonlyArray<string>, peerLink: boolean) => {
    const body = base64UrlEncode(
      JSON.stringify({ v: 1, n: name, r: redirectUris, ...(peerLink ? { p: 1 } : {}) }),
    );
    return `${body}.${sign("mcp-client-id", body)}`;
  };

  const parseClientId = (clientId: string): McpOAuthClient | undefined => {
    const [body, signature, extra] = clientId.split(".");
    if (!body || !signature || extra !== undefined) return undefined;
    if (!timingSafeEqualBase64Url(signature, sign("mcp-client-id", body))) return undefined;
    let json: string;
    try {
      json = base64UrlDecodeUtf8(body);
    } catch {
      return undefined;
    }
    return Option.getOrUndefined(
      decodeClientIdPayload(json).pipe(
        Option.map((payload) => ({
          clientId,
          name: payload.n,
          redirectUris: payload.r,
          peerLink: payload.p === 1,
        })),
      ),
    );
  };

  const pkceVerifies = (verifier: string, challenge: string) =>
    CODE_VERIFIER_PATTERN.test(verifier)
      ? crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(
          Effect.orDie,
          Effect.map((digest) => timingSafeEqualBase64Url(base64UrlEncode(digest), challenge)),
        )
      : Effect.succeed(false);

  const csrfToken = (sessionId: string, authorization: AuthorizationRequest) =>
    sign(
      "mcp-csrf",
      JSON.stringify([
        sessionId,
        authorization.client.clientId,
        authorization.redirectUri,
        authorization.codeChallenge,
        authorization.taskOnly,
        authorization.renewable,
      ]),
    );

  const register: McpOAuth["Service"]["register"] = Effect.fn("McpOAuth.register")(
    function* (metadata) {
      const rawName = metadata.client_name?.trim() ?? "";
      const name = (rawName.length > 0 ? rawName : DEFAULT_CLIENT_NAME).slice(
        0,
        MAX_CLIENT_NAME_LENGTH,
      );
      const redirectUris = metadata.redirect_uris ?? [];
      if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_redirect_uri",
          error_description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
        });
      }
      if (!redirectUris.every((uri) => parseRedirect(uri) !== undefined)) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_redirect_uri",
          error_description:
            "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
        });
      }
      // RFC 7591 allows ignoring unsupported registration options; all clients use public PKCE.
      const peerLink = metadata.software_id === MCP_PEER_LINK_SOFTWARE_ID;
      if (peerLink && !(yield* linksEnabled)) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_client_metadata",
          error_description:
            "Linked environments is off on that machine. Turn it on in its Settings → Labs.",
        });
      }
      return {
        clientId: signClientId(name, redirectUris, peerLink),
        name,
        redirectUris,
        peerLink,
      };
    },
  );

  const validateAuthorization: McpOAuth["Service"]["validateAuthorization"] = Effect.fn(
    "McpOAuth.validateAuthorization",
  )(function* ({ urls, request }) {
    const client = parseClientId(request.client_id ?? "");
    if (client === undefined) {
      return yield* new McpOAuthPageError({
        description: "This sign-in link names an unknown app. Start the sign-in again from it.",
      });
    }
    const redirectUri = request.redirect_uri;
    if (
      redirectUri === undefined ||
      !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
    ) {
      return yield* new McpOAuthPageError({
        description: "This sign-in link sends you to an address the app did not register.",
      });
    }
    const state = request.state;
    const fail = (error: McpOAuthRedirectError["error"], description: string) =>
      new McpOAuthRedirectError({
        error,
        description,
        redirectUri,
        ...(state === undefined ? {} : { state }),
      });
    if (request.response_type !== "code") {
      return yield* fail("unsupported_response_type", "Only response_type=code is supported.");
    }
    const codeChallenge = request.code_challenge;
    if (
      request.code_challenge_method !== "S256" ||
      codeChallenge === undefined ||
      !CODE_CHALLENGE_PATTERN.test(codeChallenge)
    ) {
      return yield* fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    if (!sameResource(urls, request.resource)) {
      return yield* fail("invalid_target", `This server only issues tokens for ${urls.resource}.`);
    }
    if (
      (request.task_only !== undefined && request.task_only !== "true") ||
      (request.offline_access !== undefined && request.offline_access !== "true") ||
      (request.offline_access === "true" && request.task_only !== "true")
    ) {
      return yield* fail(
        "invalid_request",
        "Renewable access requires an explicit task-only request.",
      );
    }
    const taskOnly = request.task_only === "true";
    if (taskOnly && parseRedirect(urls.resource) === undefined) {
      return yield* fail("invalid_request", "Task access requires HTTPS or loopback transport.");
    }
    // Task grant sessions do not carry the link marker that keeps a linked environment's work within its link.
    if (taskOnly && client.peerLink) {
      return yield* fail("invalid_request", "Linked environments cannot request task access.");
    }
    return {
      client,
      redirectUri,
      codeChallenge,
      state,
      resource: urls.resource,
      issuer: urls.issuer,
      taskOnly,
      renewable: request.offline_access === "true",
    } satisfies AuthorizationRequest;
  });

  const approvingBrowserSession: McpOAuth["Service"]["approvingBrowserSession"] = (
    request,
    authorization,
  ) =>
    environmentAuth.authenticateBrowserSession(request).pipe(
      Effect.map((session) =>
        // Approving manages access, and a session may only hand out scopes it holds.
        session.scopes.includes(AuthAccessWriteScope) &&
        session.scopes.includes(AuthOrchestrationReadScope)
          ? {
              csrfToken: csrfToken(session.sessionId, authorization),
              scopes: session.scopes,
              subject: session.subject,
            }
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const mintCode = Effect.fn("McpOAuth.mintCode")(function* (
    authorization: AuthorizationRequest,
    access: AuthMcpClientAccess,
    approvalSubject: string | undefined,
    approvals: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const code = Buffer.from(yield* crypto.randomBytes(32).pipe(Effect.orDie)).toString(
      "base64url",
    );
    yield* Ref.update(codes, (current) => {
      const next = new Map(Array.from(current).filter(([, pending]) => pending.expiresAtMs > now));
      next.set(code, {
        clientId: authorization.client.clientId,
        clientName: authorization.client.name,
        peerLink: authorization.client.peerLink,
        redirectUri: authorization.redirectUri,
        codeChallenge: authorization.codeChallenge,
        resource: authorization.resource,
        access,
        expiresAtMs: now + AUTHORIZATION_CODE_TTL_MS,
        taskOnly: authorization.taskOnly,
        renewable: authorization.renewable,
        approvalSubject,
        approvals,
      });
      return next;
    });
    return code;
  });

  const approve: McpOAuth["Service"]["approve"] = Effect.fn("McpOAuth.approve")(function* (input) {
    const { decision } = input;
    if (input.authorization.taskOnly && decision.access === "full-access") {
      return yield* new McpOAuthPageError({
        description: "Task-only access is limited to Auto or a lower mode.",
      });
    }
    const approvals = decision.approvals === true;
    if (
      approvals &&
      (decision.access === "read-only" ||
        input.authorization.taskOnly ||
        (input.authorization.client.peerLink && decision._tag !== "pairing-code"))
    )
      return yield* new McpOAuthPageError({
        description:
          "Permission approvals require task access; a peer link also needs an approval-capable pairing code.",
      });
    let approvalSubject: string | undefined;
    if (decision._tag === "pairing-code") {
      ({ subject: approvalSubject } = yield* environmentAuth
        .consumeMcpApprovalCode(decision.code, decision.access, approvals)
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
            Effect.logError("MCP approval code check failed.", { cause }).pipe(
              Effect.andThen(
                Effect.fail(
                  new McpOAuthPageError({
                    description: "The code could not be checked. Try again.",
                  }),
                ),
              ),
            ),
          ),
        ));
    } else {
      const session = yield* approvingBrowserSession(input.request, input.authorization);
      if (
        session === undefined ||
        !timingSafeEqualBase64Url(decision.csrfToken, session.csrfToken) ||
        !mcpClientScopes(decision.access).every((scope) => session.scopes.includes(scope)) ||
        (approvals && CredentialAttribution.isMcpClientSubject(session?.subject ?? ""))
      ) {
        return yield* new McpOAuthPageError({
          description: "Your session cannot approve this request. Enter a pairing code instead.",
        });
      }
      approvalSubject = session.subject;
    }
    const code = yield* mintCode(input.authorization, decision.access, approvalSubject, approvals);
    yield* Effect.logInfo("Approved an MCP client sign-in.", {
      client: input.authorization.client.name,
      access: decision.access,
      method: decision._tag,
    });
    return redirectWith(input.authorization.redirectUri, {
      code,
      state: input.authorization.state,
      iss: input.authorization.issuer,
    });
  });

  const deny: McpOAuth["Service"]["deny"] = (authorization) =>
    redirectWith(authorization.redirectUri, {
      error: "access_denied",
      state: authorization.state,
      iss: authorization.issuer,
    });

  const exchangeCode: McpOAuth["Service"]["exchangeCode"] = Effect.fn("McpOAuth.exchangeCode")(
    function* ({ request, urls, token }) {
      const fail = (error: AuthMcpTokenError["error"], description: string) =>
        new AuthMcpTokenError({ error, error_description: description });
      const grantResult = (issued: {
        readonly token: string;
        readonly expiresIn: number;
        readonly grantId: string;
        readonly access: AuthMcpClientAccess;
        readonly refreshToken?: string;
        readonly refreshExpiresIn?: number;
      }): AuthMcpTokenResult => ({
        access_token: issued.token,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        scope: encodeOAuthScope(mcpClientScopes(issued.access)),
        grant_id: issued.grantId,
        task_only: true,
        ...(issued.refreshToken === undefined
          ? {}
          : { refresh_token: issued.refreshToken, refresh_expires_in: issued.refreshExpiresIn! }),
      });
      if (token.grant_type === "refresh_token") {
        if (
          !token.client_id ||
          !token.refresh_token ||
          !token.resource ||
          !sameResource(urls, token.resource) ||
          parseRedirect(urls.resource) === undefined
        ) {
          return yield* fail(
            "invalid_request",
            "client_id, refresh_token and the secure MCP resource are required.",
          );
        }
        // An unattributed grant's fleet holder signs for it; any other claim changes nothing.
        // Holders sign every refresh, so the share is read only for a grant that still needs it,
        // and a share too slow to answer only leaves the grant unattributed this time.
        const holder =
          token.fleet_assertion === undefined ||
          Option.isNone(grantAttribution) ||
          !(yield* grants
            .unattributed({
              clientId: token.client_id,
              resource: urls.resource,
              token: token.refresh_token,
            })
            .pipe(Effect.orElseSucceed(() => false)))
            ? undefined
            : yield* grantAttribution.value
                .verify(token.fleet_assertion)
                .pipe(
                  Effect.timeoutOption(GRANT_ATTRIBUTION_TIMEOUT_MS),
                  Effect.map(Option.getOrUndefined),
                );
        return yield* grants
          .refresh({
            clientId: token.client_id,
            resource: urls.resource,
            token: token.refresh_token,
            client: deriveAuthClientMetadata({ request }),
            ...(holder === undefined ? {} : { holder }),
          })
          .pipe(
            Effect.map(grantResult),
            Effect.mapError(() =>
              fail(
                "invalid_grant",
                "The task grant is invalid, expired or revoked. Approve a new sign-in.",
              ),
            ),
          );
      }
      if (token.grant_type !== "authorization_code") {
        return yield* fail(
          "unsupported_grant_type",
          "Only authorization_code and refresh_token are supported.",
        );
      }
      const { redirect_uri: redirectUri, client_id: clientId } = token;
      const code = token.code && Redacted.value(token.code);
      const verifier = token.code_verifier && Redacted.value(token.code_verifier);
      if (!code || !redirectUri || !clientId || !verifier) {
        return yield* fail(
          "invalid_request",
          "code, redirect_uri, client_id and code_verifier are required.",
        );
      }
      if (parseClientId(clientId) === undefined) {
        return yield* fail("invalid_client", "The client is unknown.");
      }
      // A presented code is spent even when a later check fails (RFC 6749 §4.1.2).
      const pending = yield* Ref.modify(codes, (current) => {
        const found = current.get(code);
        if (found === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(code);
        return [found, next] as const;
      });
      const now = yield* Clock.currentTimeMillis;
      if (
        pending === undefined ||
        pending.expiresAtMs <= now ||
        pending.clientId !== clientId ||
        pending.redirectUri !== redirectUri ||
        pending.resource !== urls.resource ||
        !sameResource(urls, token.resource) ||
        !(yield* pkceVerifies(verifier, pending.codeChallenge))
      ) {
        return yield* fail("invalid_grant", "The authorization code is invalid or expired.");
      }
      if (pending.taskOnly) {
        return yield* approvalAuthority
          .withoutFamilyApproval(
            clientId,
            pending.approvalSubject ?? "",
            grants
              .issue({
                clientId,
                resource: urls.resource,
                access: pending.access,
                client: { ...deriveAuthClientMetadata({ request }), label: pending.clientName },
                renewable: pending.renewable,
                // A grant acts for the fleet machine whose credential approved it, if any.
                subject: CredentialAttribution.mcpClientSubject(pending.approvalSubject ?? ""),
              })
              .pipe(Effect.map(grantResult)),
          )
          .pipe(
            Effect.mapError(() => fail("invalid_grant", "The task grant could not be issued.")),
          );
      }
      const issued = yield* environmentAuth
        .issueMcpClientSession({
          label: pending.clientName,
          approvals: pending.approvals,
          applicationId: pending.clientId,
          access: pending.access,
          peerLink: pending.peerLink,
          client: deriveAuthClientMetadata({ request }),
          ...(pending.approvalSubject === undefined
            ? {}
            : { approvalSubject: pending.approvalSubject }),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError("Could not issue an MCP client session.", { cause }).pipe(
              Effect.andThen(
                Effect.fail(fail("invalid_grant", "The session could not be issued.")),
              ),
            ),
          ),
        );
      if (
        pending.peerLink &&
        pending.approvalSubject !== undefined &&
        Option.isSome(sessionObserver) &&
        !(yield* sessionObserver.value.sessionIssued({
          subject: pending.approvalSubject,
          sessionId: issued.sessionId,
        }))
      ) {
        yield* environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore);
        return yield* fail("invalid_grant", "The session could not be issued.");
      }
      return {
        access_token: issued.token,
        token_type: "Bearer",
        expires_in: Math.max(0, Math.floor((issued.expiresAt.epochMilliseconds - now) / 1000)),
        scope: encodeOAuthScope(mcpClientScopes(pending.access, { approvals: pending.approvals })),
      };
    },
  );

  const revoke: McpOAuth["Service"]["revoke"] = Effect.fn("McpOAuth.revoke")(function* ({
    urls,
    token,
  }) {
    if (!sameResource(urls, token.resource) || parseRedirect(urls.resource) === undefined) {
      return yield* new AuthMcpTokenError({
        error: "invalid_request",
        error_description: "A secure matching MCP resource is required.",
      });
    }
    yield* grants
      .revoke({ clientId: token.client_id, resource: urls.resource, token: token.token })
      .pipe(
        Effect.mapError(
          () =>
            new AuthMcpTokenError({
              error: "invalid_grant",
              error_description: "The task grant could not be revoked.",
            }),
        ),
      );
  });

  return McpOAuth.of({
    register,
    validateAuthorization,
    approvingBrowserSession,
    approve,
    deny,
    exchangeCode,
    revoke,
  });
});

export const layer = Layer.effect(McpOAuth, make);

export const layerMcpClientAuthenticator = Layer.effect(
  McpHttpServer.McpClientAuthenticator,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    return McpHttpServer.McpClientAuthenticator.of({
      authenticate: Effect.fn("McpHttpServer.McpClientAuthenticator.authenticate")(
        function (request) {
          return environmentAuth.authenticateMcpClient(request).pipe(
            Effect.flatMap((client) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((issuedAt): McpInvocationContext.McpInvocationScope => ({
                  environmentId,
                  requestNamespace: `client:${client.grantId ?? client.sessionId}`,
                  thread: undefined,
                  client: {
                    sessionId: client.sessionId,
                    label: client.label,
                    access: client.access,
                    ...(client.grantId === undefined
                      ? {}
                      : { grantId: client.grantId, taskOnly: client.taskOnly }),
                    linked: client.peerLink,
                    ...(client.peerLink ? {} : { webOrigin: requestUrls(request).issuer }),
                    sharesOutside: client.sharesOutside,
                  },
                  capabilities: new Set<McpInvocationContext.McpCapability>([
                    "orchestration",
                    "worktree",
                    "pull-requests",
                  ]),
                  issuedAt,
                })),
              ),
            ),
            Effect.catch((error) =>
              (EnvironmentAuth.isServerAuthCredentialError(error)
                ? Effect.void
                : Effect.logWarning("MCP client authentication failed.", { cause: error })
              ).pipe(Effect.as(undefined)),
            ),
          );
        },
      ),
    });
  }),
);
