// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

export function vitePlusCommand(
  args: ReadonlyArray<string>,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime; tests pass the platform explicitly.
  platform: NodeJS.Platform = process.platform,
): [command: string, args: Array<string>] {
  // Windows cannot spawn the package manager's vp.cmd shim without a shell.
  // Use Vite+'s exported JS entry with this Node instead, keeping paths and
  // arguments literal. Resolve here, not from the patch check's temporary cwd.
  if (platform === "win32") {
    return [
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")), ...args],
    ];
  }
  return ["vp", [...args]];
}

/** Leave room for Node, the CLI path and flags under Windows' command-line limit. */
export function batchFileArguments(
  files: ReadonlyArray<string>,
  budget = 20_000,
): Array<Array<string>> {
  const batches: Array<Array<string>> = [];
  let batch: Array<string> = [];
  let size = 0;
  for (const file of files) {
    const cost = JSON.stringify(file).length + 1;
    if (cost > budget) throw new Error("A file argument exceeds the command-line budget.");
    if (size + cost > budget) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(file);
    size += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
