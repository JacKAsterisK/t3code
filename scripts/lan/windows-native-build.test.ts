// @effect-diagnostics nodeBuiltinImport:off - Disposable local source and bootstrap fixtures only; no dependency install, native build, provider, Sandbox or Windows settings change.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it, vi } from "vite-plus/test";
import type { BuildLock } from "./hub-distribution.ts";
import { sha256 } from "./hub-distribution.ts";
import { sourceGitEnvironment } from "./source-git.ts";
import {
  captureNativeBuildSource,
  copyNativePinnedCache,
  requireNativeBuildInput,
} from "./windows-native-build.ts";
import {
  assertWindowsNativeContext,
  establishWindowsNativeContext,
  validateWindowsNativePaths,
  verifyWindowsNativeContextFacts,
  type WindowsNativeBinding,
} from "./windows-native-context.ts";
import { windowsNativeBuildBundleOptions } from "./windows-native-build.pack.ts";

const binding = (): WindowsNativeBinding => ({
  mappedSourceRoot: "C:\\LAN\\source",
  outputRoot: "C:\\LAN\\output",
  inputsRoot: "C:\\LAN\\inputs",
  toolchainRoot: "C:\\LAN\\tools",
  sourceCommit: "a".repeat(40),
  snapshotSha256: "b".repeat(64),
  preparationRequestSha256: "c".repeat(64),
});

it("requires native Windows and independent canonical paths, with no environment assertion of Sandbox", () => {
  expect(validateWindowsNativePaths(binding(), "win32").sourceRoot).toBe(
    "C:\\LAN\\output\\work\\source",
  );
  expect(() => validateWindowsNativePaths(binding(), "linux")).toThrow(/native Windows/u);
  expect(() =>
    assertWindowsNativeContext({
      ...binding(),
      kind: "windows-native-directory",
      osIsolation: false,
    }),
  ).toThrow(/No verified/u);
});

it.each([
  { mappedSourceRoot: "C:\\Users\\fixture\\.t3\\source" },
  { outputRoot: "C:\\LAN\\tools\\output" },
  { inputsRoot: "\\\\server\\share\\input" },
  { toolchainRoot: "C:\\LAN\\CON\\tools" },
  { mappedSourceRoot: "C:\\LAN\\..\\source" },
  { inputsRoot: "C:\\Users\\fixture\\AppData\\Local\\T3CodeLAN\\inputs" },
  { sourceCommit: "short" },
])("refuses unsafe native roots or incomplete source binding: %j", (change) => {
  expect(() => validateWindowsNativePaths({ ...binding(), ...change }, "win32")).toThrow();
});

it("requires the exact externally approved request bytes", () => {
  const bytes = new TextEncoder().encode("reviewed public input");
  expect(requireNativeBuildInput(bytes, sha256(bytes), "fixture")).toBe(bytes);
  expect(() => requireNativeBuildInput(bytes, "a".repeat(64), "fixture")).toThrow(/changed/u);
});

async function fixtureRoot(prefix: string) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  return {
    root,
    cleanup: async () => {
      if (!NodePath.resolve(root).startsWith(NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep))
        throw new Error("Native fixture escaped its captured temporary root.");
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

const git = (cwd: string, args: readonly string[]) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=LAN Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd, windowsHide: true, encoding: "utf8", env: sourceGitEnvironment(process.env) },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });

it("copies only pinned cache bytes into new files and preserves existing output on refusal", async () => {
  const fixture = await fixtureRoot("t3-lan-native-cache-");
  try {
    const source = NodePath.join(fixture.root, "source"),
      output = NodePath.join(fixture.root, "output");
    await NodeFSP.mkdir(source);
    await NodeFSP.mkdir(NodePath.join(source, "nested"));
    const bytes = new TextEncoder().encode("public offline cache");
    await NodeFSP.writeFile(NodePath.join(source, "nested", "entry"), bytes);
    const pins = new Map([["nested/entry", { length: bytes.length, sha256: sha256(bytes) }]]);
    for (let index = 0; index < 70; index++) {
      const tiny = index % 2 === 0 ? new Uint8Array() : new Uint8Array([index, 0, 255]);
      const relative = `nested/tiny-${index.toString().padStart(2, "0")}`;
      await NodeFSP.writeFile(NodePath.join(source, relative), tiny);
      pins.set(relative, { length: tiny.length, sha256: sha256(tiny) });
    }
    const large = new Uint8Array(32 * 1024 ** 2 + 1).fill(42);
    await NodeFSP.writeFile(NodePath.join(source, "nested", "zz-large"), large);
    pins.set("nested/zz-large", { length: large.length, sha256: sha256(large) });
    await copyNativePinnedCache(source, output, pins);
    expect(await NodeFSP.readFile(NodePath.join(output, "nested", "entry"), "utf8")).toBe(
      "public offline cache",
    );
    for (const [relative, pin] of pins) {
      const copied = await NodeFSP.readFile(NodePath.join(output, relative));
      expect({ length: copied.length, sha256: sha256(copied) }).toEqual(pin);
    }
    await expect(copyNativePinnedCache(source, output, pins)).rejects.toThrow();
    await NodeFSP.writeFile(NodePath.join(source, "nested", "entry"), "changed");
    const refused = NodePath.join(fixture.root, "refused");
    await expect(copyNativePinnedCache(source, refused, pins)).rejects.toThrow(
      /changed during copy/u,
    );
    await expect(NodeFSP.lstat(NodePath.join(refused, "nested", "entry"))).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(output, "nested", "entry"), "utf8")).toBe(
      "public offline cache",
    );
    const oversized = NodePath.join(fixture.root, "oversized");
    await expect(
      copyNativePinnedCache(
        source,
        oversized,
        new Map([["nested/entry", { length: 0, sha256: sha256(new Uint8Array()) }]]),
      ),
    ).rejects.toThrow(/oversized/u);
    await expect(NodeFSP.lstat(NodePath.join(oversized, "nested", "entry"))).rejects.toThrow();
  } finally {
    await fixture.cleanup();
  }
});

it("captures actual committed binary bytes and establishes a native context only while its original source stays clean", async () => {
  const fixture = await fixtureRoot("t3-lan-native-source-");
  try {
    const source = NodePath.join(fixture.root, "source"),
      tools = NodePath.join(fixture.root, "tools"),
      output = NodePath.join(fixture.root, "output"),
      inputs = NodePath.join(fixture.root, "inputs");
    for (const root of [source, tools, output]) await NodeFSP.mkdir(root);
    const bytes = new Uint8Array([0, 255, 10, 13, 13, 10]);
    await NodeFSP.writeFile(NodePath.join(source, "tracked.bin"), bytes);
    await git(source, ["init"]);
    await git(source, ["add", "tracked.bin"]);
    await git(source, ["commit", "-m", "fixture"]);
    const commit = await git(source, ["rev-parse", "HEAD"]),
      epoch = Number(await git(source, ["show", "-s", "--format=%ct", "HEAD"]));
    const pin = { version: "1.0.0", sha256: "a".repeat(64) };
    const lock: BuildLock = {
      schemaVersion: 1,
      forkCommit: commit,
      upstreamCommit: "b".repeat(40),
      distributionVersion: "1.0.0",
      applicationVersion: "0.1.2",
      files: { "tracked.bin": sha256(bytes) },
      tools: { node: pin, pnpm: pin, rust: pin, msvc: pin, windowsSdk: pin, nsis: pin },
      wslRuntime: null,
      cloudConfiguration: "disabled",
      telemetry: "disabled",
      nativeUpdater: "disabled",
    };
    const captured = await captureNativeBuildSource(source, lock, epoch);
    expect(Array.from(captured.files.get("tracked.bin")!)).toEqual(Array.from(bytes));
    expect(captured.snapshot.sourceCommit).toBe(commit);
    const nativeBinding = {
      mappedSourceRoot: source,
      toolchainRoot: tools,
      inputsRoot: inputs,
      outputRoot: output,
      sourceCommit: commit,
      snapshotSha256: sha256(captured.snapshotBytes),
      preparationRequestSha256: "c".repeat(64),
    };
    // eslint-disable-next-line t3code/no-global-process-runtime -- Exercise the real issuer on Windows and its real-OS refusal on other test hosts.
    if (NodeOS.platform() === "win32") {
      const context = await establishWindowsNativeContext(nativeBinding);
      assertWindowsNativeContext(context);
      expect(context.kind).toBe("windows-native-directory");
      expect(context.osIsolation).toBe(false);
      expect(context.networkIsolation).toBe(false);
      await NodeFSP.mkdir(inputs);
      await NodeFSP.mkdir(NodePath.dirname(context.sourceRoot));
      await NodeFSP.mkdir(context.sourceRoot);
      await verifyWindowsNativeContextFacts(context);
      vi.stubEnv("PATH", "C:\\No-Git-In-The-Build-Environment");
      try {
        await verifyWindowsNativeContextFacts(context);
      } finally {
        vi.unstubAllEnvs();
      }
      await NodeFSP.writeFile(NodePath.join(source, "tracked.bin"), "changed");
      await expect(verifyWindowsNativeContextFacts(context)).rejects.toThrow(/clean full commit/u);
    } else
      await expect(establishWindowsNativeContext(nativeBinding)).rejects.toThrow(/native Windows/u);
    await expect(captureNativeBuildSource(source, lock, epoch + 1)).rejects.toThrow(
      /commit epoch/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

it("bundles the normal native runner and crosses into working-source Effect services without a Sandbox issuer", async () => {
  const fixture = await fixtureRoot("t3-lan-native-bundle-");
  try {
    const out = NodePath.join(fixture.root, "bundle");
    await NodeFSP.mkdir(out);
    await build(
      windowsNativeBuildBundleOptions(NodePath.resolve(import.meta.dirname, "../.."), out),
    );
    expect(await NodeFSP.readdir(out)).toEqual(["native-runner.mjs"]);
    const bundledPath = NodePath.join(out, "native-runner.mjs");
    const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [bundledPath, "--invalid"], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString()));
        child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
    expect(cli.code).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain(
      "Supply --request ABSOLUTE_JSON --approved-request-sha256 REVIEWED_SHA256 to execute the approved native-directory build.",
    );
    expect(cli.stderr).not.toContain("approved-policy-sha256");
    const bundle = (await import(
      /* @vite-ignore */ NodeURL.pathToFileURL(bundledPath).href
    )) as typeof import("./windows-native-build.ts");
    expect(typeof bundle.runWindowsNativeBuild).toBe("function");
    const source = NodePath.join(fixture.root, "working"),
      lan = NodePath.join(source, "scripts", "lan");
    await NodeFSP.mkdir(lan, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(lan, "windows-native-context.ts"),
      `const issued=new WeakSet();export async function establishWindowsNativeContext(binding){const context=Object.freeze({...binding,kind:'windows-native-directory',osIsolation:false,networkIsolation:false});issued.add(context);return context;}export function assertContext(context){if(!issued.has(context))throw new Error('wrong native issuer');}`,
    );
    await NodeFSP.writeFile(
      NodePath.join(lan, "windows-build-execution.ts"),
      `import {assertContext} from './windows-native-context.ts';const issued=new WeakSet();export function createWindowsBuildExecution(input){assertContext(input.isolation);const value=Object.freeze({context:input.isolation});issued.add(value);return value;}export function assertExecution(value){if(!issued.has(value))throw new Error('wrong execution issuer');}`,
    );
    await NodeFSP.writeFile(
      NodePath.join(source, "scripts", "build-desktop-artifact.ts"),
      `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};import * as FileSystem from ${JSON.stringify(import.meta.resolve("effect/FileSystem"))};import {assertExecution} from './lan/windows-build-execution.ts';export const runIsolatedWindowsDesktopBuild=(execution)=>Effect.gen(function*(){assertExecution(execution);const fs=yield*FileSystem.FileSystem;return {kind:execution.context.kind,osIsolation:execution.context.osIsolation,networkIsolation:execution.context.networkIsolation,filesystem:typeof fs.readFile==='function'};});`,
    );
    const result = await bundle.runWorkingNativeWindowsBuild({
      sourceRoot: source,
      binding: binding(),
      factoryInput: {
        approvedRequestSha256: "a".repeat(64),
        requestBytes: new Uint8Array(),
        lockBytes: new Uint8Array(),
        identityBytes: new Uint8Array(),
        toolchainManifestBytes: new Uint8Array(),
        toolchainFiles: new Map(),
        nodeHeaderFiles: { nodeVersionH: new Uint8Array(), configGypi: new Uint8Array() },
        verifyUnchanged: async () => {},
      },
      policyPath: "fixture-policy",
      buildLockPath: "fixture-lock",
    });
    expect(result).toEqual({
      kind: "windows-native-directory",
      osIsolation: false,
      networkIsolation: false,
      filesystem: true,
    });
  } finally {
    await fixture.cleanup();
  }
});
