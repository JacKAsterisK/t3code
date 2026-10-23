// @effect-diagnostics nodeBuiltinImport:off -- The isolated Windows build boundary pins public executable bytes and never inherits host configuration.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { parseLanBuildIdentity } from "@t3tools/shared/distribution";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";
import { BuildLock, sha256 } from "./hub-distribution.ts";
import {
  relativeWindowsPath,
  strictJson,
  ToolchainManifest,
  TOOLCHAIN_LIMITS,
} from "./windows-artifact.ts";
import {
  assertWindowsSandboxContext,
  type WindowsSandboxContext,
} from "./windows-sandbox-context.ts";
import { assertWindowsNativeContext, type WindowsNativeContext } from "./windows-native-context.ts";

export type WindowsBuildContext = WindowsSandboxContext | WindowsNativeContext;
const assertWindowsBuildContext = (value: WindowsBuildContext) => {
  if (value.kind === "windows-native-directory") assertWindowsNativeContext(value);
  else if (value.kind === "windows-sandbox") assertWindowsSandboxContext(value);
  else throw new Error("An approved Windows build backend is required.");
};

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const WindowsBuildExecutionRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  toolchainManifestSha256: Hash,
  buildLockSha256: Hash,
  identitySha256: Hash,
  sourceDateEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tools: Schema.Struct({
    node: Schema.String,
    pnpm: Schema.String,
    cargo: Schema.String,
    rustc: Schema.String,
    cl: Schema.String,
    link: Schema.String,
    lib: Schema.String,
    rc: Schema.String,
    mt: Schema.String,
    msbuild: Schema.String,
    python: Schema.String,
    cmd: Schema.String,
    powershell: Schema.String,
    viteCli: Schema.String,
    builderCli: Schema.String,
    nodeGyp: Schema.String,
  }),
  directories: Schema.Struct({
    visualStudioRoot: Schema.String,
    msvcRoot: Schema.String,
    windowsSdkRoot: Schema.String,
    nodeHeaders: Schema.String,
    pnpmStore: Schema.String,
    cargoHome: Schema.String,
    electronCache: Schema.String,
    builderCache: Schema.String,
    include: Schema.Array(Schema.String),
    libraries: Schema.Array(Schema.String),
    path: Schema.Array(Schema.String),
  }),
  windowsSdkVersion: Schema.String,
  visualStudioVersion: Schema.String,
});
export type WindowsBuildExecutionRequest = typeof WindowsBuildExecutionRequest.Type;
const decodeRequest = Schema.decodeUnknownSync(WindowsBuildExecutionRequest, {
  onExcessProperty: "error",
});
const decodeLock = Schema.decodeUnknownSync(BuildLock, { onExcessProperty: "error" });
const decodeInventory = Schema.decodeUnknownSync(ToolchainManifest, { onExcessProperty: "error" });

export class WindowsBuildExecutionError extends Schema.TaggedError<WindowsBuildExecutionError>()(
  "WindowsBuildExecutionError",
  { message: Schema.String },
) {}

const path = NodePath.win32;
const cacheNames = ["pnpmStore", "cargoHome", "electronCache", "builderCache"] as const;
const nativeTools = [
  "node",
  "pnpm",
  "cargo",
  "rustc",
  "cl",
  "link",
  "lib",
  "rc",
  "mt",
  "msbuild",
  "python",
  "cmd",
  "powershell",
] as const;
const scriptTools = ["viteCli", "builderCli", "nodeGyp"] as const;
const normalize = (value: string) => path.normalize(value).replace(/\\$/u, "").toLowerCase();
const isInside = (child: string, root: string) =>
  normalize(child).startsWith(normalize(root) + "\\");
const executions = new WeakSet<object>();
function freezeTree<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export interface PinnedWindowsBuildCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PinnedWindowsBuildExecution {
  readonly isolation: WindowsBuildContext;
  readonly request: WindowsBuildExecutionRequest;
  readonly lock: BuildLock;
  readonly lockBytes: Uint8Array;
  readonly env: Readonly<Record<string, string>>;
  readonly node: string;
  readonly verify: Effect.Effect<void, WindowsBuildExecutionError>;
  readonly workspaceInstall: () => PinnedWindowsBuildCommand;
  readonly compile: (
    applicationVersion: string,
    policyEnvironment: Readonly<Record<string, string>>,
  ) => readonly PinnedWindowsBuildCommand[];
  readonly stageInstall: (cwd: string) => PinnedWindowsBuildCommand;
  readonly resourceMonitor: () => PinnedWindowsBuildCommand;
  readonly builder: (stageAppDir: string) => PinnedWindowsBuildCommand;
  readonly registerPackagedElectronProbe: (command: ChildProcess.StandardCommand) => void;
  readonly prepare: (command: ChildProcess.Command) => ChildProcess.StandardCommand;
}

export class WindowsBuildExecution extends Context.Service<
  WindowsBuildExecution,
  PinnedWindowsBuildExecution
>()("t3/lan/WindowsBuildExecution") {}

export function assertWindowsBuildExecution(
  value: unknown,
): asserts value is PinnedWindowsBuildExecution {
  if (typeof value !== "object" || value === null || !executions.has(value))
    throw new Error(
      "An isolated build requires a verified execution capability, never an environment flag.",
    );
  assertWindowsBuildContext((value as PinnedWindowsBuildExecution).isolation);
}

export function asChildProcess(
  command: PinnedWindowsBuildCommand,
  output: "pipe" | "inherit" = "pipe",
): ChildProcess.StandardCommand {
  return ChildProcess.make(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    extendEnv: false,
    shell: false,
    stdout: output,
    stderr: output,
  });
}

export function createWindowsBuildExecution(input: {
  readonly requestBytes: Uint8Array;
  readonly approvedRequestSha256: string;
  readonly lockBytes: Uint8Array;
  readonly identityBytes: Uint8Array;
  readonly nodeHeaderFiles: { readonly nodeVersionH: Uint8Array; readonly configGypi: Uint8Array };
  readonly toolchainManifestBytes: Uint8Array;
  readonly toolchainFiles: ReadonlyMap<
    string,
    { readonly length: number; readonly sha256: string }
  >;
  readonly isolation: WindowsBuildContext;
  readonly verifyUnchanged: () => Promise<void>;
}): PinnedWindowsBuildExecution {
  assertWindowsBuildContext(input.isolation);
  if (
    !/^[a-f0-9]{64}$/u.test(input.approvedRequestSha256) ||
    sha256(input.requestBytes) !== input.approvedRequestSha256
  )
    throw new Error("The execution request differs from the separately reviewed bytes.");
  const request = freezeTree(decodeRequest(strictJson(input.requestBytes)));
  const lock = freezeTree(decodeLock(strictJson(input.lockBytes)));
  if (lock.tools.pnpm.version !== "12.14.0")
    throw new Error(
      "The isolated adapter supports the reviewed native pnpm 12.14.0 frozen-lock semantics only.",
    );
  const identity = parseLanBuildIdentity(strictJson(input.identityBytes));
  if (
    sha256(input.lockBytes) !== request.buildLockSha256 ||
    sha256(input.identityBytes) !== request.identitySha256 ||
    identity.sourceCommit !== lock.forkCommit ||
    identity.applicationVersion !== lock.applicationVersion
  )
    throw new Error("The execution lock and immutable identity differ from the reviewed request.");
  const lockBytes = new Uint8Array(input.lockBytes);
  const toolchainFiles = new Map(input.toolchainFiles);
  if (lock.forkCommit !== input.isolation.sourceCommit || lock.wslRuntime !== null)
    throw new Error("The isolated snapshot differs from the approved native build source.");
  if (sha256(input.toolchainManifestBytes) !== request.toolchainManifestSha256)
    throw new Error("The toolchain inventory differs from the approved execution request.");
  const inventory = decodeInventory(strictJson(input.toolchainManifestBytes));
  const names = new Set<string>();
  if (
    !inventory.files.length ||
    inventory.files.length > TOOLCHAIN_LIMITS.files ||
    inventory.files.length !== toolchainFiles.size
  )
    throw new Error("The execution toolchain closure is incomplete.");
  for (const pin of inventory.files) {
    relativeWindowsPath(pin.path);
    const actual = toolchainFiles.get(pin.path);
    if (
      names.has(pin.path.toLowerCase()) ||
      pin.length < 0 ||
      actual?.length !== pin.length ||
      actual.sha256 !== pin.sha256
    )
      throw new Error("The execution toolchain bytes differ from their approved inventory.");
    names.add(pin.path.toLowerCase());
  }
  const file = (relative: string) => {
    relativeWindowsPath(relative);
    if (!toolchainFiles.has(relative))
      throw new Error("An execution tool is absent from the reviewed closure.");
    return path.join(input.isolation.toolchainRoot, relative);
  };
  const directory = (relative: string) => {
    relativeWindowsPath(relative);
    if (![...toolchainFiles.keys()].some((name) => name.startsWith(relative + "/")))
      throw new Error("An execution directory is absent from the reviewed closure.");
    return path.join(input.isolation.toolchainRoot, relative);
  };
  const tools = Object.fromEntries(
    Object.entries(request.tools).map(([name, relative]) => [name, file(relative)]),
  ) as Record<keyof WindowsBuildExecutionRequest["tools"], string>;
  const verifyNativeTool = (absolute: string) => {
    const relative = path.relative(input.isolation.toolchainRoot, absolute).replaceAll("\\", "/");
    const pin = toolchainFiles.get(relative),
      stat = NodeFS.lstatSync(absolute);
    if (
      !pin ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== pin.length
    )
      throw new Error("A selected native build tool changed before execution.");
    const bytes = NodeFS.readFileSync(absolute);
    if (bytes.length !== pin.length || sha256(bytes) !== pin.sha256)
      throw new Error("A selected native build tool changed before execution.");
  };
  for (const name of nativeTools)
    if (path.basename(tools[name]).toLowerCase() !== (name === "link" ? "link.exe" : `${name}.exe`))
      throw new Error(
        "Native execution tools must use their explicit executable names, never shims.",
      );
  for (const name of scriptTools)
    if (
      !/\.[cm]?js$/iu.test(tools[name]) &&
      !(name === "viteCli" && path.basename(tools[name]) === "vp")
    )
      throw new Error("JavaScript execution tools must be explicit reviewed entry points.");
  for (const [role, key] of [
    ["node", "node"],
    ["pnpm", "pnpm"],
    ["rust", "rustc"],
    ["msvc", "cl"],
    ["windowsSdk", "rc"],
  ] as const)
    if (toolchainFiles.get(request.tools[key])?.sha256 !== lock.tools[role].sha256)
      throw new Error("A primary execution tool differs from its approved build lock.");
  const vsMajor = /^(17|18)\.\d+\.\d+(?:\.\d+)?$/u.exec(request.visualStudioVersion)?.[1];
  const visualStudioYear = vsMajor === "17" ? "2022" : vsMajor === "18" ? "2026" : undefined;
  const compatibleToolset =
    vsMajor === "17" ? /^14\.(?:3\d|4\d)\.\d+(?:\.\d+)?$/u : /^14\.5\d\.\d+(?:\.\d+)?$/u;
  if (
    !/^\d+\.\d+\.\d+\.\d+$/u.test(request.windowsSdkVersion) ||
    request.windowsSdkVersion !== lock.tools.windowsSdk.version ||
    visualStudioYear === undefined ||
    !compatibleToolset.test(lock.tools.msvc.version) ||
    !request.directories.include.length ||
    !request.directories.libraries.length ||
    !request.directories.path.length
  )
    throw new Error(
      "Reviewed Visual Studio/MSVC versions and exact locked SDK include, library and executable paths are required.",
    );
  for (const values of [
    request.directories.include,
    request.directories.libraries,
    request.directories.path,
  ])
    if (
      values.length > 32 ||
      new Set(values.map((value) => value.toLowerCase())).size !== values.length
    )
      throw new Error("Execution directory selection is ambiguous.");
  for (const value of Object.values(request.directories))
    for (const relative of typeof value === "string" ? [value] : value) directory(relative);
  const expectedMsvcRoot = path.join(
    directory(request.directories.visualStudioRoot),
    "VC",
    "Tools",
    "MSVC",
    lock.tools.msvc.version,
  );
  const sdkBin = path.join(
    directory(request.directories.windowsSdkRoot),
    "bin",
    request.windowsSdkVersion,
    "x64",
  );
  const expectedTools = {
    cl: path.join(expectedMsvcRoot, "bin", "Hostx64", "x64", "cl.exe"),
    link: path.join(expectedMsvcRoot, "bin", "Hostx64", "x64", "link.exe"),
    lib: path.join(expectedMsvcRoot, "bin", "Hostx64", "x64", "lib.exe"),
    rc: path.join(sdkBin, "rc.exe"),
    mt: path.join(sdkBin, "mt.exe"),
    msbuild: path.join(
      directory(request.directories.visualStudioRoot),
      "MSBuild",
      "Current",
      "Bin",
      "MSBuild.exe",
    ),
  };
  if (
    normalize(directory(request.directories.msvcRoot)) !== normalize(expectedMsvcRoot) ||
    Object.entries(expectedTools).some(
      ([name, expected]) =>
        normalize(tools[name as keyof typeof expectedTools]) !== normalize(expected),
    )
  )
    throw new Error(
      "The reviewed native tool paths differ from the pinned Visual Studio and SDK layouts.",
    );
  const output = input.isolation.outputRoot;
  const source = input.isolation.sourceRoot;
  const vcTargetsRelative = `${request.directories.visualStudioRoot}/MSBuild/Microsoft/VC/${vsMajor === "18" ? "v180" : "v170"}`;
  const vcTargets = directory(vcTargetsRelative);
  if (!isInside(source, output))
    throw new Error("The isolated working source must be below its fresh output root.");
  const cache = (name: (typeof cacheNames)[number]) => path.join(output, "caches", name);
  const dirs = request.directories;
  const headerText = (name: "node_version.h" | "config.gypi", bytes: Uint8Array) => {
    const pin = toolchainFiles.get(`${dirs.nodeHeaders}/include/node/${name}`);
    if (
      !pin ||
      bytes.length > 1024 * 1024 ||
      bytes.length !== pin.length ||
      sha256(bytes) !== pin.sha256
    )
      throw new Error("The native Node headers differ from their reviewed toolchain inventory.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const nodeVersion = headerText("node_version.h", input.nodeHeaderFiles.nodeVersionH);
  const versionParts = ["MAJOR", "MINOR", "PATCH"].map((part) => {
    const matches = [
      ...nodeVersion.matchAll(
        new RegExp(`^\\s*#\\s*define\\s+NODE_${part}_VERSION\\s+(\\d+)\\s*$`, "gmu"),
      ),
    ];
    if (matches.length !== 1)
      throw new Error("The native Node header version is missing or ambiguous.");
    return matches[0]![1]!;
  });
  // Match node-gyp's documented config.gypi normalization without evaluating
  // Python/JavaScript, and keep duplicate JSON keys an explicit refusal.
  const configText = headerText("config.gypi", input.nodeHeaderFiles.configGypi)
    .replace(/#.*/gu, "")
    .replace(/'$\s+'/gmu, "")
    .replaceAll("'", '"');
  const headerConfig = strictJson(new TextEncoder().encode(configText));
  if (
    versionParts.join(".") !== lock.tools.node.version ||
    typeof headerConfig !== "object" ||
    headerConfig === null ||
    !("variables" in headerConfig) ||
    typeof headerConfig.variables !== "object" ||
    headerConfig.variables === null ||
    !("target_arch" in headerConfig.variables) ||
    headerConfig.variables.target_arch !== "x64"
  )
    throw new Error("Native headers must match the exact approved Node version and x64 target.");
  const env: Readonly<Record<string, string>> = Object.freeze({
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    ComSpec: tools.cmd,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: [
      ...new Set([
        path.dirname(tools.node),
        ...nativeTools.map((name) => path.dirname(tools[name])),
        ...dirs.path.map(directory),
      ]),
    ].join(";"),
    TEMP: path.join(output, "temp"),
    TMP: path.join(output, "temp"),
    USERPROFILE: path.join(output, "home"),
    HOME: path.join(output, "home"),
    APPDATA: path.join(output, "home", "roaming"),
    LOCALAPPDATA: path.join(output, "home", "local"),
    CI: "true",
    SOURCE_DATE_EPOCH: String(request.sourceDateEpoch),
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    POWERSHELL_TELEMETRY_OPTOUT: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    PSModulePath: path.join(path.dirname(tools.powershell), "Modules"),
    PSModuleAnalysisCachePath: path.join(output, "home", "local", "PowerShell-ModuleAnalysisCache"),
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_MULTILEVEL_LOOKUP: "0",
    npm_config_userconfig: path.join(output, "empty.npmrc"),
    npm_config_globalconfig: path.join(output, "empty-global.npmrc"),
    npm_config_manage_package_manager_versions: "false",
    npm_config_package_manager_strict_version: "true",
    npm_config_ignore_pnpmfile: "true",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_python: tools.python,
    PYTHON: tools.python,
    PYTHONDONTWRITEBYTECODE: "1",
    // The release snapshot has no Git metadata; developer hook setup has no build role.
    VP_GIT_HOOKS: "0",
    npm_config_node_gyp: tools.nodeGyp,
    NODE_GYP_FORCE_PYTHON: tools.python,
    npm_config_script_shell: tools.cmd,
    npm_config_nodedir: directory(dirs.nodeHeaders),
    npm_config_msvs_version: visualStudioYear,
    GYP_MSVS_VERSION: visualStudioYear,
    VSCMD_VER: request.visualStudioVersion,
    VSCMD_ARG_TGT_ARCH: "x64",
    VSCMD_ARG_HOST_ARCH: "x64",
    // Microsoft.Cpp.Default.props otherwise clears the pinned command-prompt paths
    // and can rediscover a different host toolchain through the registry.
    UseEnv: "true",
    DisableRegistryUse: "true",
    VsInstallRoot: directory(dirs.visualStudioRoot),
    VSINSTALLDIR: directory(dirs.visualStudioRoot) + "\\",
    VCToolsVersion: lock.tools.msvc.version,
    VCTargetsPath: vcTargets + "\\",
    MSBuildExtensionsPath: path.join(directory(dirs.visualStudioRoot), "MSBuild"),
    MSBuildExtensionsPath32: path.join(directory(dirs.visualStudioRoot), "MSBuild"),
    MSBuildExtensionsPath64: path.join(directory(dirs.visualStudioRoot), "MSBuild"),
    GYP_MSVS_OVERRIDE_PATH: directory(dirs.visualStudioRoot),
    VCINSTALLDIR: directory(dirs.visualStudioRoot) + "\\VC\\",
    VCToolsInstallDir: directory(dirs.msvcRoot) + "\\",
    [`VCInstallDir_${vsMajor}0`]: directory(dirs.visualStudioRoot) + "\\VC\\",
    [`VCToolsInstallDir_${vsMajor}0`]: directory(dirs.msvcRoot) + "\\",
    WindowsSdkDir: directory(dirs.windowsSdkRoot) + "\\",
    WindowsSDKVersion: request.windowsSdkVersion + "\\",
    WindowsSdkDir_10: directory(dirs.windowsSdkRoot) + "\\",
    UniversalCRTSdkDir: directory(dirs.windowsSdkRoot) + "\\",
    UniversalCRTSdkDir_10: directory(dirs.windowsSdkRoot) + "\\",
    WindowsTargetPlatformVersion: request.windowsSdkVersion,
    TargetPlatformVersion: request.windowsSdkVersion,
    UCRTVersion: request.windowsSdkVersion,
    TargetUniversalCRTVersion: request.windowsSdkVersion,
    INCLUDE: dirs.include.map(directory).join(";"),
    LIB: dirs.libraries.map(directory).join(";"),
    LIBPATH: dirs.libraries.map(directory).join(";"),
    CC: tools.cl,
    CXX: tools.cl,
    LD: tools.link,
    AR: tools.lib,
    RC: tools.rc,
    MSBUILD_EXE_PATH: tools.msbuild,
    npm_config_msbuild_path: tools.msbuild,
    RUSTC: tools.rustc,
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_BUILD_RUSTC: tools.rustc,
    CARGO_HOME: cache("cargoHome"),
    CARGO_TARGET_DIR: path.join(source, "native", "resource-monitor", "target"),
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: tools.link,
    CARGO_NET_OFFLINE: "true",
    CARGO_INCREMENTAL: "0",
    // Stripping symbols leaves registry panic locations in the EXE. Encode arguments
    // so both copied cache/source roots remap consistently even when paths contain spaces.
    CARGO_ENCODED_RUSTFLAGS: [
      "-C",
      "link-arg=/Brepro",
      `--remap-path-prefix=${output}=C:\\T3LanBuild`,
    ].join("\x1f"),
    CFLAGS: "/Brepro",
    CXXFLAGS: "/Brepro",
    ELECTRON_CACHE: cache("electronCache"),
    ELECTRON_BUILDER_CACHE: cache("builderCache"),
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    npm_config_electron_use_remote_checksums: "false",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "false",
  });
  const cwd = (value: string) => {
    if (!isInside(value, output) || !path.isAbsolute(value))
      throw new Error("Build commands may only write below the isolated output root.");
    relativeWindowsPath(path.relative(output, value).replaceAll("\\", "/"));
    return value;
  };
  const command = (
    executable: string,
    args: readonly string[],
    workingDirectory: string,
    extra: Readonly<Record<string, string>> = {},
  ): PinnedWindowsBuildCommand =>
    Object.freeze({
      executable,
      args: Object.freeze([...args]),
      cwd: cwd(workingDirectory),
      env: Object.freeze({ ...env, ...extra }),
    });
  const install = (workingDirectory: string, production: boolean) =>
    command(
      tools.pnpm,
      [
        "install",
        ...(production
          ? ["--prod"]
          : [
              // Include build tooling and workspace dependency closures without mobile's
              // local modules or lifecycles, which have no Windows build role.
              "--filter",
              "@t3tools/monorepo...",
              "--filter",
              "@t3tools/scripts...",
              "--filter",
              "@t3tools/web...",
              "--filter",
              "t3...",
              "--filter",
              "@t3tools/desktop...",
              "--fail-if-no-match",
            ]),
        "--offline",
        "--frozen-lockfile",
        // This exact pnpm pin preserves the recorded checksum and peer graph
        // when frozen hooks are skipped; the source hook adds WSL architectures.
        "--ignore-pnpmfile",
        "--config.manage-package-manager-versions=false",
        "--config.package-manager-strict-version=true",
        "--config.verify-store-integrity=true",
        "--store-dir",
        cache("pnpmStore"),
        "--config.cache-dir=" + path.join(cache("pnpmStore"), "metadata-cache"),
      ],
      workingDirectory,
    );
  let candidate:
    | {
        readonly executable: string;
        readonly args: readonly string[];
        readonly dev: number;
        readonly ino: number;
        readonly length: number;
        readonly sha256: string;
      }
    | undefined;
  const value: PinnedWindowsBuildExecution = {
    isolation: input.isolation,
    request,
    lock,
    get lockBytes() {
      return new Uint8Array(lockBytes);
    },
    env,
    node: tools.node,
    verify: Effect.tryPromise({
      try: async () => {
        assertWindowsBuildContext(input.isolation);
        await input.verifyUnchanged();
      },
      catch: () =>
        new WindowsBuildExecutionError({
          message: "The isolated build source, policy, tools or isolation boundary changed.",
        }),
    }),
    workspaceInstall: () => install(source, false),
    compile: (version, policyEnvironment) => {
      if (
        version !== lock.applicationVersion ||
        policyEnvironment.T3CODE_LAN_BUILD_POLICY_SHA256 !== request.identitySha256 ||
        !isInside(policyEnvironment.T3CODE_LAN_BUILD_POLICY ?? "", input.isolation.inputsRoot) ||
        Object.keys(policyEnvironment).some(
          (key) => !["T3CODE_LAN_BUILD_POLICY", "T3CODE_LAN_BUILD_POLICY_SHA256"].includes(key),
        )
      )
        throw new Error(
          "Compilation requires the reviewed immutable LAN policy and application version.",
        );
      const extra = { ...policyEnvironment, APP_VERSION: version };
      return [
        command(tools.node, [tools.viteCli, "build"], path.join(source, "apps/web"), extra),
        command(tools.node, [tools.viteCli, "pack"], path.join(source, "apps/server"), extra),
        command(
          tools.node,
          [path.join(source, "apps/desktop/scripts/build-preview-annotation-css.mjs")],
          path.join(source, "apps/desktop"),
          extra,
        ),
        command(tools.node, [tools.viteCli, "pack"], path.join(source, "apps/desktop"), extra),
      ];
    },
    stageInstall: (workingDirectory) => install(workingDirectory, true),
    resourceMonitor: () =>
      command(
        tools.cargo,
        [
          "build",
          "--frozen",
          "--offline",
          "--locked",
          "--release",
          "--manifest-path",
          path.join(source, "native/resource-monitor/Cargo.toml"),
          "--target",
          "x86_64-pc-windows-msvc",
        ],
        source,
      ),
    builder: (stageAppDir) =>
      command(
        tools.node,
        [
          tools.builderCli,
          "--projectDir",
          cwd(stageAppDir),
          "--win",
          "--x64",
          "--publish",
          "never",
        ],
        source,
      ),
    registerPackagedElectronProbe: (probe) => {
      const executable = probe.command;
      if (
        !isInside(executable, output) ||
        path.basename(path.dirname(executable)) !== "win-unpacked" ||
        path.basename(executable) !== identity.productName + ".exe" ||
        probe.args.length !== 6 ||
        probe.args[0] !== "--no-global-search-paths" ||
        probe.args[1] !== "--input-type=module" ||
        probe.args[2] !== "--eval" ||
        probe.options.env?.ELECTRON_RUN_AS_NODE !== "1"
      )
        throw new Error(
          "Only the captured packaged Electron native-load probe may execute candidate bytes.",
        );
      const stat = NodeFS.lstatSync(executable);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("The packaged Electron probe is not an independent regular file.");
      candidate = {
        executable,
        args: [...probe.args],
        dev: stat.dev,
        ino: stat.ino,
        length: stat.size,
        sha256: sha256(NodeFS.readFileSync(executable)),
      };
    },
    prepare: (original) => {
      if (original._tag !== "StandardCommand" || original.options.shell)
        throw new Error("Isolated build commands may not use shell execution or pipelines.");
      const executable = original.command;
      if (input.isolation.kind === "windows-native-directory") {
        const selected = [
          executable,
          ...original.args.filter((argument) =>
            scriptTools.some((name) => normalize(tools[name]) === normalize(argument)),
          ),
        ];
        for (const tool of selected)
          if (Object.values(tools).some((value) => normalize(value) === normalize(tool)))
            verifyNativeTool(tool);
      }
      if (!Object.values(tools).some((tool) => normalize(tool) === normalize(executable))) {
        if (
          !candidate ||
          executable !== candidate.executable ||
          original.args.length !== candidate.args.length ||
          original.args.some((argument, index) => argument !== candidate!.args[index])
        )
          throw new Error("An unpinned subprocess was requested by the LAN packager.");
        const stat = NodeFS.lstatSync(executable);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.dev !== candidate.dev ||
          stat.ino !== candidate.ino ||
          stat.size !== candidate.length ||
          sha256(NodeFS.readFileSync(executable)) !== candidate.sha256 ||
          original.options.env?.ELECTRON_RUN_AS_NODE !== "1"
        )
          throw new Error("The captured packaged Electron probe changed before execution.");
      }
      const extra: Record<string, string> = {};
      for (const [key, value] of Object.entries(original.options.env ?? {})) {
        if (value === undefined || env[key] === value) continue;
        if (
          (key === "APP_VERSION" && value === lock.applicationVersion) ||
          (key === "T3CODE_LAN_BUILD_POLICY" && isInside(value, input.isolation.inputsRoot)) ||
          (key === "T3CODE_LAN_BUILD_POLICY_SHA256" && value === request.identitySha256) ||
          (key === "NODE_PATH" && value === "") ||
          (key === "ELECTRON_RUN_AS_NODE" && value === "1")
        )
          extra[key] = value;
        else throw new Error("A build subprocess attempted to inherit unapproved configuration.");
      }
      return ChildProcess.make(executable, original.args, {
        ...original.options,
        cwd: cwd(original.options.cwd ?? source),
        env: { ...env, ...extra },
        shell: false,
        extendEnv: false,
      });
    },
  };
  executions.add(value);
  return Object.freeze(value);
}
