import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as CodexSchema from "./_generated/schema.gen.ts";

// Native semantics and schemas are pinned to the generator's upstream ref, not a button label.
const CODEX_PERMISSION_PROFILE = "codex-permissions-687a119f-v1" as const;
export const CODEX_PERMISSION_VERSION = "0.159.0" as const;
export type PermissionRequestEvidence =
  | {
      readonly supported: true;
      readonly profile: typeof CODEX_PERMISSION_PROFILE;
      readonly providerVersion: typeof CODEX_PERMISSION_VERSION;
      readonly raw: CodexSchema.PermissionsRequestApprovalParams;
    }
  | {
      readonly supported: false;
      readonly reason: "unverified_version" | "unknown_raw_profile";
      readonly safeRaw: Schema.Json;
      readonly complete: boolean;
    };

const decodeRawPermission = Schema.decodeUnknownExit(CodexSchema.PermissionsRequestApprovalParams, {
  onExcessProperty: "error",
});
function safeRawRequest(raw: unknown): { safeRaw: Schema.Json; complete: boolean } {
  let remaining = 32_000;
  let complete = true;
  const visit = (input: unknown, depth: number): Schema.Json => {
    if (depth > 12 || remaining <= 0) {
      complete = false;
      return "[presentation limit]";
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") {
      remaining -= input.length;
      if (input.length > 8_000) {
        complete = false;
        return `${input.slice(0, 8_000)}?`;
      }
      return input;
    }
    if (Array.isArray(input)) {
      if (input.length > 128) complete = false;
      return input.slice(0, 128).map((value) => visit(value, depth + 1));
    }
    if (typeof input !== "object") {
      complete = false;
      return "[unrepresentable]";
    }
    const entries = Object.entries(input);
    if (entries.length > 128) complete = false;
    return Object.fromEntries(
      entries.slice(0, 128).map(([key, value]) => {
        remaining -= key.length;
        if (/authorization|token|password|secret|api.?key/iu.test(key)) {
          complete = false;
          return [key, "[redacted]"];
        }
        return [key, visit(value, depth + 1)];
      }),
    );
  };
  const safeRaw = visit(raw, 0);
  return { safeRaw, complete };
}

export function inspectPermissionRequest(
  raw: unknown,
  version: string | undefined,
): PermissionRequestEvidence {
  const safe = safeRawRequest(raw);
  const decoded = decodeRawPermission(raw);
  if (Exit.isFailure(decoded)) return { supported: false, reason: "unknown_raw_profile", ...safe };
  if (version !== CODEX_PERMISSION_VERSION)
    return { supported: false, reason: "unverified_version", ...safe };
  if (
    decoded.value.environmentId != null ||
    decoded.value.permissions.fileSystem?.entries?.some(
      (entry) => entry.path.type === "special" && entry.path.value.kind === "unknown",
    )
  )
    return { supported: false, reason: "unknown_raw_profile", ...safe };
  return {
    supported: true,
    profile: CODEX_PERMISSION_PROFILE,
    providerVersion: CODEX_PERMISSION_VERSION,
    raw: decoded.value,
  };
}
