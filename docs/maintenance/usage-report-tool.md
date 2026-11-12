# Usage report MCP tool (LAN fork)

`usage_report` gives agents what the Usage page computes, so fleet agents stop scraping
`claude -p "/usage"`. Tracker row: [Native feature sync](native-feature-sync.md) row 15. Replace
it if upstream ships an agent-facing usage tool.

## What it reuses

| Piece                       | Where (upstream code)                                             | How the tool uses it                                                                                              |
| --------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Transcript scan and pricing | `apps/server/src/usage/UsageService.ts` `readSummary`             | The same call as `server.getUsageSummary`, with its in-flight dedupe, scan cache and rate cache.                  |
| Buckets and sources         | `packages/contracts/src/usage.ts`                                 | `account` is a bucket's `sourcePath` (a provider's history directory), and `host` is its source's `hostId`.       |
| Limit state                 | `ProviderRegistry.getProviders`, `UsageLimitSources.current`      | Read as stored; never probed.                                                                                     |
| Pooling and account dedupe  | `packages/shared/src/usageLimits.ts` `collectProviderUsageLimits` | The same function as `/usage-limits`.                                                                             |
| Linked-environment routing  | `McpToolAccess.routed`, `PeerForwarding`                          | `environmentId` routing comes for free. `scope: "fleet"` calls each linked environment's `usage_report` directly. |

The tool adds no scanning, polling or refresh. Turn-record attribution reads the rate table that the
last scan saved in `usage-model-rates.json`.

## Decisions a maintainer could get wrong

- **Limit freshness.** Upstream keeps one `checkedAt` per account, and a live event restamps it for
  every window (`applyUsageLimitsUpdate`). Claude's live events carry only `five_hour`,
  `seven_day` and the one overage-included model. The per-model weekly windows (`Weekly · Fable`,
  `Weekly · Opus`) come only from the `get_usage` probe. So each window reports `source`:
  - `live-event`: Claude Session and Weekly, and every Codex window. Its `checkedAt` is the account's.
  - `probe`: everything else. Its `checkedAt` is the earlier of the account's time and the
    provider's probe time. That is the latest time the reading could have been taken. A probe that
    reused a cached reading can be older still. An exact per-window time needs an upstream change
    to store a reading time on each window.
- **Fleet dedupe.** A history directory reported by two environments (same host, path and volume)
  counts for the first environment that reported it, as `mergeUsage` does on the page. Peers are
  asked for every row grouped by `source`, so this side can dedupe before capping. The same login
  seen from two environments keeps its latest limit reading. A peer without the tool shows as
  `unavailable` with its error.
- **Limits read as remaining.** Windows carry `remainingPercent` (100 − used, clamped to 0–100,
  one decimal), the way the user reads limits; the description tells agents to present them so.
  Stored state stays `usedPercent`.
- **Which source answers.** Transcripts cannot be attributed to threads, because `readSummary`
  drops the session id. So a `threadId`, or a `groupBy` with `thread` or `project`, switches the
  whole report to T3's turn records (`attribution: "thread-turns"`); everything else reads
  transcripts. Turn records miss provider use outside T3 threads, and the note says so.
- **Turn records.** `turnLedger.ts` reads every turn with `turnTokenUsage` in the window in one
  query over upstream's projection tables (`orchestration_v2_projection_provider_turns`,
  `_provider_threads`, `_threads` and `projection_projects`). An upstream rename or payload change
  breaks it; `turnLedger.test.ts` builds the schema through the real migrations to catch that.
  The query scans the turns table: 650 turns took 5–11 ms on real data (Nov 2026), so there is no
  index. Revisit when the table nears 100k rows. Pricing uses the saved rates and the user's
  overrides. Turns without a cache split price all input as uncached (`turns.withoutCacheSplit`).
  Subagent and compaction tokens (`otherUsage`) are returned in `turns.otherTokens`, unpriced.
  `localCommand` turns are skipped.
- **Filters and charts.** `model` takes exact model ids in both modes; rows already show the ids
  to pick, so no substring form. `hour` slots match the page's 24-hour buckets (whole hours from
  the window start) and fall back to clock hours over longer windows; transcripts only have
  hourly buckets for `period: "day"`, so a longer transcript `hour` request is refused. A `hour`
  or `day` grouping returns every row in time order unless `limit` is set, so a chart has no
  gaps. Other groupings sort by cost and keep 10 by default (0 returns all). `totals` always covers
  every row.
- **Fleet thread rows.** Thread and project ids are local to an environment, so a fleet
  turn-record report always groups by `environment` too. Peers answer uncapped and get the
  `model` filter; their rows have no `source`, so the history-directory dedupe passes them
  through, and `turns` counts are summed.

## Hook points

- Fork files: `apps/server/src/mcp/toolkits/usage/{tools,report,handlers,turnLedger}.ts` and
  their tests.
- Upstream file touched: `apps/server/src/mcp/McpHttpServer.ts`, one import and a
  `layerUsageToolkit` registration merged beside `layerLanToolkit`, outside upstream's
  `layerTools`. Upstream's advertised tool set and `AgentContextBudget.test.ts` stay untouched,
  and so does the eval toolkit list in `evals/mcp-tool-use/run.ts`. The fork's other tools are
  not in that list either.
- On an upstream merge, re-check `ServerProviderUsageWindow` and `claudeUsageLimits.ts`. New
  live-event window ids belong in `LIVE_WINDOW_IDS` in `report.ts`.
