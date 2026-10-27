// @effect-diagnostics nodeBuiltinImport:off - Isolated local Git remotes reproduce concurrent pin releases and lost push acknowledgements without touching production repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { expect, it } from "vite-plus/test";
import { syncPortalReleasePinCommit, type PortalReleasePinSync } from "./release-git-pins.ts";

const file = "scripts/publishPinnedT3CodeLanArtifact.js";
const hash = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const pinSource = (version: number) => `const artifactId = '${String(version).repeat(64)}';
export const PINNED_T3_RELEASE = Object.freeze({ artifactId, files: Object.freeze([
Object.freeze({ option: '--bundle', name: 'T3CodeLAN-1.0.${version}-win-x64.zip', byteLength: ${600 + version}, sha256: artifactId }),
Object.freeze({ option: '--metadata', name: 't3code-lan-portal-metadata.json', byteLength: 780, sha256: '${"a".repeat(64)}' }),
Object.freeze({ option: '--activation-policy', name: 't3code-lan-activation-policy.json', byteLength: 422, sha256: '${"b".repeat(64)}' })
]) });
export function publish() { return 'unchanged behavior'; }
`;

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pin-sync-"));
  const repo = NodePath.join(root, "owned"),
    remote = NodePath.join(root, "remote"),
    other = NodePath.join(root, "other");
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git.exe", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  NodeChildProcess.execFileSync("git.exe", ["init", "--bare", "--initial-branch=main", remote], {
    windowsHide: true,
    stdio: "ignore",
  });
  await NodeFSP.mkdir(repo);
  git(repo, "init", "--initial-branch=main");
  const configure = (cwd: string) => {
    git(cwd, "config", "user.name", "Synthetic");
    git(cwd, "config", "user.email", "synthetic@example.invalid");
    git(cwd, "config", "commit.gpgSign", "false");
    git(cwd, "config", "core.hooksPath", NodePath.join(root, "no-hooks"));
  };
  configure(repo);
  await NodeFSP.mkdir(NodePath.join(repo, "scripts"));
  await NodeFSP.writeFile(NodePath.join(repo, file), pinSource(1));
  git(repo, "add", "--", file);
  git(repo, "commit", "-m", "base");
  const parent = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  NodeChildProcess.execFileSync("git.exe", ["clone", remote, other], {
    windowsHide: true,
    stdio: "ignore",
  });
  configure(other);
  await NodeFSP.writeFile(NodePath.join(repo, file), pinSource(2));
  git(repo, "add", "--", file);
  git(repo, "commit", "-m", "owned pins");
  const originalCommit = git(repo, "rev-parse", "HEAD"),
    counter = NodePath.join(root, "verified");
  const options: PortalReleasePinSync = {
    repositoryRoot: repo,
    expectedRemoteUrl: remote,
    originalCommit,
    expectedParentCommit: parent,
    beforeSha256: hash(pinSource(1)),
    afterSha256: hash(pinSource(2)),
    verify: {
      executable: process.execPath,
      args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(counter)},'x')`],
    },
    journalPath: NodePath.join(root, "operation.json"),
  };
  return {
    root,
    repo,
    remote,
    other,
    git,
    options,
    counter,
    async advanceRemote(path = "story.txt", content = "other work") {
      await NodeFSP.writeFile(NodePath.join(other, path), content);
      git(other, "add", "--", path);
      git(other, "commit", "-m", "other work");
      git(other, "push", "origin", "main");
      return git(other, "rev-parse", "HEAD");
    },
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("rebases only reviewed pin literals onto unrelated remote work and verifies the combined tree before normal push", async () => {
  await using f = await fixture();
  const remote = await f.advanceRemote();
  expect(
    NodeChildProcess.spawnSync("git.exe", ["-C", f.repo, "push", "origin", "main"], {
      windowsHide: true,
      stdio: "ignore",
    }).status,
  ).not.toBe(0);
  const result = JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {syncPortalReleasePinCommit} from ${JSON.stringify(new URL("./release-git-pins.ts", import.meta.url).href)};console.log(JSON.stringify(await syncPortalReleasePinCommit(${JSON.stringify(f.options)})));`,
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  expect(result.sourceCommit).toBe(f.git(f.remote, "rev-parse", "refs/heads/main"));
  expect(f.git(f.repo, "show", "-s", "--format=%P", result.sourceCommit)).toBe(remote);
  expect(f.git(f.repo, "show", result.sourceCommit + ":story.txt")).toBe("other work");
  expect(f.git(f.repo, "show", result.sourceCommit + ":" + file)).toBe(pinSource(2).trim());
  expect(await NodeFSP.readFile(f.counter, "utf8")).toBe("x");
  expect(f.git(f.repo, "status", "--porcelain")).toBe("");
});

it("refuses a competing remote release even if its pin change was reverted", async () => {
  await using f = await fixture();
  await f.advanceRemote(file, pinSource(3));
  await f.advanceRemote(file, pinSource(1));
  await expect(syncPortalReleasePinCommit(f.options)).rejects.toThrow(
    "Competing Portal release pin changed",
  );
  expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(f.options.originalCommit);
  await expect(NodeFSP.stat(f.counter)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses executable or unowned changes and dirty worktrees before publication", async () => {
  await using f = await fixture();
  const altered = pinSource(2).replace("unchanged behavior", "new executable behavior");
  await NodeFSP.writeFile(NodePath.join(f.repo, file), altered);
  f.git(f.repo, "add", "--", file);
  f.git(f.repo, "commit", "--amend", "--no-edit");
  await expect(
    syncPortalReleasePinCommit({
      ...f.options,
      originalCommit: f.git(f.repo, "rev-parse", "HEAD"),
      afterSha256: hash(altered),
    }),
  ).rejects.toThrow("executable code");
  await NodeFSP.writeFile(NodePath.join(f.repo, "unowned.txt"), "pending work");
  await expect(syncPortalReleasePinCommit(f.options)).rejects.toThrow("clean worktree");
});

it("reconciles an unacknowledged successful push and remote fast-forward without publishing a duplicate commit", async () => {
  await using f = await fixture();
  const first = await syncPortalReleasePinCommit(f.options);
  const journal = JSON.parse(await NodeFSP.readFile(f.options.journalPath, "utf8"));
  journal.step = "pushing";
  await NodeFSP.writeFile(f.options.journalPath, JSON.stringify(journal));
  f.git(f.other, "pull", "--ff-only");
  const advanced = await f.advanceRemote();
  const second = await syncPortalReleasePinCommit(f.options);
  expect(second.alreadyPublished).toBe(true);
  expect(second.sourceCommit).toBe(advanced);
  expect(f.git(f.remote, "rev-list", "--count", first.sourceCommit + "..refs/heads/main")).toBe(
    "1",
  );
  expect(await NodeFSP.readFile(f.counter, "utf8")).toBe("xx");
});

it("retains a failed verification journal and never pushes unverified pins", async () => {
  await using f = await fixture();
  const options = {
    ...f.options,
    verify: { executable: process.execPath, args: ["-e", "process.exit(9)"] },
  };
  await expect(syncPortalReleasePinCommit(options)).rejects.toThrow();
  expect(f.git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.options.expectedParentCommit);
  expect(JSON.parse(await NodeFSP.readFile(options.journalPath, "utf8")).step).toBe("verifying");
});

it("serializes one repository even when callers use different recovery journals", async () => {
  await using f = await fixture();
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connected = new Promise<NodeNet.Socket>((resolve) => server.once("connection", resolve));
  const address = server.address() as NodeNet.AddressInfo;
  const options = {
    ...f.options,
    verify: {
      executable: process.execPath,
      args: [
        "-e",
        `const socket=require('node:net').connect(${address.port},'127.0.0.1');socket.once('data',()=>socket.end());`,
      ],
    },
  };
  const first = syncPortalReleasePinCommit(options);
  const socket = await connected;
  try {
    await expect(
      syncPortalReleasePinCommit({
        ...options,
        journalPath: NodePath.join(f.root, "other-operation.json"),
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  } finally {
    socket.end("continue");
    await first;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
