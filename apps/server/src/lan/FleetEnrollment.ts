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
import { fleetCredentialKeyFor, type FleetPrivateConfig } from "./FleetDelivery.ts";
import {
  FLEET_ROSTER_ENV,
  fleetLocalName,
  isFleetSwitchRoster,
  resolveFleetBootstrap,
  trustedFleetShareRoot,
} from "./FleetBootstrap.ts";
import { readFleetJson, validateRoster, writeFleetJson, writeFleetRoster } from "./FleetFiles.ts";
import { secureOrigin } from "./GatewayT3OAuthClient.ts";
import * as FleetTransport from "./FleetTransport.ts";
import * as FleetAccessPolicy from "./FleetAccessPolicy.ts";
import { makeMembership } from "./FleetMembership.ts";
import { reportFleetRecoveryReceiver } from "./fleetCredentialRecoveryEntry.ts";

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
/** A refusal with a reason the person can act on; see LanFleetError's messages. */
const refused = (refusal: string) => new LanFleetError({ reason: "configuration", refusal });
const translate = (error: unknown) =>
  isFleetError(error) ? error : new LanFleetError({ reason: "unavailable" });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const hostname = yield* HostProcess.Hostname;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const endpoints = yield* DirectEndpoints.DirectEndpoints;
  const config = yield* Config.ServerConfig;
  const vault = yield* Vault.FleetVault;
  const transport = yield* Effect.serviceOption(FleetTransport.FleetTransport);
  const fleetAccess = yield* FleetAccessPolicy.FleetAccess;
  const setupLock = path.join(config.stateDir, "lan-fleet-setup.lock");
  const switchedFleet = isFleetSwitchRoster(processEnvironment[FLEET_ROSTER_ENV]);
  const membership = yield* makeMembership(
    path.join(
      config.stateDir,
      fleetLocalName("lan-fleet-members.json", processEnvironment[FLEET_ROSTER_ENV]),
    ),
  );
  let reportedRecoveryAuthority: string | undefined;
  let nextRecoveryReport = 0;
  const bootstrap = () =>
    Effect.try({ try: () => resolveFleetBootstrap(processEnvironment), catch: configurationError });
  // Sync and the fleet context stop before reading enrollment when the fleet is switched off, so a
  // membership cached from an earlier launch is cleared here, at startup.
  if ((yield* bootstrap().pipe(Effect.orElseSucceed(() => null))) === undefined)
    yield* fleetAccess.leave;
  const load = Effect.fn("FleetEnrollment.load")(function* (observeVaultError = false) {
    const paths = yield* bootstrap();
    if (paths === undefined) {
      yield* fleetAccess.leave;
      return undefined;
    }
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
    const credential = yield* vault.read.pipe(
      Effect.map((record) => ({ record, error: undefined })),
      Effect.catchIf(
        () => observeVaultError,
        (error) => Effect.succeed({ record: undefined, error }),
      ),
    );
    const { record } = credential;
    const authority = (yield* fs.exists(authorityFile))
      ? yield* readFleetJson(authorityFile, Authority.FleetAuthority)
      : undefined;
    if (authority !== undefined) {
      yield* Effect.try({
        try: () => Authority.verifyAuthority(authority, record),
        catch: configurationError,
      });
      if (record !== undefined && authority.revision > record.lastRevision)
        yield* vault.advanceRevision(record, authority.revision);
    }
    const rosterAvailable = yield* fs.exists(paths.rosterPath);
    const roster = rosterAvailable
      ? yield* readFleetJson(paths.rosterPath, FleetRoster)
      : { version: 1 as const, machines: [] };
    yield* Effect.try({ try: () => validateRoster(roster), catch: configurationError });
    // Windows share access admits current signed enrollments; explicit revocations still win.
    // Authority signatures and legacy owner approval remain unchanged outside this share.
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
          )
        ) {
          const index = peers.findIndex(
            (existing) =>
              existing.machineId === peer.machineId ||
              existing.environmentId === peer.environmentId,
          );
          const existing = peers[index];
          if (existing === undefined) peers.push(peer);
          else if (
            existing.enabled &&
            existing.machineId === peer.machineId &&
            existing.environmentId === peer.environmentId &&
            existing.origin === peer.origin &&
            // A member explicitly signed by the fleet owner may refresh its TLS metadata,
            // but an enrollment file cannot restore the superseded signing or encryption keys.
            (((!switchedFleet || existing.environmentId !== authority.ownerEnvironmentId) &&
              fleetCredentialKeyFor(authority.credentialKeyDigests, existing.machineId) ===
                undefined) ||
              (existing.signingPublicKey === peer.signingPublicKey &&
                existing.encryptionPublicKey === peer.encryptionPublicKey))
          )
            peers[index] = peer;
        }
      }
    }
    if (peers.length > 100) return yield* configurationError();
    // A machine this successful read misses, such as when the enrollment folder briefly reads as
    // absent, stays until it is shown disabled or stays missing: leaving revokes everything.
    const removed = new Set([
      ...peers.filter((peer) => !peer.enabled).map((peer) => peer.machineId),
      ...roster.machines.filter((machine) => !machine.enabled).map((machine) => machine.machineId),
    ]);
    for (const peer of yield* membership.check(
      peers.filter((peer) => peer.enabled),
      removed,
    ))
      if (
        !peers.some(
          (existing) =>
            existing.machineId === peer.machineId || existing.environmentId === peer.environmentId,
        )
      )
        peers.push(peer);
    // The machines LAN 1.0.26 admits, whose keys verify access-list revisions on both versions.
    // This version trusts none whose ID could read as an access-list exception: only forged share
    // files could bring one in, and nothing here gives it access.
    const fleetPeers = peers;
    const trustedPeers = fleetPeers.filter(
      (peer) => !FleetAccessPolicy.reservedMachineId(peer.machineId),
    );
    // Whether the fleet links this machine: its own enrollment checks out and its roster row is
    // enabled. The policy's peers keep a machine whose row was just disabled, so they can't say.
    const ownPeer =
      record === undefined
        ? undefined
        : trustedPeers.find(
            (peer) =>
              peer.enabled &&
              peer.machineId === record.machineId &&
              peer.environmentId === record.environmentId,
          );
    const member =
      record !== undefined &&
      record.enabled &&
      ownPeer !== undefined &&
      record.environmentId === (yield* environment.getEnvironmentId) &&
      Authority.peerVerificationCode(ownPeer) ===
        Authority.peerVerificationCode(
          Authority.identityPeer(record, ownPeer.label, ownPeer.origin),
        ) &&
      roster.machines.some(
        (machine) =>
          machine.enabled &&
          machine.machineId === ownPeer.machineId &&
          machine.environmentId === ownPeer.environmentId &&
          machine.origin === ownPeer.origin,
      );
    // With no enrollment here the fleet no longer links this machine. A missing authority file may
    // only be a share blip, so it changes nothing.
    if (record === undefined && credential.error === undefined) yield* fleetAccess.leave;
    const accessPolicy =
      record === undefined || authority === undefined || record.fleetId !== authority.fleetId
        ? undefined
        : yield* fleetAccess.refresh({
            root,
            fleetId: record.fleetId,
            machineId: record.machineId,
            peers: fleetPeers,
            legacyAccess: record.access,
            member,
            signingPrivateKey: record.signingPrivateKey,
            credentialAuthorityRevision: authority.revision,
            ...(authority.credentialKeyDigests === undefined
              ? {}
              : { credentialKeyDigests: authority.credentialKeyDigests }),
            rosterDisabled: roster.machines
              .filter((machine) => !machine.enabled)
              .map((machine) => machine.machineId),
          });
    if (
      accessPolicy !== undefined &&
      (accessPolicy.credentialAuthorityReady === false ||
        (accessPolicy.credentialAuthorityRevision !== undefined &&
          accessPolicy.credentialAuthorityRevision !== authority?.revision) ||
        Object.entries(accessPolicy.credentialKeyDigests ?? {}).some(
          ([machineId, digest]) =>
            fleetCredentialKeyFor(authority?.credentialKeyDigests, machineId) !== digest,
        ))
    )
      return yield* new LanFleetError({ reason: "unavailable" });
    if (
      sharedFolderTrust &&
      member &&
      record !== undefined &&
      ownPeer !== undefined &&
      authority !== undefined &&
      accessPolicy?.credentialAuthorityReady === true
    ) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (reportedRecoveryAuthority !== authority.signature || now >= nextRecoveryReport) {
        // A signed observation supports an owner-approved recovery. It never grants fleet access.
        reportedRecoveryAuthority = authority.signature;
        nextRecoveryReport = now + 60_000;
        yield* reportFleetRecoveryReceiver(root, authority, record, ownPeer, now).pipe(
          Effect.ignore,
        );
      }
    }
    return {
      accessPolicy,
      member,
      ...paths,
      root,
      authorityFile,
      requestsDirectory,
      record,
      credentialError: credential.error,
      authority,
      roster,
      rosterAvailable,
      sharedFolderTrust,
      peers: trustedPeers,
      fleetPeers,
    };
  });

  const status = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const current = yield* load(true);
    const local = current?.roster.machines.find(
      (machine) => machine.environmentId === descriptor.environmentId,
    );
    const credentialUnavailable =
      current?.sharedFolderTrust === true &&
      current.record === undefined &&
      current.authority !== undefined &&
      local?.enabled === true &&
      current.peers.some(
        (peer) =>
          peer.enabled &&
          peer.machineId === local.machineId &&
          peer.environmentId === local.environmentId &&
          peer.origin === local.origin,
      );
    if (current?.credentialError !== undefined && !credentialUnavailable)
      return yield* current.credentialError;
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
      ...(credentialUnavailable ? { credentialUnavailable } : {}),
      stage: "unconfigured",
      owner: false,
      ownerCode: null,
      deviceCode: null,
      environmentId: descriptor.environmentId,
      label: local?.label ?? descriptor.label,
      origin,
      managedTls:
        current?.record?.tls !== undefined ||
        (!advertised.some((endpoint) => endpoint.httpBaseUrl.startsWith("https://")) &&
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
    const policy = current.accessPolicy;
    const exceptions =
      policy === undefined
        ? []
        : FleetAccessPolicy.exceptionsOf(policy, [
            ...current.peers.map((peer) => peer.machineId),
            ...policy.machines.map((machine) => machine.machineId),
          ]);
    return {
      ...base,
      ...(policy === undefined
        ? {}
        : {
            accessPolicy: {
              revision: policy.revision,
              defaultAccess: policy.defaultAccess,
              machines: policy.machines,
              ...(exceptions.length === 0 ? {} : { exceptions }),
              selfAccess: FleetAccessPolicy.selfAccess(policy),
              canChange:
                FleetAccessPolicy.selfAccess(policy) === "standard" && policy.unavailable !== true,
              ...(policy.seed === undefined ? {} : { seed: policy.seed }),
              ...(policy.seedPending === undefined ? {} : { seedPending: policy.seedPending }),
            },
          }),
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
            if (input.operation === "access") {
              const { record, authority } = current;
              const self = current.peers.find(
                (peer) => peer.machineId === record?.machineId && peer.enabled,
              );
              if (
                record === undefined ||
                authority === undefined ||
                !record.enabled ||
                record.environmentId !== descriptor.environmentId ||
                self === undefined ||
                Authority.peerVerificationCode(self) !==
                  Authority.peerVerificationCode(
                    Authority.identityPeer(record, self.label, self.origin),
                  )
              )
                return yield* configurationError();
              yield* fleetAccess.change({
                root: current.root,
                fleetId: record.fleetId,
                machineId: record.machineId,
                peers: current.fleetPeers,
                legacyAccess: record.access,
                credentialAuthorityRevision: authority.revision,
                ...(authority.credentialKeyDigests === undefined
                  ? {}
                  : { credentialKeyDigests: authority.credentialKeyDigests }),
                member: current.member,
                signingPrivateKey: record.signingPrivateKey,
                expectedRevision: input.revision,
                ...(input.requireNoStartingList === true ? { requireNoStartingList: true } : {}),
                next: {
                  defaultAccess: input.defaultAccess,
                  machines: input.machines,
                  ...(input.exceptions === undefined
                    ? {}
                    : {
                        pairs: FleetAccessPolicy.replaceExceptions(
                          current.accessPolicy?.pairs,
                          input.exceptions,
                        ),
                      }),
                },
              });
              return;
            }
            if (
              switchedFleet &&
              input.operation === "start" &&
              hostname.toLowerCase() !== "buildmachine"
            )
              return yield* refused("switched-fleet-start");
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
                    if (existing !== undefined && !existing.enabled)
                      return yield* refused("roster-row-disabled");
                    if (existing !== undefined && existing.origin !== origin)
                      return yield* refused("roster-origin-mismatch");
                    if (
                      input.operation === "start" &&
                      fresh.record === undefined &&
                      fresh.authority !== undefined
                    )
                      return yield* refused("fleet-exists");
                    if (input.operation === "start" && fresh.record !== undefined) {
                      if (fresh.record.rootPrivateKey === undefined)
                        return yield* refused("already-member");
                      if (fresh.authority === undefined && fresh.record.lastRevision > 1)
                        return yield* refused("owner-authority-missing");
                    }
                    if (input.operation === "join" && fresh.authority === undefined)
                      return yield* refused("fleet-missing");
                    if (
                      input.operation === "join" &&
                      fresh.authority !== undefined &&
                      !fresh.sharedFolderTrust &&
                      Authority.ownerVerificationCode(fresh.authority) !== input.ownerCode
                    )
                      return yield* refused("owner-code-mismatch");
                    if (
                      fresh.record === undefined &&
                      (existing !== undefined ||
                        fresh.authority?.peers.some(
                          (peer) => peer.environmentId === descriptor.environmentId,
                        ))
                    )
                      return yield* refused("roster-row-without-keys");
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
                      return yield* refused("machine-not-enabled");
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
                    return yield* refused("not-owner");
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
                    const approvedKey = fleetCredentialKeyFor(
                      authority.credentialKeyDigests,
                      input.machineId,
                    );
                    if (
                      Authority.peerVerificationCode(request.peer) !== input.verificationCode ||
                      request.peer.machineId !== input.machineId ||
                      (approvedKey !== undefined &&
                        approvedKey !==
                          Authority.fleetSigningKeyDigest(request.peer.signingPublicKey)) ||
                      // No machine takes an ID that could read as an access-list exception.
                      FleetAccessPolicy.reservedMachineId(input.machineId)
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
                  yield* Effect.try({
                    try: () => Authority.verifyAuthority(signed, record),
                    catch: configurationError,
                  });
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
    (effect) => (Option.isSome(transport) ? transport.value.serializeSetup(effect) : effect),
    Effect.mapError(translate),
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  const repairTarget = (current: NonNullable<Effect.Success<ReturnType<typeof load>>>) => {
    const record = current.record;
    if (!current.sharedFolderTrust || record?.enabled !== true || record.tlsEnabled === false)
      return undefined;
    const local = current.roster.machines.find(
      (machine) =>
        machine.enabled &&
        machine.machineId === record.machineId &&
        machine.environmentId === record.environmentId,
    );
    if (local === undefined) return undefined;
    const own = current.peers.find(
      (peer) =>
        peer.enabled &&
        peer.environmentId === record.environmentId &&
        peer.machineId === record.machineId &&
        peer.origin === local.origin,
    );
    const identity = Authority.identityPeer(record, local.label, local.origin);
    if (
      own?.signingPublicKey !== identity.signingPublicKey ||
      own.encryptionPublicKey !== identity.encryptionPublicKey ||
      (record.tls !== undefined &&
        Authority.peerVerificationCode(own) === Authority.peerVerificationCode(identity))
    )
      return undefined;
    return { record, local, own, requestsDirectory: current.requestsDirectory };
  };

  const resolve = Effect.gen(function* () {
    let current = yield* load();
    if (current?.record === undefined) return undefined;
    if (!current.record.enabled) return null;
    // A transient share failure must leave the last verified outbound pins in place.
    if (current.authority === undefined || !current.rosterAvailable)
      return yield* new LanFleetError({ reason: "unavailable" });
    if (Option.isSome(transport) && repairTarget(current) !== undefined) {
      const service = transport.value;
      yield* service.serializeSetup(
        Effect.gen(function* () {
          // Serialize with local setup without leaving a lock behind if the server exits.
          const latest = yield* load();
          const target = latest === undefined ? undefined : repairTarget(latest);
          if (target === undefined) return;
          const { record, local, own, requestsDirectory } = target;
          let repaired = record;
          if (record.tls !== undefined) {
            const approved = Effect.gen(function* () {
              const observed = yield* load();
              if (!observed?.rosterAvailable || observed.authority === undefined)
                return yield* new LanFleetError({ reason: "unavailable" });
              const fresh = repairTarget(observed);
              return (
                fresh !== undefined &&
                Authority.peerVerificationCode(fresh.own) === Authority.peerVerificationCode(own)
              );
            }).pipe(Effect.mapError(translate), Effect.provideService(FileSystem.FileSystem, fs));
            if (!(yield* service.restore(record, approved))) return;
          } else {
            if (
              (yield* endpoints.resolve()).some((endpoint) =>
                endpoint.httpBaseUrl.startsWith("https://"),
              )
            )
              return;
            repaired = { ...record, tls: yield* service.prepare(local.origin), tlsEnabled: true };
            yield* service.persist(repaired);
          }
          const peer = Authority.identityPeer(repaired, local.label, local.origin);
          yield* fs.makeDirectory(requestsDirectory, { recursive: true });
          yield* writeFleetJson(
            path.join(requestsDirectory, peer.machineId + ".json"),
            Authority.enrollmentRequest(repaired, peer),
          );
        }),
      );
      current = yield* load();
      if (current?.record === undefined || !current.record.enabled) return null;
      if (current.authority === undefined || !current.rosterAvailable)
        return yield* new LanFleetError({ reason: "unavailable" });
    }
    if (current.record.tls !== undefined && current.record.tlsEnabled === false) return null;
    if (!current.member) return null;
    const record = current.record;
    if (record.tls !== undefined) {
      if (Option.isNone(transport)) return yield* new LanFleetError({ reason: "transport" });
      const service = transport.value;
      if (!(yield* service.ready(record))) {
        const approved = Effect.gen(function* () {
          const latest = yield* load();
          if (!latest?.rosterAvailable || latest.authority === undefined)
            return yield* new LanFleetError({ reason: "unavailable" });
          return (
            latest.member &&
            latest.record?.tlsEnabled !== false &&
            latest.record?.tls?.publicKeySha256 === record.tls?.publicKeySha256
          );
        }).pipe(Effect.mapError(translate), Effect.provideService(FileSystem.FileSystem, fs));
        if (!(yield* service.restore(record, approved))) return null;
        current = yield* load();
        if (current?.authority === undefined || !current.rosterAvailable)
          return yield* new LanFleetError({ reason: "unavailable" });
        if (!current.member || current.record?.tlsEnabled === false) return null;
      }
      if (!(yield* service.ready(record))) return yield* new LanFleetError({ reason: "transport" });
    }
    const authority = current.authority;
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
      ...(switchedFleet ? { credentialScope: authority.fleetId } : {}),
      ...(authority.credentialKeyDigests === undefined
        ? {}
        : { credentialKeyDigests: authority.credentialKeyDigests }),
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
export const layer = layerServices.pipe(
  Layer.provide(FleetTransport.layer),
  Layer.provide(Vault.layer),
);
