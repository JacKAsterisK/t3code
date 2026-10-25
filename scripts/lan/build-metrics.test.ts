import { expect, it } from "vite-plus/test";
import { buildInventoryCounts, measureBuildStage } from "./build-metrics.ts";

it("reports completed work counts without walking the filesystem again", async () => {
  const reports: object[] = [];
  const ticks = [10, 25];
  const pins = [{ length: 0 }, { length: 7 }];
  expect(
    await measureBuildStage(
      "fixture.inventory",
      async () => pins,
      buildInventoryCounts,
      (report) => reports.push(report),
      () => ticks.shift()!,
    ),
  ).toBe(pins);
  expect(reports).toEqual([
    { stage: "fixture.inventory", status: "passed", elapsedMs: 15, files: 2, bytes: 7 },
  ]);
});

it("reports failed stages without converting the original failure into success", async () => {
  const reports: object[] = [];
  const ticks = [10, 31];
  const failure = new Error("fixture refusal");
  await expect(
    measureBuildStage(
      "fixture.copy",
      async () => {
        throw failure;
      },
      undefined,
      (report) => reports.push(report),
      () => ticks.shift()!,
    ),
  ).rejects.toBe(failure);
  expect(reports).toEqual([{ stage: "fixture.copy", status: "failed", elapsedMs: 21 }]);
});
