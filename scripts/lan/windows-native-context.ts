// @effect-diagnostics nodeBuiltinImport:off - Ordinary native builds validate paths and provenance without changing Windows or claiming OS isolation.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { assertValidationRoot } from "./validate-windows-artifact.ts";
import { sha256 } from "./hub-distribution.ts";
import { nativeBuildRoot } from "./windows-build-preparation.ts";
import { inspectSourceGit } from "./source-git.ts";
import { relativeWindowsPath } from "./windows-artifact.ts";

const contexts = new WeakSet<object>();
interface CapturedGit {
  readonly executable: string;
  readonly sha256: string;
  readonly environment: NodeJS.ProcessEnv;
}
const inspectors = new WeakMap<object, CapturedGit>();
const capability = Symbol("verified-windows-native-context");
export interface WindowsNativeContext {
  readonly [capability]: true;
  readonly kind: "windows-native-directory";
  readonly sourceRoot: string;
  readonly mappedSourceRoot: string;
  readonly toolchainRoot: string;
  readonly inputsRoot: string;
  readonly outputRoot: string;
  readonly sourceCommit: string;
  readonly snapshotSha256: string;
  readonly preparationRequestSha256: string;
  readonly osIsolation: false;
  readonly networkIsolation: false;
}

export interface WindowsNativeBinding {
  readonly mappedSourceRoot: string;
  readonly toolchainRoot: string;
  readonly inputsRoot: string;
  readonly outputRoot: string;
  readonly sourceCommit: string;
  readonly snapshotSha256: string;
  readonly preparationRequestSha256: string;
}

export function validateWindowsNativePaths(binding: WindowsNativeBinding, platform: string) {
  if (platform !== "win32") throw new Error("Native-directory builds require native Windows.");
  if (
    !/^[a-f0-9]{40}$/u.test(binding.sourceCommit) ||
    ![binding.snapshotSha256, binding.preparationRequestSha256].every((value) =>
      /^[a-f0-9]{64}$/u.test(value),
    )
  )
    throw new Error("Native builds require exact source, snapshot and preparation digests.");
  const roots = [
    binding.mappedSourceRoot,
    binding.toolchainRoot,
    binding.inputsRoot,
    binding.outputRoot,
  ].map((root) => {
    const normalized = nativeBuildRoot(root);
    relativeWindowsPath(root.slice(3).replaceAll("\\", "/").replace(/\/$/u, ""));
    return normalized;
  });
  for (let at = 0; at < roots.length; at++)
    for (let other = at + 1; other < roots.length; other++)
      if (
        roots[at] === roots[other] ||
        roots[at]!.startsWith(roots[other]! + "\\") ||
        roots[other]!.startsWith(roots[at]! + "\\")
      )
        throw new Error(
          "Native source, tools, input snapshot and output directories must be separate.",
        );
  return Object.freeze({
    mappedSourceRoot: NodePath.win32.normalize(binding.mappedSourceRoot),
    toolchainRoot: NodePath.win32.normalize(binding.toolchainRoot),
    inputsRoot: NodePath.win32.normalize(binding.inputsRoot),
    outputRoot: NodePath.win32.normalize(binding.outputRoot),
    sourceRoot: NodePath.win32.join(binding.outputRoot, "work", "source"),
  });
}

async function readGitExecutable(executable: string) {
  await assertValidationRoot(NodePath.dirname(executable));
  const before = await NodeFSP.lstat(executable);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 ** 2)
    throw new Error("Captured Git must be a bounded ordinary executable.");
  const handle = await NodeFSP.open(executable, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error("Captured Git changed while opening.");
    // Git for Windows installs its cmd/bin launchers as legitimate hard-link aliases.
    // This inspector never writes them; byte/identity checks remain required.
    const bytes = await handle.readFile();
    const after = await handle.stat(),
      current = await NodeFSP.lstat(executable);
    if (
      bytes.length !== before.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.isSymbolicLink()
    )
      throw new Error("Captured Git changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function captureGit(): Promise<CapturedGit> {
  for (const item of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    if (!item) continue;
    const executable = NodePath.resolve(item.replace(/^"|"$/gu, ""), "git.exe");
    try {
      const bytes = await readGitExecutable(executable);
      return Object.freeze({
        executable,
        sha256: sha256(bytes),
        environment: Object.freeze({
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          PATH: NodePath.dirname(executable) + ";C:\\Windows\\System32",
        }),
      });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "Native source inspection requires an existing native Git executable before build environment scrubbing.",
  );
}

async function verifyFacts(binding: WindowsNativeBinding, git: CapturedGit) {
  // eslint-disable-next-line t3code/no-global-process-runtime -- The backend requires the actual OS, never an environment assertion.
  const roots = validateWindowsNativePaths(binding, process.platform);
  for (const root of [roots.mappedSourceRoot, roots.toolchainRoot, roots.outputRoot])
    await assertValidationRoot(root);
  await assertValidationRoot(NodePath.win32.dirname(roots.inputsRoot));
  if (sha256(await readGitExecutable(git.executable)) !== git.sha256)
    throw new Error("Captured source-inspection Git bytes changed.");
  const inspect = (args: readonly string[]) =>
    inspectSourceGit(roots.mappedSourceRoot, args, git.environment, {
      executable: git.executable,
      isolatedConfiguration: true,
    });
  if (
    (await inspect(["rev-parse", "HEAD"])) !== binding.sourceCommit ||
    (await inspect(["status", "--porcelain", "--untracked-files=all"]))
  )
    throw new Error("Native build source is no longer the approved clean full commit.");
  return roots;
}

export async function establishWindowsNativeContext(
  binding: WindowsNativeBinding,
): Promise<WindowsNativeContext> {
  // eslint-disable-next-line t3code/no-global-process-runtime -- Reject non-Windows before looking for a native inspector.
  validateWindowsNativePaths(binding, process.platform);
  // Capture the read-only inspector before the packager replaces process.env with build-only configuration.
  const git = await captureGit();
  const roots = await verifyFacts(binding, git);
  const context: WindowsNativeContext = Object.freeze({
    [capability]: true as const,
    kind: "windows-native-directory",
    ...roots,
    sourceCommit: binding.sourceCommit,
    snapshotSha256: binding.snapshotSha256,
    preparationRequestSha256: binding.preparationRequestSha256,
    osIsolation: false,
    networkIsolation: false,
  });
  contexts.add(context);
  inspectors.set(context, git);
  return context;
}

export function assertWindowsNativeContext(value: unknown): asserts value is WindowsNativeContext {
  if (typeof value !== "object" || value === null || !contexts.has(value))
    throw new Error("No verified native-directory build context was supplied.");
}

export async function verifyWindowsNativeContextFacts(context: WindowsNativeContext) {
  assertWindowsNativeContext(context);
  const git = inspectors.get(context);
  if (!git) throw new Error("Native source inspector was not captured.");
  await verifyFacts(context, git);
  await assertValidationRoot(context.sourceRoot);
  await assertValidationRoot(context.inputsRoot);
}
