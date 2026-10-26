import { describe, expect, it } from "vitest";

import {
  decodeNativeUpdateRequest,
  nativeUpdatePipePath,
  nativeUpdateTokenFromMessage,
} from "./nativeUpdateControl.ts";

const ownerId = "219ef543-6042-4ef8-a9c5-2731aee19c42";
const identity = { environmentId: "synthetic-environment", ownerId, pid: 123 };
const base = { schemaVersion: 1, ...identity, nonce: "ab".repeat(32) };

describe("native update wire boundaries", () => {
  it("requires the authorization fields belonging to each operation", () => {
    expect(decodeNativeUpdateRequest({ ...base, operation: "reserve" })?.operation).toBe("reserve");
    for (const operation of ["commit", "cancel"]) {
      expect(decodeNativeUpdateRequest({ ...base, operation })).toBeUndefined();
      expect(
        decodeNativeUpdateRequest({ ...base, operation, reservationId: ownerId })?.operation,
      ).toBe(operation);
    }
    for (const operation of ["consume-close", "abort-close"]) {
      expect(
        decodeNativeUpdateRequest({ ...base, operation, reservationId: ownerId }),
      ).toBeUndefined();
      expect(
        decodeNativeUpdateRequest({
          ...base,
          operation,
          desktopPid: 456,
          closeToken: "ab".repeat(16),
        })?.operation,
      ).toBe(operation);
    }
    for (const override of [
      { nonce: "ab" },
      { pid: 0 },
      { pid: Number.MAX_SAFE_INTEGER + 1 },
      { operation: "close" },
    ]) {
      expect(
        decodeNativeUpdateRequest({ ...base, operation: "reserve", ...override }),
      ).toBeUndefined();
    }
  });

  it("keeps untrusted owner text out of the named pipe path", () => {
    expect(nativeUpdatePipePath(ownerId)).toBe(`\\\\.\\pipe\\t3code-lan-update-v1-${ownerId}`);
    for (const owner of ["..\\other-pipe", `${ownerId}\\child`, `${ownerId}\0`, ""]) {
      expect(() => nativeUpdatePipePath(owner)).toThrow();
    }
  });

  it("preserves every byte of two Windows pointer-sized message parameters", () => {
    const wParam = Buffer.alloc(8);
    const lParam = Buffer.alloc(8);
    wParam.writeBigUInt64LE(0xfedcba9876543210n);
    lParam.writeBigUInt64LE(0x8877665544332200n);
    expect(nativeUpdateTokenFromMessage(wParam, lParam)).toBe("1032547698badcfe0022334455667788");
    expect(nativeUpdateTokenFromMessage(Buffer.alloc(8), Buffer.alloc(8))).toBe("0".repeat(32));
    expect(nativeUpdateTokenFromMessage(wParam.subarray(0, 4), lParam)).toBeUndefined();
    expect(nativeUpdateTokenFromMessage(wParam, Buffer.alloc(9))).toBeUndefined();
  });
});
