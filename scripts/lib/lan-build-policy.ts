// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads only an explicit public policy; no runtime or credential configuration.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { parseLanBuildIdentity } from "@t3tools/shared/distribution";
import { strictJson } from "./strict-json.ts";

export type LanBuildIdentity = ReturnType<typeof parseLanBuildIdentity>;
export interface LanBuildSelection {
  readonly path: string;
  readonly sha256: string;
  readonly identity: LanBuildIdentity;
}

export function readLanBuildPolicyFile(path: string): LanBuildSelection {
  if (!NodePath.isAbsolute(path))
    throw new Error("LAN policy requires an explicit absolute file path.");
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
    throw new Error("LAN build policy is linked, missing or oversized.");
  const bytes = NodeFS.readFileSync(path);
  const identity = parseLanBuildIdentity(strictJson(bytes));
  return Object.freeze({
    path,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    identity,
  });
}

export function loadLanBuildPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
  read: (path: string) => LanBuildSelection = readLanBuildPolicyFile,
): LanBuildIdentity | undefined {
  const path = env.T3CODE_LAN_BUILD_POLICY?.trim();
  if (!path) {
    if (env.T3CODE_LAN_BUILD_POLICY_SHA256?.trim())
      throw new Error("LAN policy digest has no policy path.");
    return undefined;
  }
  const expected = env.T3CODE_LAN_BUILD_POLICY_SHA256;
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected))
    throw new Error("LAN compilation requires its exact policy SHA-256.");
  const selection = read(path);
  if (selection.sha256 !== expected)
    throw new Error("LAN build policy changed between compiler stages.");
  return selection.identity;
}

export const lanBuildDefines = (
  identity: LanBuildIdentity | undefined,
  upstreamTestMode = false,
) =>
  identity === undefined && upstreamTestMode
    ? {}
    : {
        __T3_LAN_BUILD_IDENTITY__: identity === undefined ? "undefined" : JSON.stringify(identity),
      };

export const lanBuildEnvironment = (selection: LanBuildSelection | undefined) => ({
  T3CODE_LAN_BUILD_POLICY: selection?.path ?? "",
  T3CODE_LAN_BUILD_POLICY_SHA256: selection?.sha256 ?? "",
});

export function transformLanIndexHtml(
  html: string,
  identity: LanBuildIdentity | undefined,
): string {
  if (identity === undefined) return html;
  const escaped = identity.productName.replace(
    /[&<>"']/gu,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
  let replacements = 0;
  const result = html
    .split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/giu)
    .map((part, index) => {
      if (index % 2) return part;
      for (const [before, after] of [
        ["<title>T3 Code (Beta)</title>", `<title>${escaped}</title>`],
        ['aria-label="T3 Code splash screen"', `aria-label="${escaped} splash screen"`],
        ['alt="T3 Code"', `alt="${escaped}"`],
      ])
        part = part.replace(before!, () => {
          replacements++;
          return after!;
        });
      return part;
    })
    .join("");
  if (replacements !== 3)
    throw new Error("LAN HTML branding anchors changed; review the upstream template.");
  return result;
}

export function transformLanWebManifest(bytes: Uint8Array, identity: LanBuildIdentity): string {
  const manifest = strictJson(bytes);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    throw new Error("Invalid public web manifest.");
  return JSON.stringify({
    ...manifest,
    name: identity.productName,
    short_name: identity.productName,
  });
}
