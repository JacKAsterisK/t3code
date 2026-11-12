import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  UsageLimitSourceId,
  type ServerProvider,
  type TurnTokenUsage,
  type UsageBucket,
  type UsageSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { createOverrideRateTable } from "../../../usage/usagePricing.ts";
import {
  claimSources,
  dedupeLimitAccounts,
  defaultRowLimit,
  groupRows,
  limitAccounts,
  normalizeGroupBy,
  resolveWindow,
  summaryRows,
  turnRows,
} from "./report.ts";
import type { LedgerTurn } from "./turnLedger.ts";

const claude = ProviderDriverKind.make("claudeAgent");

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-12T08:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function summary(
  hostId: string,
  buckets: ReadonlyArray<Pick<UsageBucket, "model" | "costUsd"> & { readonly path: string }>,
): UsageSummary {
  const paths = [...new Set(buckets.map((bucket) => bucket.path))];
  return {
    contractVersion: 6,
    readAt: "2026-11-12T12:00:00.000Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-11-06"),
    untilDay: UsageDay.make("2026-11-12"),
    buckets: buckets.map(({ path, model, costUsd }) => ({
      day: UsageDay.make("2026-11-12"),
      provider: "claude",
      model,
      sourcePath: path,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 100,
        cacheCreationTokens: 5,
        outputTokens: 20,
        reasoningTokens: 0,
      },
      costUsd,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    })),
    sources: paths.map((path) => ({
      fingerprint: { hostId, provider: "claude", resolvedHomePath: path, volumeId: "1:2" },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    })),
    pricing: { status: "cached", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

describe("fleet usage rows", () => {
  it("counts a history directory two environments report once, then folds and caps rows", () => {
    const anvil = summaryRows(
      summary("anviltoad", [
        { path: "C:/claude-accounts/spd", model: "claude-fable-5-2", costUsd: 3 },
        { path: "C:/claude-accounts/spd", model: "claude-opus-5-5", costUsd: 2 },
      ]),
      "AnvilToad",
    );
    // A share mounted on both machines: the same host, path and volume.
    const cryo = summaryRows(
      summary("anviltoad", [
        { path: "C:/claude-accounts/spd", model: "claude-fable-5-2", costUsd: 3 },
      ]),
      "CryoFrog",
    );
    const own = summaryRows(
      summary("cryofrog", [
        { path: "C:/Users/dan/.claude", model: "claude-fable-5-2", costUsd: 1 },
      ]),
      "CryoFrog",
    );
    const claimed = claimSources([{ rows: anvil }, { rows: [...cryo, ...own] }]);
    expect(claimed.duplicateSources).toEqual(["anviltoad|claude|C:/claude-accounts/spd|1:2"]);
    expect(anvil[0]).toMatchObject({ host: "anviltoad", account: "C:/claude-accounts/spd" });

    const grouped = groupRows(claimed.rows, normalizeGroupBy(["model"]), 1);
    expect(grouped.rows).toEqual([
      expect.objectContaining({ model: "claude-fable-5-2", costUsd: 4, records: 2 }),
    ]);
    expect(grouped.omittedRows).toBe(1);
    expect(grouped.totals).toMatchObject({
      costUsd: 6,
      records: 3,
      tokens: { input: 30, cacheRead: 300, cacheWrite: 15, output: 60, reasoning: 0 },
    });
  });
});

describe("limit windows", () => {
  const weekly = { kind: "weekly", windowDurationMins: 10080 } as const;
  const claudeAccount = provider({
    instanceId: ProviderInstanceId.make("claude-spd"),
    driver: claude,
    auth: { status: "authenticated", email: "spd@example.com" },
    // The probe ran at 08:00; a live event at 10:00 restamped the whole snapshot.
    checkedAt: "2026-11-12T08:00:00.000Z",
    usageLimits: {
      checkedAt: "2026-11-12T10:00:00.000Z",
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent: 33.33 },
        { id: "seven_day", label: "Weekly", usedPercent: 60, ...weekly },
        {
          id: "seven_day_fable",
          label: "Weekly · Fable",
          usedPercent: 104,
          resetsAt: "2026-11-15T00:00:00.000Z",
          ...weekly,
        },
      ],
    },
  });
  const codexAccount = provider({
    auth: { status: "authenticated", email: "dan@example.com" },
    usageLimits: {
      checkedAt: "2026-11-12T09:00:00.000Z",
      windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
    },
  });
  const hub = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Hub",
    checkedAt: "2026-11-12T07:00:00.000Z",
    accounts: [
      {
        id: "acc",
        driver: claude,
        email: "pool@example.com",
        usageLimits: {
          checkedAt: "2026-11-12T07:00:00.000Z",
          windows: [{ id: "seven_day", label: "Weekly", usedPercent: 5, ...weekly }],
        },
      },
    ],
  };

  it("labels each window with how it updates and the latest time it could have been read", () => {
    const accounts = limitAccounts(
      [claudeAccount, codexAccount],
      [hub],
      Date.parse("2026-11-12T12:00:00.000Z"),
      "AnvilToad",
    );
    const windows = (email: string) =>
      accounts
        .find((account) => account.email === email)
        ?.windows.map(({ id, label, source, checkedAt }) => ({ id, label, source, checkedAt }));
    expect(windows("spd@example.com")).toEqual([
      {
        id: "five_hour",
        label: "Session",
        source: "live-event",
        checkedAt: "2026-11-12T10:00:00.000Z",
      },
      {
        id: "seven_day",
        label: "Weekly",
        source: "live-event",
        checkedAt: "2026-11-12T10:00:00.000Z",
      },
      {
        id: "seven_day_fable",
        label: "Weekly · Fable",
        source: "probe",
        checkedAt: "2026-11-12T08:00:00.000Z",
      },
    ]);
    expect(windows("dan@example.com")).toEqual([
      {
        id: "primary",
        label: "Session",
        source: "live-event",
        checkedAt: "2026-11-12T09:00:00.000Z",
      },
    ]);
    expect(windows("pool@example.com")).toEqual([
      { id: "seven_day", label: "Weekly", source: "probe", checkedAt: "2026-11-12T07:00:00.000Z" },
    ]);
    // Agents present what is left; an overage reads as empty.
    expect(
      accounts
        .find((account) => account.email === "spd@example.com")
        ?.windows.map((window) => window.remainingPercent),
    ).toEqual([66.7, 40, 0]);
  });

  it("keeps the latest reading of a login two environments report", () => {
    const [older] = limitAccounts([claudeAccount], [], 0, "AnvilToad");
    const newer = {
      ...older!,
      environment: "CryoFrog",
      email: "SPD@example.com",
      windows: older!.windows.map((window) => ({
        ...window,
        checkedAt: "2026-11-12T11:00:00.000Z",
      })),
    };
    expect(dedupeLimitAccounts([older!, newer])).toEqual([newer]);
  });
});

describe("thread-turn attribution", () => {
  type Complete = Extract<TurnTokenUsage, { readonly usageStatus: "complete" }>;
  const turn = (
    threadId: string,
    at: string,
    usage: Omit<Complete, "usageScope" | "hasSubagents" | "usageStatus">,
    model: string | null = "claude-fable-5-2",
  ): LedgerTurn => ({
    threadId,
    threadTitle: threadId === "thread:a" ? "Coil dressing" : "Perf bench",
    projectId: "project:reprint",
    projectTitle: "Reprint",
    driver: claude,
    providerInstanceId: "claude-spd",
    at,
    model,
    usage: { usageScope: "main_agent", hasSubagents: false, usageStatus: "complete", ...usage },
  });
  const overrides = createOverrideRateTable({
    "claude-fable-5-2": {
      inputCostPerMillionTokens: 10,
      outputCostPerMillionTokens: 50,
      cacheReadCostPerMillionTokens: 1,
      cacheWriteCostPerMillionTokens: 12.5,
    },
  });
  const week = {
    sinceDay: UsageDay.make("2026-11-06"),
    untilDay: UsageDay.make("2026-11-12"),
    timeZone: "UTC",
  };

  it("prices the cache split, counts turns without one, and keeps subagent tokens apart", () => {
    const result = turnRows({
      turns: [
        turn("thread:a", "2026-11-12T10:00:00.000Z", {
          inputTokens: 1_000_000,
          cachedInputTokens: 800_000,
          cacheCreationTokens: 100_000,
          outputTokens: 10_000,
          otherUsage: { inputTokens: 5_000, outputTokens: 100 },
        }),
        turn("thread:a", "2026-11-11T10:00:00.000Z", { inputTokens: 200_000, outputTokens: 0 }),
        turn("thread:a", "2026-11-12T11:00:00.000Z", {
          inputTokens: 9,
          outputTokens: 9,
          localCommand: true,
        }),
        // The ledger read widens day windows to every UTC offset; the local day cuts it.
        turn("thread:a", "2026-11-05T23:00:00.000Z", { inputTokens: 9, outputTokens: 9 }),
      ],
      rates: new Map(),
      overrides,
      window: week,
      environment: "AnvilToad",
    });
    expect(result.count).toBe(2);
    expect(result.withoutCacheSplit).toBe(1);
    expect(result.otherTokens).toEqual({ input: 5_000, output: 100 });
    const grouped = groupRows(result.rows, normalizeGroupBy(["account", "model"]), 10);
    expect(grouped.rows).toEqual([
      {
        account: "claude-spd",
        model: "claude-fable-5-2",
        // 0.1M uncached × 10 + 0.8M read × 1 + 0.1M write × 12.5 + 0.01M out × 50, plus 0.2M × 10.
        costUsd: 5.55,
        records: 2,
        unpricedRecords: 0,
        tokens: {
          input: 300_000,
          cacheRead: 800_000,
          cacheWrite: 100_000,
          output: 10_000,
          reasoning: 0,
        },
      },
    ]);
  });

  it("ranks threads by one model's cost and charts hours whole and in time order", () => {
    const turns = [
      turn("thread:a", "2026-11-12T09:30:00.000Z", { inputTokens: 100_000, outputTokens: 0 }),
      turn("thread:b", "2026-11-12T10:15:00.000Z", { inputTokens: 300_000, outputTokens: 0 }),
      turn("thread:a", "2026-11-12T10:45:00.000Z", { inputTokens: 100_000, outputTokens: 0 }),
      turn(
        "thread:b",
        "2026-11-12T10:50:00.000Z",
        { inputTokens: 900_000, outputTokens: 0 },
        "claude-opus-5-5",
      ),
      // Before the 24-hour window.
      turn("thread:a", "2026-11-11T09:00:00.000Z", { inputTokens: 900_000, outputTokens: 0 }),
    ];
    const day = resolveWindow(
      { period: "day" },
      DateTime.toDate(DateTime.makeUnsafe("2026-11-12T12:00:00.000Z")),
    );
    if (typeof day === "string") throw new Error(day);
    const fable = turnRows({
      turns,
      rates: new Map(),
      overrides,
      window: day,
      environment: "AnvilToad",
      models: ["claude-fable-5-2"],
    });
    expect(fable.count).toBe(3);
    const byThread = groupRows(fable.rows, normalizeGroupBy(["thread"]), 1);
    expect(byThread.rows).toEqual([
      expect.objectContaining({
        thread: "thread:b",
        threadTitle: "Perf bench",
        projectTitle: "Reprint",
        costUsd: 3,
      }),
    ]);
    expect(byThread.omittedRows).toBe(1);

    const all = turnRows({
      turns,
      rates: new Map(),
      overrides,
      window: day,
      environment: "AnvilToad",
    });
    const groupBy = normalizeGroupBy(["model", "hour"]);
    const hours = groupRows(all.rows, groupBy, defaultRowLimit(groupBy));
    // The page's 24-hour slots start at the window's start, 12:00.
    expect(hours.rows.map(({ hour, model, costUsd }) => ({ hour, model, costUsd }))).toEqual([
      { hour: "2026-11-12T09:00:00.000Z", model: "claude-fable-5-2", costUsd: 1 },
      { hour: "2026-11-12T10:00:00.000Z", model: "claude-fable-5-2", costUsd: 4 },
      { hour: "2026-11-12T10:00:00.000Z", model: "claude-opus-5-5", costUsd: 0 },
    ]);
    expect(hours.rows[2]).toMatchObject({ unpricedRecords: 1 });
  });
});

describe("report window", () => {
  const now = DateTime.toDate(DateTime.makeUnsafe("2026-11-12T12:00:00.000Z"));
  it.each([
    [{ period: "week", since: "2026-11-01" }, "Pass period or since/until, not both."],
    [{ until: "2026-11-01" }, "until needs since."],
    [{ since: "2026-11-10", until: "2026-11-01" }, "since 2026-11-10 is after until 2026-11-01."],
  ] as const)("refuses %j", (input, message) => {
    expect(resolveWindow(input, now)).toBe(message);
  });

  it("uses the page's hourly window for a day", () => {
    expect(resolveWindow({ period: "day" }, now)).toMatchObject({
      resolution: "hour",
      sinceTime: "2026-11-11T12:00:00.000Z",
      untilTime: "2026-11-12T12:00:00.000Z",
    });
  });
});
