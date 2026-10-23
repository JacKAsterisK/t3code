// @effect-diagnostics nodeBuiltinImport:off -- The profile-isolation regression creates only a temporary directory junction; no Electron process is launched.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as NetService from "@t3tools/shared/Net";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { afterAll, vi } from "vite-plus/test";

const {
  identity,
  createClerkBridge,
  clerkStorage,
  exposeClerkBridge,
  protocolPrivileges,
  updater,
  updaterGetter,
  exposeDesktop,
  sendSync,
} = vi.hoisted(() => {
  const identity = {
    appId: "com.example.t3code.lan",
    productName: "T3 Code LAN",
    protocolScheme: "t3code-lan",
    homeDirectoryName: "T3CodeLAN",
    telemetry: "disabled",
    cloudConfiguration: "disabled",
    nativeUpdater: "disabled",
    protocolVersion: 2,
    applicationVersion: "0.1.2",
    sourceCommit: "a".repeat(40),
  };
  vi.stubGlobal("__T3_LAN_BUILD_IDENTITY__", identity);
  const updater = {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };
  return {
    identity,
    createClerkBridge: vi.fn(),
    clerkStorage: vi.fn(),
    exposeClerkBridge: vi.fn(),
    protocolPrivileges: vi.fn(),
    exposeDesktop: vi.fn(),
    sendSync: vi.fn(),
    updater,
    updaterGetter: vi.fn(() => updater),
  };
});

vi.mock("@clerk/electron", () => ({ createClerkBridge }));
vi.mock("@clerk/electron/storage", () => ({ storage: clerkStorage }));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge }));
vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return updaterGetter();
  },
}));
vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: protocolPrivileges },
  net: {},
  contextBridge: { exposeInMainWorld: exposeDesktop },
  ipcRenderer: { sendSync },
  webFrame: {},
  webUtils: {},
}));

import * as Distribution from "@t3tools/shared/distribution";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopStatePaths from "./DesktopStatePaths.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { makeHarness } from "../updates/updatesTestHarness.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";

afterAll(() => vi.unstubAllGlobals());

it.effect(
  "refuses automatic official SSH runtime installation and pairing before transport or password prompts",
  () =>
    Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, {
          ensureEnvironment: () => Effect.die("LAN reached an upstream SSH installer"),
          disconnectEnvironment: () => Effect.void,
        }),
        Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
          request: () => Effect.die("LAN requested new SSH credentials"),
          resolve: () => Effect.void,
        }),
      );
      const result = yield* Effect.result(
        service.ensureEnvironment({
          alias: "approved-native-host",
          hostname: "192.0.2.1",
          username: null,
          port: null,
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure._tag, "SshLaunchError");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("LAN SSH guard attempted HTTP")),
          ),
        ),
      ),
    ),
);

const expectedHome = "C:\\LANFixture\\Local\\T3CodeLAN\\data";
const layerEnvironment = (env: Record<string, string> = {}) =>
  DesktopEnvironment.layer({
    dirname: "C:\\build\\apps\\desktop\\dist-electron",
    homeDirectory: "C:\\Users\\fixture",
    platform: "win32",
    processArch: "x64",
    appVersion: "0.1.2",
    appPath: "C:\\install\\resources\\app.asar",
    resourcesPath: "C:\\install\\resources",
    isPackaged: true,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePath.layerWin32,
        DesktopConfig.layerTest({ LOCALAPPDATA: "C:\\LANFixture\\Local", ...env }),
      ),
    ),
  );

it.effect(
  "resolves the same independent LAN home and identity before and after desktop initialization",
  () =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const path = yield* Path.Path;
      assert.isTrue(Distribution.isLanDistribution);
      const earlyHome = DesktopStatePaths.resolveDesktopBaseDir({
        homeDirectory: environment.homeDirectory,
        platform: "win32",
        localAppData: "C:\\LANFixture\\Local",
        joinPath: path.join,
        t3Home: Option.none(),
      });
      assert.equal(earlyHome, expectedHome);
      assert.equal(environment.baseDir, earlyHome);
      assert.equal(environment.stateDir, `${expectedHome}\\userdata`);
      assert.equal(environment.appUserModelId, identity.appId);
      assert.equal(environment.displayName, identity.productName);
      assert.equal(
        DesktopCliShim.launcherPath(environment),
        `${expectedHome}\\bin\\t3code-lan.cmd`,
      );
      assert.notInclude(DesktopCliShim.MARKER, "Written by T3 Code:");
      assert.equal(ElectronProtocol.getDesktopScheme(true), identity.protocolScheme);
      assert.equal(ElectronProtocol.getDesktopScheme(false), identity.protocolScheme);
      yield* Effect.scoped(Layer.build(ElectronProtocol.layerSchemePrivileges));
      assert.deepEqual(
        protocolPrivileges.mock.calls.at(-1)?.[0].map((entry: { scheme: string }) => entry.scheme),
        [identity.protocolScheme],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerEnvironment({ T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.t3tools.t3code" }),
          NodePath.layerWin32,
        ),
      ),
    ),
);

it.effect("rejects an ambient official home before a desktop profile can be initialized", () =>
  Effect.gen(function* () {
    const result = yield* DesktopEnvironment.DesktopEnvironment.pipe(
      Effect.provide(layerEnvironment({ T3CODE_HOME: "C:\\Users\\fixture\\.t3" })),
      Effect.exit,
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect(
  "does not parse disabled telemetry/update settings or accept a renderer/backend override",
  () =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      assert.isTrue(Option.isNone(environment.devServerUrl));
      assert.isTrue(Option.isNone(environment.devRemoteT3ServerEntryPath));
      assert.isTrue(Option.isNone(environment.otlpHeaders));
      assert.isTrue(Option.isNone(environment.otlpTracesUrl));
    }).pipe(
      Effect.provide(
        layerEnvironment({
          T3CODE_OTLP_HEADERS: "malformed-header-fixture",
          T3CODE_OTLP_PROTOCOL: "invalid",
          T3CODE_OTLP_EXPORT_INTERVAL_MS: "invalid",
          T3CODE_DISABLE_AUTO_UPDATE: "invalid",
          T3CODE_DESKTOP_MOCK_UPDATES: "invalid",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "invalid",
          VITE_DEV_SERVER_URL: "invalid",
          T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: "C:\\unapproved\\server.mjs",
        }),
      ),
    ),
);

it.effect("does not read or import official profile encryption keys or local storage", () =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const profile = yield* DesktopUserData.resolveUserDataPath(environment);
    assert.equal(profile, "C:\\LANFixture\\Local\\T3CodeLAN\\electron-profile");
    const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
    yield* legacy.load(profile);
    assert.isTrue(Option.isNone(yield* legacy.take));
    yield* legacy.complete;
  }).pipe(
    Effect.provide(
      DesktopLegacyLocalStorage.layer.pipe(
        Layer.provideMerge(layerEnvironment()),
        Layer.provideMerge(NodePath.layerWin32),
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: () => Effect.die("LAN startup attempted to inspect an official profile"),
            readFileString: () => Effect.die("LAN startup attempted to read official credentials"),
            writeFileString: () => Effect.die("LAN startup attempted to import official storage"),
          }),
        ),
      ),
    ),
  ),
);

it.effect("refuses a preexisting profile junction without writing through it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lan-profile-junction-" });
    const parent = path.join(root, "T3CodeLAN");
    const target = path.join(root, "existing-profile-fixture");
    yield* fs.makeDirectory(parent);
    yield* fs.makeDirectory(target);
    yield* fs.writeFileString(path.join(target, "Local State"), "preserved profile fixture");
    yield* Effect.promise(() =>
      NodeFSP.symlink(target, path.join(parent, "electron-profile"), "junction"),
    );
    const result = yield* Effect.result(
      DesktopUserData.resolveUserDataPath({
        appDataDirectory: root,
        isDevelopment: false,
        platform: "win32",
        baseDir: path.join(parent, "data"),
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(
      yield* fs.readFileString(path.join(target, "Local State")),
      "preserved profile fixture",
    );
    assert.deepEqual(yield* fs.readDirectory(target), ["Local State"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "keeps native single-instance admission while skipping Clerk bridge and storage initialization",
  () => {
    const events: string[] = [];
    const electronApp = {
      setPath: (name: string, value: string) =>
        Effect.sync(() => {
          events.push(`${name}:${value}`);
        }),
      requestSingleInstanceLock: Effect.sync(() => {
        events.push("single-instance");
        return true;
      }),
      on: () => Effect.void,
    } as unknown as ElectronApp.ElectronApp["Service"];
    return Effect.gen(function* () {
      yield* DesktopClerk.DesktopClerk;
      assert.deepEqual(events, [
        "userData:C:\\LANFixture\\Local\\T3CodeLAN\\electron-profile",
        "single-instance",
      ]);
      assert.equal(createClerkBridge.mock.calls.length, 0);
      assert.equal(clerkStorage.mock.calls.length, 0);
      assert.isUndefined(DesktopClerk.desktopClerkFrontendApiHostname);
    }).pipe(
      Effect.provide(
        DesktopClerk.layer.pipe(
          Layer.provideMerge(layerEnvironment()),
          Layer.provide(NodePath.layerWin32),
          Layer.provide(Layer.succeed(ElectronApp.ElectronApp, electronApp)),
          Layer.provide(
            Layer.succeed(
              ElectronShell.ElectronShell,
              {} as ElectronShell.ElectronShell["Service"],
            ),
          ),
          Layer.provide(
            FileSystem.layerNoop({ exists: () => Effect.die("Unexpected LAN profile access") }),
          ),
        ),
      ),
      Effect.scoped,
    );
  },
);

it("does not expose the Clerk bridge or migrate legacy local storage in the native preload", async () => {
  await import("../preload.ts");
  assert.equal(exposeClerkBridge.mock.calls.length, 0);
  assert.equal(sendSync.mock.calls.length, 0);
  assert.equal(exposeDesktop.mock.calls.length, 1);
});

it.effect(
  "permits public fork checks while ignoring mock feeds and refusing direct native updater actions",
  () => {
    const harness = makeHarness({
      platform: "win32",
      env: {
        LOCALAPPDATA: "C:\\LANFixture\\Local",
        T3CODE_HOME: expectedHome,
        T3CODE_DISABLE_AUTO_UPDATE: "false",
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
      },
    });
    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      assert.equal((yield* updates.getState).status, "idle");
      assert.isTrue((yield* updates.check("manual")).checked);
      assert.isFalse((yield* updates.download).accepted);
      assert.isFalse((yield* updates.install).accepted);
      assert.isFalse((yield* updates.installPrepared("0.1.3")).accepted);
      assert.lengthOf(harness.feedUrls(), 0);
      assert.equal(harness.checkCount(), 0);
      assert.equal(harness.downloadCount(), 0);
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal((yield* Effect.result(ElectronUpdater.make.checkForUpdates))._tag, "Failure");
      assert.equal((yield* Effect.result(ElectronUpdater.make.downloadUpdate))._tag, "Failure");
      assert.equal(
        (yield* Effect.result(
          ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false }),
        ))._tag,
        "Failure",
      );
      yield* Effect.all([
        ElectronUpdater.make.setFeedURL({ provider: "generic", url: "https://unapproved.invalid" }),
        ElectronUpdater.make.setAutoDownload(true),
        ElectronUpdater.make.setAutoInstallOnAppQuit(true),
        ElectronUpdater.make.setChannel("nightly"),
        ElectronUpdater.make.setAllowPrerelease(true),
        ElectronUpdater.make.setAllowDowngrade(true),
        ElectronUpdater.make.setFullChangelog(true),
        ElectronUpdater.make.setDisableDifferentialDownload(false),
        ElectronUpdater.make.on("error", () => undefined),
      ]);
      assert.isFalse(yield* ElectronUpdater.make.allowDowngrade);
      assert.equal(updaterGetter.mock.calls.length, 0);
      assert.equal(
        updater.checkForUpdates.mock.calls.length +
          updater.downloadUpdate.mock.calls.length +
          updater.quitAndInstall.mock.calls.length,
        0,
      );
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  },
);

it.effect("surfaces a compatible fork release without downloading or stopping native tasks", () => {
  const channel = {
    schemaVersion: 1,
    repository: "JacKAsterisK/t3code",
    releaseTag: "lan-v1.0.0",
    distributionVersion: "1.0.0",
    applicationVersion: "0.1.3",
    identity: { ...identity, applicationVersion: "0.1.3", sourceCommit: "b".repeat(40) },
    artifact: { name: "T3CodeLAN-1.0.0-windows-x64.zip", sha256: "c".repeat(64), byteLength: 100 },
  };
  const channelBytes = new TextEncoder().encode(JSON.stringify(channel));
  const requests: string[] = [];
  return Effect.gen(function* () {
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", channelBytes));
    const channelHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const releases = "https://github.com/JacKAsterisK/t3code/releases";
    const api = "https://api.github.com/repos/JacKAsterisK/t3code";
    const release = {
      tag_name: channel.releaseTag,
      html_url: `${releases}/tag/${channel.releaseTag}`,
      draft: false,
      prerelease: false,
      assets: [
        {
          id: 1,
          name: "t3code-lan-channel.json",
          size: channelBytes.length,
          digest: `sha256:${channelHash}`,
        },
        {
          id: 2,
          name: channel.artifact.name,
          size: 100,
          digest: `sha256:${channel.artifact.sha256}`,
        },
      ].map((asset) => ({
        ...asset,
        browser_download_url: `${releases}/download/${channel.releaseTag}/${asset.name}`,
      })),
    };
    const harness = makeHarness({
      appVersion: "0.1.2",
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\LANFixture\\Local", T3CODE_HOME: expectedHome },
      stopBackend: Effect.die("Fork discovery attempted to stop native tasks"),
      httpClient: HttpClient.make((request) => {
        requests.push(request.url);
        assert.isUndefined(request.headers.authorization);
        const response =
          request.url === `${api}/releases/latest`
            ? new Response(JSON.stringify(release))
            : request.url === `${api}/releases/assets/1`
              ? new Response(channelBytes)
              : undefined;
        if (!response) return Effect.die("Unexpected fork update network request");
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    });
    yield* Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      assert.deepEqual(requests, []);
      assert.isTrue((yield* updates.check("manual")).checked);
      const state = yield* updates.getState;
      assert.equal(state.status, "available");
      assert.equal(state.availableVersion, "0.1.3");
      assert.deepEqual(state.forkRelease, {
        releaseUrl: `${releases}/tag/lan-v1.0.0`,
        distributionVersion: "1.0.0",
        sourceCommit: "b".repeat(40),
      });
      assert.isFalse((yield* updates.download).accepted);
      assert.isFalse((yield* updates.install).accepted);
      assert.isFalse((yield* updates.installPrepared("0.1.3")).accepted);
      yield* updates.setChannel("nightly");
      assert.equal((yield* updates.getState).channel, "latest");
      assert.deepEqual(requests, [`${api}/releases/latest`, `${api}/releases/assets/1`]);
      assert.equal(harness.downloadCount(), 0);
      assert.equal(harness.quitAndInstalls(), 0);
      assert.deepEqual(harness.installSteps, []);
      assert.deepEqual(harness.feedUrls(), []);
      assert.equal(harness.checkCount(), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});

it.effect(
  "keeps desktop telemetry exporters disabled before consulting ambient or persisted endpoints",
  () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lan-observability-" });
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(layerEnvironment()),
      );
      const settingsPath = path.join(directory, "settings.json");
      yield* fs.writeFileString(
        settingsPath,
        '{"observability":{"otlpLogsUrl":"https://persisted.invalid/v1/logs","otlpTracesUrl":"https://persisted.invalid/v1/traces"}}',
      );
      const isolatedEnvironment = {
        ...environment,
        logDir: directory,
        path,
        serverSettingsPath: settingsPath,
        otlpLogsUrl: Option.some("https://explicit.invalid/v1/logs"),
        otlpTracesUrl: Option.some("https://explicit.invalid/v1/traces"),
      };
      yield* Effect.scoped(
        Effect.logInfo("LAN desktop log remains local").pipe(
          Effect.withSpan("lan-local-test"),
          Effect.provide(
            DesktopObservability.layer.pipe(
              Layer.provide(
                Layer.succeed(DesktopEnvironment.DesktopEnvironment, isolatedEnvironment),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(requests, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push(request.url);
              return Effect.die("Compiled LAN policy permitted an external telemetry export");
            }),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                OTEL_SDK_DISABLED: "false",
                OTEL_EXPORTER_OTLP_ENDPOINT: "https://ambient.invalid",
              },
            }),
          ),
        ),
      ),
      Effect.scoped,
    );
  },
);
