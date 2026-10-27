// @effect-diagnostics nodeBuiltinImport:off - Reviewed metadata-only Portal commits use durable local intent and normal fast-forward Git pushes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as TypeScript from "typescript-legacy";

const PIN_FILE = "scripts/publishPinnedT3CodeLanArtifact.js";
const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const commitPattern = /^[a-f0-9]{40}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

export interface PortalReleasePinSync {
  repositoryRoot: string;
  expectedRemoteUrl: string;
  originalCommit: string;
  expectedParentCommit: string;
  beforeSha256: string;
  afterSha256: string;
  verify: { executable: string; args: string[] };
  journalPath: string;
}
interface PinSyncJournal {
  schemaVersion: 1;
  requestSha256: string;
  originalCommit: string;
  baseCommit: string;
  pinCommit: string;
  step: "prepared" | "rebasing" | "rebased" | "verifying" | "verified" | "pushing" | "pushed";
  targetBase?: string;
  sourceCommit?: string;
}

function normalizedPinSource(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const source = TypeScript.createSourceFile(
    PIN_FILE,
    text,
    TypeScript.ScriptTarget.Latest,
    true,
    TypeScript.ScriptKind.JS,
  );
  const edits: { start: number; end: number; value: string }[] = [];
  const found = new Set<string>();
  for (const statement of source.statements) {
    if (!TypeScript.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!TypeScript.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (name !== "artifactId" && name !== "PINNED_T3_RELEASE") continue;
      if (found.has(name)) throw new Error("Duplicate Portal pin binding");
      found.add(name);
      const visit = (node: TypeScript.Node) => {
        if (TypeScript.isStringLiteral(node)) {
          let value: string | undefined;
          if (hashPattern.test(node.text)) value = '"<release-sha256>"';
          else if (/^T3CodeLAN-\d+\.\d+\.\d+-win-x64\.zip$/u.test(node.text))
            value = '"<release-bundle-name>"';
          if (value) edits.push({ start: node.getStart(source), end: node.end, value });
        } else if (
          TypeScript.isNumericLiteral(node) &&
          TypeScript.isPropertyAssignment(node.parent) &&
          node.parent.initializer === node &&
          node.parent.name.getText(source) === "byteLength" &&
          Number.isSafeInteger(Number(node.text)) &&
          Number(node.text) > 0 &&
          Number(node.text) <= 2 ** 31
        )
          edits.push({ start: node.getStart(source), end: node.end, value: "0" });
        node.forEachChild(visit);
      };
      if (
        name === "artifactId" &&
        (!TypeScript.isStringLiteral(declaration.initializer) ||
          !hashPattern.test(declaration.initializer.text))
      )
        throw new Error("Invalid Portal artifact pin binding");
      visit(declaration.initializer);
    }
  }
  if (found.size !== 2 || edits.length < 5) throw new Error("Missing Portal release pin bindings");
  let normalized = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    normalized = normalized.slice(0, edit.start) + edit.value + normalized.slice(edit.end);
  return normalized;
}

export async function syncPortalReleasePinCommit(options: PortalReleasePinSync) {
  const root = NodePath.resolve(options.repositoryRoot);
  const journalPath = NodePath.resolve(options.journalPath);
  if (
    root !== options.repositoryRoot ||
    journalPath !== options.journalPath ||
    journalPath === root ||
    journalPath.startsWith(root + NodePath.sep) ||
    !commitPattern.test(options.originalCommit) ||
    !commitPattern.test(options.expectedParentCommit) ||
    !hashPattern.test(options.beforeSha256) ||
    !hashPattern.test(options.afterSha256) ||
    !NodePath.isAbsolute(options.verify.executable)
  )
    throw new Error("Invalid Portal pin sync request");
  if ((await NodeFSP.realpath(root)) !== root)
    throw new Error("Portal repository root must be canonical and physical");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
    delete environment[key];
  const gitBytes = (...args: string[]) =>
    NodeChildProcess.execFileSync("git.exe", ["-C", root, ...args], {
      windowsHide: true,
      maxBuffer: 8 * 1024 ** 2,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
  const git = (...args: string[]) =>
    gitBytes(...args)
      .toString("utf8")
      .trim();
  const assertIdentity = () => {
    if (
      NodePath.resolve(git("rev-parse", "--show-toplevel")) !== root ||
      git("remote", "get-url", "origin") !== options.expectedRemoteUrl ||
      git("branch", "--show-current") !== "main" ||
      git("status", "--porcelain", "--untracked-files=all")
    )
      throw new Error("Portal repository identity or clean worktree changed");
  };
  const blob = (commit: string) => gitBytes("show", commit + ":" + PIN_FILE);
  const assertOwnCommit = (commit: string, parent: string) => {
    if (git("show", "-s", "--format=%P", commit) !== parent)
      throw new Error("Portal recovery requires exactly one owned pin commit");
    if (git("diff", "--no-renames", "--name-only", parent, commit) !== PIN_FILE)
      throw new Error("Portal pin commit contains unowned changes");
    const before = blob(parent),
      after = blob(commit);
    if (sha256(before) !== options.beforeSha256 || sha256(after) !== options.afterSha256)
      throw new Error("Reviewed Portal pin bytes changed");
    if (normalizedPinSource(before) !== normalizedPinSource(after))
      throw new Error("Portal pin commit changes executable code or unapproved literals");
    const mode = (ref: string) => git("ls-tree", ref, "--", PIN_FILE).split(" ")[0];
    if (mode(parent) !== "100644" || mode(commit) !== "100644")
      throw new Error("Portal pin file mode changed");
  };
  const requestSha256 = sha256(JSON.stringify(options));
  const repositoryLockPath = NodePath.join(
    NodeOS.tmpdir(),
    "t3-portal-pin-" + sha256(root) + ".lock",
  );
  const repositoryLock = await NodeFSP.open(repositoryLockPath, "wx");
  let lock: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
  try {
    await repositoryLock.writeFile(JSON.stringify({ pid: process.pid, requestSha256 }));
    assertIdentity();
    assertOwnCommit(options.originalCommit, options.expectedParentCommit);
    await NodeFSP.mkdir(NodePath.dirname(journalPath), { recursive: true });
    lock = await NodeFSP.open(journalPath + ".lock", "wx");
    let state: PinSyncJournal;
    try {
      state = JSON.parse(await NodeFSP.readFile(journalPath, "utf8"));
      if (state.requestSha256 !== requestSha256 || state.originalCommit !== options.originalCommit)
        throw new Error("Portal pin sync request changed during recovery");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (git("rev-parse", "HEAD") !== options.originalCommit)
        throw new Error("Portal HEAD is not the reviewed pin commit", { cause: error });
      state = {
        schemaVersion: 1,
        requestSha256,
        originalCommit: options.originalCommit,
        baseCommit: options.expectedParentCommit,
        pinCommit: options.originalCommit,
        step: "prepared",
      };
    }
    if (
      state.schemaVersion !== 1 ||
      !commitPattern.test(state.pinCommit) ||
      !commitPattern.test(state.baseCommit) ||
      (state.targetBase !== undefined && !commitPattern.test(state.targetBase)) ||
      (state.sourceCommit !== undefined && !commitPattern.test(state.sourceCommit)) ||
      !["prepared", "rebasing", "rebased", "verifying", "verified", "pushing", "pushed"].includes(
        state.step,
      )
    )
      throw new Error("Invalid Portal pin recovery journal");
    assertOwnCommit(state.pinCommit, state.baseCommit);
    git("merge-base", "--is-ancestor", options.expectedParentCommit, state.baseCommit);
    const save = async () => {
      await NodeFSP.writeFile(journalPath + ".new", JSON.stringify(state, null, 2) + "\n", {
        flag: "wx",
      });
      await NodeFSP.rename(journalPath + ".new", journalPath);
    };
    await save();
    for (let attempt = 0; attempt < 3; attempt++) {
      assertIdentity();
      git("fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
      const remote = git("rev-parse", "refs/remotes/origin/main");
      const head = git("rev-parse", "HEAD");
      const containsPin =
        NodeChildProcess.spawnSync(
          "git.exe",
          ["-C", root, "merge-base", "--is-ancestor", state.pinCommit, remote],
          { windowsHide: true, stdio: "ignore", env: environment },
        ).status === 0;
      if (containsPin) {
        if (git("log", "--format=%H", state.pinCommit + ".." + remote, "--", PIN_FILE))
          throw new Error("Competing Portal release pin changed");
        if (head !== state.pinCommit && head !== state.sourceCommit)
          throw new Error("Unowned Portal HEAD changed during recovery");
        git("merge", "--ff-only", remote);
      } else {
        if (head !== state.pinCommit) {
          if (state.step !== "rebasing" || !state.targetBase)
            throw new Error("Unowned Portal HEAD changed during recovery");
          assertOwnCommit(head, state.targetBase);
          state.pinCommit = head;
          state.baseCommit = state.targetBase;
          state.step = "rebased";
          await save();
        }
        assertOwnCommit(state.pinCommit, state.baseCommit);
        git("merge-base", "--is-ancestor", state.baseCommit, remote);
        if (git("log", "--format=%H", state.baseCommit + ".." + remote, "--", PIN_FILE))
          throw new Error("Competing Portal release pin changed");
        if (remote !== state.baseCommit) {
          state.step = "rebasing";
          state.targetBase = remote;
          await save();
          git("rebase", "--onto", remote, state.baseCommit, "main");
          const rebased = git("rev-parse", "HEAD");
          assertOwnCommit(rebased, remote);
          state.pinCommit = rebased;
          state.baseCommit = remote;
          state.step = "rebased";
          await save();
        }
      }
      const verifiedCommit = git("rev-parse", "HEAD");
      state.step = "verifying";
      await save();
      await new Promise<void>((resolve, reject) =>
        NodeChildProcess.execFile(
          options.verify.executable,
          options.verify.args,
          { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 ** 2, env: environment },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      assertIdentity();
      if (
        git("rev-parse", "HEAD") !== verifiedCommit ||
        sha256(blob(verifiedCommit)) !== options.afterSha256
      )
        throw new Error("Verified Portal tree changed before push");
      state.sourceCommit = verifiedCommit;
      state.step = "verified";
      await save();
      if (containsPin && verifiedCommit === remote) {
        if (
          git("ls-remote", "--refs", "origin", "refs/heads/main").split(/\s/u)[0] !== verifiedCommit
        )
          continue;
        state.step = "pushed";
        await save();
        return {
          sourceCommit: verifiedCommit,
          originalCommit: options.originalCommit,
          requestSha256,
          journalPath,
          alreadyPublished: true,
        };
      }
      state.step = "pushing";
      await save();
      try {
        git("push", "origin", verifiedCommit + ":refs/heads/main");
      } catch {
        // A rejected or unacknowledged push is reconciled through the remote ref,
        // never through a forced push or a second unreviewed commit.
        continue;
      }
      if (
        git("ls-remote", "--refs", "origin", "refs/heads/main").split(/\s/u)[0] !== verifiedCommit
      )
        continue;
      state.step = "pushed";
      await save();
      return {
        sourceCommit: verifiedCommit,
        originalCommit: options.originalCommit,
        requestSha256,
        journalPath,
        alreadyPublished: false,
      };
    }
    throw new Error(
      "Portal main kept changing or push acknowledgement is unknown; retained journal requires reconciliation",
    );
  } finally {
    if (lock) {
      await lock.close();
      await NodeFSP.unlink(journalPath + ".lock");
    }
    await repositoryLock.close();
    await NodeFSP.unlink(repositoryLockPath);
  }
}
