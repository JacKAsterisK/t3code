import { expect, it } from "vite-plus/test";
import { parseChangedCheckArgs, selectChangedTests } from "./changed-tests.ts";

it("deduplicates Windows paths before counting or passing changed test files", () => {
  expect(selectChangedTests(["scripts/a.test.ts", "scripts\\a.test.ts"], [])).toEqual({
    tests: ["scripts/a.test.ts"],
    skipped: [],
  });
});

it("defers only explicitly selected optional tests and reports every deferred file", () => {
  const args = parseChangedCheckArgs([
    "HEAD~1",
    "--defer-test",
    "scripts\\slow.test.ts",
    "--defer-test",
    "scripts/slow.test.ts",
  ]);
  expect(args.ref).toBe("HEAD~1");
  expect(
    selectChangedTests(["scripts/fast.test.ts", "scripts/slow.test.ts"], args.deferred),
  ).toEqual({
    tests: ["scripts/fast.test.ts"],
    skipped: ["scripts/slow.test.ts"],
  });
  expect(() => selectChangedTests([], args.deferred)).toThrow(/outside/u);
});

it.each([
  "scripts/lan/runtime-policy.test.ts",
  "src/auth.test.ts",
  "src/threadHistory.test.ts",
  "src/repair.test.ts",
  "src/trust.test.ts",
])("retains required trust and compatibility checks: %s", (file) => {
  expect(() => selectChangedTests([file], [file])).toThrow(/cannot be deferred/u);
});

it.each(
  [
    ["--defer-test"],
    ["--defer-test", "../outside.test.ts"],
    ["--defer-test", "C:\\outside.test.ts"],
    ["--defer-test", "src"],
    ["--unknown"],
    ["main", "another"],
  ].map((args) => ({ args })),
)("refuses malformed changed-check arguments: $args", ({ args }) => {
  expect(() => parseChangedCheckArgs(args)).toThrow();
});
