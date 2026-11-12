import type { DesktopAppBranding } from "@t3tools/contracts";
import { lanBuildIdentity } from "@t3tools/shared/distribution";
import {
  formatAppDisplayName,
  resolveHostedAppChannelLabel,
  resolveWebAppStageLabel,
} from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  lanBuildIdentity !== undefined
    ? null
    : hostedAppChannel === "latest" || hostedAppChannel === "nightly"
      ? hostedAppChannel
      : null;
export const HOSTED_APP_CHANNEL_LABEL = resolveHostedAppChannelLabel(HOSTED_APP_CHANNEL);
export const APP_BASE_NAME =
  lanBuildIdentity?.productName ?? injectedDesktopAppBranding?.baseName ?? "T3 Code";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  resolveWebAppStageLabel({
    hostedAppChannel: HOSTED_APP_CHANNEL,
    development: import.meta.env.DEV,
  });
export const APP_DISPLAY_NAME =
  lanBuildIdentity?.productName ??
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION =
  lanBuildIdentity?.applicationVersion ?? (import.meta.env.APP_VERSION || "0.0.0");
export const DESKTOP_DOWNLOAD_URL =
  lanBuildIdentity === undefined ? "https://t3.codes/download" : null;
// Redirects to the App Store or Google Play to match the phone that opens it.
export const MOBILE_APP_URL = "https://t3.codes/mobile";
