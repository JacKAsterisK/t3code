// @effect-diagnostics nodeBuiltinImport:off -- Fresh fleet IDs are random; key generation occurs only after a confirmed setup operation.
import * as NodeCrypto from "node:crypto";
import {
  FleetRoster,
  LanFleetError,
  type LanFleetSetupInput,
  type LanFleetSetupState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as Config from "../config.ts";
import * as Vault from "./FleetVault.ts";
import * as Authority from "./FleetAuthority.ts";
import type { FleetPrivateConfig } from "./FleetDelivery.ts";
import { resolveFleetBootstrap, trustedFleetShareRoot } from "./FleetBootstrap.ts";
import { readFleetJson, validateRoster, writeFleetJson, writeFleetRoster } from "./FleetFiles.ts";
import { secureOrigin } from "./GatewayT3OAuthClient.ts";
import * as FleetTransport from "./FleetTransport.ts";

export class FleetEnrollment extends Context.Service<
  FleetEnrollment,
  {
    readonly status: Effect.Effect<LanFleetSetupState, LanFleetError>;
    readonly configure: (
      input: LanFleetSetupInput,
    ) => Effect.Effect<LanFleetSetupState, LanFleetError>;
    readonly resolve: Effect.Effect<FleetPrivateConfig | null | undefined, LanFleetError>;
  }
>()("t3/lan/FleetEnrollment") {}

const isFleetError = Schema.is(LanFleetError);
const configurationError = () => new LanFleetError({ reason: "configuration" });
const translate = (error: unknown) =>
  isFleetError(error) ? error : new LanFleetError({ reason: "unavailable" });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const endpoints = yield* DirectEndpoints.DirectEndpoints;
  const config = yield* Config.ServerConfig;
  const vault = yield* Vault.FleetVault;
  const transport = yield* Effect.serviceOption(FleetTransport.FleetTransport);
  const setupLock = path.join(config.stateDir, "lan-fleet-setup.lock");
  const bootstrap = () =>
    Effect.try({ try: () => resolveFleetBootstrap(processEnvironment), catch: configurationError });
  const load = Effect.fn("FleetEnrollment.load")(function* () {
    const paths = yield* bootstrap();
    if (paths === undefined) return undefined;
    const shareRoot = platform === "win32" ? trustedFleetShareRoot(paths.rosterPath) : undefined;
    const sharedFolderTrust =
      shareRoot === undefined
        ? false
        : yield* fs.readDirectory(shareRoot).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
    const root = path.dirname(paths.rosterPath);
    const authorityFile = path.join(root, "fleet-authority.json");
    const requestsDirectory = path.join(root, "fleet-enrollment");
    const record = yield* vault.read;
    const authority = (yield* fs.exists(authorityFile))
      ? yield* readFleetJson(authorityFile, Authority.FleetAuthority)
      : undefined;
    if (authority !== undefined) {
      yield* Effect.try({
        try: () => Authority.verifyAuthority(authority, record),
        catch: configurationError,
      });
      if (record !== undefined && authority.revision > record.lastRevision)
        yield* vault.save({ ...record, lastRevision: authority.revision });
    }
    const roster = (yield* fs.exists(paths.rosterPath))
      ? yield* readFleetJson(paths.rosterPath, FleetRoster)
      : { version: 1 as const, machines: [] };
    yield* Effect.try({ try: () => validateRoster(roster), catch: configurationError });
    // A request proves possession of the joining keys; Windows SMB access is the admission boundary.
    // The signed authority remains untouched, and any explicit authority identity wins, including revocation.
    const peers = [...(authority?.peers ?? [])];
    if (sharedFolderTrust && authority !== undefined && (yield* fs.exists(requestsDirectory))) {
      const names = yield* fs.readDirectory(requestsDirectory);
      if (names.length > 100) return yield* configurationError();
      for (const name of names.filter((file) => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/u.test(file))) {
        const request = yield* readFleetJson(
          path.join(requestsDirectory, name),
          Authority.FleetEnrollmentRequest,
        );
        yield* Effect.try({
          try: () => Authority.verifyEnrollment(request, authority),
          catch: configurationError,
        });
        const peer = request.peer;
        if (
          name === `${peer.machineId}.json` &&
          peer.enabled &&
          roster.machines.some(
            (machine) =>
              machine.machineId === peer.machineId &&
              machine.environmentId === peer.environmentId &&
              machine.origin === peer.origin &&
              machine.enabled,
          ) &&
          !peers.some(
            (existing) =>
              existing.machineId === peer.machineId ||
              existing.environmentId === peer.environmentId,
          )
        )
          peers.push(peer);
      }
    }
    if (peers.length > 100) return yield* configurationError();
    return {
      ...paths,
      root,
      authorityFile,
      requestsDirectory,
      record,
      authority,
      roster,
      sharedFolderTrust,
      peers,
    };
  });

  const status = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const current = yield* load();
    const local = current?.roster.machines.find(
      (machine) => machine.environmentId === descriptor.environmentId,
    );
    const advertised = yield* endpoints.resolve();
    const suggestedTlsOrigins = Option.isSome(transport) ? yield* transport.value.suggestions : [];
    const tlsReady =
      current?.record?.tls !== undefined &&
      current.record.tlsEnabled !== false &&
      Option.isSome(transport)
        ? yield* transport.value.ready(current.record)
        : false;
    const origin =
      local?.origin ??
      advertised
        .find((endpoint) => endpoint.httpBaseUrl.startsWith("https://"))
        ?.httpBaseUrl.replace(/\/$/u, "") ??
      (suggestedTlsOrigins.length === 1 ? suggestedTlsOrigins[0] : "") ??
      "";
    const base: LanFleetSetupState = {
      available: current !== undefined,
      sharedFolderTrust: current?.sharedFolderTrust ?? false,
      stage: "unconfigured",
      owner: false,
      ownerCode: null,
      deviceCode: null,
      environmentId: descriptor.environmentId,
      label: local?.label ?? descriptor.label,
      origin,
      managedTls:
        current?.record?.tls !== undefined ||
        (local === undefined &&
          !advertised.some((endpoint) => endpoint.httpBaseUrl.startsWith("https://")) &&
          suggestedTlsOrigins.length > 0),
      suggestedTlsOrigins,
      tlsEnabled: current?.record?.tls !== undefined && current.record.tlsEnabled !== false,
      tlsReady,
      autoPickup: current?.record?.autoPickup ?? false,
      access: current?.record?.access ?? "standard",
      peers: [],
    };
    if (current === undefined) return base;
    const { record, authority } = current;
    if (authority === undefined)
      return {
        ...base,
        ...(record === undefined
          ? {}
          : {
              deviceCode: Authority.peerVerificationCode(
                Authority.identityPeer(record, base.label, origin),
              ),
              owner: record.rootPrivateKey !== undefined,
            }),
      };
    const owner =
      record?.rootPrivateKey !== undefined &&
      authority.ownerEnvironmentId === descriptor.environmentId;
    const ownPeer = current.peers.find((peer) => peer.environmentId === descriptor.environmentId);
    const ownCode =
      record === undefined || origin === ""
        ? null
        : Authority.peerVerificationCode(Authority.identityPeer(record, base.label, origin));
    const active =
      record !== undefined &&
      ownPeer?.enabled === true &&
      ownCode === Authority.peerVerificationCode(ownPeer);
    const peers: Array<LanFleetSetupState["peers"][number]> = current.peers.map((peer) => ({
      machineId: peer.machineId,
      environmentId: peer.environmentId,
      label: peer.label,
      origin: peer.origin,
      verificationCode: Authority.peerVerificationCode(peer),
      status: peer.enabled ? "approved" : "revoked",
    }));
    if (owner && !current.sharedFolderTrust && (yield* fs.exists(current.requestsDirectory))) {
      const names = yield* fs.readDirectory(current.requestsDirectory);
      if (names.length > 100) return yield* configurationError();
      for (const name of names.filter((file) => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/u.test(file))) {
        const request = yield* readFleetJson(
          path.join(current.requestsDirectory, name),
          Authority.FleetEnrollmentRequest,
        );
        yield* Effect.try({
          try: () => Authority.verifyEnrollment(request, authority),
          catch: configurationError,
        });
        if (
          !peers.some(
            (peer) => peer.verificationCode === Authority.peerVerificationCode(request.peer),
          )
        )
          peers.push({
            machineId: request.peer.machineId,
            environmentId: request.peer.environmentId,
            label: request.peer.label,
            origin: request.peer.origin,
            verificationCode: Authority.peerVerificationCode(request.peer),
            status: "pending",
          });
      }
    }
    return {
      ...base,
      stage:
        record === undefined ? "join" : !record.enabled ? "paused" : active ? "active" : "pending",
      owner,
      ownerCode: Authority.ownerVerificationCode(authority),
      deviceCode: ownCode,
      autoPickup: record?.autoPickup ?? false,
      access: record?.access ?? "standard",
      peers,
    } satisfies LanFleetSetupState;
  }).pipe(Effect.mapError(translate), Effect.provideService(FileSystem.FileSystem, fs));

  const configure = Effect.fn("FleetEnrollment.configure")(
    function* (input: LanFleetSetupInput) {
      if (!input.confirmed) return yield* configurationError();
      yield* Effect.acquireUseRelease(
        fs
          .makeDirectory(setupLock)
          .pipe(Effect.mapError(() => new LanFleetError({ reason: "busy" }))),
        () =>
          Effect.gen(function* () {
            const current = yield* load();
            if (current === undefined) return yield* configurationError();
            const descriptor = yield* environment.getDescriptor;
            if (input.operation === "transport") {
              if (current.record?.tls === undefined || Option.isNone(transport))
                return yield* configurationError();
              const updated = { ...current.record, tlsEnabled: input.enabled };
              yield* transport.value.persist(updated);
              return;
            }
            if (input.operation === "settings") {
              if (current.record === undefined) return yield* configurationError();
              const updated = {
                ...current.record,
                enabled: input.enabled,
                autoPickup: input.autoPickup,
                access: input.access,
              };
              yield* vault.save(updated);
              return;
            }
            yield* fs.makeDirectory(current.root, { recursive: true });
            const ownerLock = path.join(current.root, "fleet-authority.lock");
            yield* Effect.acquireUseRelease(
              fs
                .makeDirectory(ownerLock)
                .pipe(Effect.mapError(() => new LanFleetError({ reason: "busy" }))),
              () =>
                Effect.gen(function* () {
                  const fresh = yield* load();
                  if (fresh === undefined) return yield* configurationError();
                  if (input.operation === "start" || input.operation === "join") {
                    const origin = yield* Effect.try({
                      try: () => secureOrigin(input.origin),
                      catch: configurationError,
                    });
                    const existing = fresh.roster.machines.find(
                      (machine) => machine.environmentId === descriptor.environmentId,
                    );
                    if (existing !== undefined && (!existing.enabled || existing.origin !== origin))
                      return yield* configurationError();
                    if (
                      input.operation === "start" &&
                      fresh.authority !== undefined &&
                      fresh.record?.rootPrivateKey === undefined
                    )
                      return yield* configurationError();
                    if (
                      input.operation === "join" &&
                      (fresh.authority === undefined ||
                        (!fresh.sharedFolderTrust &&
                          Authority.ownerVerificationCode(fresh.authority) !== input.ownerCode))
                    )
                      return yield* configurationError();
                    const original =
                      fresh.record ??
                      Authority.generateFleetIdentity(
                        descriptor.environmentId,
                        fresh.authority?.fleetId ?? NodeCrypto.randomUUID(),
                        fresh.authority?.rootPublicKey ?? "",
                        input.operation === "start",
                        input,
                        existing?.machineId,
                      );
                    if (input.managedTls === true && Option.isNone(transport))
                      return yield* configurationError();
                    const tls =
                      input.managedTls === true && Option.isSome(transport)
                        ? yield* transport.value.prepare(origin, original.tls)
                        : original.tls;
                    if (tls !== undefined && tls.origin !== origin)
                      return yield* configurationError();
                    const record = {
                      ...original,
                      ...(tls === undefined
                        ? {}
                        : { tls, tlsEnabled: original.tlsEnabled ?? true }),
                    };
                    if (record.environmentId !== descriptor.environmentId)
                      return yield* configurationError();
                    // Save once before publishing. A retry reuses these exact keys, including after a share outage.
                    if (record.tls !== undefined && Option.isSome(transport))
                      yield* transport.value.persist(record);
                    else yield* vault.save(record);
                    const peer = Authority.identityPeer(
                      record,
                      existing?.label ?? descriptor.label,
                      origin,
                    );
                    const {
                      encryptionPublicKey: _e,
                      signingPublicKey: _s,
                      tls: _tls,
                      ...metadata
                    } = peer;
                    if (existing === undefined)
                      yield* writeFleetRoster(fresh.rosterPath, {
                        ...fresh.roster,
                        machines: [...fresh.roster.machines, metadata],
                      });
                    if (input.operation === "start") {
                      if (record.rootPrivateKey === undefined) return yield* configurationError();
                      if (fresh.authority === undefined)
                        yield* writeFleetJson(
                          fresh.authorityFile,
                          Authority.signAuthority(
                            {
                              version: 1,
                              fleetId: record.fleetId,
                              rootPublicKey: record.rootPublicKey,
                              ownerEnvironmentId: record.environmentId,
                              revision: 1,
                              peers: [peer],
                              campaign: null,
                              signature: "",
                            },
                            record.rootPrivateKey,
                          ),
                        );
                    } else {
                      yield* fs.makeDirectory(fresh.requestsDirectory, { recursive: true });
                      yield* writeFleetJson(
                        path.join(fresh.requestsDirectory, `${peer.machineId}.json`),
                        Authority.enrollmentRequest(record, peer),
                      );
                    }
                    return;
                  }
                  const { record, authority } = fresh;
                  if (input.operation === "link" && fresh.sharedFolderTrust) {
                    if (
                      record === undefined ||
                      authority === undefined ||
                      !record.enabled ||
                      record.environmentId !== descriptor.environmentId
                    )
                      return yield* configurationError();
                    const enabledPeer = (machineId: string) =>
                      fresh.peers.find(
                        (peer) =>
                          peer.machineId === machineId &&
                          peer.enabled &&
                          fresh.roster.machines.some(
                            (machine) =>
                              machine.machineId === peer.machineId &&
                              machine.environmentId === peer.environmentId &&
                              machine.origin === peer.origin &&
                              machine.enabled,
                          ),
                      );
                    const self = enabledPeer(record.machineId);
                    const selected = [...new Set([record.machineId, ...input.machineIds])];
                    if (
                      self === undefined ||
                      selected.length < 2 ||
                      selected.some((id) => enabledPeer(id) === undefined) ||
                      Authority.peerVerificationCode(self) !==
                        Authority.peerVerificationCode(
                          Authority.identityPeer(record, self.label, self.origin),
                        )
                    )
                      return yield* configurationError();
                    // Shared-folder admission already supplies the effective automatic campaign.
                    // Linking validates those peers without requiring the owner or rewriting authority.
                    return;
                  }
                  if (
                    record?.rootPrivateKey === undefined ||
                    authority === undefined ||
                    authority.ownerEnvironmentId !== descriptor.environmentId ||
                    !record.enabled
                  )
                    return yield* configurationError();
                  let updated = authority;
                  if (input.operation === "approve") {
                    const request = yield* readFleetJson(
                      path.join(fresh.requestsDirectory, `${input.machineId}.json`),
                      Authority.FleetEnrollmentRequest,
                    );
                    yield* Effect.try({
                      try: () => Authority.verifyEnrollment(request, authority),
                      catch: configurationError,
                    });
                    if (
                      Authority.peerVerificationCode(request.peer) !== input.verificationCode ||
                      request.peer.machineId !== input.machineId
                    )
                      return yield* configurationError();
                    const metadata = fresh.roster.machines.find(
                      (machine) =>
                        machine.machineId === request.peer.machineId &&
                        machine.environmentId === request.peer.environmentId &&
                        machine.origin === request.peer.origin &&
                        machine.enabled,
                    );
                    if (metadata === undefined) return yield* configurationError();
                    const previous = authority.peers.find(
                      (peer) =>
                        peer.machineId === input.machineId ||
                        peer.environmentId === request.peer.environmentId,
                    );
                    if (
                      previous?.enabled &&
                      Authority.peerVerificationCode(previous) !== input.verificationCode
                    )
                      return yield* configurationError();
                    if (
                      previous?.enabled &&
                      Authority.peerVerificationCode(previous) === input.verificationCode
                    )
                      return;
                    updated = {
                      ...authority,
                      peers: [
                        ...authority.peers.filter(
                          (peer) =>
                            peer.machineId !== input.machineId &&
                            peer.environmentId !== request.peer.environmentId,
                        ),
                        request.peer,
                      ],
                    };
                  } else if (input.operation === "revoke") {
                    const revokedPeer = fresh.peers.find(
                      (peer) => peer.machineId === input.machineId,
                    );
                    if (input.machineId === record.machineId || revokedPeer === undefined)
                      return yield* configurationError();
                    updated = {
                      ...authority,
                      peers: authority.peers.some((peer) => peer.machineId === input.machineId)
                        ? authority.peers.map((peer) =>
                            peer.machineId === input.machineId ? { ...peer, enabled: false } : peer,
                          )
                        : [...authority.peers, { ...revokedPeer, enabled: false }],
                      campaign: null,
                    };
                  } else {
                    const selected = [...new Set([record.machineId, ...input.machineIds])];
                    if (
                      selected.length < 2 ||
                      selected.some(
                        (id) =>
                          !authority.peers.some((peer) => peer.machineId === id && peer.enabled),
                      )
                    )
                      return yield* configurationError();
                    const now = DateTime.toEpochMillis(yield* DateTime.now);
                    updated = {
                      ...authority,
                      campaign: {
                        id: NodeCrypto.randomUUID(),
                        expiresAt: now + 24 * 60 * 60 * 1000,
                        machineIds: selected,
                      },
                    };
                  }
                  const signed = Authority.signAuthority(
                    { ...updated, revision: authority.revision + 1 },
                    record.rootPrivateKey,
                  );
                  yield* writeFleetJson(fresh.authorityFile, signed);
                  yield* vault.save({ ...record, lastRevision: signed.revision });
                }),
              () => fs.remove(ownerLock, { recursive: true }).pipe(Effect.ignore),
            );
          }),
        () => fs.remove(setupLock, { recursive: true }).pipe(Effect.ignore),
      );
      return yield* status;
    },
    Effect.mapError(translate),
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  const resolve = Effect.gen(function* () {
    const current = yield* load();
    if (current?.record === undefined) return undefined;
    if (!current.record.enabled || current.authority === undefined) return null;
    if (current.record.tls !== undefined && current.record.tlsEnabled === false) return null;
    if (
      current.record.tls !== undefined &&
      (Option.isNone(transport) || !(yield* transport.value.ready(current.record)))
    )
      return yield* new LanFleetError({ reason: "transport" });
    const { record, authority } = current;
    const self = current.peers.find(
      (peer) =>
        peer.environmentId === record.environmentId &&
        peer.machineId === record.machineId &&
        peer.enabled,
    );
    if (
      self === undefined ||
      Authority.peerVerificationCode(self) !==
        Authority.peerVerificationCode(Authority.identityPeer(record, self.label, self.origin))
    )
      return null;
    yield* vault.save({ ...record, lastRevision: authority.revision });
    return {
      version: 1 as const,
      machineId: record.machineId,
      rosterPath: current.rosterPath,
      deliveryDirectory: current.deliveryDirectory,
      autoPickup: record.autoPickup,
      encryptionPrivateKey: record.encryptionPrivateKey,
      signingPrivateKey: record.signingPrivateKey,
      peers: current.peers,
      managed: true,
      access: record.access,
      campaign: current.sharedFolderTrust
        ? {
            id: `shared-folder:${authority.fleetId}`,
            expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 24 * 60 * 60 * 1000,
            machineIds: current.peers.filter((peer) => peer.enabled).map((peer) => peer.machineId),
          }
        : authority.campaign,
    } satisfies FleetPrivateConfig;
  }).pipe(Effect.mapError(translate), Effect.provideService(FileSystem.FileSystem, fs));
  return FleetEnrollment.of({ status, configure, resolve });
});

export const layerServices = Layer.effect(FleetEnrollment, make);
export const layer = layerServices.pipe(Layer.provide(Vault.layer));
