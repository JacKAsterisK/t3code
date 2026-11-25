import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";

const isConnectionFailure = Schema.is(
  Schema.Union([ConnectionBlockedError, ConnectionTransientError]),
);

/** Display typed connection detail without including pairing material or raw causes. */
export function fleetPairingFailureDetail(failure: unknown, pairingCode: string): string | null {
  if (!isConnectionFailure(failure)) return null;
  let detail = failure.detail;
  if (pairingCode !== "") {
    detail = detail.replaceAll(pairingCode, "[redacted]");
    detail = detail.replaceAll(encodeURIComponent(pairingCode), "[redacted]");
  }
  return (
    detail
      .replace(/\b(Bearer|DPoP)\s+[^\s,;]+/giu, "$1 [redacted]")
      .replace(/((?:https?|wss?):\/\/)[^/@\s]+@/giu, "$1[redacted]@")
      .replace(
        /([?&](?:token|access_token|refresh_token|pairingCode|code)=)[^&\s]+/giu,
        "$1[redacted]",
      )
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 400) || null
  );
}
