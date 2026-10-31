// @effect-diagnostics nodeBuiltinImport:off -- Generated rich history fixtures never touch installed homes.
import { test, expect } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { createHistoryImportFixture } from "./home-repair-history.fixture-builder.ts";
import { previewHistoryImport, importHistory } from "./home-repair-history.ts";
import { resolveAttachmentPathById } from "../../apps/server/src/attachmentStore.ts";
const dbPath = (home: string) => NodePath.join(home, "userdata", "statev2.sqlite");
const mutate = (home: string, sql: string) => {
  const db = new NodeSqlite.DatabaseSync(dbPath(home));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};
const rows = (home: string, table: string) => {
  const db = new NodeSqlite.DatabaseSync(dbPath(home), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
};
const payloads = (home: string, table: string) =>
  rows(home, table).map((row) => JSON.parse(String(row.payload_json)));
async function fixture(
  f: (input: Awaited<ReturnType<typeof createHistoryImportFixture>>) => Promise<void>,
  options: Parameters<typeof createHistoryImportFixture>[1] = {
    forkMode: "run",
    sharedProjectRoot: false,
  },
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-history-import-"));
  try {
    await f(await createHistoryImportFixture(root, options));
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(root).startsWith("t3-history-import-")
    )
      // eslint-disable-next-line no-unsafe-finally -- Only the verified synthetic temporary root can be removed.
      throw new Error("Unsafe history fixture cleanup");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

test("imports full fork history/cards/attachments through events with collision remapping and idempotency", () =>
  fixture(async ({ source, target, staged }) => {
    const targetWork = rows(target, "orchestration_v2_projection_runs"),
      requests = rows(target, "orchestration_v2_projection_runtime_requests");
    const plan = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: target,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.summary.newThreads).toBe(2);
    expect(plan.summary.convertedCards).toBeGreaterThan(0);
    const result = await importHistory({
      sourceHomeDirectory: source,
      stagedTargetHomeDirectory: staged,
      expectedReviewGeneration: plan.reviewGeneration,
    });
    const assignments = rows(staged, "agent_event_owner_assignments").filter((row) =>
      result.importedThreadIds.includes(String(row.thread_id)),
    );
    expect(assignments.map((row) => row.thread_id).sort()).toEqual(
      [...result.importedThreadIds].sort(),
    );
    expect(assignments.every((row) => row.owner_id === null)).toBe(true);
    expect(rows(staged, "agent_event_source_directories").length).toBeGreaterThan(0);
    expect(rows(staged, "agent_event_deliveries")).toEqual([]);
    expect(result.importedThreadIds).toHaveLength(2);
    expect(result.newProjectIds).toHaveLength(1);
    expect(result.proof.existingRowsGenerationAfter).toBe(
      result.proof.existingRowsGenerationBefore,
    );
    expect(result.proof.existingWorkGenerationAfter).toBe(
      result.proof.existingWorkGenerationBefore,
    );
    expect(result.proof.eventPrefixGenerationAfter).toBe(result.proof.eventPrefixGenerationBefore);
    expect(rows(staged, "orchestration_v2_projection_runs")).toEqual(targetWork);
    expect(rows(staged, "orchestration_v2_projection_runtime_requests")).toEqual(requests);
    expect(rows(staged, "orchestration_v2_projection_provider_sessions")).toEqual([]);
    expect(rows(staged, "orchestration_v2_effect_outbox")).toEqual([]);
    const threads = payloads(staged, "orchestration_v2_projection_threads");
    expect(threads.find((value) => value.id === "parent").title).toBe("Existing target thread");
    const parent = threads.find((value) => value.title === "Retained parent"),
      child = threads.find((value) => value.title === "Retained child");
    expect(parent.id).not.toBe("parent");
    expect(child.lineage.parentThreadId).toBe(parent.id);
    expect(child.forkedFrom).toBeNull();
    expect(child.activeProviderThreadId).toBeNull();
    expect(child.settledOverride).toBe("settled");
    const cards = payloads(staged, "orchestration_v2_projection_turn_items");
    const childCards = cards.filter((value) => value.threadId === child.id);
    expect(childCards.some((value) => value.text === "Visible fork prefix")).toBe(true);
    expect(childCards.some((value) => value.text === "After the fork boundary")).toBe(false);
    expect(
      childCards.some(
        (value) => value.type === "command_execution" && value.output === "Complete stored output",
      ),
    ).toBe(true);
    expect(
      childCards.some((value) => value.type === "reasoning" && value.text === "Full reasoning"),
    ).toBe(true);
    expect(
      childCards.some(
        (value) => value.type === "dynamic_tool" && value.output.result === "Full tool result",
      ),
    ).toBe(true);
    expect(
      childCards.some(
        (value) =>
          value.type === "system_notice" && value.message.includes("Complete historical approval"),
      ),
    ).toBe(true);
    expect(
      childCards.every(
        (value) =>
          value.runId === null && value.providerThreadId === null && value.nativeItemRef === null,
      ),
    ).toBe(true);
    for (const item of result.attachmentManifest) {
      expect(item.targetRelativePath).toMatch(/^userdata\/attachments\/[a-z0-9_-]+\.[a-z0-9]+$/i);
      expect(NodeFS.readFileSync(NodePath.join(staged, item.targetRelativePath)).toString()).toBe(
        item.targetRelativePath.endsWith(".html")
          ? "<article>Preserved rendered history</article>"
          : "pngbytes",
      );
    }
    expect(NodeFS.readFileSync(NodePath.join(staged, "userdata", "settings.json"), "utf8")).toBe(
      NodeFS.readFileSync(NodePath.join(target, "userdata", "settings.json"), "utf8"),
    );
    const repeated = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: staged,
    });
    expect(repeated.summary.newThreads).toBe(0);
    expect(repeated.summary.alreadyImportedThreads).toBe(2);
    expect(repeated.summary.importMessages).toBe(0);
    expect(repeated.summary.importCards).toBe(0);
    expect(repeated.summary.convertedCards).toBe(0);
    expect(repeated.summary.attachments).toBe(0);
    expect(repeated.summary.attachmentBytes).toBe(0);
    const count = rows(staged, "orchestration_events").length;
    await importHistory({
      sourceHomeDirectory: source,
      stagedTargetHomeDirectory: staged,
      expectedReviewGeneration: repeated.reviewGeneration,
    });
    expect(rows(staged, "orchestration_events")).toHaveLength(count);
    NodeFS.unlinkSync(NodePath.join(staged, result.attachmentManifest[0]!.targetRelativePath));
    expect(
      (await previewHistoryImport({ sourceHomeDirectory: source, targetHomeDirectory: staged }))
        .blockers,
    ).toEqual([]);
    mutate(
      source,
      "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','Changed source') WHERE message_id='message:1'",
    );
    expect(
      (await previewHistoryImport({ sourceHomeDirectory: source, targetHomeDirectory: staged }))
        .blockers,
    ).toContain("source-thread-changed");
  }));

test("remaps colliding attachment files without overwriting existing bytes", () =>
  fixture(async ({ source, target, staged }) => {
    const preview = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: target,
    });
    const first = await importHistory({
      sourceHomeDirectory: source,
      stagedTargetHomeDirectory: staged,
      expectedReviewGeneration: preview.reviewGeneration,
    });
    const collision = first.attachmentManifest[0]!;
    NodeFS.writeFileSync(
      NodePath.join(target, collision.targetRelativePath),
      "existing user bytes",
    );
    const freshStage = NodePath.join(
      NodePath.dirname(NodePath.dirname(staged)),
      "d".repeat(32),
      "staged-original",
    );
    NodeFS.cpSync(target, freshStage, { recursive: true, errorOnExist: true });
    const changedPreview = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: target,
    });
    expect(changedPreview.blockers).toEqual([]);
    const imported = await importHistory({
      sourceHomeDirectory: source,
      stagedTargetHomeDirectory: freshStage,
      expectedReviewGeneration: changedPreview.reviewGeneration,
    });
    expect(
      NodeFS.readFileSync(NodePath.join(freshStage, collision.targetRelativePath), "utf8"),
    ).toBe("existing user bytes");
    expect(
      imported.attachmentManifest.every(
        (entry) => entry.targetRelativePath !== collision.targetRelativePath,
      ),
    ).toBe(true);
    const repeated = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: freshStage,
    });
    expect(repeated.summary.newThreads).toBe(0);
    expect(repeated.summary.importMessages).toBe(0);
    mutate(freshStage, "DELETE FROM orchestration_command_receipts WHERE aggregate_id='child'");
    const mixed = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: freshStage,
    });
    expect(mixed.summary.newThreads).toBe(1);
    expect(mixed.summary.alreadyImportedThreads).toBe(1);
    expect(mixed.summary.importMessages).toBeGreaterThan(0);
    expect(mixed.summary.importMessages).toBeLessThan(imported.summary.importMessages);
  }));

test("matches real node-fork, hidden-message, built-in provider, shared project and artifact shapes", () =>
  fixture(
    async ({ source, target, staged }) => {
      mutate(
        source,
        "UPDATE orchestration_v2_projection_threads SET provider_instance_id='claudeAgent_saved',payload_json=json_set(payload_json,'$.providerInstanceId','claudeAgent_saved','$.modelSelection.instanceId','claudeAgent_saved') WHERE thread_id='parent'",
      );
      const preview = await previewHistoryImport({
        sourceHomeDirectory: source,
        targetHomeDirectory: target,
      });
      expect(preview.blockers).toEqual([]);
      expect(preview.baseline.targetEventHead).toBe(1);
      expect(
        preview.providerMappings.find((mapping) => mapping.sourceInstanceId === "codex")
          ?.targetInstanceId,
      ).toBe("codex");
      expect(
        preview.providerMappings.find((mapping) => mapping.sourceInstanceId === "claudeAgent_saved")
          ?.targetInstanceId,
      ).toBe("claudeAgent_saved");
      const imported = await importHistory({
        sourceHomeDirectory: source,
        stagedTargetHomeDirectory: staged,
        expectedReviewGeneration: preview.reviewGeneration,
      });
      expect(imported.newProjectIds).toEqual([]);
      const threads = payloads(staged, "orchestration_v2_projection_threads");
      const parent = threads.find((thread) => thread.title === "Retained parent"),
        child = threads.find((thread) => thread.title === "Retained child");
      const cards = payloads(staged, "orchestration_v2_projection_turn_items");
      const own = cards
        .filter((card) => card.threadId === parent.id)
        .sort((a, b) => a.ordinal - b.ordinal);
      expect(
        cards
          .filter((card) => card.threadId === child.id)
          .some((card) => card.text === "Visible fork prefix"),
      ).toBe(false);
      expect(child.lineage.relationshipToParent).toBe("subagent");
      expect(child.forkedFrom).toBeNull();
      const missing = own.findIndex(
        (card) => card.type === "user_message" && card.text === "Message without a source card",
      );
      expect(missing).toBeGreaterThanOrEqual(0);
      expect(missing).toBeLessThan(
        own.findIndex((card) => card.text === "After the fork boundary"),
      );
      expect(
        own.some(
          (card) => card.type === "system_notice" && card.message.includes("kept-checkpoint.ts"),
        ),
      ).toBe(true);
      expect(
        own.some(
          (card) =>
            card.type === "system_notice" &&
            card.message.includes("Full original subagent prompt") &&
            card.message.includes("Full original subagent result"),
        ),
      ).toBe(true);
      expect(
        own.some(
          (card) => card.type === "system_notice" && card.message.includes("historical:parent"),
        ),
      ).toBe(true);
      const message = payloads(staged, "orchestration_v2_projection_messages").find(
        (message) => message.threadId === parent.id && message.text === "Visible fork prefix",
      );
      expect(message.senderThreadId).toBe(child.id);
      expect(message.delegatedCompletion).toBeUndefined();
      const contextId = message.context.records[0].attachmentId;
      expect(contextId).toMatch(/^history-/);
      expect(
        resolveAttachmentPathById({
          attachmentsDir: NodePath.join(staged, "userdata", "attachments"),
          attachmentId: contextId,
        }),
      ).not.toBeNull();
      expect(
        imported.attachmentManifest.some((file) => file.targetRelativePath.endsWith(".html")),
      ).toBe(true);
      for (const card of own)
        if (card.type === "user_message" && card.context)
          expect(card.context.records[0].attachmentId).toBe(contextId);
      expect(rows(staged, "orchestration_v2_projection_subagents")).toEqual([]);
      expect(rows(staged, "orchestration_v2_projection_checkpoints")).toEqual([]);
    },
    { forkMode: "node", sharedProjectRoot: true },
  ));

test("refuses missing bodies/artifacts, ambiguous profile mappings and non-staged writes", () =>
  fixture(async ({ source, target, staged }) => {
    const html = NodePath.join(
      source,
      "userdata",
      "attachments",
      "parent-33333333-3333-4333-8333-333333333333-html.html",
    );
    NodeFS.renameSync(html, html + ".retained");
    expect(
      (await previewHistoryImport({ sourceHomeDirectory: source, targetHomeDirectory: target }))
        .blockers,
    ).toContain("history-artifact-unavailable");
    NodeFS.renameSync(html + ".retained", html);
    mutate(
      source,
      "UPDATE orchestration_events SET payload_json=json_remove(payload_json,'$.output') WHERE event_id='source:command'",
    );
    expect(
      (await previewHistoryImport({ sourceHomeDirectory: source, targetHomeDirectory: target }))
        .blockers,
    ).toContain("history-tool-output-unavailable");
    mutate(
      source,
      "UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.output','Complete stored output') WHERE event_id='source:command'; UPDATE orchestration_v2_projection_threads SET provider_instance_id='customClaude',payload_json=json_set(payload_json,'$.providerInstanceId','customClaude','$.modelSelection.instanceId','customClaude') WHERE thread_id='parent'",
    );
    NodeFS.writeFileSync(
      NodePath.join(source, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: { customClaude: { driver: "claudeAgent", enabled: true } },
      }),
    );
    const ambiguous = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: target,
    });
    expect(ambiguous.blockers).toContain("provider-mapping-required");
    expect(
      ambiguous.providerMappings.find((mapping) => mapping.sourceInstanceId === "customClaude")
        ?.targetCandidates,
    ).toHaveLength(2);
    const chosen = await previewHistoryImport({
      sourceHomeDirectory: source,
      targetHomeDirectory: target,
      providerMappings: { customClaude: "claudeAgent_saved" },
    });
    expect(chosen.blockers).toEqual([]);
    await expect(
      importHistory({
        sourceHomeDirectory: source,
        stagedTargetHomeDirectory: target,
        expectedReviewGeneration: chosen.reviewGeneration,
      }),
    ).rejects.toThrow("staged-target");
    await expect(
      importHistory({
        sourceHomeDirectory: source,
        stagedTargetHomeDirectory: staged,
        expectedReviewGeneration: "f".repeat(64),
        providerMappings: { customClaude: "claudeAgent_saved" },
      }),
    ).rejects.toThrow("review-changed");
  }));
