export const NATIVE_UPDATE_CLOSE_MESSAGE = "T3CodeLAN.IdleUpdateClose.v1";
export const NATIVE_UPDATE_MAX_LINE_BYTES = 8_192;
export const NATIVE_UPDATE_RESERVATION_MS = 30_000;
export const NATIVE_UPDATE_PREPARE_MS = 5_000;

export interface NativeUpdateIdentity {
  readonly environmentId: string;
  readonly ownerId: string;
  readonly pid: number;
}

export interface NativeUpdateRequest extends NativeUpdateIdentity {
  readonly schemaVersion: 1;
  readonly operation: "reserve" | "commit" | "cancel" | "consume-close" | "abort-close";
  readonly nonce: string;
  readonly reservationId?: string;
  readonly closeToken?: string;
  readonly desktopPid?: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isNativeUpdateOwnerId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);

export const nativeUpdatePipePath = (ownerId: string): string => {
  if (!isNativeUpdateOwnerId(ownerId)) throw new Error("Invalid native update owner.");
  return `\\\\.\\pipe\\t3code-lan-update-v1-${ownerId}`;
};

export function decodeNativeUpdateRequest(value: unknown): NativeUpdateRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const request = value as Record<string, unknown>;
  if (
    request.schemaVersion !== 1 ||
    typeof request.environmentId !== "string" ||
    request.environmentId.length === 0 ||
    request.environmentId.length > 200 ||
    !isNativeUpdateOwnerId(request.ownerId) ||
    !Number.isSafeInteger(request.pid) ||
    Number(request.pid) <= 0 ||
    typeof request.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.nonce)
  )
    return undefined;
  if (request.operation === "reserve") return request as unknown as NativeUpdateRequest;
  if (request.operation === "commit" || request.operation === "cancel") {
    return isNativeUpdateOwnerId(request.reservationId)
      ? (request as unknown as NativeUpdateRequest)
      : undefined;
  }
  if (request.operation === "consume-close" || request.operation === "abort-close") {
    return typeof request.closeToken === "string" &&
      /^[0-9a-f]{32}$/.test(request.closeToken) &&
      Number.isSafeInteger(request.desktopPid) &&
      Number(request.desktopPid) > 0
      ? (request as unknown as NativeUpdateRequest)
      : undefined;
  }
  return undefined;
}

export function nativeUpdateTokenFromMessage(wParam: Buffer, lParam: Buffer): string | undefined {
  if (wParam.length !== 8 || lParam.length !== 8) return undefined;
  return Buffer.concat([wParam, lParam]).toString("hex");
}
