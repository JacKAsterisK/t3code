import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";

/** Display typed connection detail without including pairing material or raw causes. */
export function fleetPairingFailureDetail(failure: unknown, pairingCode: string): string | null {
  if (!(failure instanceof ConnectionBlockedError || failure instanceof ConnectionTransientError))
    return null;
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
