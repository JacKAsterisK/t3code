// @effect-diagnostics nodeBuiltinImport:off - Read-only source inspection; no Git mutation, hook or fetch is requested.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Vendored .repos files are read-only references and cannot be imported by builds.
// Links still require exact approval rather than following an arbitrary target.
export const APPROVED_NONBUILD_SOURCE_ENTRIES = Object.freeze([
  Object.freeze({
    path: ".claude/skills",
    mode: "120000" as const,
    blob: "2b7a412b8fa0fb7e985b0793321bd4e698f2b6cd",
  }),
  Object.freeze({
    path: ".repos/alchemy-effect/submodules/distilled",
    mode: "160000" as const,
    blob: "e02e9d405b8848909f4f746b61b12a663f631c7c",
  }),
  Object.freeze({
    path: ".repos/alchemy-effect/submodules/floci",
    mode: "160000" as const,
    blob: "493909133db04153348eabc503f4e30cf0033d96",
  }),
]);
export interface SourceSnapshotExclusion {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
}
function isReferenceSourceEntry(entry: SourceSnapshotExclusion) {
  return (
    entry.path.startsWith(".repos/") &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    /^[a-f0-9]{40}$/u.test(entry.blob) &&
    entry.path
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== ".." && !/[\\\0]/u.test(part))
  );
}

export function assertSourceSnapshotExclusions(exclusions: readonly SourceSnapshotExclusion[]) {
  let previous = "";
  for (const entry of exclusions) {
    const approved = APPROVED_NONBUILD_SOURCE_ENTRIES.find(
      (candidate) => candidate.path === entry.path,
    );
    if (
      entry.path <= previous ||
      (!isReferenceSourceEntry(entry) &&
        (!approved || entry.mode !== approved.mode || entry.blob !== approved.blob))
    )
      throw new Error(
        "Source snapshot exclusion differs from the exact reviewed non-build inventory.",
      );
    previous = entry.path;
  }
}
export function partitionTrackedSourceEntries(index: string) {
  const files: {
    readonly path: string;
    readonly mode: "100644" | "100755";
    readonly blob: string;
  }[] = [];
  const exclusions: SourceSnapshotExclusion[] = [];
  const names = new Set<string>();
  const rows = index.split("\0").filter(Boolean);
  if (!rows.length || rows.length > 100000) throw new Error("Source index is empty or oversized.");
  for (const row of rows) {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t(.+)$/su.exec(row);
    if (!match) throw new Error("Source snapshot requires reviewed stage-zero tracked entries.");
    const entry = { path: match[3]!, mode: match[1]!, blob: match[2]! };
    const name = entry.path.toLowerCase();
    if (names.has(name)) throw new Error("Source index has duplicate or ambiguous paths.");
    names.add(name);
    const approved = APPROVED_NONBUILD_SOURCE_ENTRIES.find(
      (candidate) => candidate.path.toLowerCase() === name,
    );
    if (
      approved ||
      name.startsWith(".repos/") ||
      entry.mode === "120000" ||
      entry.mode === "160000"
    ) {
      assertSourceSnapshotExclusions([entry]);
      exclusions.push(entry);
    } else {
      files.push({ ...entry, mode: entry.mode as "100644" | "100755" });
    }
  }
  const compare = (left: SourceSnapshotExclusion, right: SourceSnapshotExclusion) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  files.sort(compare);
  exclusions.sort(compare);
  assertSourceSnapshotExclusions(exclusions);
  return { files, exclusions };
}

export const sourceGitEnvironment = (environment: NodeJS.ProcessEnv) => ({
  ...Object.fromEntries(Object.entries(environment).filter(([name]) => !/^git_/iu.test(name))),
  GIT_NO_LAZY_FETCH: "1",
});

export async function readCommittedSourceBlobs(
  root: string,
  ids: readonly string[],
  limits: { readonly maxBlobBytes?: number; readonly maxTotalBytes?: number } = {},
): Promise<ReadonlyMap<string, Uint8Array>> {
  const maxBlobBytes = limits.maxBlobBytes ?? 256 * 1024 ** 2;
  const maxTotalBytes = limits.maxTotalBytes ?? 2 * 1024 ** 3;
  if (
    !ids.length ||
    ids.length > 100000 ||
    ids.some((id) => !/^[a-f0-9]{40}$/u.test(id)) ||
    !Number.isSafeInteger(maxBlobBytes) ||
    maxBlobBytes < 0 ||
    maxBlobBytes > 256 * 1024 ** 2 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < 0 ||
    maxTotalBytes > 2 * 1024 ** 3
  )
    throw new Error("Committed blob requests require bounded SHA-1 object identities.");
  if ((await inspectSourceGit(root, ["rev-parse", "--show-object-format"])) !== "sha1")
    throw new Error("Committed source snapshots require the reviewed SHA-1 Git object format.");
  const child = NodeChildProcess.spawn(
    "git",
    [
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "--work-tree",
      root,
      "cat-file",
      "--batch",
    ],
    {
      cwd: root,
      env: sourceGitEnvironment(process.env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let failed = false;
  let stderrBytes = 0;
  child.once("error", () => {
    failed = true;
  });
  child.stdin.on("error", () => {
    failed = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 16384) {
      failed = true;
      try {
        child.kill();
      } catch {
        /* Cleanup still closes the captured child's pipes. */
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const iterator = child.stdout[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array();
  let offset = 0;
  const available = async () => {
    while (offset === chunk.length) {
      const next = await iterator.next();
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array)) throw new Error("Invalid binary Git blob output.");
      chunk = next.value;
      offset = 0;
    }
    return true;
  };
  const byte = async () => ((await available()) ? chunk[offset++]! : undefined);
  let complete = false;
  try {
    const result = new Map<string, Uint8Array>();
    let total = 0;
    for (const id of new Set(ids)) {
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(id + "\n", (error) =>
          error ? reject(new Error("Git refused a committed blob request.")) : resolve(),
        ),
      );
      const header: number[] = [];
      for (;;) {
        const value = await byte();
        if (value === undefined || value > 127 || header.length >= 128)
          throw new Error("Git returned an incomplete or oversized blob header.");
        if (value === 10) break;
        header.push(value);
      }
      const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/u.exec(
        Buffer.from(header).toString("ascii"),
      );
      const length = Number(match?.[2]);
      if (
        !match ||
        match[1] !== id ||
        !Number.isSafeInteger(length) ||
        length > maxBlobBytes ||
        total + length > maxTotalBytes
      )
        throw new Error(
          "Git blob identity, type, order or byte bound differs from the committed request.",
        );
      total += length;
      const bytes = Buffer.allocUnsafe(length);
      const hash = NodeCrypto.createHash("sha1").update(`blob ${length}\0`);
      let written = 0;
      while (written < length) {
        if (!(await available())) throw new Error("Git returned an incomplete committed blob.");
        const count = Math.min(length - written, chunk.length - offset);
        const part = chunk.subarray(offset, offset + count);
        bytes.set(part, written);
        hash.update(part);
        offset += count;
        written += count;
      }
      if ((await byte()) !== 10 || hash.digest("hex") !== id)
        throw new Error("Git blob framing or committed content hash differs.");
      result.set(id, bytes);
    }
    child.stdin.end();
    if ((await byte()) !== undefined || (await closed) !== 0 || failed)
      throw new Error("Git did not finish the exact committed blob batch.");
    complete = true;
    return result;
  } catch {
    // Neither blob bytes nor Git diagnostics belong in public error receipts.
    throw new Error("Committed source blob capture failed; no snapshot was accepted.");
  } finally {
    try {
      if (!complete) {
        try {
          child.kill();
        } catch {
          /* Await the captured process even if termination is refused. */
        }
        child.stdin.destroy();
        child.stdout.destroy();
      }
    } finally {
      await closed;
    }
  }
}

export async function inspectSourceGit(
  root: string,
  args: readonly string[],
  environment = process.env,
  execution?: { readonly executable: string; readonly isolatedConfiguration: true },
) {
  if (execution && !NodePath.isAbsolute(execution.executable))
    throw new Error("Captured source inspection requires an absolute Git executable.");
  const gitState = await NodeFSP.lstat(NodePath.join(root, ".git"));
  if (gitState.isSymbolicLink() || (!gitState.isFile() && !gitState.isDirectory()))
    throw new Error("Source inspection requires its own ordinary Git checkout metadata.");
  const read = async (command: readonly string[]) =>
    (
      await execFile(
        execution?.executable ?? "git",
        [
          "--no-optional-locks",
          "--no-replace-objects",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "--work-tree",
          root,
          ...command,
        ],
        {
          cwd: root,
          env: {
            ...sourceGitEnvironment(environment),
            ...(execution
              ? {
                  GIT_CONFIG_NOSYSTEM: "1",
                  GIT_CONFIG_GLOBAL: /^[a-z]:[\\/]/iu.test(execution.executable)
                    ? "NUL"
                    : "/dev/null",
                  GIT_TERMINAL_PROMPT: "0",
                }
              : {}),
          },
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
    ).stdout.trim();
  const graftPath = await read(["rev-parse", "--git-path", "info/grafts"]);
  try {
    await NodeFSP.lstat(NodePath.resolve(root, graftPath));
    throw new Error("Source ancestry cannot use local Git grafts.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return read(args);
}
