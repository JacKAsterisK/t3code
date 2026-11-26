// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Public recovery proofs use Node's Ed25519 implementation and a fixed field order.
import * as NodeCrypto from "node:crypto";
import { FleetAccess } from "@t3tools/contracts";
import { verifyFleetTlsCertificate } from "@t3tools/shared/fleetTlsCertificate";
import * as Schema from "effect/Schema";
import * as Authority from "./FleetAuthority.ts";
import { FleetPeer } from "./FleetDelivery.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const RequestId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));
const VerificationCode = /^[a-f0-9]{12}$/u;
const MAX_REQUEST_AGE_MS = 20 * 60 * 1000;

const RequestBody = Schema.Struct({
  version: Schema.Literal(1),
  id: RequestId,
  authorityDigest: Digest,
  predecessorDigest: Digest,
  accessCeiling: FleetAccess,
  accessPolicyDigest: Digest,
  expiresAt: Schema.Number.check(Schema.isInt()),
  enrollment: Authority.FleetEnrollmentRequest,
});
type RequestBody = typeof RequestBody.Type;

export const FleetCredentialRecoveryRequest = Schema.Struct({
  ...RequestBody.fields,
  signature: Schema.String.check(Schema.isMaxLength(1024)),
});
export type FleetCredentialRecoveryRequest = typeof FleetCredentialRecoveryRequest.Type;
const decodeRequest = Schema.decodeSync(FleetCredentialRecoveryRequest);

export interface FleetCredentialRecoveryReview {
  readonly authority: Authority.FleetAuthority;
  readonly predecessor: FleetPeer;
  readonly accessCeiling: FleetAccess;
  readonly accessPolicyDigest: string;
  readonly now: number;
}

const sha256 = (data: string) => NodeCrypto.createHash("sha256").update(data).digest("hex");

function authorityDigest(authority: Authority.FleetAuthority): string {
  return sha256(JSON.stringify([authority.fleetId, authority.rootPublicKey, authority.signature]));
}

function peerData(peer: FleetPeer): ReadonlyArray<unknown> {
  return [
    peer.machineId,
    peer.environmentId,
    peer.label,
    peer.origin,
    peer.enabled,
    peer.signingPublicKey,
    peer.encryptionPublicKey,
    peer.tls === undefined
      ? null
      : [
          peer.tls.origin,
          peer.tls.certificate,
          peer.tls.publicKeySha256,
          peer.tls.connectHost ?? null,
        ],
  ];
}

function requestData(request: RequestBody): string {
  return JSON.stringify([
    "t3/lan/fleet-credential-recovery/request",
    request.version,
    request.id,
    request.authorityDigest,
    request.predecessorDigest,
    request.accessCeiling,
    request.accessPolicyDigest,
    request.expiresAt,
    request.enrollment.version,
    request.enrollment.fleetId,
    peerData(request.enrollment.peer),
    request.enrollment.signature,
  ]);
}

function validateRequest(
  request: FleetCredentialRecoveryRequest,
  review: FleetCredentialRecoveryReview,
): FleetPeer {
  const { authority, predecessor } = review;
  Authority.verifyAuthority(authority);
  Authority.verifyEnrollment(request.enrollment, authority);
  const candidate = request.enrollment.peer;
  const tls = candidate.tls;
  if (
    !predecessor.enabled ||
    !candidate.enabled ||
    candidate.environmentId === authority.ownerEnvironmentId ||
    candidate.machineId !== predecessor.machineId ||
    candidate.environmentId !== predecessor.environmentId ||
    candidate.origin !== predecessor.origin ||
    candidate.label !== predecessor.label ||
    candidate.signingPublicKey === predecessor.signingPublicKey ||
    candidate.encryptionPublicKey === predecessor.encryptionPublicKey ||
    request.authorityDigest !== authorityDigest(authority) ||
    request.predecessorDigest !== sha256(JSON.stringify(peerData(predecessor))) ||
    request.accessCeiling !== review.accessCeiling ||
    request.accessPolicyDigest !== review.accessPolicyDigest ||
    request.expiresAt <= review.now ||
    request.expiresAt > review.now + MAX_REQUEST_AGE_MS ||
    tls === undefined ||
    tls.origin !== candidate.origin ||
    tls.publicKeySha256 === predecessor.tls?.publicKeySha256 ||
    !verifyFleetTlsCertificate(
      tls.certificate,
      new URL(tls.origin).hostname,
      tls.publicKeySha256,
      review.now,
    ) ||
    !NodeCrypto.verify(
      null,
      Buffer.from(requestData(request)),
      NodeCrypto.createPublicKey(candidate.signingPublicKey),
      Buffer.from(request.signature, "base64"),
    )
  )
    throw new Error("The fleet credential recovery request does not match the reviewed machine.");
  return candidate;
}

export function prepareFleetCredentialRecovery(
  id: string,
  candidate: Authority.FleetVaultRecord,
  review: FleetCredentialRecoveryReview,
): FleetCredentialRecoveryRequest {
  const { authority, predecessor } = review;
  if (
    candidate.rootPrivateKey !== undefined ||
    candidate.rootPublicKey !== authority.rootPublicKey ||
    candidate.fleetId !== authority.fleetId ||
    candidate.access !== review.accessCeiling
  )
    throw new Error("The candidate credential does not match the approved fleet and access.");
  const peer = Authority.identityPeer(candidate, predecessor.label, predecessor.origin);
  const body: RequestBody = {
    version: 1,
    id,
    authorityDigest: authorityDigest(authority),
    predecessorDigest: sha256(JSON.stringify(peerData(predecessor))),
    accessCeiling: review.accessCeiling,
    accessPolicyDigest: review.accessPolicyDigest,
    expiresAt: review.now + MAX_REQUEST_AGE_MS,
    enrollment: Authority.enrollmentRequest(candidate, peer),
  };
  const request = decodeRequest({
    ...body,
    signature: NodeCrypto.sign(
      null,
      Buffer.from(requestData(body)),
      NodeCrypto.createPrivateKey(candidate.signingPrivateKey),
    ).toString("base64"),
  });
  validateRequest(request, review);
  return request;
}

export function fleetCredentialRecoveryCode(request: FleetCredentialRecoveryRequest): string {
  return sha256(requestData(request)).slice(0, 12);
}

export function approveFleetCredentialRecovery(
  request: FleetCredentialRecoveryRequest,
  code: string,
  owner: Authority.FleetVaultRecord,
  review: FleetCredentialRecoveryReview,
): Authority.FleetAuthority {
  const { authority, predecessor } = review;
  const candidate = validateRequest(request, review);
  Authority.verifyAuthority(authority, owner);
  if (
    owner.rootPrivateKey === undefined ||
    owner.environmentId !== authority.ownerEnvironmentId ||
    !VerificationCode.test(code) ||
    code !== fleetCredentialRecoveryCode(request)
  )
    throw new Error(
      "Fleet credential recovery requires the fleet owner's matching comparison code.",
    );

  const existing = authority.peers.find(
    (peer) =>
      peer.machineId === candidate.machineId || peer.environmentId === candidate.environmentId,
  );
  if (
    existing !== undefined &&
    sha256(JSON.stringify(peerData(existing))) !== sha256(JSON.stringify(peerData(predecessor)))
  )
    throw new Error("The previously authorized fleet identity changed during review.");

  return Authority.signAuthority(
    {
      ...authority,
      revision: authority.revision + 1,
      peers: [...authority.peers.filter((peer) => peer !== existing), candidate],
      credentialKeyDigests: {
        ...authority.credentialKeyDigests,
        [candidate.machineId]: Authority.fleetSigningKeyDigest(candidate.signingPublicKey),
      },
    },
    owner.rootPrivateKey,
  );
}
