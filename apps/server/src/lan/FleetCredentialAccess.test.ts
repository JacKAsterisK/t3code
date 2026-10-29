import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, EnvironmentHttpApi, mcpClientScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthGrants from "../auth/McpOAuthGrants.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as FleetContext from "./FleetContext.ts";
import * as FleetCredentialAccess from "./FleetCredentialAccess.ts";
import * as Delivery from "./FleetDelivery.ts";

// CryoFrog's server, receiving calls from AnvilToad. Only synthetic identities and an in-memory
// database are used.
const CRYO = "cryofrog";
const ANVIL = "anviltoad";
const PANDA = "pandamedic";
let policy: FleetAccessPolicy.FleetAccessState;
let trusted: ReadonlyArray<string>;
const resetFleet = () => {
  policy = {
    revision: 1,
    defaultAccess: "standard",
    machines: [],
    machineId: CRYO,
    peers: [ANVIL, PANDA].map((machineId) => ({
      machineId,
      environmentId: `environment:${machineId}`,
    })),
  };
  trusted = [ANVIL, PANDA];
};
const restrict = (machineId: string) => {
  policy = {
    ...policy,
    revision: policy.revision + 1,
    machines: [{ machineId, access: "read-only" }],
  };
};

class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-credential-test-" });
const layerAccess = FleetCredentialAccess.layerServices.pipe(
  Layer.provide(Layer.mock(FleetAccessPolicy.FleetAccess)({ current: Effect.sync(() => policy) })),
);
const layerCap = Layer.effect(
  CredentialAttribution.CredentialAccessCap,
  FleetCredentialAccess.FleetCredentialAccess.pipe(
    Effect.map((access) => CredentialAttribution.CredentialAccessCap.of({ scopes: access.scopes })),
  ),
).pipe(Layer.provide(layerAccess));
const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(layerCap),
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);

interface Services {
  readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly grants: McpOAuthGrants.McpOAuthGrants["Service"];
  /** One revocation pass against CryoFrog's credentials. */
  readonly revoke: Effect.Effect<void>;
}

const makeLayerRoutes = (capture: (services: Services) => void) =>
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const grants = yield* McpOAuthGrants.McpOAuthGrants;
        const access = yield* FleetCredentialAccess.FleetCredentialAccess;
        const context = FleetContext.FleetContext.of({
          load: Effect.sync(
            () =>
              ({
                peers: trusted.map((machineId) => ({ peer: { machineId } })),
              }) as unknown as FleetContext.FleetLinkContext,
          ),
        });
        capture({
          auth,
          grants,
          revoke: FleetCredentialAccess.revokeExcess().pipe(
            Effect.provideService(FleetCredentialAccess.FleetCredentialAccess, access),
            Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
            Effect.provideService(FleetContext.FleetContext, context),
            Effect.orDie,
          ),
        });
      }),
    ),
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(
        McpOAuthHttp.layer.pipe(
          Layer.provide(McpOAuth.layer),
          Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
        ),
      ),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provideMerge(layerAccess),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ORIGIN = "https://cryofrog.example.test";
const verifier = "a".repeat(43) + "-verifier-for-tests";
const challenge = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";
type Handler = (request: Request) => Effect.Effect<Response>;

const at = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { host: "cryofrog.example.test", "x-forwarded-proto": "https", ...init?.headers },
  });
const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);
const postJson = (path: string, body: unknown, headers?: Record<string, string>) =>
  at(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});
const mcpRequest = (token: string) =>
  HttpServerRequest.fromWeb(at("/mcp", { headers: { authorization: `Bearer ${token}` } }));

const withRoutes = <A, E>(use: (handler: Handler, services: Services) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    resetFleet();
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let services: Services | undefined;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeLayerRoutes((captured) => {
            services = captured;
          }),
          { disableLogger: true },
        ),
      ),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          yield* handler(at("/.well-known/oauth-authorization-server"));
          return yield* use(handler, services!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

/** A renewable task grant for `t3_lan_*` routing, approved with `code` the way a gateway gets one. */
const approveTaskGrant = (handler: Handler, code: string) =>
  Effect.gen(function* () {
    const client = yield* handler(
      postJson("/oauth/mcp/register", {
        client_name: "dot T3 gateway",
        redirect_uris: ["http://127.0.0.1/oauth/t3/callback"],
        token_endpoint_auth_method: "none",
      }),
    ).pipe(Effect.flatMap(json<{ client_id: string }>));
    const authorization = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1/oauth/t3/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-1",
      resource: `${ORIGIN}/mcp`,
      task_only: "true",
      offline_access: "true",
    };
    const approved = yield* handler(
      postJson("/oauth/mcp/decision", {
        authorization,
        decision: { _tag: "pairing-code", access: "auto", code },
      }),
    ).pipe(Effect.flatMap(json<{ redirectTo: string }>));
    const issued = yield* handler(
      at(
        "/oauth/mcp/token",
        form({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: new URL(approved.redirectTo).searchParams.get("code")!,
          code_verifier: verifier,
          redirect_uri: authorization.redirect_uri,
          resource: `${ORIGIN}/mcp`,
        }),
      ),
    ).pipe(Effect.flatMap(json<{ access_token: string; refresh_token: string }>));
    const refresh = handler(
      at(
        "/oauth/mcp/token",
        form({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: issued.refresh_token,
          resource: `${ORIGIN}/mcp`,
        }),
      ),
    );
    return { ...issued, refresh };
  });

/** AnvilToad's own fleet credential here, as the fleet sync issues it. */
const anvilFleetSession = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) =>
  auth.issueSession({
    subject: `lan-fleet:${Delivery.deliveryFileName(CRYO, ANVIL)}`,
    scopes: AuthStandardClientScopes,
  });

const mintCode = (handler: Handler, token: string) =>
  handler(
    postJson(
      "/api/auth/pairing-token",
      { scopes: [...mcpClientScopes("auto")] },
      { authorization: `Bearer ${token}` },
    ),
  );

it.live("refuses a downgraded machine's existing task grant at the receiver, then revokes it", () =>
  withRoutes((handler, { auth, revoke }) =>
    Effect.gen(function* () {
      const anvil = yield* anvilFleetSession(auth);
      // AnvilToad's fleet session mints the code that approves its gateway's task grant.
      const minted = yield* mintCode(handler, anvil.token);
      expect(minted.status).toBe(200);
      const code = (yield* json<{ credential: string }>(minted)).credential;
      const grant = yield* approveTaskGrant(handler, code);
      expect((yield* auth.authenticateMcpClient(mcpRequest(grant.access_token))).access).toBe(
        "auto",
      );

      restrict(ANVIL);
      // Before anything is revoked, the grant can no longer launch, send, interrupt or respond.
      const capped = yield* auth.authenticateMcpClient(mcpRequest(grant.access_token));
      expect(capped).toMatchObject({ taskOnly: true, access: "read-only" });
      const refreshed = yield* grant.refresh.pipe(
        Effect.flatMap(json<{ access_token: string; refresh_token: string }>),
      );
      expect((yield* auth.authenticateMcpClient(mcpRequest(refreshed.access_token))).access).toBe(
        "read-only",
      );
      // Nor can its still-standard fleet session mint codes or change this machine's settings.
      expect((yield* mintCode(handler, anvil.token)).status).toBe(403);

      yield* revoke;
      expect(
        yield* auth
          .authenticateMcpClient(mcpRequest(refreshed.access_token))
          .pipe(Effect.isFailure),
      ).toBe(true);
      // Its own fleet credential is left for the fleet sync to replace, capped meanwhile.
      const sessions = yield* auth.listSessions();
      expect(sessions.some((session) => session.sessionId === anvil.sessionId)).toBe(true);
      expect(
        sessions.some(
          (session) =>
            CredentialAttribution.attributionRoot(session.subject) !== undefined &&
            session.sessionId !== anvil.sessionId,
        ),
      ).toBe(false);
    }),
  ),
);

it.live(
  "leaves grants approved here or for standard machines alone, and caps unattributed ones",
  () =>
    withRoutes((handler, { auth, grants, revoke }) =>
      Effect.gen(function* () {
        const local = yield* approveTaskGrant(
          handler,
          (yield* auth.issuePairingCredential({ scopes: [...mcpClientScopes("auto")] })).credential,
        );
        const panda = yield* auth.issueSession({
          subject: `lan-fleet:${Delivery.deliveryFileName(CRYO, PANDA)}`,
          scopes: AuthStandardClientScopes,
        });
        const pandaGrant = yield* approveTaskGrant(
          handler,
          (yield* json<{ credential: string }>(yield* mintCode(handler, panda.token))).credential,
        );
        // A grant from before grants recorded who approved them.
        const legacy = yield* grants.issue({
          clientId: "legacy",
          resource: `${ORIGIN}/mcp`,
          access: "auto",
          client: { deviceType: "bot" },
          renewable: false,
        });
        restrict(ANVIL);
        yield* revoke;
        expect((yield* auth.authenticateMcpClient(mcpRequest(local.access_token))).access).toBe(
          "auto",
        );
        expect(
          (yield* auth.authenticateMcpClient(mcpRequest(pandaGrant.access_token))).access,
        ).toBe("auto");
        // Nobody can tell whose it is, so while any machine is restricted it only reads.
        expect((yield* auth.authenticateMcpClient(mcpRequest(legacy.token))).access).toBe(
          "read-only",
        );
      }),
    ),
);

it.live("refuses everything from a machine that left or is no longer trusted, and revokes it", () =>
  withRoutes((handler, { auth, revoke }) =>
    Effect.gen(function* () {
      const anvil = yield* anvilFleetSession(auth);
      const code = (yield* json<{ credential: string }>(yield* mintCode(handler, anvil.token)))
        .credential;
      const grant = yield* approveTaskGrant(handler, code);
      // Its roster entry is disabled: the full trust check no longer finds it.
      trusted = [PANDA];
      yield* revoke;
      expect((yield* mintCode(handler, anvil.token)).status).toBe(401);
      expect(
        yield* auth.authenticateMcpClient(mcpRequest(grant.access_token)).pipe(Effect.isFailure),
      ).toBe(true);
      expect((yield* auth.listSessions()).some((s) => s.sessionId === anvil.sessionId)).toBe(false);
      // A machine the fleet disabled is refused at once, before any revocation runs.
      resetFleet();
      const again = yield* anvilFleetSession(auth);
      policy = { ...policy, peers: policy.peers.filter((peer) => peer.machineId !== ANVIL) };
      expect((yield* mintCode(handler, again.token)).status).toBe(401);
    }),
  ),
);
