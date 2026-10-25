// @effect-diagnostics nodeBuiltinImport:off - Disposable output guards and synthetic native-helper recipe fixtures only; no real helper is executed.
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { build } from "vite-plus/pack";
import { sha256 } from "./hub-distribution.ts";
import { assertOwnedNativeHelperFile, inspectNativeHelperOutput } from "./native-helper-output.ts";
import { nativeMaintenanceBundleOptions } from "./native-maintenance.pack.ts";

it.effect("refuses and preserves existing foreign files before any helper output cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-output-guard-fixture-" });
      const output = path.join(root, "foreign-output");
      yield* fs.makeDirectory(output);
      const file = path.join(output, "preserve.txt");
      yield* fs.writeFileString(file, "existing user data");
      assert.throws(() => inspectNativeHelperOutput(output, root), /foreign/u);
      assert.equal(yield* fs.readFileString(file), "existing user data");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rechecks output changed before lock acquisition and refuses changed owned cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lan-output-lock-fixture-" });
      const output = path.join(root, ".t3", "native-maintenance");
      yield* fs.makeDirectory(output, { recursive: true });
      const file = path.join(output, "native-maintenance.mjs");
      const contents = "synthetic helper fixture";
      yield* fs.writeFileString(file, contents);
      yield* fs.writeFileString(
        path.join(output, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "native-maintenance-test-build",
          release: false,
          files: [
            { name: "native-maintenance.mjs", bytes: contents.length, sha256: sha256(contents) },
          ],
        }),
      );
      const before = inspectNativeHelperOutput(output, root);
      const lock = NodeFS.openSync(path.join(output, ".native-helper-build.lock"), "wx");
      try {
        const identity = NodeFS.fstatSync(lock);
        NodeFS.writeFileSync(file, "concurrent foreign content");
        assert.throws(() => inspectNativeHelperOutput(output, root, identity), /changed/u);
        assert.throws(() => assertOwnedNativeHelperFile(before[1]!), /changed/u);
        assert.equal(NodeFS.readFileSync(file, "utf8"), "concurrent foreign content");
        NodeFS.writeFileSync(file, contents);
        const owned = inspectNativeHelperOutput(output, root, identity);
        assert.equal(owned.length, 2);
        NodeFS.renameSync(file, path.join(root, "original.fixture"));
        NodeFS.writeFileSync(file, contents);
        assert.throws(() => assertOwnedNativeHelperFile(owned[1]!), /changed/u);
        assert.equal(NodeFS.readFileSync(file, "utf8"), contents);
      } finally {
        NodeFS.closeSync(lock);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "bundles the native-helper recipe identically across independent roots and preserves entrypoint guards",
  () =>
    Effect.promise(async () => {
      const temporaryParent = NodePath.resolve(NodeOS.tmpdir());
      const directory = await NodeFSP.mkdtemp(NodePath.join(temporaryParent, "lan-helper-recipe-"));
      const identity = {
        appId: "com.example.helper-fixture",
        productName: "LAN Helper Fixture",
        protocolScheme: "lan-helper-fixture",
        homeDirectoryName: "T3CodeLAN" as const,
        cloudConfiguration: "disabled" as const,
        telemetry: "disabled" as const,
        nativeUpdater: "disabled" as const,
        protocolVersion: 2 as const,
        applicationVersion: "0.1.2",
        sourceCommit: "a".repeat(40),
      };
      const source = `
import * as path from "node:path";
import { isEntrypoint } from "../entrypoint.ts";
import { lanBuildIdentity, resolveDistributionHome, assertDistributionHome, cloudEnabled, telemetryEnabled, nativeUpdatesEnabled } from "../../../../packages/shared/src/distribution.ts";
const home = resolveDistributionHome({ homeDirectory: "C:/PublicFixture", platform: "win32", localAppData: "C:/PublicFixture/Local", joinPath: path.win32.join, homeMode: "side-by-side" });
let conflictingHomeRefused = false;
try { assertDistributionHome("C:/PublicFixture/.t3", home); } catch { conflictingHomeRefused = true; }
export const observation = { identity: lanBuildIdentity, home, conflictingHomeRefused, cloudEnabled, telemetryEnabled, nativeUpdatesEnabled, moduleUrl: import.meta.url };
export const entrypoint = isEntrypoint({ moduleUrl: import.meta.url, entryPath: process.argv[1], runtimeMain: import.meta.main });
if (entrypoint) process.stdout.write(JSON.stringify({ ...observation, entrypoint }));
`;
      const run = (args: readonly string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(process.execPath, args, {
            cwd: directory,
            env: {
              SystemRoot: "C:\\Windows",
              WINDIR: "C:\\Windows",
              HOME: directory,
              USERPROFILE: directory,
              APPDATA: directory,
              LOCALAPPDATA: directory,
              TEMP: directory,
              TMP: directory,
            },
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString()));
          child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        });
      try {
        const compiled = [];
        for (const name of ["first-source", "second-independent-source"]) {
          const root = NodePath.join(directory, name),
            outDir = NodePath.join(root, "output");
          for (const [relative, contents] of [
            ["apps/server/src/lan/nativeMaintenanceEntry.ts", source],
            [
              "apps/server/src/entrypoint.ts",
              await NodeFSP.readFile(
                NodePath.resolve(import.meta.dirname, "../../apps/server/src/entrypoint.ts"),
                "utf8",
              ),
            ],
            [
              "packages/shared/src/distribution.ts",
              await NodeFSP.readFile(
                NodePath.resolve(import.meta.dirname, "../../packages/shared/src/distribution.ts"),
                "utf8",
              ),
            ],
          ] as const) {
            const file = NodePath.join(root, relative);
            await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
            await NodeFSP.writeFile(file, contents);
          }
          await build(nativeMaintenanceBundleOptions(root, outDir, identity));
          const file = NodePath.join(outDir, "native-maintenance.mjs");
          compiled.push(await NodeFSP.readFile(file));
          const direct = await run([file]);
          assert.equal(direct.code, 0, direct.stderr);
          const imported = await run([
            "--input-type=module",
            "--eval",
            "const fixture = await import(process.argv[1]); process.stdout.write(JSON.stringify({ ...fixture.observation, entrypoint: fixture.entrypoint }));",
            NodeURL.pathToFileURL(file).href,
          ]);
          assert.equal(imported.code, 0, imported.stderr);
          for (const [result, entrypoint] of [
            [direct, true],
            [imported, false],
          ] as const)
            assert.deepEqual(JSON.parse(result.stdout), {
              identity,
              home: "C:\\PublicFixture\\Local\\T3CodeLAN\\data",
              conflictingHomeRefused: true,
              cloudEnabled: false,
              telemetryEnabled: false,
              nativeUpdatesEnabled: false,
              moduleUrl: NodeURL.pathToFileURL(file).href,
              entrypoint,
            });
        }
        assert.equal(sha256(compiled[0]!), sha256(compiled[1]!));
      } finally {
        assert.equal(NodePath.dirname(NodePath.resolve(directory)), temporaryParent);
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    }),
);
