// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Public synthetic inventories exercise exact execution selection; no tool or lifecycle script is started.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { ChildProcess } from "effect/process";
import { vi } from "vite-plus/test";
import { sha256 } from "./hub-distribution.ts";
import type { WindowsSandboxContext } from "./windows-sandbox-context.ts";
import type { WindowsNativeContext } from "./windows-native-context.ts";

// Real capability issuance is covered by the context boundary's refusal tests.
// Command selection uses an explicit fixture issuer instead of enabling host execution.
vi.mock("./windows-sandbox-context.ts", () => ({
  assertWindowsSandboxContext: (value: unknown) => {
    if (typeof value !== "object" || value === null || !("fixture" in value))
      throw new Error("No verified guest.");
  },
}));
vi.mock("./windows-native-context.ts", () => ({
  assertWindowsNativeContext: (value: unknown) => {
    if (typeof value !== "object" || value === null || !("fixture" in value))
      throw new Error("No verified native directory.");
  },
}));

import {
  asChildProcess,
  assertWindowsBuildExecution,
  createWindowsBuildExecution,
  type WindowsBuildExecutionRequest,
} from "./windows-build-execution.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fixture(outputRoot = "C:\\T3LAN\\Output", visualStudioVersion = "17.14.1.0") {
  const msvcVersion = visualStudioVersion.startsWith("18.") ? "14.51.36231" : "14.44.35207";
  const msvcRoot = `vs/VC/Tools/MSVC/${msvcVersion}`;
  const sdkVersion = "10.0.26100.0";
  const tools = {
    node: "node/node.exe",
    pnpm: "pnpm/pnpm.exe",
    cargo: "rust/cargo.exe",
    rustc: "rust/rustc.exe",
    cl: `${msvcRoot}/bin/Hostx64/x64/cl.exe`,
    link: `${msvcRoot}/bin/Hostx64/x64/link.exe`,
    lib: `${msvcRoot}/bin/Hostx64/x64/lib.exe`,
    rc: `sdk/bin/${sdkVersion}/x64/rc.exe`,
    mt: `sdk/bin/${sdkVersion}/x64/mt.exe`,
    msbuild: "vs/MSBuild/Current/Bin/MSBuild.exe",
    python: "python/python.exe",
    cmd: "windows/cmd.exe",
    powershell: "powershell/7/powershell.exe",
    viteCli: "javascript/vite/bin/vp",
    builderCli: "javascript/builder/cli.js",
    nodeGyp: "javascript/node-gyp/bin/node-gyp.js",
  };
  const directories = {
    visualStudioRoot: "vs",
    msvcRoot,
    windowsSdkRoot: "sdk",
    nodeHeaders: "headers",
    pnpmStore: "pnpm-store",
    cargoHome: "cargo-cache",
    electronCache: "electron-cache",
    builderCache: "builder-cache",
    include: [`${msvcRoot}/include`, `sdk/include/${sdkVersion}/um`],
    libraries: [`${msvcRoot}/lib/x64`, `sdk/lib/${sdkVersion}/um/x64`],
    path: [`${msvcRoot}/bin/Hostx64/x64`, `sdk/bin/${sdkVersion}/x64`],
  };
  const fileNames = [
    `vs/MSBuild/Microsoft/VC/${visualStudioVersion.startsWith("18.") ? "v180" : "v170"}/Microsoft.Cpp.Default.props`,
    ...new Set([
      ...Object.values(tools),
      ...Object.values(directories).flatMap((value) =>
        typeof value === "string"
          ? [value + "/fixture"]
          : value.map((directory) => directory + "/fixture"),
      ),
    ]),
  ];
  const nodeHeaderFiles = {
    nodeVersionH: new TextEncoder().encode(
      "#define NODE_MAJOR_VERSION 26\n#define NODE_MINOR_VERSION 12\n#define NODE_PATCH_VERSION 1\n",
    ),
    configGypi: new TextEncoder().encode(
      "# generated Node config\n{'variables': {'target_arch': 'x64'}}\n",
    ),
  };
  const files = [
    ...fileNames.map((path) => ({
      path,
      length: new TextEncoder().encode("synthetic:" + path).length,
      sha256: sha256("synthetic:" + path),
    })),
    {
      path: "headers/include/node/node_version.h",
      length: nodeHeaderFiles.nodeVersionH.length,
      sha256: sha256(nodeHeaderFiles.nodeVersionH),
    },
    {
      path: "headers/include/node/config.gypi",
      length: nodeHeaderFiles.configGypi.length,
      sha256: sha256(nodeHeaderFiles.configGypi),
    },
  ];
  const toolchainFiles = new Map(
    files.map((file) => [file.path, { length: file.length, sha256: file.sha256 }]),
  );
  const pin = (name: keyof typeof tools) => ({
    version: "1.2.3",
    sha256: toolchainFiles.get(tools[name])!.sha256,
  });
  const identity = {
    appId: "com.example.lan-fixture",
    productName: "LAN Fixture",
    protocolScheme: "lan-fixture",
    homeDirectoryName: "T3CodeLAN",
    cloudConfiguration: "disabled",
    telemetry: "disabled",
    nativeUpdater: "disabled",
    protocolVersion: 2,
    applicationVersion: "0.1.2",
    sourceCommit: "a".repeat(40),
  };
  const lock = {
    schemaVersion: 1,
    forkCommit: identity.sourceCommit,
    upstreamCommit: "b".repeat(40),
    distributionVersion: "1.0.0",
    applicationVersion: "0.1.2",
    files: {},
    tools: {
      node: { ...pin("node"), version: "26.12.1" },
      pnpm: { ...pin("pnpm"), version: "12.14.0" },
      rust: pin("rustc"),
      msvc: { ...pin("cl"), version: msvcVersion },
      windowsSdk: { ...pin("rc"), version: sdkVersion },
      nsis: pin("rc"),
    },
    wslRuntime: null,
    cloudConfiguration: "disabled",
    telemetry: "disabled",
    nativeUpdater: "disabled",
  };
  const lockBytes = encode(lock),
    identityBytes = encode(identity),
    toolchainManifestBytes = encode({ schemaVersion: 1, files });
  const request = {
    schemaVersion: 1,
    buildLockSha256: sha256(lockBytes),
    identitySha256: sha256(identityBytes),
    toolchainManifestSha256: sha256(toolchainManifestBytes),
    sourceDateEpoch: 1700000000,
    tools,
    directories,
    windowsSdkVersion: sdkVersion,
    visualStudioVersion,
  } satisfies WindowsBuildExecutionRequest;
  const isolation = {
    fixture: true,
    kind: "windows-sandbox",
    outputRoot,
    sourceRoot: NodePath.win32.join(outputRoot, "work/source"),
    toolchainRoot: "C:\\T3LAN\\Tools",
    inputsRoot: "C:\\T3LAN\\Inputs",
    mappedSourceRoot: "C:\\T3LAN\\Source",
    sourceCommit: identity.sourceCommit,
    snapshotSha256: "c".repeat(64),
    preparationRequestSha256: "d".repeat(64),
  } as unknown as WindowsSandboxContext;
  const requestBytes = encode(request);
  let verifications = 0;
  const input = {
    requestBytes,
    approvedRequestSha256: sha256(requestBytes),
    lockBytes,
    identityBytes,
    nodeHeaderFiles,
    toolchainManifestBytes,
    toolchainFiles,
    isolation,
    verifyUnchanged: async () => {
      verifications++;
    },
  };
  const create = (change?: (selection: typeof request) => void) => {
    const changed = structuredClone(request);
    change?.(changed);
    const requestBytes = encode(changed);
    return createWindowsBuildExecution({
      ...input,
      requestBytes,
      approvedRequestSha256: sha256(requestBytes),
    });
  };
  return {
    request,
    input,
    create,
    isolation,
    tools,
    get verifications() {
      return verifications;
    },
  };
}

it.live("runs release prepare without Git metadata or a Git executable", () =>
  Effect.promise(async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-prepare-"));
    const cleanup = async () => {
      if (!NodePath.resolve(directory).startsWith(NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep))
        throw new Error("Release prepare fixture escaped its captured temporary root.");
      await NodeFSP.rm(directory, { recursive: true, force: true });
    };
    try {
      await NodeFSP.writeFile(NodePath.join(directory, "package.json"), '{"private":true}');
      const command = fixture().create().workspaceInstall();
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")), "config", "--no-agent"],
            {
              cwd: directory,
              env: {
                ...command.env,
                PATH: "",
                HOME: directory,
                USERPROFILE: directory,
                APPDATA: directory,
                LOCALAPPDATA: directory,
                TEMP: directory,
                TMP: directory,
                npm_lifecycle_event: "prepare",
              },
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (bytes: Buffer) => (output += bytes.toString()));
          child.stderr.on("data", (bytes: Buffer) => (output += bytes.toString()));
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, output }));
        },
      );
      assert.equal(result.code, 0, result.output);
      assert.include(result.output, "git hooks disabled");
      assert.deepEqual(await NodeFSP.readdir(directory), ["package.json"]);
    } finally {
      await cleanup();
    }
  }),
);

it("selects exact native pnpm and reviewed caches for offline frozen workspace and production installs", () => {
  const test = fixture(),
    execution = test.create();
  for (const command of [
    execution.workspaceInstall(),
    execution.stageInstall("C:\\T3LAN\\Output\\stage\\app"),
  ]) {
    assert.equal(command.executable, "C:\\T3LAN\\Tools\\pnpm\\pnpm.exe");
    assert.include(command.args, "--offline");
    assert.include(command.args, "--frozen-lockfile");
    assert.include(command.args, "--config.manage-package-manager-versions=false");
    assert.include(
      command.args,
      "--config.cache-dir=C:\\T3LAN\\Output\\caches\\pnpmStore\\metadata-cache",
    );
    const child = asChildProcess(command);
    assert.equal(execution.prepare(child).options.extendEnv, false);
    assert.equal(child.options.shell, false);
    assert.equal(child.options.extendEnv, false);
    assert.isUndefined(command.env.GITHUB_TOKEN);
    assert.isUndefined(command.env.NODE_OPTIONS);
    assert.isUndefined(command.env.HTTPS_PROXY);
    assert.equal(command.env.ComSpec, "C:\\T3LAN\\Tools\\windows\\cmd.exe");
    assert.equal(command.env.npm_config_script_shell, command.env.ComSpec);
    assert.equal(command.env.UseEnv, "true");
    assert.equal(command.env.DisableRegistryUse, "true");
    assert.equal(command.env.VsInstallRoot, "C:\\T3LAN\\Tools\\vs");
    assert.equal(command.env.VCToolsVersion, "14.44.35207");
    assert.equal(command.env.VCTargetsPath, "C:\\T3LAN\\Tools\\vs\\MSBuild\\Microsoft\\VC\\v170\\");
    assert.equal(command.env.MSBuildExtensionsPath, "C:\\T3LAN\\Tools\\vs\\MSBuild");
    assert.equal(command.env.VCInstallDir_170, "C:\\T3LAN\\Tools\\vs\\VC\\");
    assert.equal(
      command.env.VCToolsInstallDir_170,
      "C:\\T3LAN\\Tools\\vs\\VC\\Tools\\MSVC\\14.44.35207\\",
    );
    assert.equal(command.env.WindowsSdkDir_10, "C:\\T3LAN\\Tools\\sdk\\");
    assert.equal(command.env.UniversalCRTSdkDir_10, "C:\\T3LAN\\Tools\\sdk\\");
    for (const name of [
      "WindowsTargetPlatformVersion",
      "TargetPlatformVersion",
      "UCRTVersion",
      "TargetUniversalCRTVersion",
    ])
      assert.equal(command.env[name], "10.0.26100.0");
  }
  assert.notInclude(execution.workspaceInstall().args, "--prod");
  assert.deepEqual(execution.workspaceInstall().args.slice(0, 12), [
    "install",
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
  ]);
  assert.notInclude(execution.stageInstall("C:\\T3LAN\\Output\\stage").args, "--filter");
  assert.include(execution.workspaceInstall().args, "--ignore-pnpmfile");
  assert.equal(execution.workspaceInstall().env.npm_config_ignore_pnpmfile, "true");
  assert.include(execution.stageInstall("C:\\T3LAN\\Output\\stage").args, "--prod");
  assert.include(execution.stageInstall("C:\\T3LAN\\Output\\stage").args, "--ignore-pnpmfile");
  assert.equal(
    execution.stageInstall("C:\\T3LAN\\Output\\stage").env.npm_config_ignore_pnpmfile,
    "true",
  );
  assert.throws(() => execution.stageInstall("C:\\Foreign\\stage"), /isolated output/u);
});

it("uses the same pinned commands for a separately verified native backend without claiming Sandbox isolation", () => {
  const test = fixture();
  const native = {
    ...test.isolation,
    kind: "windows-native-directory",
    osIsolation: false,
    networkIsolation: false,
  } as unknown as WindowsNativeContext;
  const execution = createWindowsBuildExecution({ ...test.input, isolation: native });
  assertWindowsBuildExecution(execution);
  assert.equal(execution.isolation.kind, "windows-native-directory");
  assert.equal(execution.workspaceInstall().executable, "C:\\T3LAN\\Tools\\pnpm\\pnpm.exe");
  assert.include(execution.workspaceInstall().args, "--offline");
  assert.equal(asChildProcess(execution.resourceMonitor()).options.extendEnv, false);
  assert.throws(
    () => execution.prepare(ChildProcess.make("C:\\Windows\\System32\\cmd.exe", [])),
    /unpinned/u,
  );
  assert.throws(
    () =>
      createWindowsBuildExecution({
        ...test.input,
        isolation: { kind: "windows-native-directory" } as WindowsNativeContext,
      }),
    /verified native/u,
  );
});

it("requires a reviewed PowerShell executable and exposes its selected directory for packaging", () => {
  const test = fixture(),
    execution = test.create();
  for (const command of [
    execution.workspaceInstall(),
    execution.stageInstall("C:\\T3LAN\\Output\\stage"),
    execution.builder("C:\\T3LAN\\Output\\stage"),
  ]) {
    assert.equal(command.env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
    assert.equal(command.env.POWERSHELL_TELEMETRY_OPTOUT, "1");
    assert.equal(command.env.DOTNET_CLI_TELEMETRY_OPTOUT, "1");
    assert.equal(command.env.PSModulePath, "C:\\T3LAN\\Tools\\powershell\\7\\Modules");
    assert.equal(
      command.env.PSModuleAnalysisCachePath,
      "C:\\T3LAN\\Output\\home\\local\\PowerShell-ModuleAnalysisCache",
    );
    assert.equal(command.env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE, "1");
    assert.equal(command.env.DOTNET_MULTILEVEL_LOOKUP, "0");
  }
  assert.include(
    execution.builder("C:\\T3LAN\\Output\\stage").env.PATH?.split(";") ?? [],
    "C:\\T3LAN\\Tools\\powershell\\7",
  );
  assert.notInclude(
    execution.env.PATH?.split(";") ?? [],
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  );
  assert.throws(() =>
    test.create((request) => {
      Reflect.deleteProperty(request.tools, "powershell");
    }),
  );
  assert.throws(
    () =>
      test.create((request) => {
        request.tools.powershell = "powershell/unreviewed/powershell.exe";
      }),
    /absent from the reviewed closure/u,
  );
  assert.throws(
    () =>
      test.create((request) => {
        request.tools.powershell = request.tools.cmd;
      }),
    /explicit executable names/u,
  );
});

it.effect(
  "rechecks the selected native executable bytes immediately before preparing a subprocess",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lan-native-tool-" });
      const test = fixture();
      const native = {
        ...test.isolation,
        kind: "windows-native-directory",
        toolchainRoot: root,
        osIsolation: false,
        networkIsolation: false,
      } as unknown as WindowsNativeContext;
      const executable = NodePath.join(root, "pnpm", "pnpm.exe");
      yield* fs.makeDirectory(NodePath.dirname(executable));
      yield* fs.writeFileString(executable, "synthetic:pnpm/pnpm.exe");
      const execution = createWindowsBuildExecution({ ...test.input, isolation: native });
      const command = asChildProcess(execution.workspaceInstall());
      assert.equal(execution.prepare(command).command, executable);
      yield* fs.writeFileString(executable, "synthetic:pnpm/pnpm.exf");
      assert.throws(() => execution.prepare(command), /tool changed before execution/u);
      const powershell = NodePath.join(root, "powershell", "7", "powershell.exe");
      yield* fs.makeDirectory(NodePath.dirname(powershell), { recursive: true });
      yield* fs.writeFileString(powershell, "synthetic:powershell/7/powershell.exe");
      const powershellCommand = ChildProcess.make(
        powershell,
        ["-NoProfile", "-Command", "fixture"],
        {
          cwd: native.sourceRoot,
        },
      );
      assert.equal(execution.prepare(powershellCommand).command, powershell);
      yield* fs.writeFileString(powershell, "synthetic:powershell/7/powershell.exf");
      assert.throws(() => execution.prepare(powershellCommand), /tool changed before execution/u);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("compiles every surface with explicit reviewed Node and bundler entry points instead of task-shell discovery", () => {
  const test = fixture(),
    execution = test.create();
  const policy = {
    T3CODE_LAN_BUILD_POLICY: "C:\\T3LAN\\Inputs\\identity.json",
    T3CODE_LAN_BUILD_POLICY_SHA256: test.request.identitySha256,
  };
  const commands = execution.compile("0.1.2", policy);
  assert.deepEqual(
    commands.map((command) => command.executable),
    Array(4).fill(execution.node),
  );
  assert.deepEqual(
    commands.map((command) => command.cwd),
    [
      "C:\\T3LAN\\Output\\work\\source\\apps\\web",
      "C:\\T3LAN\\Output\\work\\source\\apps\\server",
      "C:\\T3LAN\\Output\\work\\source\\apps\\desktop",
      "C:\\T3LAN\\Output\\work\\source\\apps\\desktop",
    ],
  );
  assert.deepEqual(
    commands.map((command) => command.args.at(-1)),
    [
      "build",
      "pack",
      "C:\\T3LAN\\Output\\work\\source\\apps\\desktop\\scripts\\build-preview-annotation-css.mjs",
      "pack",
    ],
  );
  for (const command of commands)
    assert.equal(execution.prepare(asChildProcess(command)).options.extendEnv, false);
  assert.throws(() => execution.compile("9.9.9", policy));
  assert.throws(() =>
    execution.compile("0.1.2", { ...policy, T3CODE_LAN_BUILD_POLICY_SHA256: "e".repeat(64) }),
  );
  assert.throws(() => execution.compile("0.1.2", { ...policy, NODE_OPTIONS: "--require foreign" }));
});

it("binds Cargo, Rust, MSVC, SDK, Python and builder to reviewed paths without ambient fallback or cached resource-monitor reuse", () => {
  const execution = fixture().create(),
    cargo = execution.resourceMonitor(),
    builder = execution.builder("C:\\T3LAN\\Output\\stage\\app");
  assert.equal(cargo.executable, "C:\\T3LAN\\Tools\\rust\\cargo.exe");
  for (const flag of ["--frozen", "--offline", "--locked"]) assert.include(cargo.args, flag);
  assert.equal(cargo.env.RUSTC, "C:\\T3LAN\\Tools\\rust\\rustc.exe");
  assert.equal(
    cargo.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER,
    "C:\\T3LAN\\Tools\\vs\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\link.exe",
  );
  assert.equal(cargo.env.NODE_GYP_FORCE_PYTHON, "C:\\T3LAN\\Tools\\python\\python.exe");
  assert.equal(cargo.env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(cargo.env.GYP_MSVS_OVERRIDE_PATH, "C:\\T3LAN\\Tools\\vs");
  assert.equal(cargo.env.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR, "false");
  assert.equal(
    cargo.env.INCLUDE,
    "C:\\T3LAN\\Tools\\vs\\VC\\Tools\\MSVC\\14.44.35207\\include;C:\\T3LAN\\Tools\\sdk\\include\\10.0.26100.0\\um",
  );
  assert.equal(builder.executable, execution.node);
  assert.equal(builder.args[0], "C:\\T3LAN\\Tools\\javascript\\builder\\cli.js");
  assert.deepEqual(builder.args.slice(-2), ["--publish", "never"]);
});

it("remaps private Rust source and copied registry roots through encoded arguments without inheriting ambient flags", () => {
  vi.stubEnv("RUSTFLAGS", "--cfg foreign_rust_flag");
  vi.stubEnv("CARGO_ENCODED_RUSTFLAGS", "--cfg\x1fforeign_encoded_flag");
  try {
    for (const outputRoot of ["C:\\First Build\\Output", "C:\\Second Build\\Output"]) {
      const execution = fixture(outputRoot).create(),
        command = execution.resourceMonitor();
      assert.isUndefined(command.env.RUSTFLAGS);
      assert.deepEqual(command.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f"), [
        "-C",
        "link-arg=/Brepro",
        `--remap-path-prefix=${outputRoot}=C:\\T3LanBuild`,
      ]);
      assert.equal(asChildProcess(command).options.extendEnv, false);
      for (const name of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"]) {
        assert.throws(() =>
          execution.prepare(
            ChildProcess.make(command.executable, command.args, {
              cwd: command.cwd,
              env: { [name]: "--cfg foreign_flag" },
            }),
          ),
        );
      }
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects forged capabilities, changed pins, incomplete closures, traversal and bootstrap shims", () => {
  const test = fixture();
  assert.throws(() => assertWindowsBuildExecution({}));
  assert.throws(() =>
    createWindowsBuildExecution({ ...test.input, isolation: {} as WindowsSandboxContext }),
  );
  assert.throws(() =>
    createWindowsBuildExecution({ ...test.input, approvedRequestSha256: "f".repeat(64) }),
  );
  assert.throws(() => createWindowsBuildExecution({ ...test.input, identityBytes: encode({}) }));
  const missing = new Map(test.input.toolchainFiles);
  missing.delete(test.tools.cargo);
  assert.throws(() => createWindowsBuildExecution({ ...test.input, toolchainFiles: missing }));
  assert.throws(() =>
    test.create((request) => {
      request.tools.node = "../foreign.exe";
    }),
  );
  assert.throws(() =>
    test.create((request) => {
      request.tools.pnpm = request.tools.node;
    }),
  );
  assert.throws(() =>
    test.create((request) => {
      request.directories.include = ["not-present"];
    }),
  );
});

it("binds Visual Studio's explicit-location discovery version and toolset family without registry fallback", () => {
  const vs2022 = fixture().create();
  assert.equal(vs2022.env.VSCMD_VER, "17.14.1.0");
  assert.equal(vs2022.env.GYP_MSVS_VERSION, "2022");
  assert.equal(vs2022.env.npm_config_msvs_version, "2022");
  assert.equal(
    vs2022.env.MSBUILD_EXE_PATH,
    "C:\\T3LAN\\Tools\\vs\\MSBuild\\Current\\Bin\\MSBuild.exe",
  );
  const vs2026 = fixture("C:\\T3LAN\\Output", "18.10.12224.181").create();
  assert.equal(vs2026.env.VSCMD_VER, "18.10.12224.181");
  assert.equal(vs2026.env.GYP_MSVS_VERSION, "2026");
  assert.include(vs2026.env.VCToolsInstallDir, "14.51.36231");
  assert.throws(
    () =>
      fixture().create((request) => {
        request.visualStudioVersion = "18.10.12224.181";
      }),
    /Visual Studio\/MSVC/u,
  );
  assert.throws(() =>
    fixture().create((request) => {
      request.visualStudioVersion = "16.11.1.0";
    }),
  );
  assert.throws(() =>
    fixture().create((request) => {
      request.windowsSdkVersion = "10.0.22621.0";
    }),
  );
});

it("requires fully hash-bound headers for the exact Node version and x64 configuration", () => {
  const test = fixture();
  const replaceHeaders = (nodeVersionH: Uint8Array, configGypi: Uint8Array) => {
    const toolchainFiles = new Map(test.input.toolchainFiles);
    for (const [name, bytes] of [
      ["node_version.h", nodeVersionH],
      ["config.gypi", configGypi],
    ] as const)
      toolchainFiles.set(`headers/include/node/${name}`, {
        length: bytes.length,
        sha256: sha256(bytes),
      });
    const toolchainManifestBytes = encode({
      schemaVersion: 1,
      files: [...toolchainFiles].map(([path, pin]) => ({ path, ...pin })),
    });
    const requestBytes = encode({
      ...test.request,
      toolchainManifestSha256: sha256(toolchainManifestBytes),
    });
    return () =>
      createWindowsBuildExecution({
        ...test.input,
        requestBytes,
        approvedRequestSha256: sha256(requestBytes),
        toolchainManifestBytes,
        toolchainFiles,
        nodeHeaderFiles: { nodeVersionH, configGypi },
      });
  };
  const headers = test.input.nodeHeaderFiles;
  assert.throws(
    replaceHeaders(
      new TextEncoder().encode(
        "#define NODE_MAJOR_VERSION 25\n#define NODE_MINOR_VERSION 12\n#define NODE_PATCH_VERSION 1\n",
      ),
      headers.configGypi,
    ),
    /exact approved Node version/u,
  );
  assert.throws(
    replaceHeaders(
      headers.nodeVersionH,
      new TextEncoder().encode("{'variables': {'target_arch': 'arm64'}}"),
    ),
    /x64/u,
  );
  assert.throws(
    replaceHeaders(
      new TextEncoder().encode(
        new TextDecoder().decode(headers.nodeVersionH) + "#define NODE_MAJOR_VERSION 26\n",
      ),
      headers.configGypi,
    ),
    /ambiguous/u,
  );
  assert.throws(
    () =>
      createWindowsBuildExecution({
        ...test.input,
        nodeHeaderFiles: { ...headers, configGypi: encode({}) },
      }),
    /inventory/u,
  );
});

it("refuses unknown output programs, shell commands and inherited credential or tool configuration", () => {
  const execution = fixture().create(),
    cwd = execution.isolation.sourceRoot;
  for (const command of [
    ChildProcess.make("C:\\T3LAN\\Output\\unapproved.exe", [], { cwd }),
    ChildProcess.make("node", [], { cwd }),
    ChildProcess.make(execution.node, [], { cwd, shell: true }),
    ChildProcess.make(execution.node, [], { cwd, env: { NODE_OPTIONS: "--require foreign" } }),
    ChildProcess.make(execution.node, [], { cwd, env: { GH_TOKEN: "fixture-credential" } }),
    ChildProcess.make(execution.node, [], { cwd, env: { PATH: "C:\\Foreign" } }),
  ])
    assert.throws(() => execution.prepare(command));
});

it.effect("rechecks isolation and reviewed inputs through the explicit verification barrier", () =>
  Effect.gen(function* () {
    const test = fixture(),
      execution = test.create();
    yield* execution.verify;
    assert.equal(test.verifications, 1);
    const refused = createWindowsBuildExecution({
      ...test.input,
      verifyUnchanged: async () => {
        throw new Error("fixture private detail");
      },
    });
    const error = yield* refused.verify.pipe(Effect.flip);
    assert.equal(error._tag, "WindowsBuildExecutionError");
    assert.notInclude(error.message, "private detail");
  }),
);

it("keeps approved request and lock bytes immutable after admission", () => {
  const test = fixture(),
    execution = test.create();
  assertWindowsBuildExecution(execution);
  assert.isFrozen(execution.request);
  assert.isFrozen(execution.request.tools);
  assert.isFrozen(execution.lock.tools);
  const expected = sha256(execution.lockBytes);
  execution.lockBytes[0] = 0;
  test.input.lockBytes[0] = 0;
  assert.equal(sha256(execution.lockBytes), expected);
});

it.effect(
  "captures only the exact packaged Electron probe and refuses replaced candidate bytes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lan-execution-" });
      const test = fixture(root),
        execution = test.create();
      const directory = NodePath.join(root, "stage", "dist", "win-unpacked"),
        executable = NodePath.join(directory, "LAN Fixture.exe");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(executable, "candidate one");
      const command = ChildProcess.make(
        executable,
        [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
          "fixture probe source",
          "fixture.asar/module",
          "fixture probe directory",
        ],
        { cwd: directory, env: { ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" } },
      );
      assert.throws(() => execution.prepare(command));
      execution.registerPackagedElectronProbe(command);
      assert.equal(execution.prepare(command).command, executable);
      assert.throws(() =>
        execution.prepare(
          ChildProcess.make(executable, ["--different-probe"], {
            cwd: directory,
            env: { ELECTRON_RUN_AS_NODE: "1" },
          }),
        ),
      );
      yield* fs.writeFileString(executable, "candidate two");
      assert.throws(() => execution.prepare(command), /changed/u);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
