import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { expect, it } from "vite-plus/test";
import { fleetPairingFailureDetail } from "./lanFleetPairingError";

it("shows the pairing failure and removes credentials", () => {
  const failure = new ConnectionBlockedError({
    reason: "authentication",
    detail: "Pairing was rejected for one-time-code. Header Bearer synthetic-access-token.",
  });
  expect(fleetPairingFailureDetail(failure, "one-time-code")).toBe(
    "Pairing was rejected for [redacted]. Header Bearer [redacted]",
  );
});

it("uses the caller's fallback for an untyped failure", () => {
  expect(fleetPairingFailureDetail(new Error("Raw endpoint payload"), "code")).toBeNull();
});
