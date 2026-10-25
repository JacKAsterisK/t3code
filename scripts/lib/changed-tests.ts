const normalize = (file: string) => file.replaceAll("\\", "/");

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
    // Local iteration must retain the release trust, auth, repair and history checks.
    if (/^scripts\/lan\/|auth|trust|history|repair/iu.test(file))
      throw new Error(`Required compatibility or trust test cannot be deferred: ${file}.`);
    tests.delete(file);
  }
  return { tests: [...tests].sort(), skipped };
}
