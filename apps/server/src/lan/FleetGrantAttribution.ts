// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Ed25519 signs a schema-validated claim's fields in a canonical order.
import * as NodeCrypto from "node:crypto";
import { FleetMachineId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CredentialAttribution from "../auth/CredentialAttribution.ts";
import * as FleetContext from "./FleetContext.ts";
import * as Delivery from "./FleetDelivery.ts";
import * as FleetEnrollment from "./FleetEnrollment.ts";
import { RoutingFleetIdentity } from "./RemoteTaskTransport.ts";

/**
 * The fleet server holding a task grant from before grants recorded their approver claims it at
 * its next refresh, signed with its own fleet key and checked against the key the fleet trusts
 * for it. A machine can only sign as itself, so it can only claim grants at its own access.
 */
const PURPOSE = "t3-lan-fleet-task-grant-holder/v1";
// The claim is made for one refresh request; a little clock difference between machines is fine.
const MAX_SKEW_MS = 5 * 60 * 1000;

const Claim = Schema.Struct({
  signer: FleetMachineId,
  audience: Schema.String.check(Schema.isMaxLength(256)),
  grantId: Schema.String.check(Schema.isMaxLength(256)),
  issuedAt: Schema.Number,
});
type Claim = typeof Claim.Type;
const decodeClaim = Schema.decodeUnknownSync(Schema.fromJsonString(Claim));

const claimData = (claim: Claim) =>
  Buffer.from(
    JSON.stringify([PURPOSE, claim.signer, claim.audience, claim.grantId, claim.issuedAt]),
  );

/** `signer`'s claim that it holds `grantId` on the environment `audience`. */
export function signGrantAssertion(input: Claim & { readonly signingPrivateKey: string }): string {
  const claim: Claim = {
    signer: input.signer,
    audience: input.audience,
    grantId: input.grantId,
    issuedAt: input.issuedAt,
  };
  const signature = NodeCrypto.sign(null, claimData(claim), input.signingPrivateKey);
  return `${Buffer.from(JSON.stringify(claim)).toString("base64url")}.${signature.toString("base64url")}`;
}

/** The claim, if a trusted peer signed it for this environment just now. */
function verifyGrantAssertion(input: {
  readonly assertion: string;
  readonly peers: ReadonlyArray<Delivery.FleetPeer>;
  readonly audience: string;
  readonly now: number;
}): Claim | undefined {
  if (input.assertion.length > 4096) return undefined;
  const [encoded, signature, ...rest] = input.assertion.split(".");
  if (encoded === undefined || signature === undefined || rest.length > 0) return undefined;
  try {
    const claim = decodeClaim(Buffer.from(encoded, "base64url").toString("utf8"));
    const peer = input.peers.find((item) => item.enabled && item.machineId === claim.signer);
    if (
      peer === undefined ||
      claim.audience !== input.audience ||
      Math.abs(input.now - claim.issuedAt) > MAX_SKEW_MS
    )
      return undefined;
    const key = NodeCrypto.createPublicKey(peer.signingPublicKey);
    return key.asymmetricKeyType === "ed25519" &&
      NodeCrypto.verify(null, claimData(claim), key, Buffer.from(signature, "base64url"))
      ? claim
      : undefined;
  } catch {
    return undefined;
  }
}

/** The receiving side: only peers the full trust check finds can attribute a grant. */
export const layerServices = Layer.effect(
  CredentialAttribution.McpGrantAttribution,
  Effect.gen(function* () {
    const context = yield* FleetContext.FleetContext;
    return CredentialAttribution.McpGrantAttribution.of({
      verify: Effect.fn("FleetGrantAttribution.verify")(function* (assertion) {
        const fleet = yield* context.load.pipe(Effect.orElseSucceed(() => undefined));
        if (fleet === undefined) return undefined;
        const claim = verifyGrantAssertion({
          assertion,
          peers: fleet.peers.map(({ peer }) => peer),
          audience: fleet.self.environmentId,
          now: yield* Clock.currentTimeMillis,
        });
        if (claim === undefined || claim.signer === fleet.self.machineId) return undefined;
        // The subject of what this machine's fleet credential for the signer approves.
        return {
          grantId: claim.grantId,
          subject: CredentialAttribution.mcpClientSubject(
            `lan-fleet:${Delivery.deliveryFileName(fleet.self.machineId, claim.signer)}`,
          ),
        };
      }),
    });
  }),
);
export const layer = layerServices.pipe(Layer.provide(FleetContext.layer));

/** The holding side: `t3_lan_*` routing signs each refresh as this machine. */
export const layerSigner = Layer.effect(
  RoutingFleetIdentity,
  Effect.gen(function* () {
    const enrollment = yield* FleetEnrollment.FleetEnrollment;
    return RoutingFleetIdentity.of({
      sign: Effect.fn("FleetGrantAttribution.sign")(function* (audience, grantId) {
        const config = yield* enrollment.resolve.pipe(Effect.orElseSucceed(() => undefined));
        if (config === null || config === undefined) return undefined;
        return signGrantAssertion({
          signer: config.machineId,
          signingPrivateKey: config.signingPrivateKey,
          audience,
          grantId,
          issuedAt: yield* Clock.currentTimeMillis,
        });
      }),
    });
  }),
).pipe(Layer.provide(FleetEnrollment.layer));
