// @effect-diagnostics nodeBuiltinImport:off -- Bounded SQLite header reads detect writes without rereading conversation bodies.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export class NativeDataGenerationChanged extends Error {}

export const nativeDataGeneration = (
  databasePath: string,
  safeFile: (file: string) => NodeFS.Stats,
) => {
  const hash = NodeCrypto.createHash("sha256").update("t3-native-data-v2");
  for (const file of [databasePath, `${databasePath}-wal`]) {
    hash.update(NodePath.basename(file));
    let before: NodeFS.Stats;
    try {
      before = safeFile(file);
    } catch (cause) {
      if (
        file.endsWith("-wal") &&
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        hash.update("absent");
        continue;
      }
      throw cause;
    }
    if (file.endsWith("-wal") && before.size === 0) {
      hash.update("absent");
      continue;
    }
    const descriptor = NodeFS.openSync(file, "r");
    try {
      const opened = NodeFS.fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1)
        throw new NativeDataGenerationChanged();
      const read = (offset: number, length: number) => {
        const bytes = Buffer.alloc(length);
        if (NodeFS.readSync(descriptor, bytes, 0, length, offset) !== length)
          throw new NativeDataGenerationChanged();
        hash.update(bytes);
        return bytes;
      };
      hash.update(JSON.stringify([before.size, before.mtimeMs.toFixed(3)]));
      if (file.endsWith("-wal")) {
        const header = read(0, Math.min(32, before.size));
        if (header.length === 32) {
          const pageSize = header.readUInt32BE(8);
          if (pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0) {
            const frames = Math.floor((before.size - 32) / (24 + pageSize));
            if (frames > 0) read(32 + (frames - 1) * (24 + pageSize), 24);
          }
        }
      } else read(0, Math.min(100, before.size));
      const after = safeFile(file);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new NativeDataGenerationChanged();
    } finally {
      NodeFS.closeSync(descriptor);
    }
  }
  return hash.digest("hex");
};
