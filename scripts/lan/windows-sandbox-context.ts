// @effect-diagnostics nodeBuiltinImport:off - This boundary inspects the real guest account, interfaces and mapped filesystem; it never changes Windows settings.
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { assertValidationRoot } from "./validate-windows-artifact.ts";

export const WINDOWS_SANDBOX_ROOTS = Object.freeze({
  mappedSourceRoot: "C:\\T3LAN\\Source",
  toolchainRoot: "C:\\T3LAN\\Tools",
  inputsRoot: "C:\\T3LAN\\Inputs",
  outputRoot: "C:\\T3LAN\\Output",
  sourceRoot: "C:\\T3LAN\\Output\\work\\source",
});

const capability = Symbol("verified-windows-sandbox-context");
const contexts = new WeakSet<object>();
export interface WindowsSandboxContext {
  readonly [capability]: true;
  readonly kind: "windows-sandbox";
  readonly sourceRoot: string;
  readonly mappedSourceRoot: string;
  readonly toolchainRoot: string;
  readonly inputsRoot: string;
  readonly outputRoot: string;
  readonly sourceCommit: string;
  readonly snapshotSha256: string;
  readonly preparationRequestSha256: string;
}

export function validateSandboxGuestFacts(facts: {
  readonly platform: string;
  readonly username: string;
  readonly externalInterfaces: readonly string[];
  readonly readOnlyMaps: readonly boolean[];
}) {
  if (
    facts.platform !== "win32" ||
    facts.username.toLowerCase() !== "wdagutilityaccount" ||
    facts.externalInterfaces.length !== 0 ||
    facts.readOnlyMaps.length !== 3 ||
    facts.readOnlyMaps.some((readOnly) => !readOnly)
  )
    throw new Error(
      "Build execution requires the configured offline Windows Sandbox guest and read-only source/tool/input maps.",
    );
}

async function refusesWrite(root: string) {
  const file = NodePath.join(root, `.t3-lan-readonly-probe-${NodeCrypto.randomUUID()}`);
  let handle;
  try {
    handle = await NodeFSP.open(file, "wx", 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EPERM", "EROFS"].includes(String(error.code))
    )
      return true;
    throw error;
  }
  try {
    const owned = await handle.stat();
    const current = await NodeFSP.lstat(file);
    if (current.dev === owned.dev && current.ino === owned.ino) await NodeFSP.unlink(file);
  } finally {
    await handle.close();
  }
  return false;
}

async function inspectActualGuest(includeWorkingSource: boolean) {
  // Check the account and networking before a writable-map probe can create even its owned empty file.
  // eslint-disable-next-line t3code/no-global-process-runtime -- Guest facts are read from the actual process.
  const platform = process.platform;
  const username = NodeOS.userInfo().username;
  const externalInterfaces = Object.entries(NodeOS.networkInterfaces()).flatMap(
    ([name, interfaces]) => (interfaces?.some((entry) => !entry.internal) ? [name] : []),
  );
  if (
    platform !== "win32" ||
    username.toLowerCase() !== "wdagutilityaccount" ||
    externalInterfaces.length !== 0
  )
    throw new Error(
      "The configured offline Windows Sandbox guest is required before output can be changed.",
    );
  for (const [name, root] of Object.entries(WINDOWS_SANDBOX_ROOTS))
    if (includeWorkingSource || name !== "sourceRoot") await assertValidationRoot(root);
  const readOnlyMaps = [];
  for (const root of [
    WINDOWS_SANDBOX_ROOTS.mappedSourceRoot,
    WINDOWS_SANDBOX_ROOTS.toolchainRoot,
    WINDOWS_SANDBOX_ROOTS.inputsRoot,
  ])
    readOnlyMaps.push(await refusesWrite(root));
  validateSandboxGuestFacts({ platform, username, externalInterfaces, readOnlyMaps });
}

export async function establishWindowsSandboxContext(binding: {
  readonly sourceCommit: string;
  readonly snapshotSha256: string;
  readonly preparationRequestSha256: string;
}): Promise<WindowsSandboxContext> {
  if (
    !/^[a-f0-9]{40}$/u.test(binding.sourceCommit) ||
    ![binding.snapshotSha256, binding.preparationRequestSha256].every((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    )
  )
    throw new Error("Sandbox context requires approved full source and request/snapshot digests.");
  await inspectActualGuest(false);
  const context: WindowsSandboxContext = Object.freeze({
    [capability]: true as const,
    kind: "windows-sandbox",
    ...WINDOWS_SANDBOX_ROOTS,
    sourceCommit: binding.sourceCommit,
    snapshotSha256: binding.snapshotSha256,
    preparationRequestSha256: binding.preparationRequestSha256,
  });
  contexts.add(context);
  return context;
}

export function assertWindowsSandboxContext(
  value: unknown,
): asserts value is WindowsSandboxContext {
  if (typeof value !== "object" || value === null || !contexts.has(value))
    throw new Error("No verified Windows Sandbox execution capability was provided.");
}

export async function verifyWindowsSandboxContextFacts(context: WindowsSandboxContext) {
  assertWindowsSandboxContext(context);
  await inspectActualGuest(true);
}
