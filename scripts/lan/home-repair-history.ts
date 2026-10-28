// @effect-diagnostics nodeBuiltinImport:off -- Offline history import is limited to a transaction-owned staged home; source reads are SQLite read-only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import { assertOrdinaryNativePath } from "../../packages/shared/src/nativeHomeSelection.ts";
import * as ProjectionStore from "../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../../apps/server/src/orchestration-v2/EventStore.ts";
import * as EventSink from "../../apps/server/src/orchestration-v2/EventSink.ts";
import {
  inspectNativeUpdateWork,
  inspectStoppedRepairWork,
} from "../../apps/server/src/lan/NativeMaintenance.ts";
import { nativeWorkStatusDefinitions } from "../../apps/server/src/lan/nativeWorkStates.ts";
import {
  attachmentRelativePath,
  resolveAttachmentPathById,
} from "../../apps/server/src/attachmentStore.ts";
import {
  ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  isUnconfiguredDefaultInstanceEnabled,
  resolveProviderInstanceEnabled,
  ProviderInstanceConfig,
} from "../../packages/contracts/src/index.ts";
export interface HistoryProviderMapping {
  readonly sourceInstanceId: string;
  readonly driver: string;
  readonly targetInstanceId: string | null;
  readonly targetCandidates: readonly string[];
}
export interface HistoryImportSummary {
  readonly sourceThreads: number;
  readonly eligibleThreads: number;
  readonly newThreads: number;
  readonly alreadyImportedThreads: number;
  readonly sourceMessages: number;
  readonly importMessages: number;
  readonly sourceCards: number;
  readonly importCards: number;
  readonly convertedCards: number;
  readonly attachments: number;
  readonly attachmentBytes: number;
  readonly missingAttachments: number;
}
export interface HistoryImportBaseline {
  readonly targetEventHead: number;
  readonly eventPrefixGeneration: string;
  readonly existingRowsGeneration: string;
  readonly existingWorkGeneration: string;
}
export interface HistoryImportPreview {
  readonly schemaVersion: 1;
  readonly reviewGeneration: string;
  readonly sourceEnvironmentId: string;
  readonly targetEnvironmentId: string;
  readonly sourceHistoryGeneration: string;
  readonly targetHistoryGeneration: string;
  readonly summary: HistoryImportSummary;
  readonly blockers: readonly string[];
  readonly providerMappings: readonly HistoryProviderMapping[];
  readonly baseline: HistoryImportBaseline;
}
export interface HistoryAttachmentManifest {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly alreadyPresent: boolean;
}
export interface HistoryImportResult {
  readonly schemaVersion: 1;
  readonly summary: HistoryImportSummary;
  readonly importedThreadIds: readonly string[];
  readonly newProjectIds: readonly string[];
  readonly attachmentManifest: readonly HistoryAttachmentManifest[];
  readonly proof: {
    readonly targetEventHeadBefore: number;
    readonly eventPrefixGenerationBefore: string;
    readonly eventPrefixGenerationAfter: string;
    readonly existingRowsGenerationBefore: string;
    readonly existingRowsGenerationAfter: string;
    readonly existingWorkGenerationBefore: string;
    readonly existingWorkGenerationAfter: string;
  };
}
export interface HistoryImportInput {
  readonly sourceHomeDirectory: string;
  readonly targetHomeDirectory: string;
  readonly providerMappings?: Readonly<Record<string, string>>;
}
type Row = Record<string, NodeSqlite.SQLOutputValue>;
type ObjectValue = Record<string, unknown>;
const prefix = "native-history-import:v1";
const sha = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encodeItem = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeMessage = Schema.encodeSync(OrchestrationV2ConversationMessageJson);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const decodeAttachment = Schema.decodeUnknownSync(ChatAttachment);
const decodeProviderConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
const isObject = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown): ObjectValue => {
  if (!isObject(value)) throw new Error("history-invalid-record");
  return value;
};
const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const databasePath = (home: string) => NodePath.join(home, "userdata", "statev2.sqlite");
const withDatabase = <A>(home: string, operation: (db: NodeSqlite.DatabaseSync) => A): A => {
  assertOrdinaryNativePath(databasePath(home), false);
  const db = new NodeSqlite.DatabaseSync(databasePath(home), { readOnly: true });
  try {
    return operation(db);
  } finally {
    db.close();
  }
};
function identity(home: string) {
  assertOrdinaryNativePath(home, true);
  const file = NodePath.join(home, "userdata", "environment-id");
  assertOrdinaryNativePath(file, false);
  if (NodeFS.statSync(file).size > 256) throw new Error("history-identity-invalid");
  const id = NodeFS.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("history-identity-invalid");
  return id;
}
function fileDigest(file: string) {
  assertOrdinaryNativePath(file, false);
  const before = NodeFS.statSync(file);
  const fd = NodeFS.openSync(file, "r");
  const hash = NodeCrypto.createHash("sha256");
  try {
    const chunk = Buffer.alloc(65536);
    for (;;) {
      const count = NodeFS.readSync(fd, chunk);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  const after = NodeFS.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("history-attachment-changed");
  return { sha256: hash.digest("hex"), bytes: before.size };
}
interface TableSnapshot {
  readonly name: string;
  readonly keys: readonly string[];
  readonly identities: readonly (readonly NodeSqlite.SQLInputValue[])[];
  readonly count: number;
}
interface CapturedBaseline {
  readonly baseline: HistoryImportBaseline;
  readonly tables: readonly TableSnapshot[];
}
const derivedTable = (name: string) =>
  name.startsWith("sqlite_") || name.startsWith("orchestration_v2_message_search");
const workTables = new Set<string>([
  ...nativeWorkStatusDefinitions.map(([table]) => table),
  "orchestration_command_receipts",
  "scheduled_tasks",
  "scheduled_task_webhook_pending",
  "scheduled_task_webhook_replay_keys",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_v2_projection_context_transfers",
  "orchestration_v2_projection_provider_session_bindings",
]);
const growthTables = new Set([
  "projection_projects",
  "orchestration_events",
  "orchestration_command_receipts",
  "orchestration_v2_projection_metadata",
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_plans",
  "orchestration_v2_turn_item_positions",
]);
function digestRows(
  db: NodeSqlite.DatabaseSync,
  tables: readonly TableSnapshot[],
  workOnly = false,
) {
  const hash = NodeCrypto.createHash("sha256");
  for (const table of tables) {
    if (
      table.name === "orchestration_events" ||
      table.name === "orchestration_v2_projection_metadata" ||
      (workOnly && !workTables.has(table.name))
    )
      continue;
    hash.update(table.name);
    const identities = new Set(table.identities.map((keys) => JSON.stringify(keys)));
    let matched = 0;
    for (const row of db
      .prepare(`SELECT * FROM ${quoted(table.name)} ORDER BY ${table.keys.map(quoted).join(",")}`)
      .iterate()) {
      if (!identities.has(JSON.stringify(table.keys.map((key) => row[key])))) continue;
      matched++;
      hash.update(JSON.stringify(row));
    }
    if (matched !== identities.size) throw new Error("history-existing-row-missing");
    if (
      !growthTables.has(table.name) &&
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table.name)}`).get()!.n) !== table.count
    )
      throw new Error("history-unexpected-operational-write");
  }
  return hash.digest("hex");
}
function eventPrefix(db: NodeSqlite.DatabaseSync, head: number) {
  const hash = NodeCrypto.createHash("sha256");
  for (const row of db
    .prepare("SELECT * FROM orchestration_events WHERE sequence<=? ORDER BY sequence")
    .iterate(head))
    hash.update(JSON.stringify(row));
  return hash.digest("hex");
}
function captureBaseline(home: string): CapturedBaseline {
  return withDatabase(home, (db) => {
    const tables: TableSnapshot[] = [];
    for (const row of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .iterate()) {
      const name = String(row.name);
      if (
        derivedTable(name) ||
        name === "orchestration_events" ||
        name === "orchestration_v2_projection_metadata"
      )
        continue;
      const columns = db.prepare(`PRAGMA table_info(${quoted(name)})`).all();
      const keys = columns
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => String(column.name));
      if (keys.length === 0) keys.push("rowid");
      const identities: NodeSqlite.SQLInputValue[][] = [];
      for (const entry of db
        .prepare(
          `SELECT ${keys.map(quoted).join(",")} FROM ${quoted(name)} ORDER BY ${keys.map(quoted).join(",")}`,
        )
        .iterate()) {
        identities.push(keys.map((key) => entry[key]!));
        if (identities.length > 2_000_000) throw new Error("history-target-inventory-too-large");
      }
      tables.push({ name, keys, identities, count: identities.length });
    }
    const head = Number(
      db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM orchestration_events").get()!.n,
    );
    return {
      tables,
      baseline: {
        targetEventHead: head,
        eventPrefixGeneration: eventPrefix(db, head),
        existingRowsGeneration: digestRows(db, tables),
        existingWorkGeneration: digestRows(db, tables, true),
      },
    };
  });
}
function plainRows(home: string, table: string) {
  return withDatabase(home, (db) => db.prepare(`SELECT * FROM ${quoted(table)}`).all());
}
function idSet(home: string, table: string, key: string) {
  return withDatabase(
    home,
    (db) =>
      new Set(
        [...db.prepare(`SELECT ${quoted(key)} FROM ${quoted(table)}`).iterate()].map((row) =>
          String(row[key]),
        ),
      ),
  );
}
function payloadMap(home: string, table: string, id: string) {
  return new Map(
    plainRows(home, table).map((row) => [
      String(row[id]),
      object(JSON.parse(String(row.payload_json))),
    ]),
  );
}
function profiles(home: string) {
  const file = NodePath.join(home, "userdata", "settings.json");
  if (!NodeFS.existsSync(file)) return {};
  assertOrdinaryNativePath(file, false);
  if (NodeFS.statSync(file).size > 1_048_576) throw new Error("history-settings-too-large");
  return object(object(JSON.parse(NodeFS.readFileSync(file, "utf8"))).providerInstances ?? {});
}
function providerMapping(
  source: readonly OrchestrationV2ThreadProjection[],
  sourceProfiles: ObjectValue,
  targetProfiles: ObjectValue,
  requested: Readonly<Record<string, string>> | undefined,
  blockers: Set<string>,
) {
  sourceProfiles = { ...sourceProfiles };
  targetProfiles = { ...targetProfiles };
  for (const projection of source) {
    const instanceId = projection.thread.providerInstanceId;
    if (
      sourceProfiles[instanceId] === undefined &&
      isUnconfiguredDefaultInstanceEnabled(instanceId)
    )
      sourceProfiles[instanceId] = { driver: instanceId };
  }
  for (const value of Object.values(sourceProfiles)) {
    if (
      isObject(value) &&
      typeof value.driver === "string" &&
      isUnconfiguredDefaultInstanceEnabled(ProviderInstanceId.make(value.driver)) &&
      targetProfiles[value.driver] === undefined
    )
      targetProfiles[value.driver] = { driver: value.driver };
  }
  return [...new Set(source.map((projection) => String(projection.thread.providerInstanceId)))]
    .sort()
    .map((sourceInstanceId): HistoryProviderMapping => {
      const profile = sourceProfiles[sourceInstanceId];
      const driver = isObject(profile) && typeof profile.driver === "string" ? profile.driver : "";
      const candidates = Object.entries(targetProfiles)
        .filter(
          ([, value]) =>
            isObject(value) &&
            value.driver === driver &&
            resolveProviderInstanceEnabled(decodeProviderConfig(value)),
        )
        .map(([id]) => id)
        .sort();
      const explicit = requested?.[sourceInstanceId];
      const selected =
        explicit !== undefined
          ? candidates.includes(explicit)
            ? explicit
            : null
          : candidates.includes(sourceInstanceId)
            ? sourceInstanceId
            : candidates.length === 1
              ? candidates[0]!
              : null;
      if (!driver || selected === null) blockers.add("provider-mapping-required");
      return { sourceInstanceId, driver, targetInstanceId: selected, targetCandidates: candidates };
    });
}
async function readProjections(home: string, ids: readonly string[]) {
  const database = NodeSqliteClient.layer({
    filename: databasePath(home),
    readonly: true,
    readerWorker: false,
    checkpointWorker: false,
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const result: OrchestrationV2ThreadProjection[] = [];
      for (const id of ids) result.push(yield* store.getThreadProjection(ThreadId.make(id)));
      return result;
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(database))), Effect.scoped),
  );
}
const safeTypes = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "proposed_plan",
  "todo_list",
  "system_notice",
]);
interface LoadedThread {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly cards: readonly ObjectValue[];
  readonly messages: readonly ObjectValue[];
  readonly fingerprint: string;
  readonly targetId: string;
  readonly already: boolean;
}
interface ImportPlan {
  readonly preview: HistoryImportPreview;
  readonly baseline: CapturedBaseline;
  readonly threads: readonly LoadedThread[];
  readonly projects: readonly Row[];
  readonly projectIds: ReadonlyMap<string, string>;
  readonly newProjects: readonly Row[];
  readonly attachments: readonly HistoryAttachmentManifest[];
  readonly attachmentIds: ReadonlyMap<string, string>;
  readonly sourceHome: string;
  readonly targetHome: string;
}
function allocate(
  kind: string,
  env: string,
  key: string,
  preferred: string,
  occupied: Set<string>,
) {
  let id = preferred;
  if (occupied.has(id)) id = `history-${sha([kind, env, key]).slice(0, 48)}`;
  if (occupied.has(id)) throw new Error("history-deterministic-id-collision");
  occupied.add(id);
  return id;
}
function hydrateCard(
  home: string,
  card: ObjectValue,
  messages: ReadonlyMap<string, ObjectValue>,
  aux: ReadonlyMap<string, ReadonlyMap<string, ObjectValue>>,
  blockers: Set<string>,
) {
  const hydrated = { ...card };
  if (
    (card.type === "user_message" || card.type === "assistant_message") &&
    card.textOmitted === true
  ) {
    const message = messages.get(String(card.messageId));
    if (message && typeof message.text === "string") {
      hydrated.text = message.text;
      delete hydrated.textOmitted;
    } else blockers.add("history-message-body-unavailable");
  }
  if (card.outputOmitted === true) {
    const event = withDatabase(home, (db) =>
      db
        .prepare(
          "SELECT payload_json FROM orchestration_events WHERE event_type='turn-item.updated' AND json_extract(payload_json,'$.id')=? AND json_type(payload_json,'$.output') IS NOT NULL ORDER BY sequence DESC LIMIT 1",
        )
        .get(String(card.id)),
    );
    const original = event ? object(JSON.parse(String(event.payload_json))) : undefined;
    if (original && original.outputOmitted !== true && original.output !== undefined) {
      hydrated.output = original.output;
      delete hydrated.outputOmitted;
    } else blockers.add("history-tool-output-unavailable");
  }
  const extras: ObjectValue = {};
  for (const [kind, id] of [
    ["checkpoints", card.checkpointId],
    ["subagents", card.subagentId],
    ["runtime_requests", card.requestId],
    ["context_handoffs", card.contextHandoffId],
  ] as const)
    if (typeof id === "string") {
      const value = aux.get(kind)?.get(id);
      if (value) extras[kind] = value;
      else if (kind !== "runtime_requests") blockers.add("history-card-body-unavailable");
    }
  for (const [marker, field, table, id] of [
    ["filesOmitted", "files", "checkpoints", card.checkpointId],
    ["promptOmitted", "prompt", "subagents", card.subagentId],
    ["resultOmitted", "result", "subagents", card.subagentId],
  ] as const)
    if (card[marker] === true) {
      const value = typeof id === "string" ? aux.get(table)?.get(id)?.[field] : undefined;
      if (value !== undefined) {
        hydrated[field] = value;
        delete hydrated[marker];
      } else blockers.add("history-card-body-unavailable");
    }
  if (Object.keys(extras).length) hydrated.historicalDetails = extras;
  return hydrated;
}
function attachmentReferences(
  value: unknown,
  home: string,
  found: Map<string, { relative: string; metadata: ObjectValue }>,
  blockers: Set<string>,
  depth = 0,
) {
  if (depth > 64) throw new Error("history-card-nesting-too-large");
  if (Array.isArray(value)) {
    for (const entry of value) attachmentReferences(entry, home, found, blockers, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  if ((value.type === "image" || value.type === "file") && typeof value.id === "string") {
    const attachment = decodeAttachment(value);
    const relative = attachmentRelativePath(attachment);
    if (relative) found.set(String(value.id), { relative, metadata: value });
    else blockers.add("history-attachment-type-unsupported");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "output" && typeof entry === "string" && value.type === "dynamic_tool") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry);
      } catch {
        /* Text output is already preserved verbatim. */
      }
      if (parsed !== undefined) attachmentReferences(parsed, home, found, blockers, depth + 1);
    }
    if (key === "attachmentId" && typeof entry === "string") {
      const file = resolveAttachmentPathById({
        attachmentsDir: NodePath.join(home, "userdata", "attachments"),
        attachmentId: entry,
      });
      if (file) {
        const relative = NodePath.relative(NodePath.join(home, "userdata", "attachments"), file)
          .split(NodePath.sep)
          .join("/");
        if (!found.has(entry))
          found.set(entry, {
            relative,
            metadata: {
              type: value.kind === "image" ? "image" : "file",
              id: entry,
              name: typeof value.name === "string" ? value.name : NodePath.basename(file),
              mimeType:
                typeof value.mimeType === "string"
                  ? value.mimeType
                  : NodePath.extname(file) === ".html"
                    ? "text/html"
                    : "application/octet-stream",
              sizeBytes: NodeFS.statSync(file).size,
            },
          });
      } else blockers.add("history-artifact-unavailable");
    }
    if (key === "viewedImagePath" && typeof entry === "string") {
      const relative = NodePath.relative(NodePath.join(home, "userdata", "attachments"), entry);
      if (
        !relative.startsWith("..") &&
        !NodePath.isAbsolute(relative) &&
        !relative.includes(NodePath.sep)
      ) {
        const id = NodePath.basename(relative, NodePath.extname(relative));
        found.set(id, {
          relative,
          metadata: {
            type: "file",
            id,
            name: NodePath.basename(relative),
            mimeType: "application/octet-stream",
            sizeBytes: NodeFS.existsSync(entry) ? NodeFS.statSync(entry).size : 0,
          },
        });
      } else blockers.add("history-external-image-unavailable");
    }
    attachmentReferences(entry, home, found, blockers, depth + 1);
  }
}
const converted = (card: ObjectValue) =>
  !safeTypes.has(String(card.type)) ||
  card.historicalDetails !== undefined ||
  card.viewedImagePath !== undefined ||
  (card.type === "dynamic_tool" && JSON.stringify(card).includes("attachmentId"));
async function buildPlan(input: HistoryImportInput): Promise<ImportPlan> {
  const source = NodePath.resolve(input.sourceHomeDirectory),
    target = NodePath.resolve(input.targetHomeDirectory);
  if (source.toLowerCase() === target.toLowerCase()) throw new Error("history-homes-must-differ");
  const sourceEnvironmentId = identity(source),
    targetEnvironmentId = identity(target);
  if (sourceEnvironmentId === targetEnvironmentId)
    throw new Error("history-environments-must-differ");
  const stopped = inspectStoppedRepairWork(databasePath(source));
  if (
    [
      stopped.activeRuns,
      stopped.queuedRuns,
      stopped.pendingRequests,
      stopped.backgroundAgents,
      stopped.scheduledWork,
      stopped.restartContinuations,
    ].some((value) => value !== 0)
  )
    throw new Error("history-source-has-unfinished-work");
  inspectNativeUpdateWork(databasePath(target));
  const blockers = new Set<string>();
  const sourceThreadRows = plainRows(source, "orchestration_v2_projection_threads");
  if (sourceThreadRows.length > 10_000) throw new Error("history-source-thread-bound");
  const eligible = sourceThreadRows.filter((row) => row.deleted_at === null);
  const projections = await readProjections(
    source,
    eligible.map((row) => String(row.thread_id)),
  );
  const messages = payloadMap(source, "orchestration_v2_projection_messages", "message_id");
  const aux = new Map<string, ReadonlyMap<string, ObjectValue>>();
  for (const [table, id] of [
    ["checkpoints", "checkpoint_id"],
    ["subagents", "subagent_id"],
    ["runtime_requests", "runtime_request_id"],
    ["context_handoffs", "context_handoff_id"],
  ] as const)
    aux.set(table, payloadMap(source, "orchestration_v2_projection_" + table, id));
  const pendingLegacy = withDatabase(source, (db) =>
    db
      .prepare(
        "SELECT thread_id FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL",
      )
      .all(),
  );
  if (pendingLegacy.some((row) => eligible.some((thread) => thread.thread_id === row.thread_id)))
    blockers.add("history-legacy-transcript-not-hydrated");
  const mappings = providerMapping(
    projections,
    profiles(source),
    profiles(target),
    input.providerMappings,
    blockers,
  );
  const occupiedThreads = idSet(target, "orchestration_v2_projection_threads", "thread_id");
  const receipts = withDatabase(
    target,
    (db) =>
      new Map(
        db
          .prepare(
            "SELECT command_id,aggregate_id,command_type,status FROM orchestration_command_receipts",
          )
          .all()
          .map((row) => [String(row.command_id), row]),
      ),
  );
  const attachments: HistoryAttachmentManifest[] = [];
  const attachmentIds = new Map<string, string>();
  const threads: LoadedThread[] = [];
  let rawBytes = 0;
  let sourceCards = 0;
  let importMessages = 0;
  let importCards = 0;
  let convertedCards = 0;
  let missingAttachments = 0;
  for (const projection of projections) {
    const cards = projection.visibleTurnItems.map((row) =>
      hydrateCard(source, encodeItem(row.item) as ObjectValue, messages, aux, blockers),
    );
    const threadMessages = new Map(
      projection.messages.map((message) => [
        String(message.id),
        encodeMessage(message) as ObjectValue,
      ]),
    );
    for (const card of cards)
      if (
        (card.type === "user_message" || card.type === "assistant_message") &&
        typeof card.messageId === "string"
      ) {
        const message = messages.get(card.messageId);
        if (message) threadMessages.set(card.messageId, message);
        else blockers.add("history-message-record-unavailable");
      }
    const represented = new Set(cards.map((card) => card.messageId));
    for (const message of [...threadMessages.values()].sort(
      (a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)) ||
        String(a.id).localeCompare(String(b.id)),
    )) {
      if (!represented.has(message.id)) {
        const card: ObjectValue = {
          id: `${prefix}:missing-message:${String(message.id)}`,
          threadId: message.threadId,
          runId: message.runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: message.streaming === true ? "interrupted" : "completed",
          title: null,
          startedAt: message.createdAt,
          completedAt: message.updatedAt,
          updatedAt: message.updatedAt,
          type: message.role === "user" ? "user_message" : "assistant_message",
          messageId: message.id,
          text: message.text,
          attachments: message.attachments,
          ...(message.role === "user"
            ? {
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                inputIntent: "turn_start",
                ...(message.context === undefined ? {} : { context: message.context }),
              }
            : { streaming: false }),
        };
        const index = cards.findIndex(
          (existing) =>
            String(existing.startedAt ?? existing.updatedAt) > String(message.createdAt),
        );
        cards.splice(index < 0 ? cards.length : index, 0, card);
      }
      const metadata = Object.fromEntries(
        ["scheduledTaskId", "delegatedCompletion", "notification"]
          .filter((key) => message[key] !== undefined)
          .map((key) => [key, message[key]]),
      );
      if (Object.keys(metadata).length) {
        const index = cards.findIndex((card) => card.messageId === message.id);
        cards.splice(index + 1, 0, {
          id: `${prefix}:message-metadata:${String(message.id)}`,
          threadId: message.threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: message.createdAt,
          completedAt: message.updatedAt,
          updatedAt: message.updatedAt,
          type: "system_notice",
          message: `Historical message metadata (read-only)\n${JSON.stringify(metadata, null, 2)}`,
        });
      }
    }
    const historicalRuns = [
      ...new Set(cards.map((card) => card.runId).filter((id) => typeof id === "string")),
    ].flatMap((id) => {
      const run = projections
        .flatMap((candidate) => candidate.runs)
        .find((candidate) => candidate.id === id);
      return run === undefined
        ? []
        : [
            {
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              modelSelection: run.modelSelection,
            },
          ];
    });
    cards.unshift({
      id: `${prefix}:provider-labels:${projection.thread.id}`,
      threadId: projection.thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: DateTime.formatIso(projection.thread.createdAt),
      completedAt: DateTime.formatIso(projection.thread.updatedAt),
      updatedAt: DateTime.formatIso(projection.thread.updatedAt),
      type: "system_notice",
      message: `Historical provider/model selections (read-only)\n${JSON.stringify({ providerInstanceId: projection.thread.providerInstanceId, modelSelection: projection.thread.modelSelection, runs: historicalRuns }, null, 2)}`,
    });
    const refs = new Map<string, { relative: string; metadata: ObjectValue }>();
    for (const value of [...cards, ...threadMessages.values()])
      attachmentReferences(value, source, refs, blockers);
    const sourceAttachments: unknown[] = [];
    for (const [id, ref] of refs) {
      try {
        const digest = fileDigest(NodePath.join(source, "userdata", "attachments", ref.relative));
        if (digest.bytes !== ref.metadata.sizeBytes)
          blockers.add("history-attachment-size-changed");
        sourceAttachments.push([id, ref.metadata, ref.relative, digest]);
      } catch {
        missingAttachments++;
        blockers.add("history-attachment-unavailable");
      }
    }
    const fingerprint = sha([
      encodeThread(projection.thread),
      cards,
      [...threadMessages.values()],
      sourceAttachments,
    ]);
    const commandId = `${prefix}:thread:${sha([sourceEnvironmentId, projection.thread.id])}`;
    const receipt = receipts.get(commandId);
    let targetId: string;
    let already = false;
    if (receipt) {
      targetId = String(receipt.aggregate_id);
      if (receipt.command_type !== `${prefix}:${fingerprint}` || receipt.status !== "accepted")
        blockers.add("source-thread-changed");
      if (!occupiedThreads.has(targetId)) blockers.add("history-import-marker-invalid");
      already = true;
    } else
      targetId = allocate(
        "thread",
        sourceEnvironmentId,
        String(projection.thread.id),
        String(projection.thread.id),
        occupiedThreads,
      );
    for (const [id, ref] of already ? [] : refs) {
      try {
        const sourceFile = NodePath.join(source, "userdata", "attachments", ref.relative);
        const digest = fileDigest(sourceFile);
        let newId = "",
          targetRelativePath = "",
          alreadyPresent = false;
        for (let collision = 0; collision < 1024; collision++) {
          const key = sha([
            sourceEnvironmentId,
            targetId,
            id,
            ref.metadata,
            digest.sha256,
            collision,
          ]);
          const uuid = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
          newId = `history-${key.slice(32, 40)}-${uuid}-${NodePath.extname(ref.relative).slice(1).toLowerCase()}`;
          targetRelativePath = `userdata/attachments/${newId}${NodePath.extname(ref.relative).toLowerCase()}`;
          const targetFile = NodePath.join(target, targetRelativePath);
          alreadyPresent = NodeFS.existsSync(targetFile);
          if (!alreadyPresent || fileDigest(targetFile).sha256 === digest.sha256) break;
          if (collision === 1023) throw new Error("history-attachment-collision-bound");
        }
        attachmentIds.set(`${targetId}:${id}`, newId);
        attachments.push({
          sourceRelativePath: `userdata/attachments/${ref.relative}`,
          targetRelativePath,
          sha256: digest.sha256,
          bytes: digest.bytes,
          alreadyPresent,
        });
      } catch {
        blockers.add("history-attachment-unavailable");
      }
    }
    rawBytes += Buffer.byteLength(JSON.stringify([cards, [...threadMessages.values()]]));
    if (rawBytes > 256 * 1024 * 1024) throw new Error("history-content-bound");
    sourceCards += projection.turnItems.length;
    if (!already) {
      importCards += cards.length;
      importMessages += threadMessages.size;
    }
    for (const card of already ? [] : cards)
      if (converted(card)) {
        convertedCards++;
        const cardAttachments = new Map<string, { relative: string; metadata: ObjectValue }>();
        attachmentReferences(card, source, cardAttachments, blockers);
        if (cardAttachments.size) {
          importCards++;
          importMessages++;
        }
      }
    threads.push({
      projection,
      cards,
      messages: [...threadMessages.values()],
      fingerprint,
      targetId,
      already,
    });
  }
  const projects = plainRows(source, "projection_projects");
  const targetProjects = plainRows(target, "projection_projects");
  const projectIds = new Map<string, string>();
  const newProjects: Row[] = [];
  const occupiedProjects = new Set(targetProjects.map((row) => String(row.project_id)));
  for (const sourceId of new Set(
    threads.map((entry) => String(entry.projection.thread.projectId)),
  )) {
    const project = projects.find((row) => row.project_id === sourceId);
    if (!project) {
      blockers.add("history-project-unavailable");
      continue;
    }
    const matches = targetProjects.filter(
      (row) =>
        row.deleted_at === null &&
        NodePath.win32
          .normalize(String(row.workspace_root))
          .replace(/[\\/]+$/, "")
          .toLowerCase() ===
          NodePath.win32
            .normalize(String(project.workspace_root))
            .replace(/[\\/]+$/, "")
            .toLowerCase(),
    );
    if (matches.length === 1) projectIds.set(sourceId, String(matches[0]!.project_id));
    else if (matches.length > 1) blockers.add("history-project-mapping-required");
    else {
      const id = allocate("project", sourceEnvironmentId, sourceId, sourceId, occupiedProjects);
      projectIds.set(sourceId, id);
      newProjects.push({ ...project, project_id: id });
    }
  }
  const captured = captureBaseline(target);
  const sourceHistoryGeneration = sha([
    sourceEnvironmentId,
    threads.map((entry) => [entry.projection.thread.id, entry.fingerprint]),
    projects,
  ]);
  const targetHistoryGeneration = sha(captured.baseline);
  const summary: HistoryImportSummary = {
    sourceThreads: sourceThreadRows.length,
    eligibleThreads: threads.length,
    newThreads: threads.filter((entry) => !entry.already).length,
    alreadyImportedThreads: threads.filter((entry) => entry.already).length,
    sourceMessages: [...messages.values()].filter((message) =>
      eligible.some((thread) => thread.thread_id === message.threadId),
    ).length,
    importMessages,
    sourceCards,
    importCards,
    convertedCards,
    attachments: attachments.length,
    attachmentBytes: attachments.reduce((sum, file) => sum + file.bytes, 0),
    missingAttachments,
  };
  const reviewGeneration = sha([
    sourceEnvironmentId,
    targetEnvironmentId,
    sourceHistoryGeneration,
    targetHistoryGeneration,
    mappings,
    threads.map((entry) => [
      entry.projection.thread.id,
      entry.targetId,
      entry.fingerprint,
      entry.already,
    ]),
    attachments,
  ]);
  return {
    preview: {
      schemaVersion: 1,
      reviewGeneration,
      sourceEnvironmentId,
      targetEnvironmentId,
      sourceHistoryGeneration,
      targetHistoryGeneration,
      summary,
      blockers: [...blockers].sort(),
      providerMappings: mappings,
      baseline: captured.baseline,
    },
    baseline: captured,
    threads,
    projects,
    projectIds,
    newProjects,
    attachments,
    attachmentIds,
    sourceHome: source,
    targetHome: target,
  };
}
export async function previewHistoryImport(
  input: HistoryImportInput,
): Promise<HistoryImportPreview> {
  return (await buildPlan(input)).preview;
}
function remapThreadReferences(value: unknown, threads: readonly LoadedThread[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapThreadReferences(entry, threads));
  if (!isObject(value)) return value;
  const fields = new Set([
    "threadId",
    "senderThreadId",
    "parentThreadId",
    "rootThreadId",
    "sourceThreadId",
    "targetThreadId",
    "childThreadId",
  ]);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const match =
        fields.has(key) && typeof entry === "string"
          ? threads.find((thread) => thread.projection.thread.id === entry)
          : undefined;
      return [key, match?.targetId ?? remapThreadReferences(entry, threads)];
    }),
  );
}
function remapAttachments(
  value: unknown,
  targetThreadId: string,
  ids: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value))
    return value.map((entry) => remapAttachments(entry, targetThreadId, ids));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "output" && typeof entry === "string" && value.type === "dynamic_tool") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(entry);
        } catch {
          return [key, entry];
        }
        return [key, JSON.stringify(remapAttachments(parsed, targetThreadId, ids))];
      }
      return [
        key,
        (key === "attachmentId" ||
          (key === "id" && (value.type === "image" || value.type === "file"))) &&
        typeof entry === "string"
          ? (ids.get(`${targetThreadId}:${entry}`) ?? entry)
          : remapAttachments(entry, targetThreadId, ids),
      ];
    }),
  );
}
function eventsForThread(
  plan: ImportPlan,
  entry: LoadedThread,
  occupiedMessages: Set<string>,
  occupiedItems: Set<string>,
) {
  const threadId = ThreadId.make(entry.targetId);
  const source = entry.projection.thread;
  const mapping = plan.preview.providerMappings.find(
    (candidate) => candidate.sourceInstanceId === source.providerInstanceId,
  )!;
  if (mapping.targetInstanceId === null) throw new Error("history-provider-mapping-required");
  const parent =
    source.lineage.parentThreadId === null
      ? undefined
      : plan.threads.find(
          (candidate) => candidate.projection.thread.id === source.lineage.parentThreadId,
        );
  const root = plan.threads.find(
    (candidate) => candidate.projection.thread.id === source.lineage.rootThreadId,
  );
  const at = source.updatedAt;
  const events: OrchestrationV2DomainEvent[] = [];
  const thread: OrchestrationV2ThreadProjection["thread"] = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: ProjectId.make(plan.projectIds.get(String(source.projectId))!),
    title: source.title,
    providerInstanceId: ProviderInstanceId.make(mapping.targetInstanceId),
    modelSelection: {
      ...source.modelSelection,
      instanceId: ProviderInstanceId.make(mapping.targetInstanceId),
    },
    runtimeMode: source.runtimeMode,
    interactionMode: source.interactionMode,
    branch: source.branch,
    worktreePath: source.worktreePath,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    lineage: {
      parentThreadId: parent ? ThreadId.make(parent.targetId) : null,
      relationshipToParent: parent ? source.lineage.relationshipToParent : null,
      rootThreadId: root ? ThreadId.make(root.targetId) : threadId,
    },
    forkedFrom: null,
    createdAt: source.createdAt,
    updatedAt: at,
    archivedAt: source.archivedAt,
    settledOverride: "settled",
    settledAt: at,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  events.push({
    id: EventId.make(
      `${prefix}:thread-created:${sha([plan.preview.sourceEnvironmentId, source.id])}`,
    ),
    type: "thread.created",
    threadId,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: at,
    payload: thread,
  });
  const messageIds = new Map<string, string>();
  for (const raw of entry.messages) {
    const id = allocate(
      "message",
      plan.preview.sourceEnvironmentId,
      `${threadId}:${raw.id}`,
      String(raw.id),
      occupiedMessages,
    );
    messageIds.set(String(raw.id), id);
    const remapped = object(
      remapThreadReferences(remapAttachments(raw, threadId, plan.attachmentIds), plan.threads),
    );
    if (
      typeof raw.senderThreadId === "string" &&
      !plan.threads.some((candidate) => candidate.projection.thread.id === raw.senderThreadId)
    )
      delete remapped.senderThreadId;
    const message = decodeMessage({
      ...remapped,
      id,
      threadId,
      runId: null,
      nodeId: null,
      streaming: false,
    });
    const {
      scheduledTaskId: _scheduled,
      delegatedCompletion: _delegated,
      notification: _notification,
      ...safe
    } = message;
    events.push({
      id: EventId.make(`${prefix}:message:${sha([threadId, id])}`),
      type: "message.updated",
      threadId,
      occurredAt: message.updatedAt,
      payload: safe,
    });
  }
  let ordinal = 0;
  for (const original of entry.cards) {
    const remapped = object(remapAttachments(original, threadId, plan.attachmentIds));
    const id = TurnItemId.make(
      allocate(
        "item",
        plan.preview.sourceEnvironmentId,
        `${threadId}:${original.id}`,
        String(original.id),
        occupiedItems,
      ),
    );
    const status = ["completed", "failed", "cancelled", "interrupted"].includes(
      String(original.status),
    )
      ? original.status
      : "interrupted";
    const base = {
      id,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++ordinal,
      status,
      title: original.title ?? null,
      startedAt: original.startedAt ?? null,
      completedAt: original.completedAt ?? DateTime.formatIso(at),
      updatedAt: original.updatedAt ?? DateTime.formatIso(at),
    };
    const convert = converted(original);
    let card: ObjectValue;
    if (convert)
      card = {
        ...base,
        type: "system_notice",
        message: `Historical ${String(original.type)} (read-only snapshot)\n${JSON.stringify(remapped, null, 2)}`,
      };
    else {
      card = { ...object(remapThreadReferences(remapped, plan.threads)), ...base };
      delete card.scheduledTaskId;
      if (card.type === "user_message" || card.type === "assistant_message") {
        const messageId = messageIds.get(String(original.messageId));
        if (!messageId) throw new Error("history-card-message-missing");
        card.messageId = messageId;
      }
      if ("streaming" in card) card.streaming = false;
      if (card.type === "proposed_plan" || card.type === "todo_list") {
        const nodeId = NodeId.make(`history-${sha([threadId, id, "plan-node"]).slice(0, 48)}`);
        const planId = PlanId.make(`history-${sha([threadId, id, "plan"]).slice(0, 48)}`);
        card.nodeId = nodeId;
        card.planId = planId;
        events.push({
          id: EventId.make(`${prefix}:node:${nodeId}`),
          type: "node.updated",
          threadId,
          occurredAt: at,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: card.type === "todo_list" ? "todo_list" : "plan",
            status: "completed",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: at,
            completedAt: at,
          },
        });
        events.push({
          id: EventId.make(`${prefix}:plan:${planId}`),
          type: "plan.updated",
          threadId,
          occurredAt: at,
          payload:
            card.type === "todo_list"
              ? {
                  id: planId,
                  threadId,
                  runId: null,
                  nodeId,
                  kind: "todo_list",
                  status: "active",
                  steps: card.steps as Extract<
                    OrchestrationV2TurnItem,
                    { type: "todo_list" }
                  >["steps"],
                  ...(typeof card.explanation === "string"
                    ? { explanation: card.explanation }
                    : {}),
                }
              : {
                  id: planId,
                  threadId,
                  runId: null,
                  nodeId,
                  kind: "proposed_plan",
                  status: "active",
                  markdown: String(card.markdown),
                },
        });
      }
    }
    const decoded = decodeItem(card);
    events.push({
      id: EventId.make(`${prefix}:item:${sha([threadId, id])}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: decoded.updatedAt,
      payload: decoded,
    });
    if (convert) {
      const refs = new Map<string, { relative: string; metadata: ObjectValue }>();
      const ignored = new Set<string>();
      attachmentReferences(original, plan.sourceHome, refs, ignored);
      if (refs.size) {
        const attachments = [...refs.values()].map((ref) =>
          remapAttachments(ref.metadata, threadId, plan.attachmentIds),
        );
        const attachmentMessageId = MessageId.make(
          allocate(
            "message",
            plan.preview.sourceEnvironmentId,
            `${threadId}:${original.id}:attachments`,
            `history-${sha([threadId, id, "attachments"]).slice(0, 48)}`,
            occupiedMessages,
          ),
        );
        const message = decodeMessage({
          id: attachmentMessageId,
          threadId,
          runId: null,
          nodeId: null,
          createdBy: "system",
          creationSource: "server",
          role: "assistant",
          text: `Historical attachments for ${String(original.type)}.`,
          attachments,
          streaming: false,
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
        });
        events.push({
          id: EventId.make(`${prefix}:message:${attachmentMessageId}`),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: message,
        });
        const attachmentItem = decodeItem({
          ...base,
          id: TurnItemId.make(
            allocate(
              "item",
              plan.preview.sourceEnvironmentId,
              `${threadId}:${original.id}:attachments`,
              `history-${sha([threadId, id, "attachment-item"]).slice(0, 48)}`,
              occupiedItems,
            ),
          ),
          ordinal: ++ordinal,
          type: "assistant_message",
          messageId: attachmentMessageId,
          text: message.text,
          attachments,
          streaming: false,
        });
        events.push({
          id: EventId.make(`${prefix}:item:${attachmentItem.id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: attachmentItem,
        });
      }
    }
  }
  return events;
}
export async function importHistory(input: {
  readonly sourceHomeDirectory: string;
  readonly stagedTargetHomeDirectory: string;
  readonly expectedReviewGeneration: string;
  readonly providerMappings?: Readonly<Record<string, string>>;
}): Promise<HistoryImportResult> {
  const target = NodePath.resolve(input.stagedTargetHomeDirectory);
  if (
    NodePath.basename(target) !== "staged-original" ||
    !/^[a-f0-9]{32}$/.test(NodePath.basename(NodePath.dirname(target))) ||
    NodePath.basename(NodePath.dirname(NodePath.dirname(target))) !== "recovery" ||
    NodePath.basename(NodePath.dirname(NodePath.dirname(NodePath.dirname(target)))) !== "T3CodeLAN"
  )
    throw new Error("history-import-requires-staged-target");
  const plan = await buildPlan({
    sourceHomeDirectory: input.sourceHomeDirectory,
    targetHomeDirectory: target,
    ...(input.providerMappings === undefined ? {} : { providerMappings: input.providerMappings }),
  });
  if (
    plan.preview.reviewGeneration !== input.expectedReviewGeneration ||
    plan.preview.blockers.length
  )
    throw new Error("history-review-changed-or-blocked");
  for (const file of plan.attachments) {
    const source = NodePath.join(plan.sourceHome, file.sourceRelativePath),
      destination = NodePath.join(target, file.targetRelativePath);
    if (fileDigest(source).sha256 !== file.sha256) throw new Error("history-attachment-changed");
    if (!file.alreadyPresent) {
      assertOrdinaryNativePath(NodePath.dirname(destination), true);
      NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
      NodeFS.copyFileSync(source, destination, NodeFS.constants.COPYFILE_EXCL);
    }
    if (fileDigest(destination).sha256 !== file.sha256)
      throw new Error("history-attachment-copy-failed");
  }
  const occupiedMessages = idSet(target, "orchestration_v2_projection_messages", "message_id");
  const occupiedItems = idSet(target, "orchestration_v2_projection_turn_items", "turn_item_id");
  const database = NodeSqliteClient.layer({
    filename: databasePath(target),
    readerWorker: false,
    checkpointWorker: false,
  });
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(database),
  );
  const sink = EventSink.layer.pipe(Layer.provide(stores));
  await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* EventSink.EventSinkV2;
      for (const project of plan.newProjects) {
        const projectId = ProjectId.make(String(project.project_id));
        const commandId = CommandId.make(
          `${prefix}:project:${sha([plan.preview.sourceEnvironmentId, projectId])}`,
        );
        const createdAt = String(project.created_at);
        yield* writer.commitProjectCommand({
          commandId,
          projectId,
          commandType: prefix + ":project",
          acceptedAt: DateTime.makeUnsafe(createdAt),
          event: {
            eventId: EventId.make(commandId),
            aggregateKind: "project",
            aggregateId: projectId,
            type: "project.created",
            occurredAt: createdAt,
            commandId,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId,
              title: String(project.title),
              workspaceRoot: String(project.workspace_root),
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: String(project.updated_at),
            },
          },
        });
      }
      for (const entry of plan.threads) {
        if (entry.already) continue;
        yield* writer.commitCommand({
          commandId: CommandId.make(
            `${prefix}:thread:${sha([plan.preview.sourceEnvironmentId, entry.projection.thread.id])}`,
          ),
          threadId: ThreadId.make(entry.targetId),
          commandType: `${prefix}:${entry.fingerprint}`,
          acceptedAt: entry.projection.thread.updatedAt,
          events: eventsForThread(plan, entry, occupiedMessages, occupiedItems),
          effects: [],
        });
      }
    }).pipe(Effect.provide(sink), Effect.scoped),
  );
  inspectNativeUpdateWork(databasePath(target));
  const before = plan.baseline.baseline;
  const after = withDatabase(target, (db) => ({
    eventPrefix: eventPrefix(db, before.targetEventHead),
    rows: digestRows(db, plan.baseline.tables),
    work: digestRows(db, plan.baseline.tables, true),
  }));
  if (
    before.eventPrefixGeneration !== after.eventPrefix ||
    before.existingRowsGeneration !== after.rows ||
    before.existingWorkGeneration !== after.work
  )
    throw new Error("history-existing-target-state-changed");
  return {
    schemaVersion: 1,
    summary: plan.preview.summary,
    importedThreadIds: plan.threads
      .filter((entry) => !entry.already)
      .map((entry) => entry.targetId),
    newProjectIds: plan.newProjects.map((row) => String(row.project_id)),
    attachmentManifest: plan.attachments,
    proof: {
      targetEventHeadBefore: before.targetEventHead,
      eventPrefixGenerationBefore: before.eventPrefixGeneration,
      eventPrefixGenerationAfter: after.eventPrefix,
      existingRowsGenerationBefore: before.existingRowsGeneration,
      existingRowsGenerationAfter: after.rows,
      existingWorkGenerationBefore: before.existingWorkGeneration,
      existingWorkGenerationAfter: after.work,
    },
  };
}
