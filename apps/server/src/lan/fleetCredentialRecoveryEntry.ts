// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off -- Exact Windows helper uses held package files and signs public recovery evidence.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { EnvironmentId, FleetRoster } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Authority from "./FleetAuthority.ts";
import { trustedFleetShareRoot } from "./FleetBootstrap.ts";
import { FleetPeer } from "./FleetDelivery.ts";
import { readFleetJson, validateRoster, writeFleetJson } from "./FleetFiles.ts";
import {
  approveFleetCredentialRecovery,
  fleetCredentialRecoveryCode,
  FleetCredentialRecoveryRequest,
  prepareFleetCredentialRecovery,
} from "./FleetCredentialRecovery.ts";

const Nonce = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Code = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u));

export const FleetCredentialRecoveryCommand = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literal("fleet-credential-recovery"),
  nonce: Nonce,
  homeDirectory: Schema.NonEmptyString,
  environmentId: EnvironmentId,
  journalPath: Schema.NonEmptyString,
  rosterPath: Schema.NonEmptyString,
  credentialState: Schema.Literals(["missing", "present"]),
  comparisonCode: Schema.optionalKey(Code),
});
type Command = typeof FleetCredentialRecoveryCommand.Type;

const LocalRequest = Schema.Struct({
  request: FleetCredentialRecoveryRequest,
  owner: FleetPeer,
});
const Approval = Schema.Struct({
  requestId: Schema.String,
  code: Code,
  next: Authority.FleetAuthority,
  signature: Schema.String,
});
type Approval = typeof Approval.Type;

const Membership = Schema.Struct({
  version: Schema.Literal(1),
  machines: Schema.Array(
    Schema.Struct({
      peer: FleetPeer,
      missedSince: Schema.optionalKey(Schema.Number),
      misses: Schema.Number,
    }),
  ).check(Schema.isMaxLength(200)),
});
const CredentialPrefix = "T3F1:";
const nextId = () => NodeCrypto.randomUUID();
const sha256 = (data: string) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const safeAccess = {
  accessCeiling: "read-only",
  accessPolicyDigest: sha256("no-vault-ceiling:read-only"),
} as const;
const decodeRecord = Schema.decodeSync(Schema.fromJsonString(Authority.FleetVaultRecord));

class RecoveryRefused extends Schema.TaggedError<RecoveryRefused>()("FleetRecoveryRefused", {
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const isRefusal = Schema.is(RecoveryRefused);
const refuse = (reason: string): never => {
  throw new RecoveryRefused({ reason });
};

const attempt = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      isRefusal(error) ? error : new RecoveryRefused({ reason: "io", cause: error }),
  });

export function fleetRecoveryRefusal(error: unknown): string {
  if (isRefusal(error)) return error.reason;
  if (typeof error === "object" && error !== null && "cause" in error && isRefusal(error.cause))
    return error.cause.reason;
  return "io";
}

interface KeyringEntry {
  getSecret(): Uint8Array | null;
  getPassword(): string | null;
  setSecret(bytes: Uint8Array): void;
  deleteCredential(): void;
}

const encodeCredential = (record: Authority.FleetVaultRecord) => {
  const bytes = new TextEncoder().encode(CredentialPrefix + JSON.stringify(record));
  if (bytes.byteLength > 2560) refuse("credential-too-large");
  return bytes;
};

function readEntry(entry: KeyringEntry) {
  const bytes = entry.getSecret();
  if (bytes == null) return undefined;
  const raw = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  const json = raw.startsWith(CredentialPrefix)
    ? raw.slice(CredentialPrefix.length)
    : entry.getPassword();
  if (json == null) return refuse("credential-unreadable");
  return decodeRecord(json);
}

function keyring(platform: NodeJS.Platform, architecture: string) {
  if (platform !== "win32" || architecture !== "x64") return refuse("platform");
  const require = NodeModule.createRequire(import.meta.url);
  // This native module is already part of the signed-inventory server payload held by Hub.
  const { Entry } =
    require("./server.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node") as {
      readonly Entry: new (service: string, account: string) => KeyringEntry;
    };
  return Entry;
}

const approvalData = (approval: Omit<Approval, "signature">) =>
  JSON.stringify([
    "t3/lan/fleet-recovery-approval",
    approval.requestId,
    approval.code,
    approval.next.signature,
  ]);

const samePeer = (a: FleetPeer, b: FleetPeer) =>
  a.machineId === b.machineId &&
  a.environmentId === b.environmentId &&
  a.label === b.label &&
  a.origin === b.origin &&
  a.signingPublicKey === b.signingPublicKey &&
  a.encryptionPublicKey === b.encryptionPublicKey;

const receiverData = (fleet: Authority.FleetAuthority, peer: FleetPeer, expires: number) =>
  JSON.stringify([
    "t3/lan/fleet-recovery-receiver-v1",
    fleet.fleetId,
    fleet.signature,
    peer.machineId,
    peer.environmentId,
    expires,
  ]);

const Receiver = Schema.Struct({
  expires: Schema.Number.check(Schema.isInt()),
  signature: Schema.String,
});
const readinessDirectory = (root: string) => NodePath.join(root, "fleet-recovery-receivers");

export const reportFleetRecoveryReceiver = Effect.fn("FleetRecovery.reportReceiver")(function* (
  root: string,
  authority: Authority.FleetAuthority,
  record: Authority.FleetVaultRecord,
  peer: FleetPeer,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = readinessDirectory(root);
  yield* fs.makeDirectory(directory, { recursive: true });
  const file = NodePath.join(directory, peer.machineId + ".json");
  const expires = now + 20 * 60 * 1000;
  const data = receiverData(authority, peer, expires);
  yield* writeFleetJson(file, {
    expires,
    signature: NodeCrypto.sign(null, Buffer.from(data), record.signingPrivateKey).toString(
      "base64",
    ),
  });
});

export const recoverFleetCredential = Effect.fn("FleetRecovery.run")(function* (
  command: Command,
  openKeyring: typeof keyring = keyring,
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const Entry = yield* attempt(() => openKeyring(platform, architecture));
  const root =
    trustedFleetShareRoot(command.rosterPath) === undefined
      ? refuse("roster-path")
      : NodePath.dirname(command.rosterPath);
  const authorityFile = NodePath.join(root, "fleet-authority.json");
  const roster = yield* readFleetJson(command.rosterPath, FleetRoster);
  yield* attempt(() => validateRoster(roster));
  const state = NodePath.join(command.homeDirectory, "userdata");
  const membership = yield* readFleetJson(
    NodePath.join(state, "lan-fleet-members.json"),
    Membership,
  );
  const key = new Entry("T3 Code LAN fleet", command.environmentId);
  const observed = yield* attempt(() => readEntry(key));
  if ((observed === undefined) !== (command.credentialState === "missing"))
    return yield* new RecoveryRefused({ reason: "credential-changed" });

  const directory = NodePath.join(root, "fleet-credential-recovery");
  const now = yield* Clock.currentTimeMillis;
  const readAuthority = readFleetJson(authorityFile, Authority.FleetAuthority).pipe(
    Effect.tap((authority) => attempt(() => Authority.verifyAuthority(authority))),
  );
  const enrolledOnRoster = (peer: FleetPeer) =>
    peer.enabled &&
    roster.machines.some(
      (row) =>
        row.enabled &&
        row.machineId === peer.machineId &&
        row.environmentId === peer.environmentId &&
        row.label === peer.label &&
        row.origin === peer.origin,
    );
  const trusted = (environmentId: EnvironmentId) =>
    membership.machines
      .map(({ peer }) => peer)
      .find((peer) => peer.environmentId === environmentId && enrolledOnRoster(peer)) ??
    refuse("trusted-membership-missing");
  const local = NodePath.join(state, "fleet-credential-recovery.json");
  const pendingSlot = (requestId: string) =>
    new Entry("T3 Code LAN fleet recovery", command.environmentId + "." + requestId);
  const requestFile = (id: string) => NodePath.join(directory, id + ".request.json");
  const approvalFile = (id: string) => NodePath.join(directory, id + ".approval.json");

  if (command.comparisonCode !== undefined) {
    const owner = observed;
    if (
      owner?.rootPrivateKey === undefined ||
      owner.environmentId !== command.environmentId ||
      !owner.enabled
    )
      return yield* new RecoveryRefused({ reason: "owner-required" });
    const initial = yield* readAuthority;
    const ownerPeer = initial.peers.find((item) => item.environmentId === owner.environmentId);
    if (
      ownerPeer === undefined ||
      !enrolledOnRoster(ownerPeer) ||
      !samePeer(ownerPeer, Authority.identityPeer(owner, ownerPeer.label, ownerPeer.origin))
    )
      return yield* new RecoveryRefused({ reason: "owner-identity-changed" });
    const code = command.comparisonCode;
    const names = yield* fs.readDirectory(directory);
    if (names.length > 300) return yield* new RecoveryRefused({ reason: "too-many-requests" });
    const matching: FleetCredentialRecoveryRequest[] = [];
    for (const name of names.filter((value) => /^[0-9a-f-]{36}\.request\.json$/u.test(value))) {
      const request = yield* readFleetJson(
        NodePath.join(directory, name),
        FleetCredentialRecoveryRequest,
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (
        request !== undefined &&
        name === request.id + ".request.json" &&
        fleetCredentialRecoveryCode(request) === code
      )
        matching.push(request);
    }
    if (matching.length !== 1) return yield* new RecoveryRefused({ reason: "request-not-found" });
    const request = matching[0]!;
    const candidate = request.enrollment.peer;
    if (!enrolledOnRoster(candidate))
      return yield* new RecoveryRefused({ reason: "roster-changed" });
    const authorityLock = NodePath.join(root, "fleet-authority.lock");
    yield* Effect.acquireUseRelease(
      fs
        .makeDirectory(authorityLock)
        .pipe(Effect.mapError(() => new RecoveryRefused({ reason: "authority-busy" }))),
      () =>
        Effect.gen(function* () {
          const authority = yield* readAuthority;
          const currentRoster = yield* readFleetJson(command.rosterPath, FleetRoster);
          if (JSON.stringify(currentRoster) !== JSON.stringify(roster))
            return yield* new RecoveryRefused({ reason: "roster-changed" });
          yield* attempt(() => Authority.verifyAuthority(authority, owner));
          const receiptPath = approvalFile(request.id);
          if (
            (yield* fs.exists(receiptPath)) &&
            authority.credentialKeyDigests?.[candidate.machineId] ===
              Authority.fleetSigningKeyDigest(candidate.signingPublicKey)
          ) {
            const receipt = yield* readFleetJson(receiptPath, Approval);
            if (
              receipt.requestId === request.id &&
              receipt.code === code &&
              NodeCrypto.verify(
                null,
                Buffer.from(approvalData(receipt)),
                ownerPeer.signingPublicKey,
                Buffer.from(receipt.signature, "base64"),
              )
            )
              return;
            return yield* new RecoveryRefused({ reason: "approval-invalid" });
          }

          const predecessor = trusted(candidate.environmentId);
          const priorRequest = yield* readFleetJson(
            NodePath.join(root, "fleet-enrollment", candidate.machineId + ".json"),
            Authority.FleetEnrollmentRequest,
          );
          yield* attempt(() => Authority.verifyEnrollment(priorRequest, authority));
          if (!samePeer(priorRequest.peer, predecessor))
            return yield* new RecoveryRefused({ reason: "predecessor-changed" });

          // Older receivers cannot enforce the new authority. Require current signed evidence from
          // every enabled receiver before changing the shared generation.
          for (const row of roster.machines) {
            if (
              !row.enabled ||
              row.environmentId === candidate.environmentId ||
              row.environmentId === owner.environmentId
            )
              continue;
            const peer = trusted(row.environmentId);
            const observation = yield* readFleetJson(
              NodePath.join(readinessDirectory(root), peer.machineId + ".json"),
              Receiver,
            ).pipe(Effect.orElseSucceed(() => undefined));
            if (
              observation === undefined ||
              observation.expires <= now ||
              observation.expires > now + 20 * 60 * 1000 ||
              !NodeCrypto.verify(
                null,
                Buffer.from(receiverData(authority, peer, observation.expires)),
                peer.signingPublicKey,
                Buffer.from(observation.signature, "base64"),
              )
            )
              return yield* new RecoveryRefused({ reason: "receiver-not-ready" });
          }
          const approvedAt = yield* Clock.currentTimeMillis;
          const approval = yield* Effect.try({
            try: () =>
              approveFleetCredentialRecovery(request, code, owner, {
                authority,
                predecessor,
                now: approvedAt,
                ...safeAccess,
              }),
            catch: () => new RecoveryRefused({ reason: "request-changed-or-expired" }),
          });
          yield* attempt(() => Authority.verifyAuthority(approval, owner));
          const receipt = { requestId: request.id, code, next: approval };
          yield* writeFleetJson(receiptPath, {
            ...receipt,
            signature: NodeCrypto.sign(
              null,
              Buffer.from(approvalData(receipt)),
              owner.signingPrivateKey,
            ).toString("base64"),
          });
          yield* writeFleetJson(authorityFile, approval);
        }),
      () => fs.remove(authorityLock, { recursive: true }).pipe(Effect.ignore),
    );
    return { status: "approved" };
  }

  if (yield* fs.exists(local)) {
    const saved = yield* readFleetJson(local, LocalRequest);
    const request = saved.request;
    const candidate = request.enrollment.peer;
    const code = fleetCredentialRecoveryCode(request);
    if (
      candidate.environmentId !== command.environmentId ||
      !enrolledOnRoster(candidate) ||
      !samePeer(saved.owner, trusted(saved.owner.environmentId))
    )
      return yield* new RecoveryRefused({ reason: "request-changed" });
    const slot = pendingSlot(request.id);
    const staged = (yield* attempt(() => readEntry(slot))) ?? observed;
    if (
      staged === undefined ||
      !samePeer(candidate, Authority.identityPeer(staged, candidate.label, candidate.origin))
    )
      return yield* new RecoveryRefused({ reason: "pending-credential-missing" });
    const file = approvalFile(request.id);
    const authority = yield* readAuthority;
    if (!(yield* fs.exists(file))) {
      if (observed !== undefined)
        return yield* new RecoveryRefused({ reason: "credential-present" });
      if (request.expiresAt <= now)
        return yield* new RecoveryRefused({ reason: "request-expired" });
      // Re-publish after interruption before the owner can see the request.
      if (!(yield* fs.exists(requestFile(request.id))))
        yield* writeFleetJson(requestFile(request.id), request);
      return { status: "awaiting-approval", comparisonCode: code };
    }
    const receipt = yield* readFleetJson(file, Approval);
    yield* attempt(() => Authority.verifyAuthority(receipt.next, staged));
    yield* attempt(() => Authority.verifyAuthority(authority, staged));
    if (
      receipt.requestId !== request.id ||
      receipt.code !== code ||
      receipt.next.ownerEnvironmentId !== saved.owner.environmentId ||
      !NodeCrypto.verify(
        null,
        Buffer.from(approvalData(receipt)),
        saved.owner.signingPublicKey,
        Buffer.from(receipt.signature, "base64"),
      )
    )
      return yield* new RecoveryRefused({ reason: "approval-invalid" });
    const digest = Authority.fleetSigningKeyDigest(candidate.signingPublicKey);
    if (
      authority.credentialKeyDigests?.[candidate.machineId] !== digest ||
      receipt.next.credentialKeyDigests?.[candidate.machineId] !== digest ||
      authority.revision < receipt.next.revision
    )
      return yield* new RecoveryRefused({ reason: "approval-not-published" });
    if (observed !== undefined) {
      if (
        observed.signingPrivateKey !== staged.signingPrivateKey ||
        observed.encryptionPrivateKey !== staged.encryptionPrivateKey ||
        observed.tls?.privateKey !== staged.tls?.privateKey
      )
        return yield* new RecoveryRefused({ reason: "credential-present" });
    } else {
      // Hub observed explicit Windows absence and still holds the install, admission, and
      // server ownership leases. Recheck the entry before writing the primary slot.
      yield* attempt(() => {
        if (readEntry(key) !== undefined) return refuse("credential-present");
        key.setSecret(encodeCredential({ ...staged, lastRevision: authority.revision }));
        const saved = readEntry(key);
        if (
          saved?.signingPrivateKey !== staged.signingPrivateKey ||
          saved.lastRevision !== authority.revision
        )
          return refuse("credential-write-unverified");
      });
    }
    yield* attempt(() => slot.deleteCredential()).pipe(Effect.ignore);
    return {
      status: "installed",
      listenerOrigin: candidate.tls?.origin,
      listenerKeySha256: candidate.tls?.publicKeySha256,
    };
  }

  if (observed !== undefined) return yield* new RecoveryRefused({ reason: "credential-present" });
  const authority = yield* readAuthority;
  const predecessor = trusted(command.environmentId);
  const owner = trusted(authority.ownerEnvironmentId);
  const signedOwner = authority.peers.find((item) => item.environmentId === owner.environmentId);
  if (
    signedOwner === undefined ||
    !samePeer(signedOwner, owner) ||
    predecessor.environmentId === owner.environmentId
  )
    return yield* new RecoveryRefused({ reason: "owner-identity-changed" });
  const id = nextId();
  const prepared = yield* attempt(() => {
    const record = Authority.generateFleetIdentity(
      command.environmentId,
      authority.fleetId,
      authority.rootPublicKey,
      false,
      { autoPickup: true, access: "read-only" },
      predecessor.machineId,
    );
    const tls = {
      origin: predecessor.origin,
      ...createFleetTlsCertificate({
        address: new URL(predecessor.origin).hostname,
        now,
      }),
    };
    const candidate = { ...record, tls };
    const request = prepareFleetCredentialRecovery(id, candidate, {
      authority,
      predecessor,
      now,
      ...safeAccess,
    });
    const entry = pendingSlot(id);
    entry.setSecret(encodeCredential(candidate));
    if (readEntry(entry)?.signingPrivateKey !== candidate.signingPrivateKey)
      return refuse("credential-write-unverified");
    return request;
  });
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* writeFleetJson(local, { request: prepared, owner });
  yield* writeFleetJson(requestFile(id), prepared);
  return { status: "awaiting-approval", comparisonCode: fleetCredentialRecoveryCode(prepared) };
});
