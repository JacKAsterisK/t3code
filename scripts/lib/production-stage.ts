import * as Schema from "effect/Schema";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";
import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import { selectDesktopRuntimeExternalDependencies } from "./desktop-external-packages.ts";

export interface ProductionStageWorkspaceConfig {
  readonly supportedArchitectures: { os: string[]; cpu: string[]; libc?: string[] };
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
  readonly packageExtensions: Record<
    string,
    { readonly peerDependenciesMeta: Record<string, { readonly optional: boolean }> }
  >;
  readonly nodeLinker?: "hoisted";
}

// electron-webauthn declares TypeScript as a peer only for its typings. pnpm
// auto-installs missing peers, which would ship a compiler inside the app.
const STAGE_PACKAGE_EXTENSIONS = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
} as const;

export function resolveFffNativeDependencies(
  platform: "mac" | "linux" | "win",
  arch: "arm64" | "x64" | "universal",
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

export function createStageWorkspaceConfig(input: {
  readonly platform: "mac" | "linux" | "win";
  readonly arch: "arm64" | "x64" | "universal";
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): ProductionStageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  // Linux AppImages execute a Linux/glibc Node process that loads
  // Linux-native optional deps at runtime. Keep libc explicit so pnpm
  // includes those optional packages in the staged production install.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : {
          os: [hostOs],
          cpu: hostCpu,
        };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    packageExtensions: STAGE_PACKAGE_EXTENSIONS,
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/desktop",
  );
}

const Package = Schema.Struct({
  version: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String),
});
const Root = Schema.Struct({ packageManager: Schema.String });
const Workspace = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeRoot = Schema.decodeUnknownSync(Root);
const decodePackage = Schema.decodeUnknownSync(Package);
const decodeWorkspace = Schema.decodeUnknownSync(Workspace);

export function deriveWindowsProductionStages(input: {
  readonly rootPackage: unknown;
  readonly desktopPackage: unknown;
  readonly serverPackage: unknown;
  readonly workspace: unknown;
}) {
  const root = decodeRoot(input.rootPackage),
    desktop = decodePackage(input.desktopPackage),
    server = decodePackage(input.serverPackage),
    workspace = decodeWorkspace(input.workspace);
  const catalog = workspace.catalog ?? {};
  const overrides = resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/desktop");
  const desktopDependencies = resolveDesktopRuntimeDependencies(desktop.dependencies, catalog);
  const fffVersion = server.dependencies["@ff-labs/fff-node"];
  if (fffVersion === undefined) throw new Error("The server FFF native version is absent.");
  const serverDependencies = {
    ...selectCliRuntimeExternalDependencies(
      resolveCatalogDependencies(server.dependencies, catalog, "apps/server"),
    ),
    ...resolveFffNativeDependencies("win", "x64", fffVersion),
  };
  const patches = workspace.patchedDependencies ?? {};
  const make = (name: string, dependencies: Record<string, string>, sidecar: boolean) => ({
    packageJson: {
      name,
      version: server.version,
      private: true,
      packageManager: root.packageManager,
      dependencies,
      ...(sidecar ? {} : { devDependencies: { electron: desktop.dependencies.electron! } }),
    },
    workspace: {
      ...createStageWorkspaceConfig({
        platform: "win",
        arch: "x64",
        allowBuilds: workspace.allowBuilds ?? {},
        patchedDependencies: createStagePatchedDependencies(patches, dependencies),
        overrides,
      }),
      ...(sidecar ? { nodeLinker: "hoisted" as const } : {}),
    },
  });
  if (desktop.dependencies.electron === undefined)
    throw new Error("The desktop Electron version is absent.");
  return {
    desktop: make("t3code-lan", desktopDependencies, false),
    server: make("t3code-lan-server", serverDependencies, true),
  };
}

export type WindowsProductionStage = ReturnType<typeof deriveWindowsProductionStages>["desktop"];
