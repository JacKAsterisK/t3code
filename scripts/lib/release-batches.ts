// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Standalone Node runner and durable receipt timestamp.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeURL from "node:url";

export const releaseBatchTask = "lan-release-batch";
export const releaseBatchRequest = "T3_LAN_RELEASE_BATCH";

export function digest(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fileDigest(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

export function explicitBatchInputs(root: string, files: readonly string[]) {
  try {
    return files.map((file) => [file, fileDigest(NodePath.join(root, file))]);
  } catch {
    return undefined;
  }
}

const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;

export const releaseNodePath = () => NodeFS.realpathSync(process.execPath);
export const releaseEnvName = "T3_LAN_BATCH_ENVIRONMENT";
export const serializeReleaseEnvironment = (env: NodeJS.ProcessEnv) => JSON.stringify(env);

export function releaseBatchEnvironment(env: NodeJS.ProcessEnv) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) =>
          value !== undefined &&
          !/^(?:CLAUDE_|CLAUDECODE$|CODEX_|T3CODE_THREAD_ID$|WT_SESSION$|VP_RUN_IPC_NAME$|VP_RUN_NODE_CLIENT_PATH$|VP_PATH_INJECTED_TOOLS$|VITE_CACHE_PATH$|T3_LAN_RELEASE_BATCH$|T3_LAN_BATCH_ENVIRONMENT$|NODE_OPTIONS$|VP_REMOTE_CACHE$|VP_REMOTE_CACHE_URL$|T3_TASK_CACHE_TELEMETRY$|npm_config_offline$)/iu.test(
            key,
          ),
      ),
    ),
    NODE_OPTIONS: "",
    VP_REMOTE_CACHE: "off",
    VP_REMOTE_CACHE_URL: "",
    T3_TASK_CACHE_TELEMETRY: "off",
    npm_config_offline: "true",
  };
}

const derivedInstallCaches = new Set([".cache", ".vite", ".vite-temp", ".vitest-cache"]);

// Hash physical package bytes once per invocation. Keep pnpm junction
// identities, and visit a linked package only once even when many import it.
export async function installedInputDigest(root: string, workspaces: readonly string[]) {
  root = await NodeFSP.realpath(root);
  const workspaceRoots = new Set(workspaces.map((dir) => NodePath.join(root, dir)));
  const visited = new Set<string>();
  const files: string[] = [];
  const records: Array<[string, string]> = [];
  async function walk(directory: string) {
    if (visited.has(directory)) return;
    visited.add(directory);
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (NodePath.basename(directory) === "node_modules" && derivedInstallCaches.has(entry.name))
        continue;
      const file = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await NodeFSP.realpath(file);
        records.push([file, target]);
        if (workspaceRoots.has(target)) continue;
        if ((await NodeFSP.stat(target)).isDirectory()) await walk(target);
        else files.push(target);
      } else if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile()) {
        files.push(file);
      } else {
        throw new Error(`Unsupported installed input: ${file}`);
      }
    }
  }
  for (const workspace of ["", ...workspaces]) {
    const modules = NodePath.join(root, workspace, "node_modules");
    if (NodeFS.existsSync(modules)) {
      const real = await NodeFSP.realpath(modules);
      records.push([modules, real]);
      await walk(real);
    }
  }
  return digest(
    records
      .concat(await contentRows(files))
      .sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y)),
  );
}

async function contentRows(files: readonly string[]) {
  const sorted = [...new Set(files)].sort();
  const hashes: Array<[string, string]> = [];
  for (let index = 0; index < sorted.length; index += 64) {
    hashes.push(
      ...(await Promise.all(
        sorted.slice(index, index + 64).map(async (file): Promise<[string, string]> => [
          file,
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(file))
            .digest("hex"),
        ]),
      )),
    );
  }
  return hashes;
}

export async function trackedInputDigest(root: string, index: string) {
  const rows = index.split("\0").filter(Boolean);
  const files: string[] = [];
  const links: Array<[string, string]> = [];
  for (const row of rows) {
    const match = /^(100644|100755|120000|160000) [a-f0-9]+ 0\t(.+)$/su.exec(row);
    if (!match) throw new Error("Release receipt requires stage-zero Git entries.");
    const file = NodePath.join(root, match[2]!);
    // The Git cleanliness check verifies submodule revisions separately.
    if (match[1] === "160000") continue;
    if (match[1] === "120000") {
      const stat = NodeFS.lstatSync(file);
      if (stat.isSymbolicLink()) {
        links.push([file, NodeFS.readlinkSync(file)]);
        continue;
      }
    }
    files.push(file);
  }
  return digest([links, await contentRows(files)]);
}
function directoryInventory(directory: string): Array<unknown> {
  return NodeFS.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const path = NodePath.join(directory, entry.name);
      if (entry.isFile()) return [entry.name, "file", fileDigest(path)];
      if (entry.isDirectory()) return [entry.name, "directory", directoryInventory(path)];
      throw new Error(`External input directory contains an unsupported link or entry: ${path}`);
    });
}

export function releaseRuntime(
  root: string,
  host: { platform: NodeJS.Platform; arch: NodeJS.Architecture },
  environment: NodeJS.ProcessEnv,
  inventory?: string,
) {
  const env = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  const external: Array<unknown> = [];
  if (inventory) {
    const input = JSON.parse(NodeFS.readFileSync(inventory, "utf8")) as Array<{
      path?: string;
      kind?: string;
      sha256?: string;
    }> | null;
    if (!Array.isArray(input) || input.length === 0)
      throw new Error("Expected an approved external input inventory.");
    for (const row of input) {
      if (typeof row?.path !== "string" || !NodePath.isAbsolute(row.path))
        throw new Error("Expected an absolute release input path.");
      const path = NodePath.resolve(row.path);
      const kind = row.kind ?? "file";
      if (kind === "absent") {
        if (NodeFS.lstatSync(path, { throwIfNoEntry: false }))
          throw new Error(`Previously absent release input exists: ${path}`);
        external.push([path, kind, NodeFS.realpathSync(NodePath.dirname(path))]);
        continue;
      }
      if ((kind !== "file" && kind !== "directory") || !row.sha256 || !sha256.test(row.sha256))
        throw new Error(`Invalid release input pin: ${path}`);
      const real = NodeFS.realpathSync(path);
      const current = kind === "directory" ? digest(directoryInventory(real)) : fileDigest(real);
      if (current !== row.sha256) throw new Error(`Release input changed: ${path}`);
      external.push([path, real, kind, current]);
    }
  }
  const pathVariable = env.find(([name]) => name.toUpperCase() === "PATH")?.[1];
  const gitName = host.platform === "win32" ? "git.exe" : "git";
  const gitPath = pathVariable
    ?.split(NodePath.delimiter)
    .map((dir) => NodePath.resolve(dir.replaceAll('"', ""), gitName))
    .find((file) => NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile());
  if (!gitPath) throw new Error("The release gate requires Git on PATH.");
  const gitConfig = NodeChildProcess.execFileSync(
    gitPath,
    ["config", "--null", "--list", "--show-origin"],
    {
      cwd: root,
      env: environment,
      encoding: "utf8",
    },
  );
  return digest({
    ...host,
    os: NodeOS.version(),
    release: NodeOS.release(),
    root: NodeFS.realpathSync(root),
    node: [NodeFS.realpathSync(process.execPath), fileDigest(process.execPath), process.versions],
    git: [NodeFS.realpathSync(gitPath), fileDigest(gitPath), gitConfig],
    vitePlus: fileDigest(NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin"))),
    lockfiles: ["pnpm-lock.yaml", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"].map(
      (file) => [file, fileDigest(NodePath.join(root, file))],
    ),
    env,
    external,
  });
}
const receiptVersion = 2;
const attemptId = /^[a-f0-9-]{36}$/;

export function invalidateBatchAttempt(directory: string, attempt: string) {
  NodeFS.mkdirSync(directory, { recursive: true });
  atomicJson(NodePath.join(directory, `${attempt}.invalid.json`), { attempt });
}

function validAttempt(directory: string, attempt: unknown) {
  return (
    typeof attempt === "string" &&
    attemptId.test(attempt) &&
    !NodeFS.lstatSync(NodePath.join(directory, `${attempt}.invalid.json`), {
      throwIfNoEntry: false,
    })
  );
}
interface Receipt {
  version: number;
  key: string;
  sourceCommit: string;
  batch: string;
  completedUtc: string;
  attempt: string;
  outputSha256: string;
}

export function readBatchReceipt(directory: string, key: string, sourceCommit: string) {
  if (!sha256.test(key) || !commit.test(sourceCommit)) return;
  try {
    const value: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, `${key}.json`), "utf8"),
    );
    if (typeof value !== "object" || value === null) return;
    const receipt = value as Partial<Receipt>;
    if (
      receipt.version === receiptVersion &&
      receipt.key === key &&
      receipt.sourceCommit === sourceCommit &&
      validAttempt(directory, receipt.attempt) &&
      typeof receipt.completedUtc === "string" &&
      Number.isFinite(Date.parse(receipt.completedUtc)) &&
      typeof receipt.outputSha256 === "string" &&
      sha256.test(receipt.outputSha256)
    )
      return receipt;
  } catch {
    // Unreadable or incomplete evidence never counts as a pass.
  }
}

export function writeBatchReceipt(
  directory: string,
  key: string,
  sourceCommit: string,
  batch: string,
  output: string,
  attempt: string,
) {
  if (!sha256.test(key) || !commit.test(sourceCommit)) throw new Error("Invalid batch identity.");
  NodeFS.mkdirSync(directory, { recursive: true });
  const target = NodePath.join(directory, `${key}.json`);
  const receipt: Receipt = {
    version: receiptVersion,
    key,
    sourceCommit,
    batch,
    attempt,
    completedUtc: new Date().toISOString(),
    outputSha256: NodeCrypto.createHash("sha256").update(output).digest("hex"),
  };
  atomicJson(target, receipt);
  return receipt;
}

interface NativeEvidence {
  directory: string;
  database: string;
  sha256: string;
}

function atomicJson(target: string, value: unknown) {
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx" });
  NodeFS.renameSync(temporary, target);
}

export function beginBatchTrace(receipts: string, key: string) {
  const directory = NodePath.join(receipts, "traces", key);
  NodeFS.mkdirSync(directory, { recursive: true });
  const pointer = NodePath.join(directory, "pass.json");
  const createAttempt = () => NodeFS.mkdtempSync(NodePath.join(directory, "attempt-"));
  let attempt = createAttempt();
  let priorCommit: string | undefined;
  try {
    const previous = JSON.parse(NodeFS.readFileSync(pointer, "utf8")) as Partial<NativeEvidence> & {
      sourceCommit?: string;
      attempt?: string;
    };
    if (
      previous &&
      typeof previous.directory === "string" &&
      /^attempt-[A-Za-z0-9]+$/.test(previous.directory) &&
      typeof previous.database === "string" &&
      /^v\d+\/cache\.db$/.test(previous.database) &&
      typeof previous.sourceCommit === "string" &&
      commit.test(previous.sourceCommit) &&
      validAttempt(receipts, previous.attempt)
    ) {
      const original = NodePath.join(directory, previous.directory, previous.database);
      if (fileDigest(original) === previous.sha256) {
        const target = NodePath.join(attempt, previous.database);
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
        NodeFS.copyFileSync(original, target, NodeFS.constants.COPYFILE_EXCL);
        if (fileDigest(target) === previous.sha256) priorCommit = previous.sourceCommit;
        else attempt = createAttempt();
      }
    }
  } catch {
    // A partial attempt or cache without sealed evidence cannot supply a pass.
    attempt = createAttempt();
  }

  function outcome(): "reused" | "tracked" | "untracked" | undefined {
    try {
      const version = NodeFS.readdirSync(attempt).filter((entry) => /^v\d+$/.test(entry));
      if (version.length !== 1) return;
      const summary = JSON.parse(
        NodeFS.readFileSync(NodePath.join(attempt, version[0]!, "last-summary.json"), "utf8"),
      ) as {
        tasks?: Array<{
          task_name?: string;
          result?: {
            CacheHit?: { source?: string };
            Spawned?: {
              outcome?: {
                Success?: {
                  infra_error?: null | string;
                  fspy_unsupported?: boolean;
                  tracking_incomplete?: boolean;
                  tool_disabled_cache?: boolean;
                  ipc_server_error?: null | string;
                  input_modified?: unknown;
                };
              };
            };
          };
        }>;
        exit_code?: number;
      };
      if (summary.exit_code !== 0 || summary.tasks?.length !== 1) return;
      const task = summary.tasks[0]!;
      if (task.task_name !== releaseBatchTask) return;
      if (task.result?.CacheHit?.source === "Local" && priorCommit) return "reused";
      const success = task.result?.Spawned?.outcome?.Success;
      if (!success) return;
      return success.fspy_unsupported === false &&
        success.tracking_incomplete === false &&
        success.tool_disabled_cache === false &&
        success.infra_error === null &&
        success.ipc_server_error === null &&
        success.input_modified === null
        ? "tracked"
        : "untracked";
    } catch {
      // A missing or different native summary cannot certify a scoped pass.
    }
  }
  return {
    path: attempt,
    priorCommit,
    outcome,
    seal(sourceCommit: string, gateAttempt: string) {
      const mode = outcome();
      if (mode !== "tracked" && mode !== "reused") return;
      const version = NodeFS.readdirSync(attempt).find((entry) => /^v\d+$/.test(entry));
      const database = `${version}/cache.db`;
      if (!NodeFS.existsSync(NodePath.join(attempt, database))) return;
      atomicJson(pointer, {
        sourceCommit,
        attempt: gateAttempt,
        directory: NodePath.basename(attempt),
        database,
        sha256: fileDigest(NodePath.join(attempt, database)),
      });
    },
  };
}

export function encodeReleaseBatch(value: {
  context: string;
  arguments: readonly string[];
  node: string;
  environmentKey: string;
}) {
  return NodeZlib.deflateRawSync(JSON.stringify(value)).toString("base64url");
}

export function decodeReleaseBatch(encoded: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid release batch encoding.");
  return JSON.parse(
    NodeZlib.inflateRawSync(Buffer.from(encoded, "base64url"), {
      maxOutputLength: 100_000,
    }).toString("utf8"),
  );
}

export function releaseBatchConfig(encoded: string | undefined) {
  if (!encoded) return {};
  const request = decodeReleaseBatch(encoded);
  if (
    typeof request !== "object" ||
    request === null ||
    !("context" in request) ||
    typeof request.context !== "string" ||
    !sha256.test(request.context) ||
    !("arguments" in request) ||
    !Array.isArray(request.arguments) ||
    !request.arguments.every((argument): argument is string => typeof argument === "string") ||
    !("node" in request) ||
    typeof request.node !== "string" ||
    !NodePath.isAbsolute(request.node) ||
    !("environmentKey" in request) ||
    typeof request.environmentKey !== "string" ||
    !sha256.test(request.environmentKey)
  )
    throw new Error("Invalid local release batch request.");
  return {
    [releaseBatchTask]: {
      command: `node scripts/lib/release-batches.ts ${encoded}`,
      cache: {
        input: [
          { auto: true },
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          ".pnpmfile.cjs",
          "**/package.json",
          "**/vite.config.*",
          "**/tsconfig*.json",
          "!**/node_modules/.vitest-cache/**",
        ],
        output: [],
        // The parent fingerprints the environment before passing it through.
        untrackedEnv: [releaseEnvName],
      },
    },
  };
}

if (import.meta.main) {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Missing release batch arguments.");
  const request = decodeReleaseBatch(encoded) as {
    arguments: string[];
    node: string;
    environmentKey: string;
  };
  if (NodeFS.realpathSync(process.execPath) !== request.node)
    throw new Error("Traced batch selected a different Node executable.");
  const env = JSON.parse(process.env[releaseEnvName] ?? "null") as NodeJS.ProcessEnv | null;
  if (!env || digest(env) !== request.environmentKey)
    throw new Error("Traced batch did not receive its verified release environment.");
  const executable = NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin"));
  const result = NodeChildProcess.spawnSync(process.execPath, [executable, ...request.arguments], {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
