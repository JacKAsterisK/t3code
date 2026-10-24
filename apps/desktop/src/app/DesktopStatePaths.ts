import * as Option from "effect/Option";
import { assertDistributionHome, isLanDistribution } from "@t3tools/shared/distribution";
import { resolveNativeHomeSelection } from "@t3tools/shared/nativeHomeSelection";

export type JoinPath = (...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly localAppData: string | undefined;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  if (isLanDistribution) {
    const expected = resolveNativeHomeSelection({
      userHomeDirectory: input.homeDirectory,
      localAppData: input.localAppData ?? input.joinPath(input.homeDirectory, "AppData", "Local"),
    }).homeDirectory;
    return assertDistributionHome(
      Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () => expected),
      expected,
    );
  }
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".t3"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    !isLanDistribution &&
    input.isDevelopment &&
    Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
