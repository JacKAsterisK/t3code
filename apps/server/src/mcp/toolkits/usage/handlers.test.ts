import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  OrchestratorMcpFailure,
  UsageDay,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { usageReport } from "./handlers.ts";
import type { UsageReportResult } from "./tools.ts";

const here = EnvironmentId.make("environment:cryofrog");
const anvil = EnvironmentId.make("environment:anviltoad");
const spd = EnvironmentId.make("environment:spdevmachine");
const asleep = EnvironmentId.make("environment:laptop");
const shared = "anviltoad|claude|C:/claude-accounts/spd|1:2";

const tokens = { input: 1, cacheRead: 2, cacheWrite: 0, output: 1, reasoning: 0 };
const peerReport: UsageReportResult = {
  environmentId: anvil,
  attribution: "transcripts",
  window: { sinceDay: "2026-11-06", untilDay: "2026-11-12", timeZone: "UTC" },
  groupBy: ["environment", "account", "source"],
  rows: [
    {
      environment: "AnvilToad",
      account: "C:/claude-accounts/spd",
      source: shared,
      tokens,
      costUsd: 2,
      records: 1,
      unpricedRecords: 0,
    },
    {
      environment: "AnvilToad",
      account: "C:/Users/gavin/.claude",
      source: "anviltoad|claude|C:/Users/gavin/.claude|1:3",
      tokens,
      costUsd: 1,
      records: 1,
      unpricedRecords: 0,
    },
  ],
  omittedRows: 0,
  totals: { tokens, costUsd: 3, records: 2, unpricedRecords: 0 },
  sources: { ok: 2, missing: 0, problems: [] },
  notes: [],
};

it.effect("merges linked environments and reports the ones that did not answer", () =>
  Effect.gen(function* () {
    const forwarded = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const result: UsageReportResult = yield* usageReport({
      scope: "fleet",
      groupBy: ["account"],
      include: ["usage"],
    }).pipe(Effect.provide(layer(forwarded)));

    expect(result.environments).toEqual([
      { environmentId: here, label: "CryoFrog", status: "ok" },
      { environmentId: anvil, label: "AnvilToad", status: "ok" },
      {
        environmentId: spd,
        label: "SPDevMachine",
        status: "unavailable",
        message: "invalid_request: Unknown tool usage_report",
      },
      {
        environmentId: asleep,
        label: "Laptop",
        status: "unavailable",
        message: "Link is unreachable.",
      },
    ]);
    // The shared directory counts once, for CryoFrog, which reported it first.
    expect(result.rows.map(({ account, costUsd }) => ({ account, costUsd }))).toEqual([
      { account: "C:/claude-accounts/spd", costUsd: 5 },
      { account: "C:/Users/gavin/.claude", costUsd: 1 },
    ]);
    expect(result.notes).toContain(
      "1 history directories reported by more than one environment were counted once.",
    );
    // Each peer is asked for every row of its own machine, keyed by source so this side can dedupe.
    expect(yield* Ref.get(forwarded)).toEqual([
      expect.objectContaining({
        environmentId: anvil,
        scope: "environment",
        groupBy: ["environment", "account", "source"],
        include: ["usage"],
        limit: 0,
      }),
      expect.objectContaining({ environmentId: spd }),
    ]);
  }),
);

it.effect("ranks threads across the fleet with each environment's rows kept apart", () =>
  Effect.gen(function* () {
    const forwarded = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const thread = (id: string, title: string, costUsd: number) => ({
      environment: "AnvilToad",
      thread: id,
      threadTitle: title,
      projectTitle: "Reprint",
      tokens,
      costUsd,
      records: 1,
      unpricedRecords: 0,
    });
    const turns = { count: 2, withoutCacheSplit: 0, otherTokens: { input: 0, output: 0 } };
    const result: UsageReportResult = yield* usageReport({
      scope: "fleet",
      groupBy: ["thread"],
      model: ["claude-opus-5-5"],
      include: ["usage"],
      limit: 1,
    }).pipe(
      Effect.provide(
        layer(forwarded, {
          ...peerReport,
          attribution: "thread-turns",
          groupBy: ["environment", "thread", "source"],
          rows: [thread("thread:a", "Coil dressing", 2), thread("thread:b", "Perf bench", 3)],
          turns,
        }),
      ),
    );

    expect(result).toMatchObject({
      attribution: "thread-turns",
      groupBy: ["environment", "thread"],
    });
    // This machine's empty ledger adds nothing; the peer's rows keep its name and titles.
    expect(result.rows).toEqual([thread("thread:b", "Perf bench", 3)]);
    expect(result.omittedRows).toBe(1);
    expect(result.turns).toEqual(turns);
    expect((yield* Ref.get(forwarded))[0]).toMatchObject({
      groupBy: ["environment", "thread", "source"],
      model: ["claude-opus-5-5"],
      limit: 0,
    });
  }),
);

const layer = (forwarded: Ref.Ref<ReadonlyArray<unknown>>, answer = peerReport) =>
  Layer.mergeAll(
    SqlitePersistence.layerMemory,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: here,
      requestNamespace: "client:usage",
      thread: undefined,
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(Environment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: here,
        label: "CryoFrog",
        platform: { os: "windows", arch: "x64" },
        serverVersion: "0.0.0",
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(UsageService.UsageService)({
      readSummary: () =>
        Effect.succeed({
          contractVersion: 6,
          readAt: "2026-11-12T12:00:00.000Z",
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-11-06"),
          untilDay: UsageDay.make("2026-11-12"),
          buckets: [
            {
              day: UsageDay.make("2026-11-12"),
              provider: "claude",
              model: "claude-fable-5-2",
              sourcePath: "C:/claude-accounts/spd",
              totals: {
                uncachedInputTokens: 1,
                cachedInputTokens: 2,
                cacheCreationTokens: 0,
                outputTokens: 1,
                reasoningTokens: 0,
              },
              costUsd: 5,
              cacheSavingsUsd: 0,
              costSource: "modelPriced",
              records: 1,
              unpricedRecords: 0,
              sessions: 1,
            },
          ],
          sources: [
            {
              fingerprint: {
                hostId: "anviltoad",
                provider: "claude",
                resolvedHomePath: "C:/claude-accounts/spd",
                volumeId: "1:2",
              },
              status: "ok",
              scannedFiles: 1,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 1,
              message: null,
            },
          ],
          pricing: { status: "cached", source: "litellm", fetchedAt: null, knownModels: 1 },
          scanDurationMs: 1,
        }),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-report-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
    Layer.mock(PeerForwarding.PeerForwarding)({
      links: () =>
        Effect.succeed({
          environmentId: here,
          notListed: "",
          links: [anvil, spd, asleep].map((environmentId) => ({
            environmentId,
            label:
              environmentId === anvil
                ? "AnvilToad"
                : environmentId === spd
                  ? "SPDevMachine"
                  : "Laptop",
            status: environmentId === asleep ? ("unreachable" as const) : ("reachable" as const),
            access: "full-access" as const,
            expiresAt: "2026-12-01T00:00:00.000Z",
            lastError: null,
          })),
        }),
      call: (_scope, _tool, environmentId, params) =>
        Ref.update(forwarded, (all) => [...all, params]).pipe(
          Effect.andThen(
            environmentId === anvil
              ? Effect.succeed(answer as never)
              : Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "Unknown tool usage_report",
                  }),
                ),
          ),
        ),
    }),
  );
