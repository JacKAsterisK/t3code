// @effect-diagnostics nodeBuiltinImport:off -- Synthetic migrated homes contain only generated history, work and attachment fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { assertOrdinaryNativePath } from "../../packages/shared/src/nativeHomeSelection.ts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import { runMigrations } from "../../apps/server/src/persistence/Migrations.ts";

const at = "2026-10-27T00:00:00.000Z";
const later = "2026-10-27T00:01:00.000Z";
const dbPath = (home: string) => NodePath.join(home, "userdata", "statev2.sqlite");
const insert = (home: string, table: string, values: Record<string, string | number | null>) => {
  const db = new NodeSqlite.DatabaseSync(dbPath(home));
  try {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .filter(
        (column) =>
          column.pk ||
          (column.notnull && column.dflt_value === null) ||
          Object.hasOwn(values, String(column.name)),
      );
    db.prepare(
      `INSERT INTO ${table} (${columns.map((column) => column.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(
      ...columns.map((column) =>
        Object.hasOwn(values, String(column.name))
          ? values[String(column.name)]!
          : String(column.type).includes("INT")
            ? 0
            : String(column.name).endsWith("json")
              ? "{}"
              : "fixture",
      ),
    );
  } finally {
    db.close();
  }
};
const mutate = (home: string, sql: string) => {
  const db = new NodeSqlite.DatabaseSync(dbPath(home));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};
function thread(home: string, id: string, title: string, parent: string | null = null) {
  const value = {
    createdBy: "system",
    creationSource: "server",
    id,
    projectId: "project:collision",
    title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "historical-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    historyOrigin: "native",
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent ? "fork" : null,
      rootThreadId: parent ?? id,
    },
    forkedFrom: parent ? { type: "run", threadId: parent, runId: "run:before-fork" } : null,
    createdAt: at,
    updatedAt: later,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: later,
    lastVisitedAt: null,
    deletedAt: null,
  };
  insert(home, "orchestration_v2_projection_threads", {
    thread_id: id,
    project_id: value.projectId,
    title,
    default_provider: "codex",
    provider_instance_id: "codex",
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_at: at,
    updated_at: later,
    payload_json: JSON.stringify(value),
  });
}
function run(home: string, id: string, ordinal: number) {
  const payload = {
    id,
    threadId: "parent",
    ordinal,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "historical-model" },
    providerThreadId: null,
    userMessageId: `message:${ordinal}`,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: later,
    checkpointId: null,
    contextHandoffId: null,
  };
  insert(home, "orchestration_v2_projection_runs", {
    run_id: id,
    thread_id: "parent",
    ordinal,
    provider: "codex",
    status: "completed",
    requested_at: at,
    payload_json: JSON.stringify(payload),
  });
}
function card(
  home: string,
  id: string,
  threadId: string,
  ordinal: number,
  extra: Record<string, unknown>,
  runId: string | null = null,
) {
  const payload = {
    id,
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: later,
    updatedAt: later,
    ...extra,
  };
  insert(home, "orchestration_v2_projection_turn_items", {
    turn_item_id: id,
    thread_id: threadId,
    run_id: runId,
    ordinal,
    type: String(extra.type),
    status: String(payload.status),
    updated_at: later,
    payload_json: JSON.stringify(payload),
  });
  return payload;
}
function message(
  home: string,
  id: string,
  threadId: string,
  text: string,
  ordinal: number,
  runId: string | null = null,
  attachments: unknown[] = [],
) {
  const payload = {
    createdBy: "user",
    creationSource: "server",
    id,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text,
    attachments,
    streaming: false,
    createdAt: at,
    updatedAt: later,
  };
  insert(home, "orchestration_v2_projection_messages", {
    message_id: id,
    thread_id: threadId,
    run_id: runId,
    role: "user",
    streaming: 0,
    created_at: at,
    updated_at: later,
    payload_json: JSON.stringify(payload),
  });
  card(
    home,
    `item:${id}`,
    threadId,
    ordinal,
    {
      type: "user_message",
      createdBy: "user",
      creationSource: "server",
      messageId: id,
      inputIntent: "turn_start",
      text,
      attachments,
    },
    runId,
  );
}
export async function createHistoryImportFixture(
  root: string,
  options: { readonly forkMode?: "run" | "node"; readonly sharedProjectRoot?: boolean } = {},
) {
  if (!NodePath.isAbsolute(root) || NodePath.resolve(root) !== root)
    throw new Error("Fixture requires a canonical absolute root.");
  assertOrdinaryNativePath(root, true);
  if (NodeFS.existsSync(root) && NodeFS.readdirSync(root).length)
    throw new Error("Fixture root must be empty.");
  NodeFS.mkdirSync(root, { recursive: true });
  const localAppData = NodePath.join(root, "AppData", "Local"),
    appDataDirectory = NodePath.join(root, "AppData", "Roaming");
  const source = NodePath.join(localAppData, "T3CodeLAN", "data"),
    target = NodePath.join(root, ".t3");
  for (const [home, id] of [
    [source, "11111111-1111-4111-8111-111111111111"],
    [target, "22222222-2222-4222-8222-222222222222"],
  ]) {
    NodeFS.mkdirSync(NodePath.join(home!, "userdata", "attachments"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home!, "userdata", "environment-id"), id!);
    NodeFS.writeFileSync(NodePath.join(home!, "native-admission.lock"), "synthetic admission");
    NodeFS.writeFileSync(
      NodePath.join(home!, "userdata", "server-owner.sqlite"),
      "synthetic owner",
    );
    NodeFS.writeFileSync(
      NodePath.join(home!, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances:
          home === source
            ? {
                claudeAgent: { driver: "claudeAgent", enabled: true },
                claudeAgent_saved: { driver: "claudeAgent", enabled: true },
              }
            : {
                targetCodex: { driver: "codex", enabled: true, config: { private: "target-only" } },
                claudeAgent: { driver: "claudeAgent", enabled: true },
                claudeAgent_saved: { driver: "claudeAgent", enabled: true },
              },
      }),
    );
    await Effect.runPromise(
      runMigrations().pipe(
        Effect.provide([
          NodeSqliteClient.layer({ filename: dbPath(home!) }),
          NodeServices.layer,
          Logger.layer([], { mergeWithExisting: false }),
        ]),
        Effect.scoped,
      ),
    );
    mutate(
      home!,
      "UPDATE orchestration_v2_projection_metadata SET schema_version=2,last_sequence=0 WHERE projection_name='thread-projections'",
    );
    insert(home!, "projection_projects", {
      project_id: "project:collision",
      title: "Project",
      workspace_root:
        home === source
          ? options.sharedProjectRoot === false
            ? "C:/source"
            : "C:/TARGET/"
          : "C:/target",
      scripts_json: "[]",
      created_at: at,
      updated_at: later,
    });
  }
  thread(target, "parent", "Existing target thread");
  message(target, "message:1", "parent", "Existing target text", 1);
  const existingThread = new NodeSqlite.DatabaseSync(dbPath(target), { readOnly: true });
  let existingThreadPayload: string;
  try {
    existingThreadPayload = String(
      existingThread
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='parent'",
        )
        .get()!.payload_json,
    );
  } finally {
    existingThread.close();
  }
  insert(target, "orchestration_events", {
    sequence: 1,
    event_id: "target:existing",
    aggregate_kind: "thread",
    stream_id: "parent",
    stream_version: 1,
    event_type: "thread.created",
    occurred_at: at,
    actor_kind: "server",
    application_event_version: 2,
    metadata_json: "{}",
    payload_json: existingThreadPayload,
  });
  mutate(
    target,
    "UPDATE orchestration_v2_projection_metadata SET last_sequence=1 WHERE projection_name='thread-projections'",
  );
  insert(target, "orchestration_v2_projection_runs", {
    run_id: "existing:queued",
    thread_id: "parent",
    ordinal: 1,
    provider: "codex",
    status: "queued",
    requested_at: at,
    payload_json: JSON.stringify({
      id: "existing:queued",
      threadId: "parent",
      status: "queued",
      userMessageId: "message:1",
    }),
  });
  insert(target, "orchestration_v2_projection_runtime_requests", {
    runtime_request_id: "existing:request",
    thread_id: "parent",
    status: "pending",
    payload_json: '{"status":"pending","responseCapability":{"type":"live"}}',
  });
  thread(source, "parent", "Retained parent");
  thread(source, "child", "Retained child", "parent");
  run(source, "run:before-fork", 1);
  run(source, "run:after-fork", 2);
  const image = {
    type: "image",
    id: "source-image-11111111-1111-4111-8111-111111111111",
    name: "kept.png",
    mimeType: "image/png",
    sizeBytes: 8,
  };
  NodeFS.writeFileSync(
    NodePath.join(source, "userdata", "attachments", image.id + ".png"),
    "pngbytes",
  );
  message(source, "message:1", "parent", "Visible fork prefix", 1, "run:before-fork", [image]);
  card(
    source,
    "reasoning",
    "parent",
    2,
    { type: "reasoning", text: "Full reasoning", streaming: false },
    "run:before-fork",
  );
  const command = card(
    source,
    "command",
    "parent",
    3,
    { type: "command_execution", input: "echo kept", output: "", outputOmitted: true },
    "run:before-fork",
  );
  insert(source, "orchestration_events", {
    sequence: 1,
    event_id: "source:command",
    aggregate_kind: "thread",
    stream_id: "parent",
    stream_version: 1,
    event_type: "turn-item.updated",
    occurred_at: later,
    actor_kind: "server",
    application_event_version: 2,
    metadata_json: "{}",
    payload_json: JSON.stringify({
      ...command,
      output: "Complete stored output",
      outputOmitted: false,
    }),
  });
  mutate(
    source,
    "UPDATE orchestration_v2_projection_metadata SET last_sequence=1 WHERE projection_name='thread-projections'",
  );
  card(
    source,
    "plan",
    "parent",
    4,
    { type: "proposed_plan", planId: "plan:one", markdown: "## Full plan", streaming: false },
    "run:before-fork",
  );
  card(
    source,
    "todo",
    "parent",
    5,
    {
      type: "todo_list",
      planId: "plan:todo",
      steps: [{ id: "step", text: "Retain incomplete todo", status: "running" }],
    },
    "run:before-fork",
  );
  card(
    source,
    "tool",
    "parent",
    6,
    {
      type: "dynamic_tool",
      toolName: "fixture-tool",
      input: { argument: "preserved" },
      output: { result: "Full tool result" },
    },
    "run:before-fork",
  );
  card(
    source,
    "change",
    "parent",
    7,
    { type: "file_change", fileName: "file.ts", diffStr: "-old\n+new" },
    "run:before-fork",
  );
  card(
    source,
    "question",
    "parent",
    8,
    {
      type: "user_input_request",
      requestId: "request:history",
      questions: [],
      questionAnswer: {
        requestId: "request:history",
        answers: {},
        attachmentsByQuestionId: { choice: [image] },
      },
    },
    "run:before-fork",
  );
  card(
    source,
    "approval",
    "parent",
    9,
    {
      type: "approval_request",
      requestId: "old:approval",
      requestKind: "command",
      prompt: "Complete historical approval",
    },
    "run:before-fork",
  );
  message(source, "message:2", "parent", "After the fork boundary", 20, "run:after-fork");
  message(source, "message:child", "child", "Child message", 1);
  const context = {
    version: 1,
    records: [
      {
        version: 1,
        contextId: "ctx_image",
        label: "Context image",
        kind: "image",
        attachmentId: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      },
    ],
  };
  const db = new NodeSqlite.DatabaseSync(dbPath(source));
  try {
    db.prepare(
      "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.context',json(?),'$.senderThreadId','child','$.delegatedCompletion',json(?)) WHERE message_id='message:1'",
    ).run(
      JSON.stringify(context),
      JSON.stringify({ parentRunId: "historical:parent", generation: 1, taskIds: [] }),
    );
    db.prepare(
      "UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.context',json(?),'$.senderThreadId','child') WHERE turn_item_id='item:message:1'",
    ).run(JSON.stringify(context));
  } finally {
    db.close();
  }
  const htmlId = "parent-33333333-3333-4333-8333-333333333333-html";
  NodeFS.writeFileSync(
    NodePath.join(source, "userdata", "attachments", htmlId + ".html"),
    "<article>Preserved rendered history</article>",
  );
  card(
    source,
    "html-tool",
    "parent",
    10,
    {
      type: "dynamic_tool",
      toolName: "html_render",
      input: { html: "<article>Preserved rendered history</article>" },
      output: { htmlRender: { attachmentId: htmlId, title: "Rendered history", height: 200 } },
    },
    "run:before-fork",
  );
  const checkpoint = {
    id: "checkpoint:full",
    threadId: "parent",
    scopeId: "scope:full",
    runId: "run:before-fork",
    nodeId: "node:checkpoint",
    parentCheckpointId: null,
    ordinalWithinScope: 1,
    appRunOrdinal: 1,
    ref: "refs/t3/fixture/full",
    status: "ready",
    files: [{ path: "kept-checkpoint.ts", kind: "modified", additions: 3, deletions: 1 }],
    capturedAt: later,
  };
  insert(source, "orchestration_v2_projection_checkpoints", {
    checkpoint_id: checkpoint.id,
    thread_id: "parent",
    run_id: "run:before-fork",
    scope_id: checkpoint.scopeId,
    status: "ready",
    payload_json: JSON.stringify(checkpoint),
  });
  card(
    source,
    "checkpoint-card",
    "parent",
    11,
    { type: "checkpoint", checkpointId: checkpoint.id, scopeId: checkpoint.scopeId, files: [] },
    "run:before-fork",
  );
  const subagent = {
    id: "subagent:history",
    threadId: "parent",
    runId: "run:before-fork",
    parentNodeId: "node:root",
    origin: "provider_native",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: "codex",
    providerThreadId: null,
    childThreadId: "child",
    nativeTaskRef: null,
    prompt: "Full original subagent prompt",
    title: null,
    model: "historical-model",
    status: "completed",
    result: "Full original subagent result",
    startedAt: at,
    completedAt: later,
    updatedAt: later,
  };
  insert(source, "orchestration_v2_projection_subagents", {
    subagent_id: subagent.id,
    thread_id: "parent",
    run_id: "run:before-fork",
    origin: "provider_native",
    status: "completed",
    payload_json: JSON.stringify(subagent),
  });
  insert(source, "orchestration_v2_projection_nodes", {
    node_id: subagent.id,
    thread_id: "parent",
    run_id: "run:before-fork",
    kind: "subagent",
    status: "completed",
    payload_json: JSON.stringify({
      id: subagent.id,
      threadId: "parent",
      runId: "run:before-fork",
      parentNodeId: null,
      rootNodeId: subagent.id,
      kind: "subagent",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: at,
      completedAt: later,
    }),
  });
  card(
    source,
    "subagent-card",
    "parent",
    12,
    {
      type: "subagent",
      subagentId: subagent.id,
      origin: "provider_native",
      driver: "codex",
      providerInstanceId: "codex",
      childThreadId: "child",
      prompt: "",
      result: null,
    },
    "run:before-fork",
  );
  if (options.forkMode !== "run")
    mutate(
      source,
      "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.forkedFrom',json('{\"type\":\"node\",\"nodeId\":\"subagent:history\"}'),'$.lineage.relationshipToParent','subagent') WHERE thread_id='child'",
    );
  message(
    source,
    "message:missing",
    "parent",
    "Message without a source card",
    13,
    "run:before-fork",
  );
  mutate(
    source,
    "DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item:message:missing'; UPDATE orchestration_v2_projection_messages SET created_at='2026-10-27T00:00:30.000Z',payload_json=json_set(payload_json,'$.createdAt','2026-10-27T00:00:30.000Z') WHERE message_id='message:missing'; UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.startedAt','2026-10-27T00:01:00.000Z') WHERE turn_item_id='item:message:2'",
  );
  const staged = NodePath.join(
    localAppData,
    "T3CodeLAN",
    "recovery",
    "a".repeat(32),
    "staged-original",
  );
  NodeFS.mkdirSync(NodePath.dirname(staged), { recursive: true });
  NodeFS.cpSync(target, staged, { recursive: true });
  for (const profile of [
    NodePath.join(appDataDirectory, "t3code-v2"),
    NodePath.join(localAppData, "T3CodeLAN", "electron-profile"),
  ]) {
    NodeFS.mkdirSync(profile, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(profile, "Local State"), "opaque synthetic profile");
  }
  const selectionPath = NodePath.join(localAppData, "T3CodeLAN", "home-selection.json");
  const selectionReceipt = NodePath.join(
    localAppData,
    "T3CodeLAN",
    "recovery",
    "c".repeat(32),
    "receipt.json",
  );
  const profile = NodePath.join(appDataDirectory, "t3code-v2");
  const selectionText =
    JSON.stringify({
      schemaVersion: 1,
      mode: "drop-in",
      originalHomeDirectory: target,
      originalEnvironmentId: "22222222-2222-4222-8222-222222222222",
      lanHomeDirectory: source,
      lanEnvironmentId: "11111111-1111-4111-8111-111111111111",
      electronProfileDirectory: profile,
      repairId: "c".repeat(32),
      receiptPath: selectionReceipt,
    }) + "\n";
  NodeFS.mkdirSync(NodePath.dirname(selectionReceipt), { recursive: true });
  NodeFS.writeFileSync(selectionPath, selectionText);
  NodeFS.writeFileSync(
    selectionReceipt,
    JSON.stringify({
      schemaVersion: 1,
      status: "selected-pending-verification",
      repairId: "c".repeat(32),
      selectionSha256: NodeCrypto.createHash("sha256").update(selectionText).digest("hex"),
      selectionPath,
      previousSelection: null,
      selectedHomeDirectory: target,
      retainedHomeDirectory: source,
      electronProfileDirectory: profile,
      snapshots: [],
    }),
  );
  return {
    source,
    target,
    staged,
    userHomeDirectory: root,
    localAppData,
    appDataDirectory,
    sourceHomeDirectory: source,
    targetHomeDirectory: target,
    stagedTargetHomeDirectory: staged,
  };
}
