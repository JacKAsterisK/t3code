import { expect, it } from "@effect/vitest";
import { ThreadId, UsageDay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { readTurnLedger } from "./turnLedger.ts";

const usage = (inputTokens: number) =>
  JSON.stringify({
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens,
    outputTokens: 1,
  });

it.layer(SqlitePersistence.layerMemory)("turn ledger", (it) => {
  it.effect("reads every thread's turns with usage in the window, with their names", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-11-12T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project:reprint', 'Reprint', 'C:/git/Reprint', '[]', ${now}, ${now})`;
      for (const [threadId, title, project] of [
        ["thread:a", "Coil dressing", "project:reprint"],
        ["thread:b", "Perf bench", "project:gone"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${project}, ${title}, 'claudeAgent', 'full-access', 'default', ${now}, ${now}, '{}')`;
      }
      // An older row that predates the driver columns keeps them only in its payload.
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('pt:a', 'thread:a', 'claude-spd', 'idle', ${now}, ${JSON.stringify({ driver: "claudeAgent", providerInstanceId: "claude-spd" })})`;
      const turn = (
        id: string,
        threadId: string,
        completedAt: string | null,
        payload: Record<string, unknown>,
      ) =>
        sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, started_at, completed_at, payload_json)
          VALUES (${id}, ${threadId}, ${threadId === "thread:a" ? "pt:a" : "pt:b"}, 'node', ${id.length}, 'completed', '2026-11-10T23:00:00.000Z', ${completedAt}, ${JSON.stringify(payload)})`;
      yield* turn("in-a", "thread:a", "2026-11-11T10:00:00.000Z", {
        model: "claude-opus-5-5",
        turnTokenUsage: JSON.parse(usage(100)),
      });
      // Never completed: its start time places it.
      yield* turn("in-bb", "thread:b", null, { turnTokenUsage: JSON.parse(usage(200)) });
      yield* turn("late-a", "thread:a", "2026-11-12T10:00:00.000Z", {
        turnTokenUsage: JSON.parse(usage(300)),
      });
      yield* turn("no-usage-a", "thread:a", "2026-11-11T11:00:00.000Z", {});

      const window = {
        sinceDay: UsageDay.make("2026-11-11"),
        untilDay: UsageDay.make("2026-11-11"),
        timeZone: "UTC",
        sinceTime: "2026-11-10T22:00:00.000Z",
        untilTime: "2026-11-11T22:00:00.000Z",
      };
      const all = yield* readTurnLedger(window);
      expect(
        all
          .map(({ usage, ...turn }) => ({ ...turn, inputTokens: usage.inputTokens }))
          .sort((a, b) => a.at.localeCompare(b.at)),
      ).toEqual([
        {
          threadId: "thread:b",
          threadTitle: "Perf bench",
          projectId: "project:gone",
          projectTitle: null,
          driver: null,
          providerInstanceId: null,
          at: "2026-11-10T23:00:00.000Z",
          model: null,
          inputTokens: 200,
        },
        {
          threadId: "thread:a",
          threadTitle: "Coil dressing",
          projectId: "project:reprint",
          projectTitle: "Reprint",
          driver: "claudeAgent",
          providerInstanceId: "claude-spd",
          at: "2026-11-11T10:00:00.000Z",
          model: "claude-opus-5-5",
          inputTokens: 100,
        },
      ]);
      const one = yield* readTurnLedger(window, ThreadId.make("thread:a"));
      expect(one.map((turn) => turn.at)).toEqual(["2026-11-11T10:00:00.000Z"]);
      // A day window widens to every UTC offset; the report cuts it to local days.
      const days = yield* readTurnLedger({
        sinceDay: window.sinceDay,
        untilDay: window.untilDay,
        timeZone: "UTC",
      });
      expect(days).toHaveLength(3);
    }),
  );
});
