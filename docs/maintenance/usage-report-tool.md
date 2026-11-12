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

The tool adds no scanning, polling or refresh. Thread mode reads the rate table that the last scan
saved in `usage-model-rates.json`.

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
- **Thread mode** (`threadId`, `attribution: "thread-turns"`). It sums the thread's own
  `turnTokenUsage` and prices it with the saved rates and the user's price overrides. Turns that
  report no cache split have their input priced as uncached and are counted in
  `turnsWithoutCacheSplit`. Subagent and compaction tokens (`otherUsage`) are returned but not
  priced. Transcript usage cannot be attributed to threads, because `readSummary` drops the
  session id.
- **Output size.** Rows are folded to `groupBy` (default `account, provider, model`), sorted by
  cost and capped by `limit` (default 10; 0 returns all). `totals` always covers every row. Only
  sources that did not scan cleanly are listed.

## Hook points

- Fork files: `apps/server/src/mcp/toolkits/usage/{tools,report,handlers}.ts` and their tests.
- Upstream file touched: `apps/server/src/mcp/McpHttpServer.ts`, one import and a
  `layerUsageToolkit` registration merged beside `layerLanToolkit`, outside upstream's
  `layerTools`. Upstream's advertised tool set and `AgentContextBudget.test.ts` stay untouched,
  and so does the eval toolkit list in `evals/mcp-tool-use/run.ts`. The fork's other tools are
  not in that list either.
- On an upstream merge, re-check `ServerProviderUsageWindow` and `claudeUsageLimits.ts`. New
  live-event window ids belong in `LIVE_WINDOW_IDS` in `report.ts`.
