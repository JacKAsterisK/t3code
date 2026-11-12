import {
  NonNegativeInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadId,
  UsageDay,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerConfig from "../../../config.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** `source` is a history directory's host, path and volume; fleet merges use it to count a shared directory once. */
export const UsageReportGroupKey = Schema.Literals([
  "environment",
  "account",
  "provider",
  "model",
  "host",
  "day",
  "source",
]);
export type UsageReportGroupKey = typeof UsageReportGroupKey.Type;

const Tokens = Schema.Struct({
  input: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
});

const Amounts = {
  tokens: Tokens,
  costUsd: Schema.Number,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
};

export const UsageReportRow = Schema.Struct({
  environment: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  day: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  ...Amounts,
});
export type UsageReportRow = typeof UsageReportRow.Type;

export const UsageReportLimitWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.optionalKey(Schema.String),
  /** The latest time this reading could have been taken; a probe reading may be older. */
  checkedAt: Schema.String,
  source: Schema.Literals(["live-event", "probe"]),
});
export type UsageReportLimitWindow = typeof UsageReportLimitWindow.Type;

export const UsageReportLimitAccount = Schema.Struct({
  environment: Schema.optionalKey(Schema.String),
  provider: Schema.String,
  account: Schema.String,
  email: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
  notice: Schema.optionalKey(Schema.String),
  windows: Schema.Array(UsageReportLimitWindow),
});
export type UsageReportLimitAccount = typeof UsageReportLimitAccount.Type;

export const UsageReportResult = Schema.Struct({
  environmentId: Schema.String,
  attribution: Schema.Literals(["transcripts", "thread-turns"]),
  window: Schema.Struct({
    sinceDay: Schema.String,
    untilDay: Schema.String,
    timeZone: Schema.String,
    sinceTime: Schema.optionalKey(Schema.String),
    untilTime: Schema.optionalKey(Schema.String),
  }),
  groupBy: Schema.Array(UsageReportGroupKey),
  rows: Schema.Array(UsageReportRow),
  omittedRows: NonNegativeInt,
  totals: Schema.Struct(Amounts),
  limits: Schema.optionalKey(Schema.Array(UsageReportLimitAccount)),
  /** History directories that did not scan cleanly; clean and absent ones are only counted. */
  sources: Schema.optionalKey(
    Schema.Struct({
      ok: NonNegativeInt,
      missing: NonNegativeInt,
      problems: Schema.Array(
        Schema.Struct({
          source: Schema.String,
          status: Schema.String,
          message: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
  pricing: Schema.optionalKey(
    Schema.Struct({ status: Schema.String, fetchedAt: Schema.NullOr(Schema.String) }),
  ),
  environments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        environmentId: Schema.String,
        label: Schema.String,
        status: Schema.Literals(["ok", "unavailable"]),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  thread: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.String,
      turns: NonNegativeInt,
      /** Turns whose provider reported no cache split; their input is priced as uncached. */
      turnsWithoutCacheSplit: NonNegativeInt,
      /** Subagent and compaction tokens the provider reported apart from the main agent; not priced. */
      otherTokens: Schema.Struct({ input: NonNegativeInt, output: NonNegativeInt }),
    }),
  ),
  notes: Schema.Array(Schema.String),
});
export type UsageReportResult = typeof UsageReportResult.Type;

export const UsageReportParameters = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  scope: Schema.optionalKey(
    Schema.Literals(["environment", "fleet"]).annotate({
      description: "fleet: this machine plus every linked one, merged. Default environment.",
    }),
  ),
  period: Schema.optionalKey(
    Schema.Literals(["day", "week", "month", "quarter"]).annotate({
      description: "Past 24 hours, 7, 30 or 90 days. Default week.",
    }),
  ),
  since: Schema.optionalKey(UsageDay),
  until: Schema.optionalKey(UsageDay),
  groupBy: Schema.optionalKey(
    Schema.Array(UsageReportGroupKey).annotate({
      description: "Default account, provider, model. account is a provider's history directory.",
    }),
  ),
  include: Schema.optionalKey(Schema.Array(Schema.Literals(["usage", "limits"]))),
  threadId: Schema.optionalKey(
    ThreadId.annotate({
      description:
        "Attribute one thread from its own turn records instead of transcripts (partial cache split).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })).annotate({
      description: "Rows to return, by cost. Default 10; 0 returns all.",
    }),
  ),
});
export type UsageReportParameters = typeof UsageReportParameters.Type;

export const UsageReportTool = Tool.make("usage_report", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    UsageService.UsageService,
    UsageLimitSources.UsageLimitSources,
    ProviderRegistry.ProviderRegistry,
    Settings.ServerSettingsService,
    ServerConfig.ServerConfig,
    ServerEnvironment.ServerEnvironment,
    FileSystem.FileSystem,
    Path.Path,
  ],
  description:
    "Token use, API-rate cost and subscription limits from T3's Usage page: per account, provider, model and host, plus limit windows (percent used, reset, checkedAt, live-event or probe). Reads cached scans and stored limits; never refreshes.",
  parameters: UsageReportParameters,
  success: UsageReportResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const UsageToolkit = Toolkit.make(UsageReportTool);
