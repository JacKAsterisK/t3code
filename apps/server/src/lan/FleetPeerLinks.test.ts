// @effect-diagnostics nodeBuiltinImport:off -- Fixture share files are compared byte for byte, and one plain-http request sets its own Host.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import {
  type AuthMcpClientAccess,
  EnvironmentHttpApi,
  type FleetAccess as FleetAccessLevel,
  OrchestratorMcpFailure,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import { FLEET_TLS_FORWARD_HEADER, startFleetProxy } from "@t3tools/shared/fleetTlsProxy";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import * as FleetContext from "./FleetContext.ts";
import * as Delivery from "./FleetDelivery.ts";
import { syntheticFleetPeer } from "./FleetDelivery.fixtures.ts";
import { writeFleetJson } from "./FleetFiles.ts";
import * as FleetMcpOrigin from "./FleetMcpOrigin.ts";
import * as FleetPeerHttpClient from "./FleetPeerHttpClient.ts";
import * as FleetPeerLinks from "./FleetPeerLinks.ts";
import * as FleetTransport from "./FleetTransport.ts";

// What the synthetic fleet endpoint stamps on what it forwards; the server's own is random.
const FORWARDED_MARK = "synthetic-forwarded-mark";

/** A plain-http request straight to a backend, naming whatever `Host` its caller chooses. */
const plainGet = (url: string, host: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = NodeHttp.get(url, { headers: { host }, agent: false }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => resolve(body));
          response.on("error", reject);
        });
        request.on("error", reject);
      }),
  );

class FleetPeerTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

/** What the linked machine sees of the caller: the access its link carries. */
const Caller = Schema.Struct({ access: Schema.String });
const CallerToolkit = Toolkit.make(
  Tool.make("caller", {
    description: "Reports the calling link's access.",
    success: Caller,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);
const callerHandlers = McpToolAccess.toLayer(CallerToolkit, {
  caller: McpToolAccess.reads(() =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.map((scope) => ({ access: scope.client?.access ?? "none" })),
    ),
  ),
});

type Identity = ReturnType<typeof syntheticFleetPeer>;

/** One fleet machine: its own database, auth, links, settings and view of the fleet. */
const makeMachine = (input: {
  readonly identity: Identity;
  readonly settings: DeepPartial<ServerSettingsShape>;
  readonly launchEnvironment: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const fleet = yield* Ref.make<FleetContext.FleetLinkContext | undefined>(undefined);
    const levels = yield* Ref.make<Record<string, FleetAccessLevel>>({});
    const transportOrigin = yield* Ref.make<string | undefined>(undefined);
    const backendOrigin = yield* Ref.make<string | undefined>(undefined);
    const descriptor = descriptorOf(input.identity.peer.environmentId, input.identity.peer.label);
    const context = yield* FleetPeerLinks.layerServices.pipe(
      Layer.provideMerge(FleetMcpOrigin.layer),
      Layer.provideMerge(PeerMcpClient.layer),
      Layer.provideMerge(PeerLinks.layer),
      Layer.provide(FleetPeerHttpClient.layer),
      Layer.provideMerge(FleetPeerHttpClient.layerTrust),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(EnvironmentAuth.layer),
      Layer.provideMerge(ServerSettings.layerTest(input.settings)),
      Layer.provide(Layer.succeed(FleetContext.FleetContext, { load: Ref.get(fleet) })),
      Layer.provide(
        Layer.mock(FleetAccessPolicy.FleetAccess)({
          accessFor: (environmentId) =>
            Ref.get(levels).pipe(Effect.map((current) => current[environmentId])),
          // The levels above come from a policy just read from the share.
          current: Effect.succeed({
            revision: 1,
            defaultAccess: "standard",
            machines: [],
            machineId: input.identity.peer.machineId,
            peers: [],
          }),
        }),
      ),
      Layer.provide(
        Layer.mock(FleetTransport.FleetTransport)({
          origin: Ref.get(transportOrigin),
          forwarded: (headers) => headers[FLEET_TLS_FORWARD_HEADER] === FORWARDED_MARK,
        }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-link-" })),
      Layer.provide(Layer.succeed(HostProcess.Environment, input.launchEnvironment)),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
      Layer.build,
    );
    const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
    return {
      identity: input.identity,
      descriptor,
      context,
      fleet,
      levels,
      transportOrigin,
      backendOrigin,
      adapter: Context.get(context, FleetPeerLinks.FleetPeerLinks),
      links: Context.get(context, PeerLinks.PeerLinks),
      mcp: Context.get(context, PeerMcpClient.PeerMcpClient),
      trust: Context.get(context, FleetPeerHttpClient.FleetPeerTrust),
      auth,
      /** Link sessions another machine's adapter holds here. */
      linkSessions: (from: Identity) =>
        auth
          .listSessions()
          .pipe(
            Effect.map((sessions) =>
              sessions.filter((session) => session.client.label === `T3 Code · ${from.peer.label}`),
            ),
          ),
    };
  });
type Machine = Effect.Success<ReturnType<typeof makeMachine>>;

/** What `machine`'s fleet policy lets `peer` do there. */
const grant = (machine: Machine, peer: Identity, access: FleetAccessLevel) =>
  Ref.set(machine.levels, { [peer.peer.environmentId]: access });

/**
 * Serves `machine` on a real socket behind the fleet's TLS endpoint, as a fleet machine runs:
 * the endpoint forwards to plain http and keeps the `Host` header.
 */
const serveBehindFleetEndpoint = (machine: Machine) =>
  Effect.gen(function* () {
    const server = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(FleetPeerTestApi).pipe(
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      McpHttpServer.toolkitRegistration(CallerToolkit, callerHandlers).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
            resolve: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(McpOAuth.McpPeerLinkSessionObserver, {
          sessionIssued: machine.adapter.sessionIssued,
        }),
      ),
      Layer.provide(Layer.succeedContext(machine.context)),
    );
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
      Effect.provideContext(server),
    );
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const certificate = createFleetTlsCertificate({ address: "127.0.0.1", now });
    const endpoint = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startFleetProxy({
          listen: { address: "127.0.0.1", port: 0 },
          target: `http://127.0.0.1:${address.port}/`,
          serverTls: { certificate: certificate.certificate, privateKey: certificate.privateKey },
          forwardedMark: FORWARDED_MARK,
        }),
      ),
      (proxy) => Effect.promise(() => proxy.close()),
    );
    const origin = new URL(endpoint.httpBaseUrl).origin;
    yield* Ref.set(machine.transportOrigin, origin);
    yield* Ref.set(machine.backendOrigin, `http://127.0.0.1:${address.port}`);
    return {
      origin,
      certificate: certificate.certificate,
      publicKeySha256: certificate.publicKeySha256,
    };
  });

const privateConfig = (
  identity: Identity,
  deliveryDirectory: string,
  peers: ReadonlyArray<Delivery.FleetPeer>,
): Delivery.FleetPrivateConfig => ({
  version: 1,
  machineId: identity.peer.machineId,
  deliveryDirectory,
  autoPickup: false,
  encryptionPrivateKey: identity.encryptionPrivateKey,
  signingPrivateKey: identity.signingPrivateKey,
  peers,
  managed: true,
});

/** CryoFrog links to PandaMedic, which serves at its encrypted endpoint. */
const makeFleet = (settings: DeepPartial<ServerSettingsShape>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const share = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-share-" });
    const cryoFrog = syntheticFleetPeer("cryofrog");
    const pandaMedic = syntheticFleetPeer("pandamedic");
    const launchEnvironment: Record<string, string> = {};
    const linking = yield* makeMachine({ identity: cryoFrog, settings, launchEnvironment });
    const linked = yield* makeMachine({ identity: pandaMedic, settings, launchEnvironment: {} });
    const endpoint = yield* serveBehindFleetEndpoint(linked);
    const pandaPeer: Delivery.FleetPeer = { ...pandaMedic.peer, tls: endpoint };
    const peers = [cryoFrog.peer, pandaPeer];
    const contextFor = (
      self: Identity,
      selfPeer: Delivery.FleetPeer,
      peer: Delivery.FleetPeer,
    ) => ({
      config: privateConfig(self, share, peers),
      self: selfPeer,
      deliveryDirectory: share,
      peers: [{ peer, connectHost: undefined }],
    });
    yield* Ref.set(linking.fleet, contextFor(cryoFrog, cryoFrog.peer, pandaPeer));
    yield* Ref.set(linked.fleet, contextFor(pandaMedic, pandaPeer, cryoFrog.peer));
    yield* grant(linking, pandaMedic, "standard");
    yield* grant(linked, cryoFrog, "standard");
    return { share, cryoFrog, pandaMedic, pandaPeer, linking, linked, launchEnvironment, endpoint };
  });

/** Ask, offer, link, settle: what a round of syncs on both machines does. */
const round = (fleet: Effect.Success<ReturnType<typeof makeFleet>>) =>
  Effect.gen(function* () {
    yield* fleet.linking.adapter.pass;
    yield* fleet.linked.adapter.pass;
    yield* fleet.linking.adapter.pass;
    yield* fleet.linked.adapter.pass;
  });

const callerAccess = (fleet: Effect.Success<ReturnType<typeof makeFleet>>) =>
  fleet.linking.mcp
    .call({
      environmentId: fleet.pandaMedic.peer.environmentId,
      tool: "caller",
      arguments: {},
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      success: Caller,
    })
    .pipe(
      Effect.map((caller) => caller.access),
      Effect.catchTags({ OrchestratorMcpFailure: (failure) => Effect.succeed(failure.code) }),
    );

const shareSnapshot = (share: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = (yield* fs.readDirectory(share)).toSorted();
    return yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(share, name)).pipe(Effect.map((contents) => [name, contents])),
    );
  });

it.live(
  "links, renews, narrows, widens and forgets a fleet peer with no prompt, leaving fleet connections alone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
        const path = yield* Path.Path;
        const { cryoFrog, pandaMedic, linking, linked } = fleet;
        const linkedSessions = linked.linkSessions(cryoFrog);
        const linkOf = linking.links
          .get(pandaMedic.peer.environmentId)
          .pipe(Effect.map(Option.getOrUndefined));

        // The fleet's existing desktop connection: its grants, session and share files.
        const fleetSubject = `lan-fleet:${Delivery.deliveryFileName(pandaMedic.peer.machineId, cryoFrog.peer.machineId)}`;
        const fleetCode = yield* linked.auth.createPairingLink({
          subject: fleetSubject,
          ttl: Duration.hours(24),
        });
        const fleetSession = yield* linked.auth.issueSession({ subject: fleetSubject });
        for (const name of [
          `${Delivery.deliveryFileName(pandaMedic.peer.machineId, cryoFrog.peer.machineId)}.json`,
          `${Delivery.deliveryFileName(pandaMedic.peer.machineId, cryoFrog.peer.machineId)}.receipt.json`,
          `${Delivery.deliveryFileName(cryoFrog.peer.machineId, cryoFrog.peer.machineId)}.catalog.json`,
        ])
          yield* writeFleetJson(path.join(fleet.share, name), { synthetic: name });
        const fleetFiles = yield* shareSnapshot(fleet.share);

        // Link: no person approves anything on either machine.
        yield* round(fleet);
        const first = yield* linkOf;
        expect(first?.access).toBe("full-access");
        expect(first?.urls).toEqual([fleet.endpoint.origin]);
        // Through the endpoint, sign-in names its https origin; a plain-http client that only
        // names the endpoint's host is not told it is on https.
        const spoofed = yield* plainGet(
          `${yield* Ref.get(linked.backendOrigin)}/.well-known/oauth-authorization-server`,
          new URL(fleet.endpoint.origin).host,
        );
        expect(spoofed).toContain(`"issuer":"http://${new URL(fleet.endpoint.origin).host}"`);
        expect(yield* callerAccess(fleet)).toBe("full-access");
        const [firstSession] = yield* linkedSessions;
        expect(yield* linkedSessions).toHaveLength(1);

        // Renew: a fresh code replaces the token and the superseded session is revoked.
        fleet.launchEnvironment[FleetPeerLinks.RENEW_WITHIN_ENV] = "31 days";
        yield* linking.adapter.pass;
        yield* linked.adapter.pass;
        delete fleet.launchEnvironment[FleetPeerLinks.RENEW_WITHIN_ENV];
        yield* linking.adapter.pass;
        yield* linked.adapter.pass;
        const renewed = yield* linkOf;
        expect(renewed?.linkedAt).not.toEqual(first?.linkedAt);
        const afterRenewal = yield* linkedSessions;
        expect(afterRenewal).toHaveLength(1);
        expect(afterRenewal[0]?.sessionId).not.toBe(firstSession?.sessionId);
        expect(yield* callerAccess(fleet)).toBe("full-access");

        // Narrow: the linked machine revokes at once, before the linking machine relinks.
        yield* grant(linked, cryoFrog, "read-only");
        yield* linked.adapter.pass;
        expect(yield* linkedSessions).toHaveLength(0);
        expect(yield* callerAccess(fleet)).toBe("capability_denied");
        yield* linking.adapter.pass;
        yield* linked.adapter.pass;
        expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");

        // Widen: the read-only link keeps working until the wider one replaces it.
        yield* grant(linked, cryoFrog, "standard");
        yield* linked.adapter.pass;
        expect(yield* callerAccess(fleet)).toBe("read-only");
        yield* linking.adapter.pass;
        yield* linked.adapter.pass;
        expect(yield* callerAccess(fleet)).toBe("full-access");
        expect(yield* linkedSessions).toHaveLength(1);

        // A fleet machine linked by hand is adopted and relinked at the policy's access. Its
        // hand-made session there was never the fleet's, so the fleet does not revoke it.
        const fleetSessions = new Set((yield* linkedSessions).map((session) => session.sessionId));
        const byHand = yield* linked.auth.issuePairingCredential();
        yield* linking.links.link({
          url: fleet.endpoint.origin,
          pairingCode: byHand.credential,
          access: "auto",
        });
        const handMade = (yield* linkedSessions).filter(
          (session) => !fleetSessions.has(session.sessionId),
        );
        expect(handMade).toHaveLength(1);
        expect(yield* callerAccess(fleet)).toBe("auto");
        yield* round(fleet);
        expect(yield* callerAccess(fleet)).toBe("full-access");

        // Forget: the machine leaves the fleet on both sides.
        yield* Ref.update(linking.fleet, (current) => current && { ...current, peers: [] });
        yield* Ref.update(linked.fleet, (current) => current && { ...current, peers: [] });
        yield* linking.adapter.pass;
        yield* linked.adapter.pass;
        expect(yield* linkOf).toBeUndefined();
        expect((yield* linkedSessions).map((session) => session.sessionId)).toEqual([
          handMade[0]?.sessionId,
        ]);
        const codes = yield* linked.auth.listPairingLinks();
        expect(codes.map((code) => code.id)).toEqual([fleetCode.id]);

        // The fleet's own connection is exactly as it was.
        expect(
          (yield* linked.auth.listSessions()).some(
            (session) => session.sessionId === fleetSession.sessionId,
          ),
        ).toBe(true);
        expect(yield* shareSnapshot(fleet.share)).toEqual(fleetFiles);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "turned off, forgets its links and revokes what it issued, refusing peers that still have it on",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
        const { cryoFrog, pandaMedic, linking, linked } = fleet;
        const linkOf = linking.links
          .get(pandaMedic.peer.environmentId)
          .pipe(Effect.map(Option.getOrUndefined));
        const fleetSubject = `lan-fleet:${Delivery.deliveryFileName(pandaMedic.peer.machineId, cryoFrog.peer.machineId)}`;
        const fleetCode = yield* linked.auth.createPairingLink({
          subject: fleetSubject,
          ttl: Duration.hours(24),
        });
        const fleetSession = yield* linked.auth.issueSession({ subject: fleetSubject });
        yield* round(fleet);
        expect(yield* callerAccess(fleet)).toBe("full-access");
        const switchOff = (machine: Machine) =>
          Context.get(machine.context, ServerSettings.ServerSettingsService).updateSettings({
            fleetLinkedEnvironmentsEnabled: false,
          });

        // PandaMedic turns it off; CryoFrog still has it on and keeps asking.
        yield* switchOff(linked);
        yield* round(fleet);
        expect(yield* linked.linkSessions(cryoFrog)).toEqual([]);
        expect(
          (yield* linked.auth.listPairingLinks()).filter((code) => code.id !== fleetCode.id),
        ).toEqual([]);
        expect(yield* callerAccess(fleet)).not.toBe("full-access");

        // CryoFrog turns it off too: the link its adapter made is forgotten.
        yield* switchOff(linking);
        yield* linking.adapter.pass;
        expect(yield* linkOf).toBeUndefined();

        // The fleet's own connection is exactly as it was.
        expect((yield* linked.auth.listPairingLinks()).map((code) => code.id)).toEqual([
          fleetCode.id,
        ]);
        expect(
          (yield* linked.auth.listSessions()).some(
            (session) => session.sessionId === fleetSession.sessionId,
          ),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does nothing on either machine while the adapter is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleet = yield* makeFleet({});
      const path = yield* Path.Path;
      const { cryoFrog, pandaMedic, linking, linked } = fleet;
      // A peer asks this machine for a code; it does not answer while off.
      const files = Delivery.peerLinkFileNames(pandaMedic.peer.machineId, cryoFrog.peer.machineId);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* writeFleetJson(
        path.join(fleet.share, files.request),
        Delivery.makePeerLinkRequest({
          config: privateConfig(cryoFrog, fleet.share, [cryoFrog.peer, fleet.pandaPeer]),
          recipient: pandaMedic.peer,
          requestId: "00000000-0000-4000-8000-000000000001",
          now,
          expiresAt: now + 60_000,
        }),
      );
      const before = yield* shareSnapshot(fleet.share);
      yield* round(fleet);
      expect(yield* shareSnapshot(fleet.share)).toEqual(before);
      expect(yield* linked.auth.listPairingLinks()).toEqual([]);
      expect(yield* linking.links.list).toEqual([]);
      expect(yield* linking.trust.current).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
