import { expect, it } from "vite-plus/test";
import { parseDeferredTests, selectChangedTests } from "./changed-tests.ts";

const optionalBudgetTest = "packages/client-runtime/src/operations/commands.performance.test.ts";
const functionalCommandTest = "packages/client-runtime/src/operations/commands.test.ts";

it("deduplicates Windows paths before counting or passing changed test files", () => {
  expect(selectChangedTests(["scripts/a.test.ts", "scripts\\a.test.ts"], [])).toEqual({
    tests: ["scripts/a.test.ts"],
    skipped: [],
  });
});

it("defers only explicitly selected optional tests and reports every deferred file", () => {
  const deferred = parseDeferredTests([
    optionalBudgetTest.replaceAll("/", "\\"),
    optionalBudgetTest,
  ]);
  expect(selectChangedTests([functionalCommandTest, optionalBudgetTest], deferred)).toEqual({
    tests: [functionalCommandTest],
    skipped: [optionalBudgetTest],
  });
  expect(() => selectChangedTests([], deferred)).toThrow(/outside/u);
});

it("retains the budget test when its functional companion is absent", () => {
  expect(() => selectChangedTests([optionalBudgetTest], [optionalBudgetTest])).toThrow(
    /functional coverage/u,
  );
  expect(() =>
    selectChangedTests(
      [functionalCommandTest, optionalBudgetTest],
      [functionalCommandTest, optionalBudgetTest],
    ),
  ).toThrow(/cannot be deferred/u);
});

it.each([
  "scripts/lan/runtime-policy.test.ts",
  "scripts/lan/windows-artifact.test.ts",
  "src/auth.test.ts",
  "src/threadHistory.test.ts",
  "src/repair.test.ts",
  "src/trust.test.ts",
  "apps/server/src/lan/FleetDelivery.test.ts",
  "apps/server/src/lan/FleetEnrollment.test.ts",
  "packages/client-runtime/src/connection/onboarding.test.ts",
  "apps/server/src/provider/ProviderCredentialStore.test.ts",
  "packages/client-runtime/src/state/threadHistoryController.test.ts",
  "apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts",
  "src/unclassified-slow.test.ts",
  "src/newFeature.performance.test.ts",
])("retains required trust and compatibility checks: %s", (file) => {
  expect(() => selectChangedTests([file], [file])).toThrow(/cannot be deferred/u);
});

it("refuses deferring the complete fleet credential and onboarding selection", () => {
  const tests = [
    "apps/server/src/lan/FleetDelivery.test.ts",
    "apps/server/src/lan/FleetEnrollment.test.ts",
    "packages/client-runtime/src/connection/onboarding.test.ts",
  ];
  expect(selectChangedTests(tests, [])).toEqual({ tests, skipped: [] });
  expect(() => selectChangedTests(tests, tests)).toThrow(/cannot be deferred/u);
});

it.each(["", "../outside.test.ts", "C:\\outside.test.ts", "/outside.test.ts", "src"])(
  "refuses a malformed --defer-test value: %j",
  (file) => {
    expect(() => parseDeferredTests([file])).toThrow(/exact repository-relative/u);
  },
);
