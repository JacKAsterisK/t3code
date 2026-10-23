// @effect-diagnostics nodeBuiltinImport:off -- These subprocess fixtures run freshly compiled public policy without application startup or installed data.
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { build } from "vite-plus/pack";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const identity = {
  appId: "com.spiderpunch.t3code.lan",
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

it.live(
  "read-only Hub preparation distinguishes an explicit LAN profile from upstream defaults",
  () =>
    Effect.tryPromise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-readiness-"));
      try {
        const policyPath = NodePath.join(root, "public-identity.json");
        await NodeFSP.writeFile(policyPath, JSON.stringify(identity));
        const repository = NodePath.resolve(import.meta.dirname, "../..");
        const run = async (args: string[]) => {
          const { stdout } = await execFile(
            process.execPath,
            [NodePath.join(repository, "scripts/lan/prepare-hub.ts"), ...args],
            {
              cwd: repository,
              windowsHide: true,
              env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
            },
          );
          return JSON.parse(stdout);
        };
        const upstream = await run([]);
        expect(upstream).toMatchObject({
          target: "upstream-default",
          ready: false,
          buildAuthorized: false,
          distributionAuthorized: false,
          compiledArtifactVerified: false,
        });
        expect(upstream.blockers).toContain(
          "An independent package appId has not been established.",
        );
        const selected = await run(["--lan-policy", policyPath]);
        expect(selected).toMatchObject({
          target: "lan",
          ready: false,
          buildAuthorized: false,
          distributionAuthorized: false,
          compiledArtifactVerified: false,
          identity,
        });
        expect(selected.blockers).not.toContain(
          "An independent package appId has not been established.",
        );
        expect(selected.blockers).toContain(
          "LAN preparation requires --lock and reviewed frozen stage inputs.",
        );
        expect(await NodeFSP.readdir(root)).toEqual(["public-identity.json"]);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
);

it.live(
  "compiled LAN policy defeats ambient cloud/updater/telemetry and official-home overrides",
  () =>
    Effect.tryPromise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-policy-"));
      try {
        const shared = NodePath.resolve(import.meta.dirname, "../../packages/shared/src");
        const entry = NodePath.join(root, "fixture.mjs");
        await NodeFSP.writeFile(
          entry,
          `
import * as policy from ${JSON.stringify(NodePath.join(shared, "distribution.ts"))};
import * as otel from ${JSON.stringify(NodePath.join(shared, "otelEnvironment.ts"))};
import { providerAuthReturnUrl } from ${JSON.stringify(NodePath.join(shared, "providerAuthReturnUrl.ts"))};
import { buildNewThreadLink, promptLinkAppPath, promptLinkDeepLink } from ${JSON.stringify(NodePath.join(shared, "promptLinks.ts"))};
import * as Effect from ${JSON.stringify(NodePath.resolve(import.meta.dirname, "../../apps/server/node_modules/effect/dist/Effect.js"))};
import * as path from 'node:path';
const home = policy.resolveDistributionHome({ homeDirectory: 'C:\\\\Users\\\\fixture', platform:'win32',localAppData:'C:\\\\Users\\\\fixture\\\\AppData\\\\Local',joinPath:path.win32.join });
const invalidHomes = ['C:\\\\Users\\\\fixture\\\\.t3','C:\\\\Users\\\\fixture\\\\.codex\\\\cache','C:\\\\Users\\\\fixture\\\\AppData\\\\Local\\\\Packages\\\\sandbox'];
const refused = invalidHomes.map(value=>{try{policy.assertDistributionHome(value,home);return false}catch{return true}});
const invalidRoots = invalidHomes.map(value=>{try{policy.resolveDistributionHome({homeDirectory:'C:\\\\Users\\\\fixture',platform:'win32',localAppData:value,joinPath:path.win32.join});return false}catch{return true}});
const loaded = await Effect.runPromise(otel.load);
const result = {
  flags:[policy.cloudEnabled,policy.telemetryEnabled,policy.nativeUpdatesEnabled],
  home,refused,invalidRoots,protocols:policy.desktopProtocolSchemes,
  scheme:policy.getDistributionProtocolScheme(true),
  promptLink:buildNewThreadLink({prompt:'hello LAN',origin:'https://app.t3.codes'}),
  promptPath:promptLinkAppPath('t3code-lan://new?prompt=hello'),
  officialPromptPath:promptLinkAppPath('t3code://new?prompt=hello'),
  hostedPromptPath:promptLinkAppPath('https://app.t3.codes/new?prompt=hello'),
  deepLink:promptLinkDeepLink('/new?prompt=hello'),
  returns:[providerAuthReturnUrl('t3code-lan://app/welcome'),providerAuthReturnUrl('t3code://app/welcome')??null,providerAuthReturnUrl('https://app.t3.codes/welcome')??null,providerAuthReturnUrl('http://127.0.0.1:3773/welcome')],
  telemetryDisabled:loaded.disabled,
  relayTracing:otel.isRelayTracingEnabled(process.env),
  forcedEndpoint:otel.resolveSignalEndpoint({...loaded,disabled:false},'traces',{url:'https://blocked.example/v1/traces',export:{protocol:'http/json',headers:undefined,exportIntervalMs:1}})??null
};
console.log(JSON.stringify(result));
`,
        );
        await build({
          config: false,
          entry: { fixture: entry },
          outDir: NodePath.join(root, "out"),
          platform: "node",
          format: "esm",
          target: "node24",
          dts: false,
          define: { __T3_LAN_BUILD_IDENTITY__: JSON.stringify(identity) },
          deps: { alwaysBundle: [/^effect(?:\/|$)/, /^@t3tools\//], onlyBundle: false },
        });
        const { stdout } = await execFile(
          process.execPath,
          [NodePath.join(root, "out/fixture.mjs")],
          {
            windowsHide: true,
            env: {
              SystemRoot: process.env.SystemRoot,
              T3CODE_LAN_BUILD_POLICY: "a-runtime-path-cannot-reconfigure-compiled-policy",
              T3CODE_HOME: "C:\\Users\\fixture\\.t3",
              T3CODE_TELEMETRY_ENABLED: "true",
              T3CODE_OTEL_SDK_DISABLED: "false",
              OTEL_SDK_DISABLED: "false",
              OTEL_EXPORTER_OTLP_ENDPOINT: "https://blocked.example",
              OTEL_RESOURCE_ATTRIBUTES: "malformed=%zz",
              T3CODE_RELAY_URL: "https://blocked.example",
              T3CODE_DISABLE_SELF_UPDATE: "false",
            },
          },
        );
        const result = JSON.parse(stdout);
        expect(result).toEqual({
          flags: [false, false, false],
          home: "C:\\Users\\fixture\\AppData\\Local\\T3CodeLAN\\data",
          refused: [true, true, true],
          invalidRoots: [true, true, true],
          protocols: ["t3code-lan"],
          scheme: "t3code-lan",
          promptLink: "t3code-lan://new?prompt=hello+LAN",
          promptPath: "/new?prompt=hello",
          officialPromptPath: null,
          hostedPromptPath: null,
          deepLink: "t3code-lan://new?prompt=hello",
          returns: ["t3code-lan://app/welcome", null, null, "http://127.0.0.1:3773/welcome"],
          telemetryDisabled: true,
          relayTracing: false,
          forcedEndpoint: null,
        });
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
);
