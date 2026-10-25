export function resolveClientBuildVersion(
  forkBuildVersion: string | undefined,
  development: boolean,
) {
  const version = forkBuildVersion?.trim();
  return version && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/iu.test(version)
    ? `v${version}`
    : development
      ? "dev"
      : "unknown";
}

// Never derive the client build from an environment RPC or the Hub's selected package.
export const CLIENT_FORK_BUILD_VERSION = resolveClientBuildVersion(
  import.meta.env.FORK_BUILD_VERSION,
  import.meta.env.DEV,
);
