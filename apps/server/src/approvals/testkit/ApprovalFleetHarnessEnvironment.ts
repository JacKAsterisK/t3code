// @effect-diagnostics nodeBuiltinImport:off -- The fixture owns a captured loopback listener and closes it with its scope.
import * as NodeHttp from "node:http";
import { assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  ApprovalReceiptResult,
  EnvironmentHttpApi,
  type ApprovalRespondInput,
  type ApprovalToolInput,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Auth from "../../auth/EnvironmentAuth.ts";
import * as Sessions from "../../auth/SessionStore.ts";
import * as Authority from "../../auth/ApprovalAuthority.ts";
import * as PeerAccess from "../../auth/ApprovalPeerAccess.ts";
import * as OAuth from "../../auth/McpOAuth.ts";
import * as OAuthHttp from "../../auth/mcpOAuthHttp.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Commands from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Outbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Registry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadCommands from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Mcp from "../../mcp/McpHttpServer.ts";
import * as McpSessions from "../../mcp/McpSessionRegistry.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerClient from "../../peer/PeerMcpClient.ts";
import * as Network from "../../peer/PeerNetworkDispatch.ts";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Runtime from "../ApprovalRuntime.ts";
import * as FleetPeerLinks from "../../lan/FleetPeerLinks.ts";
import * as Service from "../ApprovalService.ts";
import * as LaunchFixture from "./ApprovalFleetHarnessLaunch.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as Receiver from "../ApprovalReceiver.ts";
import * as Forwarding from "../ApprovalForwarding.ts";
import * as Delegations from "../ApprovalDelegations.ts";
import * as Wire from "../../../../../packages/contracts/src/approvalForwarding.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";

const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeWireEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    params: Schema.Struct({ name: Schema.String, arguments: Wire.LinkApprovalRequest }),
  }),
);
const decodeReceipt = Schema.decodeUnknownEffect(ApprovalReceiptResult);
export const proof = (kind: string, fields: Record<string, unknown>) =>
  Console.log(stringify({ proof: "approval_fleet", kind, ...fields }));
export const instanceId = ProviderInstanceId.make("codex");
class ApprovalFleetOAuthApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.mcpOAuth,
) {}

export const makeEnvironment = Effect.fn("ApprovalFleetHarness.makeEnvironment")(function* (
  name: "A" | "B",
) {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: `t3-approval-fleet-${name}-` });
  const database = Sqlite.layerMemory;
  const identity = Environment.layerIdentity.pipe(
    Layer.provideMerge(Secrets.layer),
    Layer.provide(config),
  );
  const settings = ServerSettings.layerTest({ linkedEnvironmentsEnabled: true });
  const authority = Auth.layer.pipe(
    Layer.provideMerge(Runtime.layerDestination),
    Layer.provideMerge(database),
    Layer.provideMerge(identity),
    Layer.provideMerge(config),
    Layer.provideMerge(settings),
    Layer.provide(NodeServices.layer),
  );
  const native = Replay.layerWithRegistry(
    { name: `approval-fleet-${name}` },
    Registry.layerFromAdapters([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("Only the explicitly owned free Node fixture may run"),
      },
    ]),
    { databaseLayer: database, runEffectWorker: false },
  ).pipe(Layer.provideMerge(authority));
  const services = Service.layer.pipe(
    Layer.provideMerge(ThreadCommands.layer),
    Layer.provideMerge(native),
    Layer.provideMerge(Projections.layer.pipe(Layer.provide(database))),
    Layer.provideMerge(Commands.layer.pipe(Layer.provide(database))),
    Layer.provideMerge(Outbox.layer.pipe(Layer.provide(database))),
    Layer.provideMerge(config),
    Layer.provideMerge(settings),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(services).pipe(
    Effect.provideService(References.MinimumLogLevel, "Error"),
  );
  const id = yield* Context.get(context, Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const auth = Context.get(context, Auth.EnvironmentAuth);
  const owner = yield* auth.issueSession({
    scopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
  });
  assert.isDefined(
    yield* Context.get(context, PeerAccess.ApprovalPeerAccess).owner(owner.sessionId),
  );
  yield* proof("environment", {
    name,
    environmentId: id,
    home: Context.get(context, ServerConfig.ServerConfig).baseDir,
    sql: "isolated-memory",
    ownerSessionId: owner.sessionId,
  });
  return {
    name,
    id,
    context,
    auth,
    owner,
    sql: Context.get(context, SqlClient.SqlClient),
    projections: Context.get(context, Projections.ProjectionStoreV2),
  };
});
export type FleetEnvironment = Effect.Success<ReturnType<typeof makeEnvironment>>;

export interface HttpFault {
  readonly operation: "prepare" | "commit" | "status";
  readonly stage: "before" | "after";
  readonly drop?: boolean;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
export const makeNetwork = Effect.fn("ApprovalFleetHarness.makeNetwork")(function* () {
  const fault = yield* Ref.make<HttpFault | undefined>(undefined);
  const calls: Wire.LinkApprovalRequest[] = [];
  const client = yield* HttpClient.HttpClient;
  const dispatch = yield* Network.PeerNetworkDispatch;
  const intercept = Effect.fn("ApprovalFleetHarness.intercept")(function* <E, R>(
    response: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const body = request.body;
    const rpc: unknown =
      body._tag === "Uint8Array" ? parse(new TextDecoder().decode(body.body)) : undefined;
    const parsed = decodeWireEnvelope(rpc);
    const args =
      parsed._tag === "Some" && parsed.value.params.name === "t3_link_approval_request"
        ? parsed.value.params.arguments
        : undefined;
    if (args !== undefined) calls.push(args);
    const candidate = yield* Ref.get(fault);
    const active =
      candidate !== undefined && args?.operation === candidate.operation ? candidate : undefined;
    if (active !== undefined) yield* Ref.set(fault, undefined);
    if (active?.stage === "before") {
      yield* Deferred.succeed(active.reached, undefined);
      yield* Deferred.await(active.release);
      if (active.drop === true)
        return HttpClientResponse.fromWeb(
          request,
          new Response("fixture withheld request", { status: 503 }),
        );
    }
    const received = yield* response;
    // Consume the actual response before losing it, proving B completed its transaction.
    if (active?.stage === "after") {
      yield* received.text;
      yield* Deferred.succeed(active.reached, undefined);
      yield* Deferred.await(active.release);
    }
    if (active?.drop === true)
      return HttpClientResponse.fromWeb(
        request,
        new Response("fixture lost reply", { status: 503 }),
      );
    return received;
  });
  const network = HttpClient.transform(client, intercept);
  const guarded: typeof dispatch = {
    execute: (request, beforeSend) => intercept(dispatch.execute(request, beforeSend), request),
  };
  const arm = Effect.fn("ApprovalFleetHarness.arm")(function* (
    operation: HttpFault["operation"],
    stage: HttpFault["stage"],
    drop = false,
  ) {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const value = { operation, stage, drop, reached, release };
    yield* Ref.set(fault, value);
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));
    return value;
  });
  return { client: network, dispatch: guarded, calls, arm };
});
export type FleetNetwork = Effect.Success<ReturnType<typeof makeNetwork>>;

export const serve = Effect.fn("ApprovalFleetHarness.serve")(function* (
  env: FleetEnvironment,
  extra: ReturnType<typeof forwardingLayer> | undefined = undefined,
  includeLinkToolkit = false,
  includeLaunchToolkit = false,
) {
  const identity = Layer.succeed(
    Environment.ServerEnvironment,
    Environment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(env.id),
      getDescriptor: Effect.die("Environment metadata is not used by approval tools"),
    }),
  );
  const launchServices = yield* Layer.build(LaunchFixture.layer(env)).pipe(
    Effect.provide(env.context),
  );
  const registry = McpSessions.layer.pipe(Layer.provide(identity));
  const authenticator = OAuth.layerMcpClientAuthenticator.pipe(Layer.provide(identity));
  const handlerServices = Receiver.layer.pipe(Layer.provideMerge(extra ?? Layer.empty));
  const approvalTools = includeLinkToolkit
    ? Layer.mergeAll(Mcp.layerApprovalToolkit, Mcp.layerLinkApprovalToolkit)
    : Mcp.layerApprovalToolkit;
  const tools = includeLaunchToolkit
    ? Layer.mergeAll(approvalTools, Mcp.layerProjectRegistration)
    : approvalTools;
  const mcp = tools.pipe(
    Layer.provideMerge(Mcp.layerMcpTransport),
    Layer.provide(handlerServices),
    Layer.provide(Layer.succeedContext(launchServices)),
    Layer.provide(registry),
    Layer.provide(authenticator),
  );
  const oauth = HttpApiBuilder.layer(ApprovalFleetOAuthApi).pipe(
    Layer.provide(OAuthHttp.layer.pipe(Layer.provide(OAuth.layer))),
  );
  const ownedListener = yield* Effect.sync(() => NodeHttp.createServer());
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      assert.isFalse(ownedListener.listening);
      yield* proof("boundary", {
        environment: env.name,
        resource: "loopback-listener",
        state: "closed",
      });
    }),
  );
  const listener = NodeHttpServer.layer(() => ownedListener, { port: 0, host: "127.0.0.1" });
  const listenerContext = yield* Layer.build(listener);
  const address = HttpServer.formatAddress(
    Context.get(listenerContext, HttpServer.HttpServer).address,
  );
  yield* HttpRouter.serve(Layer.mergeAll(mcp, oauth), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.build, Effect.provide(env.context), Effect.provide(listenerContext));
  yield* proof("boundary", {
    environment: env.name,
    listener: address,
    state: "listening",
    authentication: "McpOAuth+normalMiddleware",
  });
  yield* Effect.addFinalizer(() =>
    proof("boundary", { environment: env.name, listener: address, state: "scope_closing" }),
  );
  return { env, url: address };
});
export interface FleetServer {
  readonly env: FleetEnvironment;
  readonly url: string;
}

const jsonObject = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
export const connect = Effect.fn("ApprovalFleetHarness.connect")(function* (
  server: FleetServer,
  token: string,
) {
  const http = yield* HttpClient.HttpClient;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    http.post(`${server.url}${path}`, {
      headers,
      body: HttpBody.text(stringify(body), "application/json"),
    });
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
  };
  const initialized = yield* post(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "approval-fleet-fixture", version: "1" },
      },
    },
    headers,
  );
  const initializedText = yield* initialized.text;
  assert.equal(initialized.status, 200, initializedText);
  assert.isString(initialized.headers["mcp-session-id"]);
  const mcpHeaders = {
    ...headers,
    "mcp-session-id": initialized.headers["mcp-session-id"]!,
    "mcp-protocol-version": "2025-06-18",
  };
  yield* post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, mcpHeaders);
  const call = Effect.fn("ApprovalFleetHarness.call")(function* (
    input: unknown,
    name = "t3_approval_request",
  ) {
    const response = yield* post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } },
      mcpHeaders,
    );
    const text = yield* response.text;
    const data = text.includes("data:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : text;
    return yield* jsonObject(parse(data));
  });
  return { call, token, server };
});
export type FleetClient = Effect.Success<ReturnType<typeof connect>>;

export const oauthClient = Effect.fn("ApprovalFleetHarness.oauthClient")(function* (
  server: FleetServer,
  label: string,
  access: AuthMcpClientAccess = "full-access",
  approvals = true,
) {
  const http = yield* HttpClient.HttpClient;
  const post = (path: string, body: unknown) =>
    http.post(`${server.url}${path}`, { body: HttpBody.text(stringify(body), "application/json") });
  const registered = yield* post("/oauth/mcp/register", {
    client_name: label,
    redirect_uris: ["http://localhost/callback"],
    grant_types: ["authorization_code"],
    token_endpoint_auth_method: "none",
  });
  const registration = yield* jsonObject(yield* registered.json);
  const clientId = String(registration.client_id);
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:51234/callback",
    code_challenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
    code_challenge_method: "S256",
    state: label,
  };
  const owner = (yield* Context.get(server.env.context, Sessions.SessionStore).listActive()).find(
    (s) => s.sessionId === server.env.owner.sessionId,
  )!;
  const grant = yield* server.env.auth.issuePairingCredential(
    { approvalGrant: true },
    { subject: owner.subject, scopes: new Set(owner.scopes) },
  );
  const approved = yield* post("/oauth/mcp/decision", {
    authorization,
    decision: { _tag: "pairing-code", code: grant.credential, access, approvals },
  });
  const decision = yield* jsonObject(yield* approved.json);
  assert.equal(approved.status, 200, stringify(decision));
  const code = new URL(String(decision.redirectTo)).searchParams.get("code")!;
  const exchanged = yield* http.post(`${server.url}/oauth/mcp/token`, {
    body: HttpBody.text(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: authorization.redirect_uri,
        code_verifier: "a".repeat(43) + "-verifier-for-tests",
      }).toString(),
      "application/x-www-form-urlencoded",
    ),
  });
  const token = yield* jsonObject(yield* exchanged.json);
  assert.equal(exchanged.status, 200, stringify(token));
  assert.equal(String(token.scope).includes("orchestration:approve"), approvals);
  const client = yield* connect(server, String(token.access_token));
  const verified = yield* Context.get(server.env.context, Sessions.SessionStore).verify(
    client.token,
  );
  const current = yield* Context.get(server.env.context, Authority.ApprovalAuthority).identity(
    verified.sessionId,
    "read",
  );
  yield* proof("boundary", {
    environment: server.env.name,
    authentication: "OAuth/PKCE",
    client: label,
    initiatingClientId: current.initiating_client_id,
    approvals,
  });
  return {
    ...client,
    sessionId: verified.sessionId,
    initiatingClientId: current.initiating_client_id,
  };
});
export type FleetOAuthClient = Effect.Success<ReturnType<typeof oauthClient>>;

export const linkPeer = Effect.fn("ApprovalFleetHarness.linkPeer")(function* (
  a: FleetEnvironment,
  b: FleetEnvironment,
  access: AuthMcpClientAccess = "full-access",
) {
  const delegations = Context.get(b.context, Delegations.ApprovalDelegations);
  const peers = Context.get(b.context, PeerAccess.ApprovalPeerAccess);
  const linkIdentityId = yield* delegations.createLink(b.owner.sessionId, a.id);
  const issue = () =>
    b.auth.issueMcpClientSession({
      label: "A native link",
      applicationId: "fleet-fixture-link",
      access,
      approvals: true,
      peerLink: true,
      client: { deviceType: "bot" },
    });
  const credential = yield* issue();
  yield* peers.bind(b.owner.sessionId, {
    sessionId: credential.sessionId,
    linkIdentityId,
    approvals: true,
    interactionModeCeiling: "default",
  });
  yield* peers.setPolicy(b.owner.sessionId, linkIdentityId, true, 0);
  const token = yield* Ref.make(credential.token);
  const rotate = Effect.fn("ApprovalFleetHarness.rotatePeer")(function* () {
    const replacement = yield* issue();
    yield* peers.bind(b.owner.sessionId, {
      sessionId: replacement.sessionId,
      linkIdentityId,
      approvals: true,
      interactionModeCeiling: "default",
      renew: { sessionId: credential.sessionId, revision: 1 },
    });
    yield* Ref.set(token, replacement.token);
    return replacement;
  });
  return { credential, token, linkIdentityId, rotate };
});
export type FleetLink = Effect.Success<ReturnType<typeof linkPeer>>;

export const forwardingLayer = (
  b: { readonly env: FleetEnvironment; readonly url: string | Ref.Ref<string> },
  link: FleetLink,
  network: FleetNetwork,
) => {
  const links = Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.succeed(true),
    list: Effect.succeed([]),
    resolve: Effect.fn("ApprovalFleetHarness.resolve")(function* () {
      const url = typeof b.url === "string" ? b.url : yield* Ref.get(b.url);
      assert.isNotEmpty(url, "An unpublished fixture endpoint must never receive a forwarded call");
      const token = yield* Ref.get(link.token);
      return {
        url,
        token,
        link: {
          environmentId: b.env.id,
          label: b.env.name,
          urls: [url],
          access: "full-access" as const,
          linkedAt: DateTime.toUtc(link.credential.expiresAt),
          expiresAt: DateTime.toUtc(link.credential.expiresAt),
          lastReachedAt: null,
          lastError: null,
        },
      };
    }),
    recordOutcome: () => Effect.void,
  });
  return Layer.mergeAll(Forwarding.layer, PeerForwarding.layer).pipe(
    Layer.provideMerge(
      PeerClient.layer.pipe(
        Layer.provideMerge(links),
        Layer.provide(FleetPeerLinks.layerWriteCeiling),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, network.client)),
        Layer.provide(Layer.succeed(Network.PeerNetworkDispatch, network.dispatch)),
      ),
    ),
  );
};

export const receipt = Effect.fn("ApprovalFleetHarness.receipt")(function* (
  client: FleetClient,
  input: ApprovalToolInput,
) {
  const response = yield* client.call(input);
  const value = yield* jsonObject(response.result);
  assert.notEqual(value.isError, true, stringify(response));
  const result = yield* jsonObject(value.structuredContent);
  const decoded = yield* decodeReceipt(result);
  return {
    ...decoded,
    forwarding: result.forwarding as {
      environmentId: string;
      receiptId: string | null;
      commandId: string | null;
    },
  };
});
export const failureCode = Effect.fn("ApprovalFleetHarness.failureCode")(function* (
  client: FleetClient,
  input: unknown,
  name = "t3_approval_request",
) {
  const response = yield* client.call(input, name);
  const result = yield* jsonObject(response.result);
  const content = result.content as Array<{ text: string }>;
  const failure = yield* jsonObject(parse(content[0]!.text));
  if (result.isError === true) {
    assert.isString(failure.code);
    return failure.code;
  }
  assert.equal(failure.state, "refused", stringify(response));
  assert.isString(failure.failureCode);
  return failure.failureCode;
});
export const statusInput = (input: ApprovalRespondInput) => ({
  action: "status" as const,
  ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
  threadId: input.threadId,
  clientRequestId: input.clientRequestId,
});
export const baseLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
