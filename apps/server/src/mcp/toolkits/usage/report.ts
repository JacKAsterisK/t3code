import {
  UsageDay,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshots,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  limitsNotice,
} from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { priceUsage, type RateTable } from "../../../usage/usagePricing.ts";
import type {
  UsageReportGroupKey,
  UsageReportLimitAccount,
  UsageReportLimitWindow,
  UsageReportResult,
  UsageReportRow,
} from "./tools.ts";

const DEFAULT_GROUP_BY: readonly UsageReportGroupKey[] = ["account", "provider", "model"];
export const DEFAULT_ROW_LIMIT = 10;
const PERIOD_DAYS = { day: 1, week: 7, month: 30, quarter: 90 } as const;
const GROUP_KEYS: readonly UsageReportGroupKey[] = [
  "environment",
  "account",
  "provider",
  "model",
  "host",
  "day",
  "source",
];

type Amounts = Pick<UsageReportRow, "tokens" | "costUsd" | "records" | "unpricedRecords">;

const emptyAmounts = (): Amounts => ({
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  costUsd: 0,
  records: 0,
  unpricedRecords: 0,
});

function addAmounts(into: Amounts, from: Amounts): Amounts {
  return {
    tokens: {
      input: into.tokens.input + from.tokens.input,
      cacheRead: into.tokens.cacheRead + from.tokens.cacheRead,
      cacheWrite: into.tokens.cacheWrite + from.tokens.cacheWrite,
      output: into.tokens.output + from.tokens.output,
      reasoning: into.tokens.reasoning + from.tokens.reasoning,
    },
    costUsd: into.costUsd + from.costUsd,
    records: into.records + from.records,
    unpricedRecords: into.unpricedRecords + from.unpricedRecords,
  };
}

const tokensOf = (totals: UsageTokenTotals) => ({
  input: totals.uncachedInputTokens,
  cacheRead: totals.cachedInputTokens,
  cacheWrite: totals.cacheCreationTokens,
  output: totals.outputTokens,
  reasoning: totals.reasoningTokens,
});

const totalTokens = ({ tokens }: Amounts) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

const roundCost = (usd: number) => Math.round(usd * 10_000) / 10_000;

export type UsageWindow = UsageSummaryInput;

/** The page's 24h, 7d, 30d and 90d windows, or an explicit day range, in the server's time zone. */
export function resolveWindow(
  input: {
    readonly period?: keyof typeof PERIOD_DAYS;
    readonly since?: string;
    readonly until?: string;
  },
  now: Date,
): UsageWindow | string {
  if (input.since === undefined && input.until === undefined) {
    const days = PERIOD_DAYS[input.period ?? "week"];
    return makeWindow(days, now, days === 1 ? "hour" : "day");
  }
  if (input.period !== undefined) return "Pass period or since/until, not both.";
  if (input.since === undefined) return "until needs since.";
  const today = makeWindow(1, now);
  const untilDay = input.until ?? today.untilDay;
  if (input.since > untilDay) return `since ${input.since} is after until ${untilDay}.`;
  return {
    sinceDay: UsageDay.make(input.since),
    untilDay: UsageDay.make(untilDay),
    timeZone: today.timeZone,
    resolution: "day",
  };
}

const sourceKey = (fingerprint: UsageSummary["sources"][number]["fingerprint"]) =>
  `${fingerprint.hostId}|${fingerprint.provider}|${fingerprint.resolvedHomePath}|${fingerprint.volumeId}`;

/** One row per bucket with every key filled; `groupRows` then folds them. */
export function summaryRows(summary: UsageSummary, environment: string): UsageReportRow[] {
  const sourceByPath = new Map(
    summary.sources.map(
      ({ fingerprint }) =>
        [`${fingerprint.provider}|${fingerprint.resolvedHomePath}`, fingerprint] as const,
    ),
  );
  return summary.buckets.map((bucket) => {
    const fingerprint =
      bucket.sourcePath === undefined
        ? undefined
        : sourceByPath.get(`${bucket.provider}|${bucket.sourcePath}`);
    return {
      environment,
      account: bucket.sourcePath ?? "unknown",
      provider: bucket.provider,
      model: bucket.model,
      host: fingerprint?.hostId ?? "unknown",
      day: bucket.day,
      source: fingerprint === undefined ? `unknown|${bucket.provider}` : sourceKey(fingerprint),
      tokens: tokensOf(bucket.totals),
      costUsd: bucket.costUsd,
      records: bucket.records,
      unpricedRecords: bucket.unpricedRecords,
    };
  });
}

export function sourceProblems(summary: UsageSummary): NonNullable<UsageReportResult["sources"]> {
  const count = (status: string) =>
    summary.sources.filter((source) => source.status === status).length;
  const problems = summary.sources
    .filter((source) => source.status !== "ok" && source.status !== "missing")
    .map((source) => ({
      source: sourceKey(source.fingerprint),
      status: source.status,
      ...(source.message === null ? {} : { message: source.message }),
    }));
  return { ok: count("ok"), missing: count("missing"), problems };
}

/** Folds rows to `groupBy`, most expensive first, and keeps `limit` of them (0 keeps all). */
export function groupRows(
  rows: readonly UsageReportRow[],
  groupBy: readonly UsageReportGroupKey[],
  limit: number,
): Pick<UsageReportResult, "rows" | "omittedRows" | "totals"> {
  const groups = new Map<string, UsageReportRow>();
  let totals = emptyAmounts();
  for (const row of rows) {
    totals = addAmounts(totals, row);
    const key = groupBy.map((name) => row[name] ?? "").join("\u0000");
    const existing = groups.get(key);
    if (existing !== undefined) {
      groups.set(key, { ...existing, ...addAmounts(existing, row) });
      continue;
    }
    const keys: Partial<Record<UsageReportGroupKey, string>> = {};
    for (const name of groupBy) {
      const value = row[name];
      if (value !== undefined) keys[name] = value;
    }
    groups.set(key, { ...keys, ...addAmounts(emptyAmounts(), row) });
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.costUsd - a.costUsd || totalTokens(b) - totalTokens(a),
  );
  const kept = limit === 0 ? sorted : sorted.slice(0, limit);
  return {
    rows: kept.map((row) => ({ ...row, costUsd: roundCost(row.costUsd) })),
    omittedRows: sorted.length - kept.length,
    totals: { ...totals, costUsd: roundCost(totals.costUsd) },
  };
}

export function normalizeGroupBy(
  groupBy: readonly UsageReportGroupKey[] | undefined,
): UsageReportGroupKey[] {
  const wanted = new Set(
    groupBy === undefined || groupBy.length === 0 ? DEFAULT_GROUP_BY : groupBy,
  );
  return GROUP_KEYS.filter((key) => wanted.has(key));
}

/**
 * A history directory reported by two environments, such as a shared mount, counts for the first
 * environment that reported it, as on the Usage page.
 */
export function claimSources(
  environments: ReadonlyArray<{ readonly rows: readonly UsageReportRow[] }>,
): { readonly rows: UsageReportRow[]; readonly duplicateSources: string[] } {
  const owner = new Map<string, number>();
  const duplicates = new Set<string>();
  const rows: UsageReportRow[] = [];
  for (const [index, environment] of environments.entries()) {
    for (const row of environment.rows) {
      const source = row.source;
      if (source === undefined || source.startsWith("unknown|")) {
        rows.push(row);
        continue;
      }
      const claimed = owner.get(source);
      if (claimed === undefined) owner.set(source, index);
      if (claimed === undefined || claimed === index) rows.push(row);
      else duplicates.add(source);
    }
  }
  return { rows, duplicateSources: [...duplicates] };
}

// Only the Claude and Codex adapters stream limit updates mid-turn; every other window, including
// Claude's per-model weekly allowances, changes only when the provider is probed.
const LIVE_WINDOW_IDS: Readonly<Record<string, ReadonlySet<string> | "all">> = {
  claudeAgent: new Set(["five_hour", "seven_day"]),
  codex: "all",
};

const isLiveWindow = (driver: string, id: string) => {
  const live = LIVE_WINDOW_IDS[driver];
  return live === "all" || (live !== undefined && live.has(id));
};

const earlier = (a: string, b: string) => (Date.parse(b) < Date.parse(a) ? b : a);

function limitWindows(
  driver: string,
  limits: ServerProviderUsageLimits,
  provider: ServerProvider | undefined,
): UsageReportLimitWindow[] {
  return limits.windows.map((window) => {
    // A live event stamps the account's checkedAt for every window; the provider's own probe time
    // bounds when a probe-only window was last read.
    const live = provider !== undefined && isLiveWindow(driver, window.id);
    return {
      id: window.id,
      label: window.label,
      kind: window.kind,
      usedPercent: window.usedPercent,
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      checkedAt:
        live || provider === undefined
          ? limits.checkedAt
          : earlier(limits.checkedAt, provider.checkedAt),
      source: live ? "live-event" : "probe",
    };
  });
}

/** Each provider's pooled accounts, deduplicated as `/usage-limits` and Usage → Limits do. */
export function limitAccounts(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  nowMs: number,
  environment?: string,
): UsageReportLimitAccount[] {
  const byInstance = new Map(providers.map((provider) => [provider.instanceId, provider] as const));
  const drivers = new Map<string, ServerProvider>();
  for (const provider of providers) {
    if (provider.enabled && !drivers.has(provider.driver)) drivers.set(provider.driver, provider);
  }
  const accounts: UsageReportLimitAccount[] = [];
  for (const [driver, selected] of drivers) {
    if (!hasProviderUsageLimits(selected.driver, providers, sources)) continue;
    const report = collectProviderUsageLimits(selected.instanceId, providers, sources, nowMs);
    for (const account of report?.accounts ?? []) {
      const provider =
        account.instanceId === undefined ? undefined : byInstance.get(account.instanceId);
      const notice = limitsNotice(account.limits);
      accounts.push({
        ...(environment === undefined ? {} : { environment }),
        provider: driver,
        account: account.label,
        ...(account.email === undefined ? {} : { email: account.email }),
        ...(account.plan === undefined ? {} : { plan: account.plan }),
        ...(notice === null ? {} : { notice }),
        windows: limitWindows(driver, account.limits, provider),
      });
    }
  }
  return accounts;
}

/** The same login seen from two environments counts once: the latest reading wins. */
export function dedupeLimitAccounts(
  accounts: readonly UsageReportLimitAccount[],
): UsageReportLimitAccount[] {
  const latest = (account: UsageReportLimitAccount) =>
    Math.max(0, ...account.windows.map((window) => Date.parse(window.checkedAt)));
  const byKey = new Map<string, UsageReportLimitAccount>();
  const unkeyed: UsageReportLimitAccount[] = [];
  for (const account of accounts) {
    if (account.email === undefined) {
      unkeyed.push(account);
      continue;
    }
    const key = `${account.provider}|${account.email.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing === undefined || latest(account) > latest(existing)) byKey.set(key, account);
  }
  return [...byKey.values(), ...unkeyed];
}

const dayIn = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);

function inWindow(ms: number, window: UsageWindow): boolean {
  if (window.sinceTime !== undefined && window.untilTime !== undefined) {
    return ms >= Date.parse(window.sinceTime) && ms < Date.parse(window.untilTime);
  }
  const day = dayIn(ms, window.timeZone);
  return day >= window.sinceDay && day <= window.untilDay;
}

/**
 * Prices a thread's own turn records with the Usage rate table. Turns report input including
 * cache reads and writes; when a provider omits the split, all input is priced as uncached.
 */
export function threadTurnRows(input: {
  readonly turns: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderTurn,
      "providerThreadId" | "startedAt" | "completedAt" | "turnTokenUsage" | "model"
    >
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "driver" | "providerInstanceId">
  >;
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly window: UsageWindow;
  readonly environment: string;
}) {
  const threads = new Map(input.providerThreads.map((thread) => [thread.id, thread] as const));
  const rows: UsageReportRow[] = [];
  let turns = 0;
  let turnsWithoutCacheSplit = 0;
  const otherTokens = { input: 0, output: 0 };
  for (const turn of input.turns) {
    const usage = turn.turnTokenUsage;
    const at = turn.completedAt ?? turn.startedAt;
    if (usage === undefined || usage.localCommand === true || at === null) continue;
    const ms = DateTime.toEpochMillis(at);
    if (!inWindow(ms, input.window)) continue;
    turns += 1;
    if (usage.cachedInputTokens === undefined) turnsWithoutCacheSplit += 1;
    otherTokens.input += usage.otherUsage?.inputTokens ?? 0;
    otherTokens.output += usage.otherUsage?.outputTokens ?? 0;
    const inputTokens = usage.inputTokens ?? 0;
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    const totals: UsageTokenTotals = {
      uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    };
    const model = turn.model ?? usage.models?.[0] ?? "unknown";
    const priced = priceUsage(
      input.rates,
      { model, totals, speed: "standard", reportedCostUsd: null },
      input.overrides,
    );
    const thread = threads.get(turn.providerThreadId);
    rows.push({
      environment: input.environment,
      account: thread?.providerInstanceId ?? "unknown",
      provider: thread?.driver ?? "unknown",
      model,
      day: dayIn(ms, input.window.timeZone),
      tokens: tokensOf(totals),
      costUsd: priced.costUsd,
      records: 1,
      unpricedRecords: priced.costSource === "unpriced" ? 1 : 0,
    });
  }
  return { rows, turns, turnsWithoutCacheSplit, otherTokens };
}
