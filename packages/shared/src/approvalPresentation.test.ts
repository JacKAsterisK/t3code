import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { approvalPresentationDigest, approvalOperationDigest } from "./approvalPresentation.ts";
it.effect(
  "binds raw authority, ordered choices, incarnation and asserted consent canonically",
  () =>
    Effect.gen(function* () {
      const first = {
        reason: "same",
        permissions: { network: { enabled: true }, fileSystem: { write: ["/repo"] } },
        requestIncarnation: "one",
        providerGeneration: "generation-one",
        revision: 1,
        options: ["accept", "decline"],
      };
      const digest = yield* approvalPresentationDigest(first);
      assert.equal(
        digest,
        yield* approvalPresentationDigest({
          ...first,
          permissions: { fileSystem: { write: ["/repo"] }, network: { enabled: true } },
        }),
      );
      for (const change of [
        { ...first, requestIncarnation: "two" },
        { ...first, revision: 2 },
        { ...first, providerGeneration: "other" },
        { ...first, options: ["decline", "accept"] },
        { ...first, permissions: { network: { enabled: false } } },
      ])
        assert.notEqual(digest, yield* approvalPresentationDigest(change));
      const operation = {
        principalId: "session:one",
        decision: "accept",
        consent: { effectiveScope: "turn", authorization: "Allow this permission for the turn." },
      };
      assert.notEqual(
        yield* approvalOperationDigest(operation),
        yield* approvalOperationDigest({ ...operation, principalId: "session:two" }),
      );
      assert.notEqual(
        yield* approvalOperationDigest(operation),
        yield* approvalOperationDigest({
          ...operation,
          consent: { ...operation.consent, authorization: "Different assertion" },
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
