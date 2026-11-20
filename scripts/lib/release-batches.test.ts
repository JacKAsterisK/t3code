// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Isolated checkout with opt-in wall-time reporting.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  beginBatchTrace,
  digest,
  encodeReleaseBatch,
  readBatchReceipt,
  releaseBatchRequest,
  releaseBatchEnvironment,
  releaseEnvName,
  releaseNodePath,
  releaseBatchTask,
  releaseRuntime,
  writeBatchReceipt,
} from "./release-batches.ts";

test("a failed batch does not invalidate a sealed sibling, and transitive changes rerun", () => {
  const project = NodePath.resolve(import.meta.dirname, "../..");
  const fixture = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lan-batch-retry-"));
  const root = NodePath.join(fixture, "checkout");
  const receipts = NodePath.join(fixture, "evidence");
  NodeFS.mkdirSync(root);
  const env = {
    ...process.env,
    PATH: [
      NodePath.dirname(process.execPath),
      NodePath.join(project, "node_modules/.bin"),
      process.env.PATH,
    ].join(NodePath.delimiter),
    VP_REMOTE_CACHE: "off",
  };
  const write = (file: string, contents: string) =>
    NodeFS.writeFileSync(NodePath.join(root, file), contents);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git("add", "--all");
    git(
      "-c",
      "user.name=Batch Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };

  function batch(name: string, sourceCommit: string) {
    const args = ["exec", "node", `${name}.mjs`];
    const context = digest([name, args]);
    const key = digest([context, sourceCommit]);
    const benchmark = process.env.T3_LAN_BATCH_TIMINGS === "1";
    // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Optional diagnostics, never used in assertions.
    const started = benchmark ? performance.now() : 0;
    const logTime = (outcome: string) => {
      if (!benchmark) return;
      // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Optional diagnostics, never used in assertions.
      const elapsed = performance.now() - started;
      console.log(`${name} ${outcome}: ${elapsed.toFixed(1)} ms`);
    };
    if (readBatchReceipt(receipts, key, sourceCommit)) {
      logTime("exact receipt");
      return "exact";
    }
    const trace = beginBatchTrace(receipts, context);
    const runtimeEnv = releaseBatchEnvironment(env);
    const attempt = "10000000-0000-4000-8000-000000000000";
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(project, "node_modules/vite-plus/dist/bin.js"), "run", releaseBatchTask],
      {
        cwd: root,
        env: {
          ...env,
          VITE_CACHE_PATH: trace.path,
          [releaseEnvName]: JSON.stringify(runtimeEnv),
          [releaseBatchRequest]: encodeReleaseBatch({
            context,
            arguments: args,
            node: releaseNodePath(),
            environmentKey: digest(runtimeEnv),
          }),
        },
        encoding: "utf8",
      },
    );
    if (result.error) throw result.error;
    const summaryDir = NodeFS.readdirSync(trace.path).find((entry) => /^v\d+$/.test(entry));
    const summary =
      summaryDir &&
      JSON.parse(
        NodeFS.readFileSync(NodePath.join(trace.path, summaryDir, "last-summary.json"), "utf8"),
      );
    const hit = summary?.tasks.some(
      (task: { task_name: string; result: { CacheHit?: object } }) =>
        task.task_name === releaseBatchTask && !!task.result.CacheHit,
    );
    const outcome = result.status === 0 ? (hit ? "scoped" : "executed") : "failed";
    logTime(outcome);
    if (result.status === 0) {
      trace.seal(sourceCommit, attempt);
      writeBatchReceipt(receipts, key, sourceCommit, name, result.stdout, attempt);
    } else {
      NodeAssert.match(
        result.stderr + result.stdout,
        /fixture value/,
        result.stderr + result.stdout,
      );
    }
    return outcome;
  }

  try {
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "commit.gpgsign", "false");
    write(".gitignore", "node_modules/\n");
    write("pnpm-lock.yaml", "lockfileVersion: 9.0\n");
    write("package.json", '{"name":"batch-fixture","type":"module"}');
    NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(project, "node_modules/vite-plus")),
      NodePath.join(root, "node_modules/vite-plus"),
      HostProcess.Platform.defaultValue() === "win32" ? "junction" : "dir",
    );
    NodeFS.mkdirSync(NodePath.join(root, "scripts/lib"), { recursive: true });
    for (const file of ["scripts/check-changed-command.ts", "scripts/lib/release-batches.ts"]) {
      NodeFS.copyFileSync(NodePath.join(project, file), NodePath.join(root, file));
    }
    write(
      "vite.config.ts",
      'import {releaseBatchConfig, releaseBatchRequest} from "./scripts/lib/release-batches.ts"; export default {run:{tasks:releaseBatchConfig(process.env[releaseBatchRequest])}};',
    );
    for (const name of ["a", "b"]) {
      write(
        `${name}.mjs`,
        `import assert from "node:assert/strict"; import {value} from "./dep-${name}.mjs"; assert.match(value, /^good/, "fixture value");`,
      );
    }
    write("dep-a.mjs", 'export const value = "broken";');
    write("dep-b.mjs", 'export const value = "good";');
    const broken = commit("broken fixture");
    NodeAssert.equal(batch("b", broken), "executed");
    NodeAssert.equal(batch("a", broken), "failed");
    NodeAssert.equal(batch("b", broken), "exact");
    NodeAssert.equal(batch("a", broken), "failed");
    write("dep-a.mjs", 'export const value = "good";');
    const fixed = commit("fix dependency");
    NodeAssert.equal(batch("b", fixed), "scoped");
    NodeAssert.equal(batch("a", fixed), "executed");
    write("dep-b.mjs", 'export const value = "now broken";');
    const changed = commit("change independent dependency");
    NodeAssert.equal(batch("a", changed), "scoped");
    NodeAssert.equal(batch("b", changed), "failed");
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});

test("a changed external pin cannot authorize scoped reuse", () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lan-batch-inputs-"));
  try {
    const file = NodePath.join(folder, "tool");
    NodeFS.writeFileSync(file, "changed");
    const inventory = NodePath.join(folder, "inventory.json");
    NodeFS.writeFileSync(inventory, JSON.stringify([{ path: file, sha256: "0".repeat(64) }]));
    NodeAssert.throws(
      () =>
        releaseRuntime(
          folder,
          {
            platform: HostProcess.Platform.defaultValue(),
            arch: HostProcess.Architecture.defaultValue(),
          },
          process.env,
          inventory,
        ),
      /Release input changed/,
    );
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

test("an external configuration appearing invalidates a previously absent pin", () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lan-batch-absent-"));
  try {
    const file = NodePath.join(folder, "new-config.json");
    const inventory = NodePath.join(folder, "inventory.json");
    NodeFS.writeFileSync(inventory, JSON.stringify([{ path: file, kind: "absent" }]));
    NodeFS.writeFileSync(file, "{}");
    NodeAssert.throws(
      () =>
        releaseRuntime(
          folder,
          {
            platform: HostProcess.Platform.defaultValue(),
            arch: HostProcess.Architecture.defaultValue(),
          },
          process.env,
          inventory,
        ),
      /Previously absent release input exists/,
    );
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

test("the traced launcher refuses a different Node path", () => {
  const payload = encodeReleaseBatch({
    context: digest("mismatched Node"),
    arguments: ["--version"],
    node: NodePath.join(NodePath.dirname(process.execPath), "other-node.exe"),
    environmentKey: digest({}),
  });
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(import.meta.dirname, "release-batches.ts"), payload],
    { encoding: "utf8" },
  );
  NodeAssert.equal(result.status, 1);
  NodeAssert.match(result.stderr, /different Node executable/);
});
