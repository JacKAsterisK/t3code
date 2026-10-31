import type { ApprovalGrant } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

export function canonicalApprovalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}
const hash = Effect.fn("ApprovalPresentation.hash")(function* (domain: string, value: unknown) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalApprovalJson([domain, 1, value])),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
});
export const approvalGrantDigest = (grant: ApprovalGrant) => hash("t3.approval.grant", grant);
export const approvalPresentationDigest = (presentation: unknown) =>
  hash("t3.approval.presentation", presentation);
export const approvalOperationDigest = (operation: unknown) =>
  hash("t3.approval.operation", operation);

export function approvalDeliveryText(
  state: import("@t3tools/contracts").ApprovalReceiptState,
): string {
  switch (state) {
    case "prepared":
      return "Approval response prepared; native request is still unanswered";
    case "committed":
      return "Approval response committed; delivery pending";
    case "delivery_admitted":
      return "Approval response admitted for delivery; write not confirmed";
    case "response_written":
      return "Native approval response written; tool execution is not confirmed";
    case "provider_acknowledged":
      return "Provider acknowledged the response; tool execution is not confirmed";
    case "refused":
      return "Approval response refused";
    case "delivery_withheld":
      return "Approval response withheld before handoff";
    case "delivery_failed":
      return "Approval response was not delivered";
    case "delivery_unknown":
      return "Native approval delivery is uncertain; inspect before retrying";
  }
}
