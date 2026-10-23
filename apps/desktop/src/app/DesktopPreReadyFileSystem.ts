// @effect-diagnostics nodeBuiltinImport:off -- Effect's Node FileSystem is async, and pre-ready startup must not yield before the Clerk bridge registers its privileged scheme.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

const systemErrorTag = (cause: unknown): PlatformError.SystemErrorTag => {
  switch ((cause as NodeJS.ErrnoException | undefined)?.code) {
    case "EEXIST":
      return "AlreadyExists";
    case "ENOENT":
      return "NotFound";
    case "EACCES":
    case "EPERM":
      return "PermissionDenied";
    default:
      return "Unknown";
  }
};

const syncFs = <A>(method: string, path: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      PlatformError.systemError({
        _tag: systemErrorTag(cause),
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        cause,
      }),
  });

export const inspectOrdinaryDirectoryAncestors = Effect.fn("desktop.profile.inspectAncestors")(
  (directory: string) =>
    syncFs("stat", directory, () => {
      const normalized = (value: string) =>
        value.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
      for (let at = NodePath.resolve(directory); ; at = NodePath.dirname(at)) {
        let state: NodeFS.Stats | undefined;
        try {
          state = NodeFS.lstatSync(at);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        if (
          state !== undefined &&
          (!state.isDirectory() ||
            state.isSymbolicLink() ||
            normalized(NodeFS.realpathSync.native(at)) !== normalized(at))
        )
          throw new Error(
            "LAN desktop profile requires ordinary canonical directories without filesystem links.",
          );
        if (at === NodePath.dirname(at)) return;
      }
    }),
);

/**
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = FileSystem.makeNoop({
  exists: (path) =>
    syncFs("exists", path, () => {
      NodeFS.accessSync(path);
      return true;
    }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
    ),
  readFileString: (path) => syncFs("readFileString", path, () => NodeFS.readFileSync(path, "utf8")),
  makeDirectory: (path, options) =>
    syncFs("makeDirectory", path, () => {
      NodeFS.mkdirSync(path, { recursive: options?.recursive ?? false });
    }),
  writeFileString: (path, data, options) =>
    syncFs("writeFileString", path, () =>
      NodeFS.writeFileSync(path, data, { flag: options?.flag ?? "w" }),
    ),
});

export const layer = Layer.succeed(FileSystem.FileSystem, make);
