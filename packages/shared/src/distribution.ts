import type { NativeActivationBuildIdentity } from "@t3tools/contracts";

declare const __T3_LAN_BUILD_IDENTITY__: unknown;

const identityKeys = [
  "appId",
  "productName",
  "protocolScheme",
  "homeDirectoryName",
  "telemetry",
  "cloudConfiguration",
  "nativeUpdater",
  "protocolVersion",
  "applicationVersion",
  "sourceCommit",
] as const;

export function isIndependentDistributionScheme(value: string): boolean {
  // Electron registers this as an OS handler; Windows also uses it as a CLI basename.
  return (
    /^[a-z][a-z0-9+-]{1,63}$/u.test(value) &&
    !/^(?:ms-|microsoft)/u.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(value) &&
    ![
      "t3code",
      "t3code-dev",
      "http",
      "https",
      "ws",
      "wss",
      "file",
      "ftp",
      "ftps",
      "sftp",
      "ssh",
      "data",
      "blob",
      "about",
      "javascript",
      "mailto",
      "tel",
      "sms",
      "geo",
      "shell",
      "powershell",
      "chrome",
      "chrome-extension",
      "edge",
      "vscode",
      "vscode-insiders",
    ].includes(value)
  );
}

/** The packager and runtime accept the same public identity; no credential is part of it. */
export function parseLanBuildIdentity(input: unknown): Readonly<NativeActivationBuildIdentity> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid compiled LAN distribution identity.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== identityKeys.length ||
    identityKeys.some((key) => !Object.hasOwn(value, key)) ||
    typeof value.appId !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{2,127}$/iu.test(value.appId) ||
    value.appId.toLowerCase().startsWith("com.t3tools.") ||
    typeof value.productName !== "string" ||
    !value.productName.trim() ||
    value.productName !== value.productName.trim() ||
    /[\\/:<>"|?*]/u.test(value.productName) ||
    [...value.productName].some((character) => character.charCodeAt(0) < 32) ||
    /[ .]$/u.test(value.productName) ||
    /^T3 Code(?: \((?:Beta|Nightly)\))?$/iu.test(value.productName) ||
    typeof value.protocolScheme !== "string" ||
    !isIndependentDistributionScheme(value.protocolScheme) ||
    value.homeDirectoryName !== "T3CodeLAN" ||
    value.telemetry !== "disabled" ||
    value.cloudConfiguration !== "disabled" ||
    value.nativeUpdater !== "disabled" ||
    value.protocolVersion !== 2 ||
    typeof value.applicationVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.applicationVersion) ||
    value.applicationVersion.split(".").some((part) => Number(part) > 2147483647) ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
  )
    throw new Error("Invalid compiled LAN distribution identity.");
  return Object.freeze({
    appId: value.appId,
    productName: value.productName,
    protocolScheme: value.protocolScheme,
    homeDirectoryName: value.homeDirectoryName,
    telemetry: value.telemetry,
    cloudConfiguration: value.cloudConfiguration,
    nativeUpdater: value.nativeUpdater,
    protocolVersion: value.protocolVersion,
    applicationVersion: value.applicationVersion,
    sourceCommit: value.sourceCommit,
  });
}

// Only compiler substitution selects a LAN build. Environment variables and
// persisted settings cannot turn an installed LAN artifact back into a cloud build.
export const lanBuildIdentity =
  typeof __T3_LAN_BUILD_IDENTITY__ === "undefined"
    ? undefined
    : parseLanBuildIdentity(__T3_LAN_BUILD_IDENTITY__);
export const isLanDistribution = lanBuildIdentity !== undefined;
export const cloudEnabled = !isLanDistribution;
export const telemetryEnabled = !isLanDistribution;
export const nativeUpdatesEnabled = !isLanDistribution;
export const LAN_UPDATE_REPOSITORY = "JacKAsterisK/t3code";
export const LAN_PORTABLE_ZIP_MAX_BYTES = 768 * 1024 ** 2;
export const distributionUpdateMode = isLanDistribution ? "hub" : "native";
export const distributionUpdateGuidance = isLanDistribution
  ? "Updates come from JacKAsterisK/t3code. Use Reprint Hub to verify, stage and activate them while T3 Code is stopped."
  : "Use the desktop update controls to check for updates.";

export function resolveDistributionUpdateRepository(configured?: string): string {
  if (isLanDistribution) return LAN_UPDATE_REPOSITORY;
  const value = configured?.trim() ?? "";
  const parts = value.split("/");
  return parts.length === 2 &&
    parts.every((part) => /^[A-Za-z0-9._-]+$/u.test(part) && part !== "." && part !== "..")
    ? value
    : "pingdotgg/t3code";
}

export function getDistributionUpdateReleaseUrl(version?: string | null): string {
  const base = `https://github.com/${resolveDistributionUpdateRepository()}/releases`;
  return version?.trim()
    ? `${base}/tag/${isLanDistribution ? "lan-v" : "v"}${encodeURIComponent(version.trim())}`
    : base;
}
export const desktopProtocolSchemes: readonly string[] = Object.freeze(
  lanBuildIdentity === undefined ? ["t3code", "t3code-dev"] : [lanBuildIdentity.protocolScheme],
);
export const getDistributionProtocolScheme = (development: boolean) =>
  lanBuildIdentity?.protocolScheme ?? (development ? "t3code-dev" : "t3code");

export function resolveDistributionHome(input: {
  readonly homeDirectory: string;
  readonly platform: string;
  readonly localAppData: string | undefined;
  readonly joinPath: (...parts: string[]) => string;
  readonly homeMode?: "drop-in" | "side-by-side";
}): string {
  if (!isLanDistribution) return input.joinPath(input.homeDirectory, ".t3");
  if (input.platform !== "win32")
    throw new Error("This LAN distribution requires a native Windows home.");
  if (input.homeMode !== "side-by-side") return input.joinPath(input.homeDirectory, ".t3");
  const local =
    input.localAppData?.trim() || input.joinPath(input.homeDirectory, "AppData", "Local");
  if (
    !/^[a-z]:[\\/]/iu.test(local) ||
    local
      .split(/[\\/]/u)
      .some((part) =>
        [
          ".",
          "..",
          ".t3",
          "codex",
          ".codex",
          "cache",
          ".cache",
          "codex-runtimes",
          "packages",
          "localcache",
        ].includes(part.toLowerCase()),
      )
  )
    throw new Error("The LAN distribution requires an independent native LocalAppData directory.");
  return input.joinPath(local, "T3CodeLAN", "data");
}

export function assertDistributionHome(home: string, expectedHome: string): string {
  const normalized = (value: string) =>
    value.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
  if (isLanDistribution && normalized(home) !== normalized(expectedHome))
    throw new Error(
      "The configured T3 home does not match the approved home selection. Use Hub repair preview to select the original or explicit side-by-side home.",
    );
  return home;
}
