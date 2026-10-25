// @effect-diagnostics globalConsole:off - Build diagnostics contain stage names and counts, never local paths or input bytes.
export interface BuildStageCounts {
  readonly files: number;
  readonly bytes: number;
}

export function buildInventoryCounts(
  pins: Iterable<{ readonly length: number }>,
): BuildStageCounts {
  let files = 0,
    bytes = 0;
  for (const pin of pins) {
    files++;
    bytes += pin.length;
  }
  return { files, bytes };
}

export async function measureBuildStage<T>(
  stage: string,
  run: () => Promise<T>,
  counts?: (value: T) => BuildStageCounts,
  report = (value: object) => console.log("[build-metrics] " + JSON.stringify(value)),
  now = () => performance.now(),
): Promise<T> {
  const started = now();
  let status: "passed" | "failed" = "failed";
  let inventory: BuildStageCounts | undefined;
  try {
    const value = await run();
    inventory = counts?.(value);
    status = "passed";
    return value;
  } finally {
    report({ stage, status, elapsedMs: Math.round(now() - started), ...inventory });
  }
}
