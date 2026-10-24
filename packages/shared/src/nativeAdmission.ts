// @effect-diagnostics nodeBuiltinImport:off -- The native startup boundary must acquire its Windows share-mode handle synchronously before Electron pre-ready services can write the home.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "./HostProcess.ts";
import { isLanDistribution } from "./distribution.ts";
import { assertNativeHomeMatchesSelection } from "./nativeHomeSelection.ts";

export class NativeAdmissionError extends Schema.TaggedError<NativeAdmissionError>()(
  "NativeAdmissionError",
  {
    reason: Schema.Literals(["busy", "recovery_required", "unsafe_path", "io"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "busy":
        return "T3 native startup is blocked by an exclusive activation lease.";
      case "recovery_required":
        return "T3 native activation recovery is unresolved. Keep this home stopped until reviewed recovery completes.";
      case "unsafe_path":
        return "T3 native admission requires ordinary directories and a single-link lock file.";
      case "io":
        return "T3 could not acquire its native startup admission handle.";
    }
  }
}

const isNativeAdmissionError = Schema.is(NativeAdmissionError);

export function resolveNativeAdmissionPaths(homeDirectory: string) {
  if (!NodePath.isAbsolute(homeDirectory)) {
    throw new NativeAdmissionError({ reason: "unsafe_path" });
  }
  const home = NodePath.resolve(homeDirectory);
  const journalPaths = [NodePath.join(home, "native-activation.json")];
  const parent = NodePath.dirname(home);
  if (
    NodePath.basename(home).toLowerCase() === "data" &&
    NodePath.basename(parent).toLowerCase() === "t3codelan"
  ) {
    journalPaths.push(NodePath.join(parent, "activation.json"));
  }
  return {
    homeDirectory: home,
    lockPath: NodePath.join(home, "native-admission.lock"),
    journalPaths,
  };
}

function lstatIfPresent(path: string) {
  try {
    return NodeFS.lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function validateDirectories(path: string) {
  for (let directory = path; ; directory = NodePath.dirname(directory)) {
    const state = lstatIfPresent(directory);
    if (state !== undefined && (!state.isDirectory() || state.isSymbolicLink())) {
      throw new NativeAdmissionError({ reason: "unsafe_path" });
    }
    if (directory === NodePath.dirname(directory)) return;
  }
}

function validateLock(state: NodeFS.Stats) {
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new NativeAdmissionError({ reason: "unsafe_path" });
  }
}

export interface NativeAdmissionLease {
  readonly close: () => void;
}

/** Hold this handle for the entire lifetime of any ordinary home/database writer. */
export function acquireNativeAdmission(
  homeDirectory: string,
  selectionContext?: { readonly userHomeDirectory: string; readonly localAppData: string },
): NativeAdmissionLease {
  let descriptor: number | undefined;
  try {
    const paths = resolveNativeAdmissionPaths(homeDirectory);
    validateDirectories(paths.homeDirectory);
    NodeFS.mkdirSync(paths.homeDirectory, { recursive: true });
    validateDirectories(paths.homeDirectory);
    const before = lstatIfPresent(paths.lockPath);
    if (before !== undefined) validateLock(before);
    // Windows checks sharing in both directions against Hub's FileShare.None
    // handle. Never unlink or truncate this inode, even after a crash.
    descriptor = NodeFS.openSync(paths.lockPath, "a+", 0o600);
    const opened = NodeFS.fstatSync(descriptor);
    const current = NodeFS.lstatSync(paths.lockPath);
    validateLock(opened);
    validateLock(current);
    if (
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      (before !== undefined && (before.dev !== current.dev || before.ino !== current.ino))
    ) {
      throw new NativeAdmissionError({ reason: "unsafe_path" });
    }
    validateDirectories(paths.homeDirectory);
    if (isLanDistribution) {
      const userHomeDirectory =
        selectionContext?.userHomeDirectory ?? Effect.runSync(HostProcess.HomeDirectory);
      const environment = Effect.runSync(HostProcess.Environment);
      assertNativeHomeMatchesSelection(
        paths.homeDirectory,
        selectionContext ?? {
          userHomeDirectory,
          localAppData:
            environment.LOCALAPPDATA ?? NodePath.join(userHomeDirectory, "AppData", "Local"),
        },
      );
    }
    if (paths.journalPaths.some((path) => lstatIfPresent(path) !== undefined)) {
      throw new NativeAdmissionError({ reason: "recovery_required" });
    }
    const held = descriptor;
    descriptor = undefined;
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        NodeFS.closeSync(held);
      },
    };
  } catch (cause) {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
    if (isNativeAdmissionError(cause)) throw cause;
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    throw new NativeAdmissionError({
      reason: code === "EACCES" || code === "EPERM" || code === "EBUSY" ? "busy" : "io",
      cause,
    });
  }
}

export const acquireNativeAdmissionScoped = Effect.fn("nativeAdmission.acquireScoped")(function* (
  homeDirectory: string,
) {
  const userHomeDirectory = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        acquireNativeAdmission(homeDirectory, {
          userHomeDirectory,
          localAppData:
            environment.LOCALAPPDATA ?? NodePath.join(userHomeDirectory, "AppData", "Local"),
        }),
      catch: (cause) =>
        isNativeAdmissionError(cause) ? cause : new NativeAdmissionError({ reason: "io", cause }),
    }),
    (lease) => Effect.sync(lease.close),
  );
});
