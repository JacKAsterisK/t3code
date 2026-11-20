// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  comparisonBase,
  defaultConcurrency,
  docReaderTests,
  gitLines,
  ignoredCheckInputs,
  runSteps,
  splitTests,
  type Step,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("runs the server tests for the one guide they read and leaves other docs inert", () => {
    const packages = readWorkspace();
    assert.isTrue(
      decide(["docs/user/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    );
    assert.deepStrictEqual(docReaderTests(["docs/user/t3-connect-troubleshooting.md"]), [
      "apps/server/src/cloud/ConnectReachability.test.ts",
    ]);
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\thread-transfer-report.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [
          ".github/scripts/ci-changes.test.cjs",
          ".github\\scripts\\thread-transfer-report.test.cjs",
        ],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  it("opens the built desktop app only for startup, settlement, and sidebar changes", () => {
    const packages = readWorkspace();
    const launches = (file: string) => decide([file], packages, false).outputs.desktop_launch;
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.ts",
      "apps/server/src/persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts",
      "apps/web/src/components/sidebar/SidebarThreadRow.tsx",
      "apps/desktop/src/backend/DesktopBackendManager.ts",
      "apps/desktop/src/electron/ElectronProtocol.ts",
      "packages/contracts/src/settings.ts",
      "scripts/fixtures/desktop-launch/statev2.sqlite",
    ]) {
      assert.isTrue(launches(file), file);
    }
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.test.ts",
      "apps/web/src/components/chat/ChatView.tsx",
      "apps/desktop/src/updates/DesktopRemoteUpdates.ts",
      "packages/contracts/src/orchestration.ts",
    ]) {
      assert.isFalse(launches(file), file);
    }
    // A script-only change still builds the app it opens.
    assert.isTrue(decide(["scripts/smoke-desktop-app.ts"], packages, false).outputs.build);
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
    "packages/shared/src/testing/gitEnv.ts",
    "packages/shared/src/testing/gitRepositoryEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files.
// Git for Windows rejects the null device as a config path, so use an empty file.
const emptyConfigDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "t3-check-changed-config-"),
);
const emptyConfig = NodePath.join(emptyConfigDir, "empty.gitconfig");
NodeFS.writeFileSync(emptyConfig, "");
afterAll(() => NodeFS.rmSync(emptyConfigDir, { recursive: true, force: true }));
const fixtureConfig = {
  "core.excludesFile": emptyConfig,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const inFixture = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
const compare = (root: string, ref: Option.Option<string>) => inFixture(comparisonBase(root, ref));

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

it("lists the ignored inputs that main's pathspecs list, without entering node_modules", async () => {
  using project = fixture({});
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: project.root, encoding: "utf8", env });
  const write = (file: string, content = "") => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(project.root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(project.root, file), content);
  };
  write(".gitignore", "node_modules/\ndist/\n.generated/\n.env*\n*.gen.d.ts\nreplaced/\nskipped/");
  for (const file of ["replaced", "skipped"]) write(file);
  git("add", ".");
  git("commit", "-m", "files that directories replace");
  git("update-index", "--skip-worktree", "skipped");
  for (const file of ["replaced", "skipped"]) NodeFS.rmSync(NodePath.join(project.root, file));
  for (const file of [
    ".env.local",
    "src/types.gen.d.ts",
    "src/.generated/routes.ts",
    "dist/index.d.ts",
    "dist/node_modules/pkg/index.d.ts",
    "node_modules/pkg/index.d.ts",
    // A package folder left behind by a branch switch.
    "old/dist/a.d.ts",
    "old/node_modules/pkg/index.d.ts",
    "replaced/sub/a.d.ts",
    "skipped/a.d.ts",
  ])
    write(file);
  const command =
    "ls-files -o -i --exclude-standard -- :(glob)**/.generated/** :(glob)**/.astro/** :(glob)**/*.d.ts :(glob)**/.env* :(exclude,glob)**/node_modules/**";
  const old = git(...command.split(" "))
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.includeMembers(old, ["old/dist/a.d.ts", "replaced/sub/a.d.ts", "skipped/a.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), old);
});

function launcherFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    "scripts/lib/changed-tests.ts",
    "scripts/lib/check-inputs.ts",
    "scripts/lib/release-batches.ts",
    ".github/scripts/ci-changes.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  write(".gitignore", "node_modules/\nrecords/\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("pnpm-lock.yaml", "lockfileVersion: 9.0\n");
  write("node_modules/.modules.yaml", "{}");
  write("node_modules/.pnpm/lock.yaml", "{}");
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: {
        "knip:check:files": "knip --include files",
        "knip:check:exports": "knip --exports",
      },
    }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.env.FAIL_ONCE === "1" &&
        (process.env.VP_REMOTE_CACHE !== "off" || process.env.VP_REMOTE_CACHE_URL !== "" ||
         process.env.T3_TASK_CACHE_TELEMETRY !== "off" || process.env.npm_config_offline !== "true")) {
      throw new Error("release batch inherited remote settings");
    }
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    if (args[0] === "install" && process.env.REQUIRE_OFFLINE_METADATA === "1" &&
        !fs.existsSync(path.join(process.env.RECORDS, ".offline-metadata"))) {
      console.error("ERR_PNPM_NO_OFFLINE_META");
      process.exit(24);
    }
    if (args[0] === process.env.FAIL_STEP) {
      if (process.env.FAIL_ONCE !== "1") process.exit(23);
      const marker = path.join(process.env.RECORDS, ".failed-once");
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, "");
        if (process.env.PAUSE_FIXTURE === "1") {
          const release = path.join(process.env.RECORDS, ".release-pause");
          if (!fs.existsSync(release))
            await new Promise((resolve) => {
              const watcher = fs.watch(path.dirname(release), () => {
                if (fs.existsSync(release)) { watcher.close(); resolve(); }
              });
              if (fs.existsSync(release)) { watcher.close(); resolve(); }
            });
        }
        process.exit(23);
      }
    }
    process.exit(0);
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
      "vitePlusCommand(args, platform)",
      'vitePlusCommand(args, "win32")',
    ),
  );
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  interface Retry {
    base: string;
    receipts: string;
    thread?: string;
    timeout?: number;
    changedEnv?: string;
    pause?: boolean;
    requireOfflineMetadata?: boolean;
  }
  function invocation(failStep: string, retry?: Retry) {
    const args = ["scripts/check-changed.ts", retry?.base ?? "HEAD"];
    if (retry) args.push("--batch-receipts", retry.receipts);
    if (retry?.timeout) args.push("--timeout", String(retry.timeout));
    return {
      args,
      env: {
        ...env,
        TEMP: NodeOS.tmpdir(),
        RECORDS: records,
        FAIL_STEP: failStep,
        FAIL_ONCE: retry ? "1" : "0",
        T3CODE_THREAD_ID: retry?.thread,
        RELEASE_FIXTURE_INPUT: retry?.changedEnv,
        PAUSE_FIXTURE: retry?.pause ? "1" : "0",
        REQUIRE_OFFLINE_METADATA: retry?.requireOfflineMetadata ? "1" : "0",
        VP_REMOTE_CACHE: "read-write",
        VP_REMOTE_CACHE_URL: "http://127.0.0.1:1/test-cache",
        T3_TASK_CACHE_TELEMETRY: "on",
      },
    };
  }
  return {
    root,
    source,
    write,
    commitChange() {
      const base = git("rev-parse", "HEAD").toString().trim();
      git("add", ".");
      git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "candidate");
      return base;
    },
    run(failStep = "", retry?: Retry) {
      const { args, env } = invocation(failStep, retry);
      return NodeChildProcess.spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        env,
      });
    },
    start(failStep: string, retry: Retry) {
      const { args, env } = invocation(failStep, retry);
      return NodeChildProcess.spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    git,
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8"))),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "install")).toBe(false);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  const commands = calls.map(({ args }) => args);
  expect(commands).toContainEqual(["exec", "knip", "--include", "files"]);
  expect(commands).toContainEqual(["exec", "knip", "--exports"]);
});

it.each(["install", "lint"])("reports a failing %s step with its output", (step) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(step);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[0] === "install");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${step}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${step}`);
  expect(result.stdout).toContain(step === "install" ? "FAIL  unused patches" : "FAIL  lint");
  if (step === "lint") expect(result.stdout).toContain("pass  unused patches");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it("retries only the failed command on the same commit", () => {
  using project = launcherFixture();
  const receipts = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lan-release-test-receipts-"));
  try {
    project.write(project.source, "export const value = 2;\n");
    const base = project.commitChange();
    const first = project.run("lint", { base, receipts });
    expect(first.status, first.stdout + first.stderr).toBe(1);
    expect(first.stdout).toContain("FAIL  lint");
    const typecheck = project.calls().find(({ args }) => args.includes("typecheck"));
    expect(typecheck?.args).toContain("--no-cache");
    expect(typecheck?.args).not.toContain("--cache");
    const calls = project.calls().length;
    const second = project.run("lint", { base, receipts, thread: "new-session", timeout: 300 });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("Reused batch receipt");
    expect(project.calls()).toHaveLength(calls + 1);
    const changedEnv = project.run("lint", { base, receipts, changedEnv: "real-input" });
    expect(changedEnv.status, changedEnv.stdout + changedEnv.stderr).toBe(0);
    expect(changedEnv.stdout).not.toContain("Reused batch receipt");
    project.write("node_modules/vite-plus/extra.js", "export const installed = 'changed';");
    const changedInstall = project.run("lint", { base, receipts, changedEnv: "real-input" });
    expect(changedInstall.status, changedInstall.stdout + changedInstall.stderr).toBe(0);
    expect(changedInstall.stdout).not.toContain("Reused batch receipt");
    project.git("update-index", "--skip-worktree", project.source);
    const hiddenSource = project.run("lint", { base, receipts, changedEnv: "real-input" });
    expect(hiddenSource.status).toBe(1);
    expect(hiddenSource.stdout + hiddenSource.stderr).toContain("skip-worktree");
  } finally {
    NodeFS.rmSync(receipts, { recursive: true, force: true });
  }
});

it("preserves completed batches when the gate process is interrupted", async () => {
  using project = launcherFixture();
  const receipts = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lan-release-interrupted-"));
  const releasePause = () => project.write("records/.release-pause", "");
  try {
    project.write(project.source, "export const value = 2;\n");
    const base = project.commitChange();
    const retry = { base, receipts, pause: true };
    const first = project.start("lint", retry);
    let stdout = "";
    let stderr = "";
    first.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    first.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if ((stdout.match(/^> vp .*  pass  /gm) ?? []).length === 4) {
        first.kill();
        releasePause();
      }
    });
    await new Promise<void>((resolve, reject) => {
      first.once("close", () => resolve());
      first.once("error", reject);
    });
    expect(stdout, stdout + stderr).not.toContain("check:changed summary");
    expect(NodeFS.readdirSync(receipts).filter((name) => name.endsWith(".json"))).toHaveLength(4);
    const calls = project.calls().length;
    const second = project.run("lint", retry);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(project.calls()).toHaveLength(calls + 1);
  } finally {
    releasePause();
    NodeFS.rmSync(receipts, { recursive: true, force: true });
  }
});

it("requires fresh offline patch resolution even when the other batches have receipts", () => {
  using project = launcherFixture();
  const receipts = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lan-release-patch-retry-"));
  const metadata = "records/.offline-metadata";
  try {
    project.write(
      "packages/example/package.json",
      JSON.stringify({ name: "example", version: "1.0.1" }),
    );
    project.write(metadata, "fixture registry metadata");
    const base = project.commitChange();
    const retry = { base, receipts, requireOfflineMetadata: true };
    const first = project.run("", retry);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const calls = project.calls().length;
    expect(project.calls().find(({ args }) => args[0] === "install")?.args).toContain("--offline");
    NodeFS.unlinkSync(NodePath.join(project.root, metadata));
    const second = project.run("", retry);
    expect(second.status).toBe(1);
    expect(second.stdout + second.stderr).toContain("ERR_PNPM_NO_OFFLINE_META");
    expect(second.stdout).toContain("Reused batch receipt");
    expect(project.calls()).toHaveLength(calls + 1);
  } finally {
    NodeFS.rmSync(receipts, { recursive: true, force: true });
  }
});
