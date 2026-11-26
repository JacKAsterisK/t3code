// @effect-diagnostics nodeBuiltinImport:off -- Spawns cmd.exe against a disposable shim to prove the Windows limit.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  chunkStagedCommands,
  escapedArgumentLength,
  STAGED_COMMAND_BUDGET,
} from "./staged-commands.ts";

// cmd.exe itself, so the shim check runs wherever the limit exists.
const comSpec = process.env.ComSpec;

const COMMANDS = [
  "vp fmt --no-error-on-unmatched-pattern",
  "vp lint --no-error-on-unmatched-pattern",
];

// An upstream merge stages a few thousand files with long absolute paths.
const stagedFiles = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    NodePath.join(
      "C:\\Git\\t3code-lan-release-worktree",
      "apps",
      "server",
      "src",
      "orchestration-v2",
      `staged file ${String(index).padStart(4, "0")} (copy).ts`,
    ),
  );

const filesOf = (command: string, prefix: string) =>
  [...command.slice(prefix.length).matchAll(/"([^"]*)"/g)].map((match) => match[1]);

it("splits each command over every staged file, in order, within the Windows budget", () => {
  const files = stagedFiles(3000);
  const budget = STAGED_COMMAND_BUDGET;
  // The unsplit list is far over the limit this guards.
  expect(files.reduce((sum, file) => sum + escapedArgumentLength(file) + 1, 0)).toBeGreaterThan(
    8191 * 10,
  );

  const commands = chunkStagedCommands(COMMANDS, files, budget);

  expect(commands.length).toBeGreaterThan(2);
  for (const command of commands) {
    const [prefix] = COMMANDS.filter((candidate) => command.startsWith(`${candidate} `));
    expect(prefix).toBeDefined();
    const length = filesOf(command, prefix!).reduce(
      (sum, file) => sum + 1 + escapedArgumentLength(file),
      escapedArgumentLength(prefix!),
    );
    expect(length).toBeLessThanOrEqual(budget);
  }
  // Every fmt chunk comes before the first lint chunk, and each covers the files once, in order.
  const firstLint = commands.findIndex((command) => command.startsWith(COMMANDS[1]!));
  expect(commands.slice(0, firstLint).every((command) => command.startsWith(COMMANDS[0]!))).toBe(
    true,
  );
  expect(commands.slice(0, firstLint).flatMap((command) => filesOf(command, COMMANDS[0]!))).toEqual(
    files,
  );
  expect(commands.slice(firstLint).flatMap((command) => filesOf(command, COMMANDS[1]!))).toEqual(
    files,
  );
});

it("keeps one command per tool when the files fit, and gives an oversized file its own command", () => {
  expect(chunkStagedCommands(COMMANDS, ["a.ts", "b.ts"], STAGED_COMMAND_BUDGET)).toEqual([
    `${COMMANDS[0]} "a.ts" "b.ts"`,
    `${COMMANDS[1]} "a.ts" "b.ts"`,
  ]);
  const long = "x".repeat(200);
  expect(chunkStagedCommands(["fmt"], ["a.ts", long, "b.ts"], 100)).toEqual([
    `fmt "a.ts"`,
    `fmt "${long}"`,
    `fmt "b.ts"`,
  ]);
  expect(chunkStagedCommands(COMMANDS, [])).toEqual([]);
});

// Only Windows has cmd.exe and its 8191-character line limit.
it.skipIf(comSpec === undefined)(
  "runs every split command through cmd.exe and a .cmd shim, where the unsplit one fails",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-staged-commands-"));
    try {
      // Shaped like node_modules/.bin/vp.cmd: the shim repeats every argument behind node's path.
      const shim = NodePath.join(root, "vp.cmd");
      NodeFS.writeFileSync(shim, `@SETLOCAL\r\n@"${process.execPath}" -e "process.exit(0)" %*\r\n`);
      const run = (command: string) => {
        const args = command.slice("vp ".length);
        return NodeChildProcess.spawnSync(comSpec!, ["/d", "/s", "/c", `""${shim}" ${args}"`], {
          windowsVerbatimArguments: true,
          encoding: "utf8",
        });
      };
      const files = stagedFiles(250);

      const unsplit = run(`${COMMANDS[0]} ${files.map((file) => `"${file}"`).join(" ")}`);
      expect(unsplit.status).not.toBe(0);
      expect(`${unsplit.stdout}${unsplit.stderr}`).toMatch(/too long/i);

      const commands = chunkStagedCommands(COMMANDS, files);
      expect(commands.length).toBeGreaterThan(2);
      for (const command of commands) {
        const result = run(command);
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
