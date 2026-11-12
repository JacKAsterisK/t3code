import {
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLink,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import { createOverrideRateTable, parseRateTable } from "../../../usage/usagePricing.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, readThread, unavailable } from "../../threadAccess.ts";
import {
  claimSources,
  dedupeLimitAccounts,
  defaultRowLimit,
  groupRows,
  limitAccounts,
  modelFilter,
  normalizeGroupBy,
  resolveWindow,
  sourceProblems,
  summaryRows,
  turnRows,
  usesTurnLedger,
  type UsageWindow,
} from "./report.ts";
import {
  UsageReportTool,
  UsageToolkit,
  type UsageReportParameters,
  type UsageReportResult,
  type UsageReportGroupKey,
  type UsageReportRow,
} from "./tools.ts";
import { readTurnLedger } from "./turnLedger.ts";

type Params = Omit<UsageReportParameters, "environmentId">;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const decodeRatesCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ document: Schema.Unknown })),
);

/** The rate table the last Usage scan saved; thread attribution never fetches rates itself. */
const savedRates = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem
    .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
    .pipe(Effect.option);
  const saved = Option.flatMap(raw, decodeRatesCache);
  return Option.isSome(saved) ? parseRateTable(saved.value.document) : new Map();
});

interface LocalReport {
  readonly attribution: UsageReportResult["attribution"];
  readonly rows: readonly UsageReportRow[];
  readonly limits?: UsageReportResult["limits"];
  readonly sources?: UsageReportResult["sources"];
  readonly pricing?: UsageReportResult["pricing"];
  readonly turns?: UsageReportResult["turns"];
}

const localReport = Effect.fn("UsageReport.local")(function* (input: {
  readonly window: UsageWindow;
  readonly include: ReadonlySet<"usage" | "limits">;
  readonly label: string;
  readonly groupBy: readonly UsageReportGroupKey[];
  readonly threadId: ThreadId | undefined;
  readonly models: readonly string[] | undefined;
}) {
  const { window, include, label, threadId } = input;
  let report: LocalReport = { attribution: "transcripts", rows: [] };
  if (usesTurnLedger(input.groupBy, threadId)) {
    if (threadId !== undefined) yield* readThread(threadId);
    report = { attribution: "thread-turns", rows: [] };
    if (threadId !== undefined || include.has("usage")) {
      const settings = yield* (yield* Settings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(unavailable),
      );
      const rates = yield* savedRates;
      const ledger = yield* readTurnLedger(window, threadId).pipe(Effect.mapError(unavailable));
      const turns = turnRows({
        turns: ledger,
        rates,
        overrides: createOverrideRateTable(settings.usagePriceOverrides),
        window,
        environment: label,
        ...(input.models === undefined ? {} : { models: input.models }),
      });
      report = {
        attribution: "thread-turns",
        rows: turns.rows,
        pricing: { status: rates.size > 0 ? "cached" : "unavailable", fetchedAt: null },
        turns: {
          ...(threadId === undefined ? {} : { threadId }),
          count: turns.count,
          withoutCacheSplit: turns.withoutCacheSplit,
          otherTokens: turns.otherTokens,
        },
      };
    }
  } else if (include.has("usage")) {
    const usage = yield* UsageService.UsageService;
    const summary = yield* usage
      .readSummary(window)
      .pipe(
        Effect.mapError((error) =>
          error.reason === "invalidWindow" ? invalid(error.detail) : unavailable(),
        ),
      );
    const wanted = modelFilter(input.models);
    report = {
      attribution: "transcripts",
      rows: summaryRows(summary, label).filter((row) => wanted(row.model)),
      sources: sourceProblems(summary),
      pricing: { status: summary.pricing.status, fetchedAt: summary.pricing.fetchedAt },
    };
  }
  if (include.has("limits")) {
    const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
    const hubs = yield* (yield* UsageLimitSources.UsageLimitSources).current;
    report = {
      ...report,
      limits: limitAccounts(providers, hubs, yield* Clock.currentTimeMillis, label),
    };
  }
  return report;
});

const windowOf = (window: UsageWindow): UsageReportResult["window"] => ({
  sinceDay: window.sinceDay,
  untilDay: window.untilDay,
  timeZone: window.timeZone,
  ...(window.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
  ...(window.untilTime === undefined ? {} : { untilTime: window.untilTime }),
});

const TURNS_NOTE =
  "thread-turns: summed from T3's own turn records and priced with the saved Usage rates; provider use outside T3 threads is not included, and subagent and compaction tokens are in turns.otherTokens, unpriced.";

type Turns = NonNullable<UsageReportResult["turns"]>;
const addTurns = (into: Turns | undefined, from: Turns): Turns =>
  into === undefined
    ? from
    : {
        count: into.count + from.count,
        withoutCacheSplit: into.withoutCacheSplit + from.withoutCacheSplit,
        otherTokens: {
          input: into.otherTokens.input + from.otherTokens.input,
          output: into.otherTokens.output + from.otherTokens.output,
        },
      };

export const usageReport = Effect.fn("UsageReport.report")(function* (params: Params) {
  const { scope } = yield* readCaller();
  const fleet = params.scope === "fleet";
  if (fleet && params.threadId !== undefined)
    return yield* invalid("threadId reads one environment's thread; omit scope fleet.");
  const window = resolveWindow(params, DateTime.toDate(yield* DateTime.now));
  if (typeof window === "string") return yield* invalid(window);
  const include = new Set(params.include ?? (["usage", "limits"] as const));
  const asked = normalizeGroupBy(params.groupBy);
  const turnLedger = usesTurnLedger(asked, params.threadId);
  // Thread and project ids are local to an environment, so fleet rows keep theirs.
  const groupBy = fleet && turnLedger ? normalizeGroupBy([...asked, "environment"]) : asked;
  if (!turnLedger && groupBy.includes("hour") && window.resolution !== "hour")
    return yield* invalid(
      "Transcripts keep hourly buckets only for period day. Group by thread or project for hourly turn records over longer windows.",
    );
  const limit = params.limit ?? defaultRowLimit(groupBy);
  const descriptor = yield* (yield* Environment.ServerEnvironment).getDescriptor;
  const local = yield* localReport({
    window,
    include,
    label: descriptor.label,
    groupBy,
    threadId: params.threadId,
    models: params.model,
  });
  const notes: string[] = local.attribution === "thread-turns" ? [TURNS_NOTE] : [];
  const base = {
    environmentId: descriptor.environmentId,
    attribution: local.attribution,
    window: windowOf(window),
    groupBy,
    ...(local.pricing === undefined ? {} : { pricing: local.pricing }),
  };
  if (!fleet) {
    return {
      ...base,
      ...groupRows(local.rows, groupBy, limit),
      ...(local.turns === undefined ? {} : { turns: local.turns }),
      ...(local.limits === undefined ? {} : { limits: local.limits }),
      ...(local.sources === undefined ? {} : { sources: local.sources }),
      notes,
    } satisfies UsageReportResult;
  }

  const environments: Array<NonNullable<UsageReportResult["environments"]>[number]> = [
    { environmentId: descriptor.environmentId, label: descriptor.label, status: "ok" },
  ];
  const reports: Array<{ readonly rows: readonly UsageReportRow[] }> = [local];
  let turns = local.turns;
  const limits = [...(local.limits ?? [])];
  const problems = [...(local.sources?.problems ?? [])];
  let okSources = local.sources?.ok ?? 0;
  let missingSources = local.sources?.missing ?? 0;
  const forwarding = Option.getOrUndefined(
    yield* Effect.serviceOption(PeerForwarding.PeerForwarding),
  );
  const links =
    forwarding === undefined || scope.linkedEnvironments === false
      ? undefined
      : Option.getOrUndefined(yield* forwarding.links(scope).pipe(Effect.option));
  if (links === undefined)
    notes.push("Linked environments are unavailable here; this covers one machine.");
  else if (links.links.length === 0)
    notes.push("No environments are linked to this one; this covers one machine.");
  const remote: Params = {
    scope: "environment",
    ...(params.period === undefined ? {} : { period: params.period }),
    ...(params.since === undefined ? {} : { since: params.since }),
    ...(params.until === undefined ? {} : { until: params.until }),
    groupBy: normalizeGroupBy([...groupBy, "environment", "source"]),
    ...(params.model === undefined ? {} : { model: params.model }),
    include: [...include],
    limit: 0,
  };
  const ask = (
    link: OrchestratorMcpEnvironmentLink,
  ): Effect.Effect<Result.Result<UsageReportResult, OrchestratorMcpFailure> | undefined> =>
    forwarding === undefined || link.status !== "reachable"
      ? Effect.undefined
      : forwarding
          .call(
            scope,
            UsageReportTool,
            link.environmentId,
            { ...remote, environmentId: link.environmentId },
            false,
          )
          .pipe(Effect.result);
  const answers = yield* Effect.forEach(
    links?.links ?? [],
    (link) => ask(link).pipe(Effect.map((answer) => ({ link, answer }))),
    { concurrency: "unbounded" },
  );
  for (const { link, answer } of answers) {
    if (answer === undefined || Result.isFailure(answer)) {
      environments.push({
        environmentId: link.environmentId,
        label: link.label,
        status: "unavailable",
        message:
          answer === undefined
            ? `Link is ${link.status}.`
            : `${answer.failure.code}: ${answer.failure.message}`,
      });
      continue;
    }
    const peer = answer.success;
    environments.push({ environmentId: link.environmentId, label: link.label, status: "ok" });
    reports.push(peer);
    limits.push(...(peer.limits ?? []));
    okSources += peer.sources?.ok ?? 0;
    missingSources += peer.sources?.missing ?? 0;
    problems.push(...(peer.sources?.problems ?? []));
    if (peer.turns !== undefined) turns = addTurns(turns, peer.turns);
  }
  const claimed = claimSources(reports);
  if (claimed.duplicateSources.length > 0)
    notes.push(
      `${claimed.duplicateSources.length} history directories reported by more than one environment were counted once.`,
    );
  return {
    ...base,
    ...groupRows(claimed.rows, groupBy, limit),
    ...(turns === undefined ? {} : { turns }),
    ...(include.has("limits") ? { limits: dedupeLimitAccounts(limits) } : {}),
    ...(include.has("usage")
      ? { sources: { ok: okSources, missing: missingSources, problems } }
      : {}),
    environments,
    notes,
  } satisfies UsageReportResult;
});

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  usage_report: McpToolAccess.reads(usageReport),
});
