const normalize = (file: string) => file.replaceAll("\\", "/");

// The synthetic 600-row payload budget overlaps functional dispatch coverage in
// commands.test.ts. Deferring it requires that companion to remain selected.
// Other tests stay required until their optional role is reviewed explicitly.
const OPTIONAL_TEST_COMPANIONS = new Map([
  [
    "packages/client-runtime/src/operations/commands.performance.test.ts",
    "packages/client-runtime/src/operations/commands.test.ts",
  ],
]);

export function parseChangedCheckArgs(args: readonly string[]) {
  let ref: string | undefined;
  const deferred: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--defer-test") {
      const file = normalize(args[++index] ?? "");
      if (
        (!file.endsWith(".test.ts") && !file.endsWith(".test.tsx")) ||
        file.startsWith("/") ||
        file.includes(":") ||
        file.split("/").includes("..")
      )
        throw new Error("--defer-test requires an exact repository-relative test file.");
      deferred.push(file);
    } else if (arg.startsWith("-") || ref !== undefined) {
      throw new Error("Usage: check:changed [ref] [--defer-test path.test.ts ...]");
    } else ref = arg;
  }
  return { ref: ref ?? "origin/main", deferred };
}

export function selectChangedTests(selected: Iterable<string>, deferred: readonly string[]) {
  const tests = new Set([...selected].map(normalize));
  const skipped = [...new Set(deferred.map(normalize))].sort();
  for (const file of skipped) {
    if (!tests.has(file))
      throw new Error(`Cannot defer a test outside the changed-test selection: ${file}.`);
    const companion = OPTIONAL_TEST_COMPANIONS.get(file);
    if (companion === undefined)
      throw new Error(
        `Test cannot be deferred; it is not in the optional-test allowlist: ${file}.`,
      );
    if (!tests.has(companion))
      throw new Error(
        `Test cannot be deferred without selected functional coverage: ${companion}.`,
      );
    tests.delete(file);
  }
  return { tests: [...tests].sort(), skipped };
}
