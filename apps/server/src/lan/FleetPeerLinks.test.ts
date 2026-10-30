// @effect-diagnostics nodeBuiltinImport:off -- Fixture share files are compared byte for byte, and one plain-http request sets its own Host.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import {
  type AuthMcpClientAccess,
  EnvironmentHttpApi,
  type FleetAccess as FleetAccessLevel,
  LanFleetError,
  mcpClientScopes,
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

import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
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
import * as FleetCredentialAccess from "./FleetCredentialAccess.ts";
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
    // The levels above come from this policy, just read from the share.
    const policy = yield* Ref.make<FleetAccessPolicy.FleetAccessState>({
      revision: 1,
      defaultAccess: "standard",
      machines: [],
      machineId: input.identity.peer.machineId,
      // An active member: linked environments count as on here while the adapter is.
      peers: [
        {
          machineId: input.identity.peer.machineId,
          environmentId: input.identity.peer.environmentId,
        },
      ],
      member: true,
    });
    // The cap the server puts on every credential it verifies, link sessions included: the real
    // FleetCredentialAccess over the same list, each fleet peer at the level `levels` gives it.
    const capView = Effect.gen(function* () {
      const current = yield* Ref.get(policy);
      const known = yield* Ref.get(levels);
      const peers = ((yield* Ref.get(fleet))?.peers ?? [])
        .map(({ peer }) => peer)
        .filter((peer) => known[peer.environmentId] !== undefined);
      return {
        ...current,
        machines: peers.map((peer) => ({
          machineId: peer.machineId,
          access: known[peer.environmentId]!,
        })),
        pairs: [],
        peers: [
          ...current.peers.filter(
            (item) => !peers.some((peer) => peer.machineId === item.machineId),
          ),
          ...peers.map((peer) => ({
            machineId: peer.machineId,
            environmentId: peer.environmentId,
          })),
        ],
      } satisfies FleetAccessPolicy.FleetAccessState;
    });
    const receiverCap = Layer.effect(
      CredentialAttribution.CredentialAccessCap,
      FleetCredentialAccess.FleetCredentialAccess.pipe(
        Effect.map((access) =>
          CredentialAttribution.CredentialAccessCap.of({
            scopes: access.scopes,
            administersFleet: access.administersFleet,
          }),
        ),
      ),
    ).pipe(
      Layer.provide(FleetCredentialAccess.layerServices),
      Layer.provide(Layer.mock(FleetAccessPolicy.FleetAccess)({ current: capView })),
    );
    // Runs once, right after the next access read, as a list change landing mid-pass.
    const afterAccessRead = yield* Ref.make<Effect.Effect<void> | undefined>(undefined);
    // The share stops answering: loading the fleet fails.
    const shareDown = yield* Ref.make(false);
    const transportOrigin = yield* Ref.make<string | undefined>(undefined);
    const backendOrigin = yield* Ref.make<string | undefined>(undefined);
    const descriptor = descriptorOf(input.identity.peer.environmentId, input.identity.peer.label);
    const context = yield* FleetPeerLinks.layerServices.pipe(
      Layer.provideMerge(FleetMcpOrigin.layer),
      // This machine's own list caps every write it sends over a link.
      Layer.provideMerge(PeerMcpClient.layer.pipe(Layer.provide(FleetPeerLinks.layerWriteCeiling))),
      Layer.provideMerge(PeerLinks.layer),
      Layer.provide(FleetPeerHttpClient.layer),
      Layer.provideMerge(FleetPeerHttpClient.layerTrust),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(EnvironmentAuth.layer.pipe(Layer.provide(receiverCap))),
      Layer.provideMerge(ServerSettings.layerTest(input.settings)),
      Layer.provide(
        Layer.succeed(FleetContext.FleetContext, {
          load: Ref.get(shareDown).pipe(
            Effect.flatMap((down) =>
              down ? Effect.fail(new LanFleetError({ reason: "unavailable" })) : Ref.get(fleet),
            ),
          ),
        }),
      ),
      Layer.provide(
        Layer.mock(FleetAccessPolicy.FleetAccess)({
          accessFor: (environmentId) =>
            Ref.get(levels).pipe(
              Effect.tap(() =>
                Ref.getAndSet(afterAccessRead, undefined).pipe(
                  Effect.flatMap((change) => change ?? Effect.void),
                ),
              ),
              Effect.map((current) => current[environmentId]),
            ),
          current: Ref.get(policy),
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
      policy,
      afterAccessRead,
      shareDown,
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
    // Each machine's list governs both, as every enabled fleet machine's does.
    for (const machine of [linking, linked])
      yield* Ref.update(machine.policy, (current) => ({
        ...current,
        peers: [cryoFrog.peer, pandaMedic.peer].map((peer) => ({
          machineId: peer.machineId,
          environmentId: peer.environmentId,
        })),
      }));
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
      writes: false,
      success: Caller,
    })
    .pipe(
      Effect.map((caller) => caller.access),
      Effect.catchTags({ OrchestratorMcpFailure: (failure) => Effect.succeed(failure.code) }),
    );

/**
 * The same call as one that writes: refused on the linking machine once its own list makes it
 * read-only there, whatever the linked machine still allows. The linked machine answers it as a
 * read, so any refusal is the linking machine's.
 */
const writeAccess = (fleet: Effect.Success<ReturnType<typeof makeFleet>>) =>
  fleet.linking.mcp
    .call({
      environmentId: fleet.pandaMedic.peer.environmentId,
      tool: "caller",
      arguments: {},
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      writes: true,
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

        // Narrow: writes stop at once on the linked machine, which caps every call, but the
        // session stays, so the link keeps reading. The linking machine takes the narrower code
        // offered unasked, and only then is the wider session retired.
        const [standardSession] = yield* linkedSessions;
        yield* grant(linked, cryoFrog, "read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");
        yield* linked.adapter.pass;
        expect((yield* linkedSessions).map((session) => session.sessionId)).toEqual([
          standardSession?.sessionId,
        ]);
        expect(yield* callerAccess(fleet)).toBe("read-only");
        yield* linking.adapter.pass;
        expect(yield* callerAccess(fleet)).toBe("read-only");
        yield* linked.adapter.pass;
        expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");
        const narrowed = yield* linkedSessions;
        expect(narrowed).toHaveLength(1);
        expect(narrowed[0]?.sessionId).not.toBe(standardSession?.sessionId);

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

it.live(
  "links nothing while the fleet's starting access list waits, then links at the list's access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
        const { cryoFrog, pandaMedic, linking, linked } = fleet;
        const waiting = (machine: Machine) =>
          Ref.update(machine.policy, (current) => ({
            ...current,
            revision: 0,
            seed: "waiting" as const,
          }));
        yield* waiting(linking);
        yield* waiting(linked);
        // Before the list, PandaMedic would give CryoFrog the default, standard.
        yield* round(fleet);
        expect(yield* shareSnapshot(fleet.share)).toEqual([]);
        expect(yield* linked.auth.listPairingLinks()).toEqual([]);
        expect(yield* linking.links.list).toEqual([]);

        // The list makes CryoFrog read-only; links form at that access.
        for (const machine of [linking, linked])
          yield* Ref.update(machine.policy, ({ seed: _, ...current }) => ({
            ...current,
            revision: 1,
          }));
        yield* grant(linked, cryoFrog, "read-only");
        yield* round(fleet);
        const link = yield* linking.links.get(pandaMedic.peer.environmentId);
        expect(Option.getOrUndefined(link)?.access).toBe<AuthMcpClientAccess>("read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "neither offers nor links before the fleet has a Machine access list, starting list or not",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
        const { cryoFrog, pandaMedic, linking, linked } = fleet;
        // No list and no starting list, as a machine with no saved history reads a share whose
        // fleet-access folder is not found. Each peer then has its setup access, here standard.
        const noList = (machine: Machine) =>
          Ref.update(machine.policy, (current) => ({ ...current, revision: 0 }));
        const listed = (machine: Machine) =>
          Ref.update(machine.policy, (current) => ({ ...current, revision: 1 }));
        yield* grant(linked, cryoFrog, "standard");
        yield* noList(linking);
        yield* noList(linked);
        yield* round(fleet);
        expect(yield* shareSnapshot(fleet.share)).toEqual([]);
        expect(yield* linked.auth.listPairingLinks()).toEqual([]);
        expect(yield* linking.links.list).toEqual([]);
        const settings = Context.get(linking.context, ServerSettings.ServerSettingsService);
        expect((yield* settings.getSettings).linkedEnvironmentsEnabled).toBe(false);

        // PandaMedic reads the list but CryoFrog does not yet: CryoFrog asks for and takes nothing.
        yield* grant(linked, cryoFrog, "read-only");
        yield* listed(linked);
        yield* round(fleet);
        expect(yield* linking.links.list).toEqual([]);

        // CryoFrog reads it too: the link forms at the list's access.
        yield* listed(linking);
        yield* round(fleet);
        const link = yield* linking.links.get(pandaMedic.peer.environmentId);
        expect(Option.getOrUndefined(link)?.access).toBe<AuthMcpClientAccess>("read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "never links above its own access, ignoring 1.0.25 offers and narrowing an out-of-date issuer's",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
        const path = yield* Path.Path;
        const { cryoFrog, pandaMedic, pandaPeer, linking, linked } = fleet;
        const linkOf = linking.links
          .get(pandaMedic.peer.environmentId)
          .pipe(Effect.map(Option.getOrUndefined));
        const ownAccess = (access: FleetAccessLevel) =>
          Ref.update(linking.policy, (current) => ({
            ...current,
            machines: [{ machineId: cryoFrog.peer.machineId, access }],
          }));
        // CryoFrog's accepted list makes it read-only.
        yield* ownAccess("read-only");

        // PandaMedic on 1.0.25, its adapter turned on by hand and no list read, offers its setup
        // access: full access, with no list revision.
        const files = Delivery.peerLinkFileNames(
          pandaMedic.peer.machineId,
          cryoFrog.peer.machineId,
        );
        const deliveryId = "00000000-0000-4000-8000-000000000002";
        const code = yield* linked.auth.createPairingLink({
          ttl: Duration.hours(1),
          subject: `lan-fleet-peer-link:${cryoFrog.peer.machineId}:${deliveryId}`,
          scopes: mcpClientScopes("full-access"),
        });
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        yield* writeFleetJson(
          path.join(fleet.share, files.offer),
          Delivery.sealDelivery({
            config: privateConfig(pandaMedic, fleet.share, [cryoFrog.peer, pandaPeer]),
            sender: pandaPeer,
            recipient: cryoFrog.peer,
            deliveryId,
            expiresAt: now + 60 * 60 * 1000,
            credential: code.credential,
            peerLink: { access: "full-access" },
          }),
        );
        yield* linking.adapter.pass;
        expect(yield* linking.links.list).toEqual([]);
        expect(yield* linked.linkSessions(cryoFrog)).toEqual([]);

        // PandaMedic updates but its copy of the list misses the revision that restricted
        // CryoFrog, so it still grants standard. CryoFrog links only at its own access.
        yield* grant(linked, cryoFrog, "standard");
        yield* round(fleet);
        expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");

        // Lifted, CryoFrog asks again and takes the access PandaMedic offers.
        yield* ownAccess("standard");
        yield* round(fleet);
        expect(yield* callerAccess(fleet)).toBe("full-access");

        expect(yield* writeAccess(fleet)).toBe("full-access");
        // Restricted again, it keeps the full-access link, so it never stops reading, even while
        // the share does not answer. PandaMedic's list still allows writes, but CryoFrog's own
        // refuses every one at once.
        yield* ownAccess("read-only");
        yield* Ref.set(linking.shareDown, true);
        yield* linking.adapter.pass;
        expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("full-access");
        expect(yield* callerAccess(fleet)).toBe("full-access");
        expect(yield* writeAccess(fleet)).toBe("capability_denied");
        // Once the share answers it asks again, and links only at its own access.
        yield* Ref.set(linking.shareDown, false);
        yield* round(fleet);
        expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("read-only");
        expect(yield* callerAccess(fleet)).toBe("read-only");
        expect(yield* linked.linkSessions(cryoFrog)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("never keeps a link above an access list that narrows during a pass", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
      const { cryoFrog, pandaMedic, linking, linked } = fleet;
      const linkOf = linking.links
        .get(pandaMedic.peer.environmentId)
        .pipe(Effect.map(Option.getOrUndefined));
      // CryoFrog asks; PandaMedic offers full access.
      yield* linking.adapter.pass;
      yield* linked.adapter.pass;
      // CryoFrog's own list makes it read-only while its pass is under way, before it redeems.
      yield* Ref.set(
        linking.afterAccessRead,
        Ref.update(linking.policy, (current) => ({
          ...current,
          revision: 2,
          machines: [{ machineId: cryoFrog.peer.machineId, access: "read-only" as const }],
        })),
      );
      yield* linking.adapter.pass;
      expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("read-only");
      expect(yield* callerAccess(fleet)).toBe("read-only");

      // PandaMedic's list narrows CryoFrog after it read CryoFrog's access but before it mints:
      // the code carries only what the list says now.
      const fresh = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
      yield* fresh.linking.adapter.pass;
      yield* Ref.set(
        fresh.linked.afterAccessRead,
        grant(fresh.linked, fresh.cryoFrog, "read-only"),
      );
      yield* fresh.linked.adapter.pass;
      yield* fresh.linking.adapter.pass;
      const freshLink = yield* fresh.linking.links.get(fresh.pandaMedic.peer.environmentId);
      expect(Option.getOrUndefined(freshLink)?.access).toBe<AuthMcpClientAccess>("read-only");
      expect(yield* callerAccess(fresh)).toBe("read-only");

      // PandaMedic's list narrows CryoFrog while it revokes the codes it offered before: the code
      // it then mints carries only what the list says now.
      const revoking = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
      yield* revoking.linking.adapter.pass;
      const listPairingLinks = revoking.linked.auth.listPairingLinks;
      let narrowOnce = true;
      Object.assign(revoking.linked.auth, {
        listPairingLinks: (...args: Parameters<typeof listPairingLinks>) =>
          listPairingLinks(...args).pipe(
            Effect.tap(() => {
              if (!narrowOnce) return Effect.void;
              narrowOnce = false;
              return grant(revoking.linked, revoking.cryoFrog, "read-only");
            }),
          ),
      });
      yield* revoking.linked.adapter.pass;
      yield* revoking.linking.adapter.pass;
      const revokingLink = yield* revoking.linking.links.get(
        revoking.pandaMedic.peer.environmentId,
      );
      expect(Option.getOrUndefined(revokingLink)?.access).toBe<AuthMcpClientAccess>("read-only");
      expect(yield* callerAccess(revoking)).toBe("read-only");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does nothing on either machine while the adapter is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: false });
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

it.live("widens and narrows one pair's link through an exception, with no prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
      const { cryoFrog, pandaMedic, linking, linked } = fleet;
      const cryo = cryoFrog.peer.machineId;
      const panda = pandaMedic.peer.machineId;
      const linkedSessions = linked.linkSessions(cryoFrog);
      // Both machines read one list: CryoFrog read-only, with or without standard on PandaMedic.
      const read = (revision: number, standardOn: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const list = {
            revision,
            defaultAccess: "standard" as const,
            machines: [{ machineId: cryo, access: "read-only" as const }],
            pairs: FleetAccessPolicy.replaceExceptions([], [{ machineId: cryo, standardOn }]),
            peers: [cryoFrog.peer, pandaMedic.peer].map((peer) => ({
              machineId: peer.machineId,
              environmentId: peer.environmentId,
            })),
            member: true,
          };
          yield* Ref.set(linking.policy, { ...list, machineId: cryo });
          const issuer = { ...list, machineId: panda };
          yield* Ref.set(linked.policy, issuer);
          yield* grant(linked, cryoFrog, FleetAccessPolicy.callerAccess(issuer, cryo));
        });

      yield* read(1, []);
      yield* round(fleet);
      expect(yield* callerAccess(fleet)).toBe("read-only");

      // An exception for another machine changes nothing between these two.
      yield* read(2, ["anviltoad"]);
      yield* round(fleet);
      expect(yield* callerAccess(fleet)).toBe("read-only");

      // The exception for PandaMedic replaces the read-only link with a standard one, and the
      // read-only session is retired, with nothing approved or picked up by hand.
      yield* read(3, [panda]);
      yield* round(fleet);
      expect(yield* callerAccess(fleet)).toBe("full-access");
      expect(yield* linkedSessions).toHaveLength(1);

      expect(yield* writeAccess(fleet)).toBe("full-access");
      // The requester reads the removal first: it keeps the standard link, so it never stops
      // reading, and asks for a narrower one. PandaMedic's list still grants the exception, but
      // the requester refuses every write at once, before any pass.
      const [standardSession] = yield* linkedSessions;
      yield* Ref.update(linking.policy, (current) => ({ ...current, revision: 4, pairs: [] }));
      expect(yield* writeAccess(fleet)).toBe("capability_denied");
      yield* linking.adapter.pass;
      expect(yield* callerAccess(fleet)).toBe("full-access");
      expect(yield* writeAccess(fleet)).toBe("capability_denied");
      // PandaMedic reads it too: writes stop at once, reads go on, and nothing is revoked yet.
      yield* read(4, []);
      expect(yield* callerAccess(fleet)).toBe("read-only");
      yield* linked.adapter.pass;
      expect(yield* callerAccess(fleet)).toBe("read-only");
      expect((yield* linkedSessions).map((session) => session.sessionId)).toEqual([
        standardSession?.sessionId,
      ]);
      // The pair relinks read-only, and only then is the standard session retired.
      yield* round(fleet);
      expect(yield* callerAccess(fleet)).toBe("read-only");
      const relinked = yield* linkedSessions;
      expect(relinked).toHaveLength(1);
      expect(relinked[0]?.sessionId).not.toBe(standardSession?.sessionId);
      const link = yield* linking.links.get(pandaMedic.peer.environmentId);
      expect(Option.getOrUndefined(link)?.access).toBe<AuthMcpClientAccess>("read-only");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps reading through an exception's removal that the receiver reads first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
      const { cryoFrog, pandaMedic, linking, linked } = fleet;
      const cryo = cryoFrog.peer.machineId;
      const panda = pandaMedic.peer.machineId;
      const linkedSessions = linked.linkSessions(cryoFrog);
      const listOf = (revision: number, standardOn: ReadonlyArray<string>, self: string) => ({
        revision,
        defaultAccess: "standard" as const,
        machines: [{ machineId: cryo, access: "read-only" as const }],
        pairs: FleetAccessPolicy.replaceExceptions([], [{ machineId: cryo, standardOn }]),
        peers: [cryoFrog.peer, pandaMedic.peer].map((peer) => ({
          machineId: peer.machineId,
          environmentId: peer.environmentId,
        })),
        member: true,
        machineId: self,
      });
      yield* Ref.set(linking.policy, listOf(1, [panda], cryo));
      yield* Ref.set(linked.policy, listOf(1, [panda], panda));
      yield* round(fleet);
      expect(yield* callerAccess(fleet)).toBe("full-access");
      const [standardSession] = yield* linkedSessions;

      // PandaMedic reads the removal; CryoFrog has not yet. Writes stop at once, and the link
      // keeps reading, never failing for a link PandaMedic forgot.
      const removed = listOf(2, [], panda);
      yield* Ref.set(linked.policy, removed);
      yield* grant(linked, cryoFrog, FleetAccessPolicy.callerAccess(removed, cryo));
      yield* linked.adapter.pass;
      expect(yield* callerAccess(fleet)).toBe("read-only");
      expect((yield* linkedSessions).map((session) => session.sessionId)).toEqual([
        standardSession?.sessionId,
      ]);
      // CryoFrog, whose own list still grants standard, takes the read-only code PandaMedic
      // offered unasked; the standard session is retired only after that.
      yield* linking.adapter.pass;
      expect(yield* callerAccess(fleet)).toBe("read-only");
      yield* linked.adapter.pass;
      const replaced = yield* linkedSessions;
      expect(replaced).toHaveLength(1);
      expect(replaced[0]?.sessionId).not.toBe(standardSession?.sessionId);
      expect(yield* callerAccess(fleet)).toBe("read-only");
      // Nothing was approved or relinked by hand, and no code above read-only is left there.
      const codes = yield* linked.auth.listPairingLinks();
      expect(
        codes.filter((code) => FleetAccessPolicy.credentialAccess(code) === "standard"),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("drops a first link that signed in above a list that narrowed meanwhile, and relinks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleet = yield* makeFleet({ fleetLinkedEnvironmentsEnabled: true });
      const { cryoFrog, pandaMedic, linking, linked } = fleet;
      const linkOf = linking.links
        .get(pandaMedic.peer.environmentId)
        .pipe(Effect.map(Option.getOrUndefined));
      // CryoFrog asks; PandaMedic offers full access.
      yield* linking.adapter.pass;
      yield* linked.adapter.pass;
      // CryoFrog's own list makes it read-only while it signs in with that code: after its check
      // before signing in, before the link is in use.
      const link = linking.links.link;
      let narrowOnce = true;
      Object.assign(linking.links, {
        link: (...args: Parameters<typeof link>) =>
          link(...args).pipe(
            Effect.tap(() => {
              if (!narrowOnce) return Effect.void;
              narrowOnce = false;
              return Ref.update(linking.policy, (current) => ({
                ...current,
                revision: 2,
                machines: [{ machineId: cryoFrog.peer.machineId, access: "read-only" as const }],
              }));
            }),
          ),
      });
      yield* linking.adapter.pass;
      // With no link before it, none is kept above the list; a narrower one is asked for.
      expect(yield* linkOf).toBeUndefined();
      expect(yield* callerAccess(fleet)).toBe("invalid_request");
      // PandaMedic's list still gives standard, so it offers that; CryoFrog takes it read-only.
      yield* round(fleet);
      expect((yield* linkOf)?.access).toBe<AuthMcpClientAccess>("read-only");
      expect(yield* callerAccess(fleet)).toBe("read-only");
      expect(yield* writeAccess(fleet)).toBe("capability_denied");
      expect(yield* linked.linkSessions(cryoFrog)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
