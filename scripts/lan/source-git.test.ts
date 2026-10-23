// @effect-diagnostics nodeBuiltinImport:off - Read-only checkout inspection plus disposable Git history fixtures; no fetch or application process.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import {
  inspectSourceGit,
  sourceGitEnvironment,
  APPROVED_NONBUILD_SOURCE_ENTRIES,
  partitionTrackedSourceEntries,
  assertSourceSnapshotExclusions,
  readCommittedSourceBlobs,
} from "./source-git.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const removeGitFixture = async (root: string) => {
  const temporaryRoot = NodePath.resolve(NodeOS.tmpdir()) + NodePath.sep;
  if (!NodePath.resolve(root).startsWith(temporaryRoot))
    throw new Error("Git fixture escaped its captured temporary root.");
  await NodeFSP.rm(root, { recursive: true, force: true });
};

it("omits only the exact reviewed agent link and reference gitlinks while retaining their object inventory", () => {
  const regular = { path: "scripts/build.ts", blob: "a".repeat(40), mode: "100644" };
  const index = [...APPROVED_NONBUILD_SOURCE_ENTRIES, regular]
    .toReversed()
    .map((entry) => `${entry.mode} ${entry.blob} 0\t${entry.path}\0`)
    .join("");
  const selected = partitionTrackedSourceEntries(index);
  expect(selected.files).toEqual([regular]);
  expect(selected.exclusions).toEqual(APPROVED_NONBUILD_SOURCE_ENTRIES);
  expect(() => assertSourceSnapshotExclusions(selected.exclusions)).not.toThrow();
});

it("refuses changed non-build references, unknown links, case aliases and unmerged index entries", () => {
  const known = APPROVED_NONBUILD_SOURCE_ENTRIES[0]!;
  for (const entry of [
    { ...known, blob: "f".repeat(40) },
    { ...known, mode: "100644" },
    { ...known, path: ".CLAUDE/skills" },
    { ...known, path: ".claude/other" },
    { ...known, path: ".repos/another", mode: "160000" },
  ])
    expect(() =>
      partitionTrackedSourceEntries(`${entry.mode} ${entry.blob} 0\t${entry.path}\0`),
    ).toThrow();
  expect(() => partitionTrackedSourceEntries(`100644 ${"a".repeat(40)} 2\tconflicted\0`)).toThrow();
  expect(() =>
    partitionTrackedSourceEntries(
      [`100644 ${"a".repeat(40)} 0\tA.ts\0`, `100644 ${"b".repeat(40)} 0\ta.ts\0`].join(""),
    ),
  ).toThrow();
  expect(() =>
    assertSourceSnapshotExclusions(APPROVED_NONBUILD_SOURCE_ENTRIES.toReversed()),
  ).toThrow();
  expect(() => assertSourceSnapshotExclusions([known, known])).toThrow();
});

it("classifies the actual tracked checkout without following or initializing non-build entries", async () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const selected = partitionTrackedSourceEntries(
    await inspectSourceGit(root, ["ls-files", "--stage", "-z"]),
  );
  expect(selected.files.some((entry) => entry.path === "scripts/build-desktop-artifact.ts")).toBe(
    true,
  );
  expect(selected.exclusions).toEqual(APPROVED_NONBUILD_SOURCE_ENTRIES);
});

it("removes repository/index/config overrides without exposing unrelated environment values", () => {
  expect(
    sourceGitEnvironment({
      Path: "fixture-tools",
      SystemRoot: "fixture-system",
      GIT_DIR: "other-repo",
      GIT_WORK_TREE: "other-tree",
      GIT_INDEX_FILE: "other-index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "other-tree",
      git_object_directory: "other-objects",
      GIT_NO_LAZY_FETCH: "0",
    }),
  ).toEqual({ Path: "fixture-tools", SystemRoot: "fixture-system", GIT_NO_LAZY_FETCH: "1" });
});

it("streams committed binary and empty blobs through one batch without trimming or duplicating their bytes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-git-blobs-"));
  const git = async (...args: string[]) =>
    (
      await execFile(
        "git",
        ["-c", "core.hooksPath=" + NodePath.join(root, "disabled-hooks"), ...args],
        { cwd: root, env: sourceGitEnvironment(process.env), windowsHide: true },
      )
    ).stdout.trim();
  try {
    await git("init", "--quiet");
    const binary = Buffer.from([0, 255, 128, 10, 32, 10]);
    await NodeFSP.writeFile(NodePath.join(root, "binary.fixture"), binary);
    await NodeFSP.writeFile(NodePath.join(root, "empty.fixture"), "");
    const id = await git("hash-object", "-w", "binary.fixture");
    const empty = await git("hash-object", "-w", "empty.fixture");
    const blobs = await readCommittedSourceBlobs(root, [id, empty, id]);
    expect([...blobs.keys()]).toEqual([id, empty]);
    expect(Buffer.from(blobs.get(id)!)).toEqual(binary);
    expect(blobs.get(empty)!.length).toBe(0);
    await expect(
      readCommittedSourceBlobs(root, [id], { maxBlobBytes: binary.length - 1 }),
    ).rejects.toThrow("no snapshot was accepted");
    await expect(
      readCommittedSourceBlobs(root, [empty, id], { maxTotalBytes: binary.length - 1 }),
    ).rejects.toThrow("no snapshot was accepted");
    const tree = await git("write-tree");
    await expect(readCommittedSourceBlobs(root, [tree])).rejects.toThrow(
      "no snapshot was accepted",
    );
    await expect(readCommittedSourceBlobs(root, ["f".repeat(40)])).rejects.toThrow(
      "no snapshot was accepted",
    );
    await expect(readCommittedSourceBlobs(root, [id + "\n"])).rejects.toThrow("bounded SHA-1");
    await expect(readCommittedSourceBlobs(root, [id], { maxBlobBytes: 1024 ** 3 })).rejects.toThrow(
      "bounded SHA-1",
    );
    expect(Buffer.from((await readCommittedSourceBlobs(root, [id])).get(id)!)).toEqual(binary);
  } finally {
    await removeGitFixture(root);
  }
});

it("reads the requested checkout despite conflicting ambient Git repository and index paths", async () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const environment = {
    ...process.env,
    GIT_DIR: NodePath.join(root, ".git-that-does-not-exist"),
    GIT_WORK_TREE: "other-tree",
    GIT_INDEX_FILE: "other-index",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: "other-tree",
  };
  expect(await inspectSourceGit(root, ["rev-parse", "HEAD"], environment)).toMatch(
    /^[a-f0-9]{40}$/u,
  );
});

it("does not accept replacement history or local grafts as upstream ancestry", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lan-git-history-"));
  const git = async (...args: string[]) =>
    (
      await execFile(
        "git",
        [
          "-c",
          "user.name=LAN fixture",
          "-c",
          "user.email=lan-fixture@example.invalid",
          "-c",
          "core.hooksPath=" + NodePath.join(root, "disabled-hooks"),
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        { cwd: root, env: sourceGitEnvironment(process.env), windowsHide: true },
      )
    ).stdout.trim();
  try {
    await git("init", "--quiet");
    await git("commit", "--quiet", "--allow-empty", "-m", "upstream fixture");
    const upstream = await git("rev-parse", "HEAD");
    const tree = await git("rev-parse", "HEAD^{tree}");
    const unrelated = await git("commit-tree", tree, "-m", "unrelated fork fixture");
    const replacement = await git("commit-tree", tree, "-p", upstream, "-m", "replacement fixture");
    await git("replace", unrelated, replacement);
    await git("merge-base", "--is-ancestor", upstream, unrelated);
    await expect(
      inspectSourceGit(root, ["merge-base", "--is-ancestor", upstream, unrelated]),
    ).rejects.toThrow();
    await NodeFSP.writeFile(
      NodePath.join(root, ".git", "info", "grafts"),
      `${unrelated} ${upstream}\n`,
    );
    await expect(inspectSourceGit(root, ["rev-parse", "HEAD"])).rejects.toThrow(
      /local Git grafts/u,
    );
  } finally {
    await removeGitFixture(root);
  }
});
