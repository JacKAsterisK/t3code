// @effect-diagnostics nodeBuiltinImport:off -- Native startup resolves an approved home before any service can write it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export interface NativeHomePaths {
  readonly originalHomeDirectory: string;
  readonly lanHomeDirectory: string;
  readonly selectionPath: string;
  readonly journalPath: string;
}

export interface NativeHomeSelection {
  readonly schemaVersion: 1;
  readonly mode: "drop-in" | "side-by-side";
  readonly originalHomeDirectory: string;
  readonly originalEnvironmentId: string | null;
  readonly lanHomeDirectory: string;
  readonly lanEnvironmentId: string | null;
  readonly electronProfileDirectory: string;
  readonly repairId: string;
  readonly receiptPath: string;
}

export function nativeHomePaths(userHomeDirectory: string, localAppData: string): NativeHomePaths {
  if (!NodePath.isAbsolute(userHomeDirectory) || !NodePath.isAbsolute(localAppData))
    throw new Error("T3 home discovery requires absolute per-user directories.");
  const root = NodePath.join(localAppData, "T3CodeLAN");
  return {
    originalHomeDirectory: NodePath.join(userHomeDirectory, ".t3"),
    lanHomeDirectory: NodePath.join(root, "data"),
    selectionPath: NodePath.join(root, "home-selection.json"),
    journalPath: NodePath.join(root, "home-repair.json"),
  };
}

export function assertOrdinaryNativePath(file: string, directory: boolean): void {
  let at = NodePath.resolve(file);
  let first = true;
  for (;;) {
    let stat: NodeFS.Stats | undefined;
    try {
      stat = NodeFS.lstatSync(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      stat &&
      (stat.isSymbolicLink() ||
        (first && !directory ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))
    )
      throw new Error("T3 home selection refuses redirected or nonordinary paths.");
    const parent = NodePath.dirname(at);
    if (parent === at) return;
    at = parent;
    first = false;
  }
}

function readBounded(file: string): string | undefined {
  assertOrdinaryNativePath(file, false);
  try {
    if (NodeFS.statSync(file).size > 16_384)
      throw new Error("T3 home selection metadata is oversized.");
    return NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function nativeHomeIdentity(home: string): string | null {
  assertOrdinaryNativePath(home, true);
  const raw = readBounded(NodePath.join(home, "userdata", "environment-id"));
  const database = NodePath.join(home, "userdata", "statev2.sqlite");
  assertOrdinaryNativePath(database, false);
  const databasePresent = NodeFS.existsSync(database);
  if (raw === undefined && !databasePresent) {
    if (NodeFS.existsSync(home)) {
      for (const name of NodeFS.readdirSync(home)) {
        if (name === "native-admission.lock") continue;
        if (name === "userdata") {
          const state = NodePath.join(home, name);
          assertOrdinaryNativePath(state, true);
          if (NodeFS.readdirSync(state).every((entry) => entry === "server-owner.sqlite")) continue;
        }
        throw new Error(
          "T3 found existing state without an initialized identity; use Hub repair preview.",
        );
      }
    }
    return null;
  }
  const identity = raw?.trim();
  if (!identity || !/^[a-f0-9-]{36}$/i.test(identity) || !databasePresent)
    throw new Error(
      "T3 found an incomplete existing home; use the Hub repair preview before starting.",
    );
  return identity;
}

function readNativeHomeSelection(paths: NativeHomePaths): NativeHomeSelection | undefined {
  if (NodeFS.existsSync(paths.journalPath))
    throw new Error(
      "T3 home repair is incomplete. Keep both homes stopped until Hub recovery completes.",
    );
  const raw = readBounded(paths.selectionPath);
  if (raw === undefined) return undefined;
  const selection = JSON.parse(raw) as NativeHomeSelection;
  if (
    selection.schemaVersion !== 1 ||
    !["drop-in", "side-by-side"].includes(selection.mode) ||
    !/^[a-f0-9]{32}$/.test(selection.repairId) ||
    !NodePath.isAbsolute(selection.originalHomeDirectory) ||
    NodePath.resolve(selection.lanHomeDirectory) !== NodePath.resolve(paths.lanHomeDirectory) ||
    !NodePath.isAbsolute(selection.electronProfileDirectory)
  )
    throw new Error("Invalid T3 home selection; use Hub repair preview.");
  const expectedReceipt = NodePath.join(
    NodePath.dirname(paths.selectionPath),
    "recovery",
    selection.repairId,
    "receipt.json",
  );
  if (NodePath.resolve(selection.receiptPath) !== NodePath.resolve(expectedReceipt))
    throw new Error("Invalid T3 home selection receipt.");
  const receiptRaw = readBounded(expectedReceipt);
  if (receiptRaw === undefined)
    throw new Error("T3 home selection has no completed preservation receipt.");
  const receipt = JSON.parse(receiptRaw) as { status?: string; selectionSha256?: string };
  if (
    !["selected-pending-verification", "verified"].includes(receipt.status ?? "") ||
    receipt.selectionSha256 !== NodeCrypto.createHash("sha256").update(raw).digest("hex")
  )
    throw new Error("T3 home selection does not match its preservation receipt.");
  if (
    nativeHomeIdentity(selection.originalHomeDirectory) !== selection.originalEnvironmentId ||
    nativeHomeIdentity(selection.lanHomeDirectory) !== selection.lanEnvironmentId
  )
    throw new Error("T3 home identities changed after repair selection. Use Hub repair preview.");
  assertOrdinaryNativePath(selection.electronProfileDirectory, true);
  return selection;
}

export function resolveNativeHomeSelection(input: {
  readonly userHomeDirectory: string;
  readonly localAppData: string;
}): {
  readonly homeDirectory: string;
  readonly electronProfileDirectory?: string;
  readonly mode: "drop-in" | "side-by-side";
} {
  const paths = nativeHomePaths(input.userHomeDirectory, input.localAppData);
  const selection = readNativeHomeSelection(paths);
  if (selection)
    return {
      homeDirectory:
        selection.mode === "drop-in" ? selection.originalHomeDirectory : selection.lanHomeDirectory,
      electronProfileDirectory: selection.electronProfileDirectory,
      mode: selection.mode,
    };
  const original = nativeHomeIdentity(paths.originalHomeDirectory);
  const lan = nativeHomeIdentity(paths.lanHomeDirectory);
  if (original && lan)
    throw new Error(
      "Both original and LAN T3 homes contain state. Use Hub repair preview and choose which home to use; neither home was changed.",
    );
  // Preserve the only initialized installation; this does not create a new separate home.
  if (lan)
    return {
      homeDirectory: paths.lanHomeDirectory,
      electronProfileDirectory: NodePath.join(input.localAppData, "T3CodeLAN", "electron-profile"),
      mode: "side-by-side",
    };
  return { homeDirectory: paths.originalHomeDirectory, mode: "drop-in" };
}

/** Recheck the choice while the startup admission handle is held; allow a fresh selected home to finish initialization. */
export function assertNativeHomeMatchesSelection(
  homeDirectory: string,
  input: { readonly userHomeDirectory: string; readonly localAppData: string },
) {
  const paths = nativeHomePaths(input.userHomeDirectory, input.localAppData);
  const selection = readNativeHomeSelection(paths);
  const legacyLan = !selection && nativeHomeIdentity(paths.lanHomeDirectory) !== null;
  if (legacyLan && nativeHomeIdentity(paths.originalHomeDirectory) !== null)
    throw new Error("Both initialized homes require an explicit selection before startup.");
  const expected =
    selection?.mode === "side-by-side" || legacyLan
      ? paths.lanHomeDirectory
      : (selection?.originalHomeDirectory ?? paths.originalHomeDirectory);
  if (NodePath.resolve(homeDirectory).toLowerCase() !== NodePath.resolve(expected).toLowerCase())
    throw new Error("T3 home selection changed before startup admission; restart through Hub.");
}
