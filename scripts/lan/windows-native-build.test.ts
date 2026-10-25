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
  prepareNativePnpmMetadata,
  requireNativeBuildInput,
  verifyNativeSnapshotFiles,
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

it("isolates pnpm policy memo writes and refuses redirected pinned metadata mappings", async () => {
  const fixture = await fixtureRoot("t3-lan-pnpm-metadata-");
  try {
    const source = NodePath.join(fixture.root, "source"),
      output = NodePath.join(fixture.root, "output"),
      foreign = NodePath.join(fixture.root, "foreign");
    await NodeFSP.mkdir(NodePath.join(source, "v12"), { recursive: true });
    await NodeFSP.mkdir(foreign);
    const entries = new Map([
      ["lockfile-verified.jsonl", "verified policy"],
      ["v12/registry.jsonl", "pinned registry"],
    ]);
    const pins = new Map();
    for (const [relative, text] of entries) {
      const bytes = new TextEncoder().encode(text);
      await NodeFSP.writeFile(NodePath.join(source, relative), bytes);
      pins.set(relative, { length: bytes.length, sha256: sha256(bytes) });
    }
    const verify = await prepareNativePnpmMetadata(source, output, pins);
    await NodeFSP.appendFile(NodePath.join(output, "lockfile-verified.jsonl"), "new build record");
    expect(await NodeFSP.readFile(NodePath.join(source, "lockfile-verified.jsonl"), "utf8")).toBe(
      "verified policy",
    );
    expect(await NodeFSP.readFile(NodePath.join(output, "v12", "registry.jsonl"), "utf8")).toBe(
      "pinned registry",
    );
    await verify();
    await NodeFSP.unlink(NodePath.join(output, "v12"));
    await NodeFSP.symlink(foreign, NodePath.join(output, "v12"), "junction");
    await expect(verify()).rejects.toThrow(/mapping changed/u);
    await expect(
      prepareNativePnpmMetadata(
        source,
        NodePath.join(fixture.root, "refused"),
        new Map([["unexpected/registry.jsonl", { length: 1, sha256: "a".repeat(64) }]]),
      ),
    ).rejects.toThrow(/metadata layout/u);
  } finally {
    await fixture.cleanup();
  }
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

it("verifies actual snapshot bytes and refuses changed contents, lengths, and hardlink aliases", async () => {
  const fixture = await fixtureRoot("t3-lan-native-snapshot-");
  try {
    const bytes = Buffer.from("approved source"),
      file = NodePath.join(fixture.root, "entry");
    const pin = { path: "entry", length: bytes.length, sha256: sha256(bytes) };
    await NodeFSP.writeFile(file, bytes);
    await verifyNativeSnapshotFiles(fixture.root, [pin]);
    await NodeFSP.writeFile(file, "modified source");
    await expect(verifyNativeSnapshotFiles(fixture.root, [pin])).rejects.toThrow(
      /working source changed/u,
    );
    await NodeFSP.writeFile(file, Buffer.concat([bytes, Buffer.from([0])]));
    await expect(verifyNativeSnapshotFiles(fixture.root, [pin])).rejects.toThrow(/oversized/u);
    await NodeFSP.writeFile(file, bytes);
    await expect(
      verifyNativeSnapshotFiles(fixture.root, [{ ...pin, length: bytes.length + 1 }]),
    ).rejects.toThrow(/working source changed/u);
    await NodeFSP.link(file, NodePath.join(fixture.root, "alias"));
    await expect(verifyNativeSnapshotFiles(fixture.root, [pin])).rejects.toThrow(/linked/u);
  } finally {
    await fixture.cleanup();
  }
});

it("checks every actual source file across successful snapshot batches", async () => {
  const fixture = await fixtureRoot("t3-lan-native-snapshot-batches-");
  try {
    const pins = await Promise.all(
      Array.from({ length: 70 }, async (_, index) => {
        const bytes = Buffer.from([index, 0, 255]),
          path = `entry-${index}`;
        await NodeFSP.writeFile(NodePath.join(fixture.root, path), bytes);
        return { path, length: bytes.length, sha256: sha256(bytes) };
      }),
    );
    await verifyNativeSnapshotFiles(fixture.root, pins);
    await NodeFSP.writeFile(NodePath.join(fixture.root, pins[69]!.path), Buffer.from([0, 0, 255]));
    await expect(verifyNativeSnapshotFiles(fixture.root, pins)).rejects.toThrow(
      /working source changed/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  { path: "../outside", length: 0 },
  { path: "entry", length: -1 },
  { path: "entry", length: 0.5 },
  { path: "entry", length: Number.NaN },
  { path: "entry", length: 256 * 1024 ** 2 + 1 },
])("refuses invalid snapshot pins before reading: %j", async (pin) => {
  const readFile = vi.fn(async () => Buffer.alloc(0));
  await expect(
    verifyNativeSnapshotFiles(
      NodePath.resolve("fixture"),
      [{ ...pin, sha256: sha256("") }],
      readFile,
    ),
  ).rejects.toThrow();
  expect(readFile).not.toHaveBeenCalled();
});

it("drains pending snapshot reads before reporting a sibling read failure", async () => {
  const fixture = await fixtureRoot("t3-lan-native-snapshot-drain-");
  try {
    const bytes = Buffer.from("approved source"),
      pendingRead = Promise.withResolvers<typeof bytes>(),
      pendingStarted = Promise.withResolvers<void>(),
      failure = new Error("refused source read");
    await NodeFSP.writeFile(NodePath.join(fixture.root, "entry"), bytes);
    let siblingSettled = false;
    const verification = verifyNativeSnapshotFiles(
      fixture.root,
      ["refused", "pending"].map((name) => ({
        path: name,
        length: bytes.length,
        sha256: sha256(bytes),
      })),
      async (file) => {
        if (NodePath.basename(file) === "refused") throw failure;
        pendingStarted.resolve();
        try {
          return await pendingRead.promise;
        } finally {
          siblingSettled = true;
        }
      },
    );
    const outcome = verification.then(
      () => ({ error: undefined, siblingSettled }),
      (error: unknown) => ({ error, siblingSettled }),
    );
    await pendingStarted.promise;
    const releaseRead = NodeFSP.readFile(NodePath.join(fixture.root, "entry")).then(
      (contents) => pendingRead.resolve(contents),
      (error: unknown) => pendingRead.reject(error),
    );
    try {
      expect(await outcome).toEqual({ error: failure, siblingSettled: true });
    } finally {
      await releaseRead;
      await Promise.allSettled([verification]);
    }
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  { label: "32 file limit", lengths: Array.from({ length: 33 }, () => 0), batchSize: 32 },
  { label: "32 MiB limit", lengths: [20 * 1024 ** 2, 12 * 1024 ** 2, 1], batchSize: 2 },
  { label: "oversized file alone", lengths: [32 * 1024 ** 2 + 1, 1], batchSize: 1 },
  { label: "256 MiB maximum file", lengths: [256 * 1024 ** 2, 1], batchSize: 1 },
])("bounds pending snapshot reads at $label", async ({ lengths, batchSize }) => {
  const root = NodePath.resolve("fixture"),
    batchStarted = Promise.withResolvers<void>(),
    releaseBatch = Promise.withResolvers<void>(),
    failure = new Error("refused source read");
  const observed: Array<{ files: number; bytes: number; length: number }> = [];
  let activeFiles = 0,
    activeBytes = 0;
  const pins = lengths.map((length, index) => ({
    path: `entry-${index}`,
    length,
    sha256: sha256(""),
  }));
  const verification = verifyNativeSnapshotFiles(root, pins, async (file, maximum) => {
    const index = Number(NodePath.basename(file).slice("entry-".length)),
      length = lengths[index]!;
    expect(maximum).toBe(length);
    activeFiles += 1;
    activeBytes += length;
    observed.push({ files: activeFiles, bytes: activeBytes, length });
    if (activeFiles === batchSize) batchStarted.resolve();
    try {
      await releaseBatch.promise;
      throw failure;
    } finally {
      activeFiles -= 1;
      activeBytes -= length;
    }
  });
  const outcome = verification.then(
    () => undefined,
    (error: unknown) => error,
  );
  await batchStarted.promise;
  expect(observed).toHaveLength(batchSize);
  releaseBatch.resolve();
  expect(await outcome).toBe(failure);
  expect(observed).toHaveLength(batchSize);
  expect(observed.every((item) => item.files <= 32)).toBe(true);
  expect(observed.every((item) => item.bytes <= 32 * 1024 ** 2 || item.files === 1)).toBe(true);
  expect(
    observed.filter((item) => item.length > 32 * 1024 ** 2).every((item) => item.files === 1),
  ).toBe(true);
  expect(activeFiles).toBe(0);
  expect(activeBytes).toBe(0);
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
    await NodeFSP.mkdir(NodePath.join(source, ".repos", "reference"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(source, ".repos", "reference", "notes.txt"),
      "reference only",
    );
    await git(source, ["init"]);
    await git(source, ["add", "-f", "tracked.bin", ".repos/reference/notes.txt"]);
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
    expect(captured.files.has(".repos/reference/notes.txt")).toBe(false);
    expect(captured.snapshot.exclusions).toEqual([
      {
        path: ".repos/reference/notes.txt",
        mode: "100644",
        blob: await git(source, ["rev-parse", "HEAD:.repos/reference/notes.txt"]),
      },
    ]);
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
