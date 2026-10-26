// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- The offline native lease helper reads closed SQLite state and hashes files without loading the server runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNativeAdmissionPaths } from "@t3tools/shared/nativeAdmission";
import { strictJson } from "@t3tools/shared/strictJson";
import {
  NativeActivationBuildIdentity,
  type NativeMaintenanceRequest,
  OrchestrationV2DelegatedCompletionCohort,
  OrchestrationV2DelegatedCompletionTaskDelivery,
  OrchestrationV2ProviderGoal,
} from "@t3tools/contracts";
import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";

export type NativeBuildIdentity = typeof NativeActivationBuildIdentity.Type;
export type { NativeMaintenanceRequest };

export class NativeMaintenanceError extends Schema.TaggedError<NativeMaintenanceError>()(
  "NativeMaintenanceError",
  {
    reason: Schema.Literals(["identity", "lease", "schema", "projection", "busy", "changed", "io"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Native maintenance refused (${this.reason}).`;
  }
}

export class NativeMaintenanceLease extends Context.Service<
  NativeMaintenanceLease,
  {
    readonly verify: (home: string) => Effect.Effect<void, NativeMaintenanceError>;
  }
>()("t3/lan/NativeMaintenance/NativeMaintenanceLease") {}

const safeFile = (file: string) => {
  const stat = NodeFS.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new NativeMaintenanceError({ reason: "identity" });
  return stat;
};
const safeParents = (directory: string) => {
  for (let at = NodePath.resolve(directory); ;) {
    const stat = NodeFS.lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new NativeMaintenanceError({ reason: "identity" });
    const parent = NodePath.dirname(at);
    if (parent === at) return;
    at = parent;
  }
};
const isNativeMaintenanceError = Schema.is(NativeMaintenanceError);
const ioError = (cause: unknown) =>
  isNativeMaintenanceError(cause) ? cause : new NativeMaintenanceError({ reason: "io", cause });

const bootstrapJournal = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    kind: Schema.Literal("bootstrap"),
    environmentId: Schema.String,
    homeDirectory: Schema.String,
    bootstrapId: Schema.String,
  }),
);
const isAllowedMaintenanceLayout = (home: string, journal: string) =>
  (NodePath.basename(home).toLowerCase() === ".t3" &&
    NodePath.resolve(journal) === NodePath.join(home, "native-activation.json")) ||
  (NodePath.basename(home).toLowerCase() === "data" &&
    NodePath.basename(NodePath.dirname(home)).toLowerCase() === "t3codelan" &&
    NodePath.resolve(journal) === NodePath.join(NodePath.dirname(home), "activation.json"));

const bootstrapFiles = new Set([
  "native-admission.lock",
  "native-bootstrap-state.json",
  "native-activation.json",
  "userdata/server-owner.sqlite",
  "userdata/environment-id",
  "userdata/statev2.sqlite",
  "userdata/statev2.sqlite-wal",
  "userdata/statev2.sqlite-shm",
]);
const decodeBootstrapState = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    bootstrapId: Schema.String,
    environmentId: Schema.String,
    stagingDirectory: Schema.String,
    databaseSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  { onExcessProperty: "error" },
);
function readBootstrapState(request: NativeMaintenanceRequest) {
  const receipt = NodePath.join(request.homeDirectory, "native-bootstrap-state.json");
  const stat = NodeFS.lstatSync(receipt);
  if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink) || stat.size > 8192)
    throw new NativeMaintenanceError({ reason: "identity" });
  const state = decodeBootstrapState(strictJson(NodeFS.readFileSync(receipt)));
  const directory = NodePath.resolve(state.stagingDirectory);
  if (
    state.bootstrapId !== request.bootstrapId ||
    state.environmentId !== request.environmentId ||
    NodePath.dirname(directory) !== NodePath.dirname(request.homeDirectory) ||
    !NodePath.basename(directory).startsWith(`.bootstrap-${request.bootstrapId}-`)
  )
    throw new NativeMaintenanceError({ reason: "identity" });
  if (stat.nlink === 2) {
    safeParents(directory);
    const stagedReceipt = NodePath.join(directory, "native-bootstrap-state.json");
    const other = NodeFS.lstatSync(stagedReceipt);
    if (
      !other.isFile() ||
      other.isSymbolicLink() ||
      other.dev !== stat.dev ||
      other.ino !== stat.ino ||
      other.nlink !== 2
    )
      throw new NativeMaintenanceError({ reason: "identity" });
    NodeFS.unlinkSync(stagedReceipt);
  }
  return state;
}
function bootstrapDatabaseHash(file: string, allowOwnedPair = false) {
  const stat = NodeFS.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 32 * 1024 ** 2 ||
    (stat.nlink !== 1 && !(allowOwnedPair && stat.nlink === 2))
  )
    throw new NativeMaintenanceError({ reason: "identity" });
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}
function publishBootstrapDatabase(request: NativeMaintenanceRequest) {
  const state = readBootstrapState(request);
  const directory = NodePath.resolve(state.stagingDirectory);
  if (
    state.bootstrapId !== request.bootstrapId ||
    state.environmentId !== request.environmentId ||
    NodePath.dirname(directory) !== NodePath.dirname(request.homeDirectory) ||
    !NodePath.basename(directory).startsWith(`.bootstrap-${request.bootstrapId}-`)
  )
    throw new NativeMaintenanceError({ reason: "identity" });
  const staged = NodePath.join(directory, "statev2.sqlite");
  const final = NodePath.join(request.homeDirectory, "userdata", "statev2.sqlite");
  if (NodeFS.existsSync(final + "-wal") && safeFile(final + "-wal").size !== 0)
    throw new NativeMaintenanceError({ reason: "changed" });
  if (NodeFS.existsSync(final + "-shm")) safeFile(final + "-shm");
  if (!NodeFS.existsSync(final)) {
    safeParents(directory);
    if (bootstrapDatabaseHash(staged) !== state.databaseSha256)
      throw new NativeMaintenanceError({ reason: "changed" });
    NodeFS.linkSync(staged, final);
  }
  if (bootstrapDatabaseHash(final, true) !== state.databaseSha256)
    throw new NativeMaintenanceError({ reason: "changed" });
  if (NodeFS.existsSync(staged)) {
    safeParents(directory);
    const source = NodeFS.lstatSync(staged),
      destination = NodeFS.lstatSync(final);
    if (
      source.dev !== destination.dev ||
      source.ino !== destination.ino ||
      source.nlink !== 2 ||
      destination.nlink !== 2
    )
      throw new NativeMaintenanceError({ reason: "identity" });
    NodeFS.unlinkSync(staged);
  }
  safeFile(final);
}
function inspectBootstrapHome(request: NativeMaintenanceRequest) {
  const home = NodePath.resolve(request.homeDirectory);
  if (
    home !== request.homeDirectory ||
    !isAllowedMaintenanceLayout(home, request.journalPath) ||
    !request.bootstrapId ||
    !/^[a-f0-9]{64}$/u.test(request.bootstrapId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      request.environmentId,
    )
  )
    throw new NativeMaintenanceError({ reason: "identity" });
  safeParents(home);
  if (safeFile(request.journalPath).size > 65536)
    throw new NativeMaintenanceError({ reason: "identity" });
  const journal = bootstrapJournal(strictJson(NodeFS.readFileSync(request.journalPath)));
  if (
    journal.environmentId !== request.environmentId ||
    journal.homeDirectory !== home ||
    journal.bootstrapId !== request.bootstrapId
  )
    throw new NativeMaintenanceError({ reason: "identity" });
  for (const entry of NodeFS.readdirSync(home)) {
    const file = NodePath.join(home, entry);
    if (entry === "userdata") {
      safeParents(file);
      for (const child of NodeFS.readdirSync(file)) {
        const relative = `userdata/${child}`;
        if (!bootstrapFiles.has(relative)) throw new NativeMaintenanceError({ reason: "identity" });
        const childPath = NodePath.join(home, relative);
        if (
          relative === "userdata/statev2.sqlite" &&
          NodeFS.existsSync(NodePath.join(home, "native-bootstrap-state.json"))
        )
          bootstrapDatabaseHash(childPath, true);
        else safeFile(childPath);
      }
    } else {
      if (!bootstrapFiles.has(entry)) throw new NativeMaintenanceError({ reason: "identity" });
      if (entry === "native-bootstrap-state.json") readBootstrapState(request);
      else safeFile(file);
    }
  }
  safeParents(NodePath.join(home, "userdata"));
  safeFile(NodePath.join(home, "userdata", "server-owner.sqlite"));
}

function assertEmptyBootstrapDatabase(databasePath: string) {
  if (!NodeFS.existsSync(databasePath)) return;
  safeFile(databasePath);
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    // FTS5 has bookkeeping rows even before any messages have been indexed.
    // Its visible table must still be empty, and only SQLite-owned shadows qualify.
    const searchShadows = new Set(
      db
        .prepare("PRAGMA table_list")
        .all()
        .filter(
          (row) =>
            row.type === "shadow" &&
            String(row.name).startsWith("orchestration_v2_message_search_"),
        )
        .map((row) => String(row.name)),
    );
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const name = String(row.name);
      if (searchShadows.has(name)) continue;
      if (name === "effect_sql_migrations") {
        const history = db
          .prepare("SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id")
          .all();
        if (
          history.some(
            (entry, index) =>
              entry.migration_id !== migrationManifest[index]?.[0] ||
              entry.name !== migrationManifest[index]?.[1],
          )
        )
          throw new NativeMaintenanceError({ reason: "schema" });
      } else if (name === "orchestration_v2_projection_metadata") {
        const rows = db
          .prepare(
            "SELECT projection_name,schema_version,last_sequence FROM orchestration_v2_projection_metadata",
          )
          .all();
        if (
          rows.length > 1 ||
          rows.some(
            (entry) =>
              entry.projection_name !== "thread-projections" ||
              ![1, 2].includes(Number(entry.schema_version)) ||
              entry.last_sequence !== 0,
          )
        )
          throw new NativeMaintenanceError({ reason: "busy" });
      } else {
        const quoted = '"' + name.replaceAll('"', '""') + '"';
        if (db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get())
          throw new NativeMaintenanceError({ reason: "busy" });
      }
    }
  } finally {
    db.close();
  }
}

export const layerNativeLease = Layer.succeed(NativeMaintenanceLease, {
  verify: Effect.fn("NativeMaintenance.verifyExclusiveLease")(function* (home: string) {
    if ((yield* HostProcess.Platform) !== "win32")
      return yield* new NativeMaintenanceError({ reason: "lease" });
    return yield* Effect.try({
      try: () => {
        const { lockPath } = resolveNativeAdmissionPaths(home);
        safeParents(home);
        safeFile(lockPath);
        let descriptor: number;
        try {
          descriptor = NodeFS.openSync(lockPath, "r+");
        } catch (cause) {
          // This conflict is protocol sanity, not holder authentication: ACL denial
          // can also fail this open. Hub's held kernel handles establish admission.
          if (
            cause instanceof Error &&
            "code" in cause &&
            ["EACCES", "EPERM", "EBUSY"].includes(String(cause.code))
          )
            return;
          throw new NativeMaintenanceError({ reason: "lease", cause });
        }
        NodeFS.closeSync(descriptor);
        throw new NativeMaintenanceError({ reason: "lease" });
      },
      catch: ioError,
    });
  }),
});

const terminal = ["completed", "interrupted", "failed", "cancelled", "rolled_back"];
const completed = ["completed", "interrupted", "failed", "cancelled"];
const decodePayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeCohort = Schema.decodeUnknownSync(OrchestrationV2DelegatedCompletionCohort);
const decodeTaskDelivery = Schema.decodeUnknownSync(OrchestrationV2DelegatedCompletionTaskDelivery);
const decodeGoal = Schema.decodeUnknownSync(OrchestrationV2ProviderGoal);
const statuses = [
  [
    "orchestration_v2_projection_runs",
    ["preparing", "queued", "starting", "running", "waiting", ...terminal],
    ["preparing", "starting", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_run_attempts",
    ["pending", "running", "superseded", ...completed],
    ["pending", "running"],
  ],
  [
    "orchestration_v2_projection_nodes",
    ["idle", "pending", "running", "waiting", ...terminal],
    ["pending", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    ["starting", "ready", "running", "waiting", "stopped", "error"],
    ["starting", "ready", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_provider_threads",
    ["not_loaded", "idle", "active", "archived", "closed", "error"],
    ["active"],
  ],
  [
    "orchestration_v2_projection_provider_turns",
    ["pending", "running", ...completed],
    ["pending", "running"],
  ],
  [
    "orchestration_v2_projection_runtime_requests",
    ["pending", "resolved", "expired", "cancelled"],
    ["pending"],
  ],
  [
    "orchestration_v2_projection_subagents",
    ["idle", "pending", "running", "waiting", ...completed],
    ["pending", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_turn_items",
    ["idle", "pending", "running", "waiting", ...completed],
    ["pending", "running", "waiting"],
  ],
  [
    "orchestration_v2_effect_outbox",
    ["pending", "running", "succeeded", "failed", "cancelled"],
    ["pending", "running"],
  ],
] as const;

const isWarmProviderState = (table: string, status: unknown) =>
  (table === "orchestration_v2_projection_provider_sessions" && status === "ready") ||
  (table === "orchestration_v2_projection_provider_threads" && status === "active");

// All identifiers below are fixed source constants, never request-derived SQL.
export const inspectStoppedRepairWork = (databasePath: string) => {
  const db = new NodeSqlite.DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN;");
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new NativeMaintenanceError({ reason: "schema" });
    const recorded = db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    if (
      recorded.length < 55 ||
      recorded.length > migrationManifest.length ||
      recorded.some(
        (row, index) =>
          row.migration_id !== migrationManifest[index]?.[0] ||
          row.name !== migrationManifest[index]?.[1],
      )
    )
      throw new NativeMaintenanceError({ reason: "schema" });
    const head = db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS sequence FROM orchestration_events WHERE application_event_version=2",
      )
      .get()!;
    const projection = db
      .prepare(
        "SELECT schema_version,last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'",
      )
      .get();
    if (projection?.schema_version !== 2 || projection.last_sequence !== head.sequence)
      throw new NativeMaintenanceError({ reason: "projection" });
    const counts = new Map<string, number>();
    for (const [table, allowed, busy] of statuses) {
      let count = 0;
      for (const row of db
        .prepare(`SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status`)
        .all()) {
        if (
          typeof row.status !== "string" ||
          !(allowed as ReadonlyArray<string>).includes(row.status) ||
          typeof row.count !== "number"
        )
          throw new NativeMaintenanceError({ reason: "schema" });
        if (
          (busy as ReadonlyArray<string>).includes(row.status) &&
          !isWarmProviderState(table, row.status)
        )
          count += row.count;
      }
      counts.set(table, count);
    }
    let deferredDelivery = 0;
    let activeGoals = 0;
    const unfinishedThreads = new Set<string>();
    const unfinishedProviderThreads = new Set<string>();
    const readySessions = new Map<string, string | null>();
    const providerThreads = new Map<
      string,
      { threadId: string | null; sessionId: string | null; active: boolean }
    >();
    const rememberWork = (row: Readonly<Record<string, unknown>>) => {
      for (const key of [
        "thread_id",
        "source_thread_id",
        "target_thread_id",
        "parent_thread_id",
        "child_thread_id",
      ])
        if (typeof row[key] === "string") unfinishedThreads.add(row[key]);
      if (typeof row.provider_thread_id === "string")
        unfinishedProviderThreads.add(row.provider_thread_id);
    };
    const optionalId = (value: unknown) => {
      if (value === null || typeof value === "string") return value;
      throw new NativeMaintenanceError({ reason: "schema" });
    };
    for (const [table, , busy] of statuses) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
        let payload: Record<string, unknown>;
        try {
          payload = decodePayload(row.payload_json);
        } catch (cause) {
          throw new NativeMaintenanceError({ reason: "schema", cause });
        }
        const beforeDelivery = deferredDelivery;
        if (table === "orchestration_v2_projection_provider_sessions") {
          if (row.status === "ready") {
            if (typeof row.provider_session_id !== "string")
              throw new NativeMaintenanceError({ reason: "schema" });
            readySessions.set(row.provider_session_id, optionalId(row.thread_id));
          }
        } else if (table === "orchestration_v2_projection_provider_threads") {
          if (typeof row.provider_thread_id !== "string")
            throw new NativeMaintenanceError({ reason: "schema" });
          providerThreads.set(row.provider_thread_id, {
            threadId: optionalId(row.thread_id),
            sessionId: optionalId(row.provider_session_id),
            active: row.status === "active",
          });
          if (payload.goal != null) {
            let goal;
            try {
              goal = decodeGoal(payload.goal);
            } catch (cause) {
              throw new NativeMaintenanceError({ reason: "schema", cause });
            }
            if (goal.status === "active") {
              // Native goals can continue after a terminal turn or an idle recovery label.
              activeGoals++;
              rememberWork(row);
            }
          }
        } else if (
          typeof row.status === "string" &&
          (busy as ReadonlyArray<string>).includes(row.status)
        )
          rememberWork(row);
        if (table === "orchestration_v2_projection_runs" && payload.delegatedCompletion != null) {
          let cohort;
          try {
            cohort = decodeCohort(payload.delegatedCompletion);
          } catch (cause) {
            throw new NativeMaintenanceError({ reason: "schema", cause });
          }
          if (cohort.disposition === "open" && cohort.delivery !== null) deferredDelivery++;
        }
        if (table === "orchestration_v2_projection_subagents") {
          if (payload.completionDelivery !== undefined) {
            let delivery;
            try {
              delivery = decodeTaskDelivery(payload.completionDelivery);
            } catch (cause) {
              throw new NativeMaintenanceError({ reason: "schema", cause });
            }
            if (["pending", "claimed"].includes(delivery.state)) deferredDelivery++;
          }
          // Uncollected app-owned child results can create parent work during restart recovery.
          if (
            payload.origin === "app_owned" &&
            payload.childThreadId != null &&
            payload.result == null
          )
            deferredDelivery++;
        }
        if (
          table === "orchestration_v2_projection_provider_threads" &&
          payload.pendingBackgroundTasks !== undefined
        ) {
          if (!Array.isArray(payload.pendingBackgroundTasks))
            throw new NativeMaintenanceError({ reason: "schema" });
          deferredDelivery += payload.pendingBackgroundTasks.length;
        }
        if (deferredDelivery !== beforeDelivery) rememberWork(row);
      }
    }
    const count = (sql: string) => Number(db.prepare(sql).get()!.count);
    const activeRuns = counts.get("orchestration_v2_projection_runs")!;
    const queuedRuns = count(
      "SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE status='queued'",
    );
    const pendingRequests = counts.get("orchestration_v2_projection_runtime_requests")!;
    if (count("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE enabled NOT IN (0,1)") !== 0)
      throw new NativeMaintenanceError({ reason: "schema" });
    const scheduledWork = count("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE enabled=1");
    let workflows = 0;
    for (const row of db
      .prepare(
        "SELECT thread_id FROM orchestration_v2_thread_launch_workflows WHERE status NOT IN ('completed','failed')",
      )
      .iterate()) {
      workflows++;
      rememberWork(row);
    }
    if (
      count(
        "SELECT COUNT(*) AS count FROM orchestration_v2_projection_context_transfers WHERE status NOT IN ('pending','resolved_native','resolved_portable','failed','consumed','superseded')",
      ) !== 0
    )
      throw new NativeMaintenanceError({ reason: "schema" });
    let unconsumedContext = 0;
    for (const row of db
      .prepare(
        "SELECT source_thread_id,target_thread_id FROM orchestration_v2_projection_context_transfers WHERE status IN ('pending','resolved_native','resolved_portable')",
      )
      .iterate()) {
      unconsumedContext++;
      rememberWork(row);
    }
    const childResultRows = db
      .prepare(`SELECT thread.thread_id,json_extract(thread.payload_json,'$.lineage.parentThreadId') AS parent_thread_id FROM orchestration_v2_projection_threads AS thread
      WHERE json_extract(thread.payload_json,'$.lineage.relationshipToParent')='subagent'
      AND json_extract(thread.payload_json,'$.forkedFrom.type')='node'
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run WHERE run.thread_id=thread.thread_id AND run.status IN ('completed','interrupted','failed','cancelled','rolled_back'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers AS transfer WHERE json_extract(transfer.payload_json,'$.type')='subagent_result' AND json_extract(transfer.payload_json,'$.sourceThreadId')=thread.thread_id AND json_extract(transfer.payload_json,'$.targetThreadId')=json_extract(thread.payload_json,'$.lineage.parentThreadId'))`)
      .all();
    const childResults = childResultRows.length;
    for (const row of childResultRows) rememberWork(row);
    // With admission held, warm provider labels alone cannot represent a live process.
    const busySessions = new Set<string>();
    let activeProviderThreads = 0;
    for (const [id, thread] of providerThreads) {
      if (
        !unfinishedProviderThreads.has(id) &&
        !(thread.threadId !== null && unfinishedThreads.has(thread.threadId))
      )
        continue;
      if (thread.active) activeProviderThreads++;
      if (thread.sessionId !== null) busySessions.add(thread.sessionId);
    }
    if (readySessions.size) {
      for (const row of db
        .prepare(
          "SELECT provider_session_id,thread_id FROM orchestration_v2_projection_provider_session_bindings",
        )
        .iterate())
        if (
          typeof row.provider_session_id === "string" &&
          typeof row.thread_id === "string" &&
          unfinishedThreads.has(row.thread_id)
        )
          busySessions.add(row.provider_session_id);
    }
    counts.set(
      "orchestration_v2_projection_provider_sessions",
      counts.get("orchestration_v2_projection_provider_sessions")! +
        [...readySessions].filter(
          ([id, threadId]) =>
            busySessions.has(id) || (threadId !== null && unfinishedThreads.has(threadId)),
        ).length,
    );
    counts.set("orchestration_v2_projection_provider_threads", activeProviderThreads);
    const backgroundAgents = [...counts]
      .filter(
        ([table]) =>
          ![
            "orchestration_v2_projection_runs",
            "orchestration_v2_projection_runtime_requests",
            "orchestration_v2_effect_outbox",
          ].includes(table),
      )
      .reduce((total, [, value]) => total + value, activeGoals);
    const restartContinuations =
      counts.get("orchestration_v2_effect_outbox")! +
      workflows +
      deferredDelivery +
      unconsumedContext +
      childResults;
    const hash = NodeCrypto.createHash("sha256");
    for (const [table, key] of [
      ["orchestration_events", "sequence"],
      ["orchestration_command_receipts", "command_id"],
      ["orchestration_v2_thread_launch_workflows", "command_id"],
      ["scheduled_tasks", "task_id"],
    ]) {
      hash.update(table!);
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate())
        hash.update(JSON.stringify(row));
    }
    db.exec("COMMIT");
    return {
      activeRuns,
      queuedRuns,
      pendingRequests,
      backgroundAgents,
      scheduledWork,
      restartContinuations,
      workGeneration: hash.digest("hex"),
    };
  } finally {
    db.close();
  }
};

const filesGeneration = async (databasePath: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [databasePath, `${databasePath}-wal`]) {
    hash.update(NodePath.basename(file));
    try {
      const stat = safeFile(file);
      if (file.endsWith("-wal") && stat.size === 0) {
        // SQLite read-only connections can create an empty WAL without changing durable state.
        hash.update("absent");
        continue;
      }
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT" &&
        file.endsWith("-wal")
      ) {
        hash.update("absent");
        continue;
      }
      throw cause;
    }
    for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  }
  return hash.digest("hex");
};

export const layer = (compiledIdentity: NativeBuildIdentity) =>
  Layer.effect(
    NativeMaintenance,
    Effect.gen(function* () {
      const lease = yield* NativeMaintenanceLease;
      const inspect = Effect.fn("NativeMaintenance.inspect")(function* (
        request: NativeMaintenanceRequest,
      ) {
        yield* lease.verify(request.homeDirectory);
        const snapshot = yield* Effect.tryPromise({
          try: async () => {
            const home = NodePath.resolve(request.homeDirectory);
            if (
              home !== request.homeDirectory ||
              !isAllowedMaintenanceLayout(home, request.journalPath)
            )
              throw new NativeMaintenanceError({ reason: "identity" });
            safeParents(home);
            const state = NodePath.join(home, "userdata");
            safeParents(state);
            const identityPath = NodePath.join(state, "environment-id");
            if (
              safeFile(identityPath).size > 256 ||
              NodeFS.readFileSync(identityPath, "utf8").trim() !== request.environmentId
            )
              throw new NativeMaintenanceError({ reason: "identity" });
            const dbPath = NodePath.join(state, "statev2.sqlite");
            safeFile(dbPath);
            const before = await filesGeneration(dbPath);
            const work = inspectStoppedRepairWork(dbPath);
            const after = await filesGeneration(dbPath);
            if (before !== after) throw new NativeMaintenanceError({ reason: "changed" });
            return {
              schemaVersion: request.schemaVersion,
              nonce: request.nonce,
              operation: request.operation,
              environmentId: request.environmentId,
              homeDirectory: request.homeDirectory,
              dataGeneration: after,
              ...work,
              processStopped: true as const,
              compiledIdentity,
            };
          },
          catch: ioError,
        });
        return { ...snapshot, observedUtc: DateTime.formatIso(yield* DateTime.now) };
      });
      const verify = Effect.fn("NativeMaintenance.verify")(function* (
        request: NativeMaintenanceRequest,
      ) {
        const before = yield* inspect(request);
        if (
          [
            before.activeRuns,
            before.queuedRuns,
            before.pendingRequests,
            before.backgroundAgents,
            before.scheduledWork,
            before.restartContinuations,
          ].some((value) => value !== 0)
        )
          return yield* new NativeMaintenanceError({ reason: "busy" });
        const dbPath = NodePath.join(request.homeDirectory, "userdata", "statev2.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA foreign_keys=ON`;
          yield* runMigrations();
        }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
          Effect.scoped,
          Effect.mapError(ioError),
        );
        const after = yield* inspect(request);
        if (after.workGeneration !== before.workGeneration)
          return yield* new NativeMaintenanceError({ reason: "changed" });
        return after;
      });
      const bootstrap = Effect.fn("NativeMaintenance.bootstrap")(function* (
        request: NativeMaintenanceRequest,
      ) {
        yield* lease.verify(request.homeDirectory);
        const dbPath = NodePath.join(request.homeDirectory, "userdata", "statev2.sqlite");
        const receipt = NodePath.join(request.homeDirectory, "native-bootstrap-state.json");
        yield* Effect.try({
          try: () => {
            inspectBootstrapHome(request);
            const environmentFile = NodePath.join(
              request.homeDirectory,
              "userdata",
              "environment-id",
            );
            if (NodeFS.existsSync(dbPath) && !NodeFS.existsSync(receipt))
              throw new NativeMaintenanceError({ reason: "identity" });
            if (NodeFS.existsSync(receipt) && !NodeFS.existsSync(environmentFile))
              throw new NativeMaintenanceError({ reason: "identity" });
            if (NodeFS.existsSync(environmentFile)) {
              if (
                safeFile(environmentFile).size > 256 ||
                NodeFS.readFileSync(environmentFile, "utf8").trim() !== request.environmentId
              )
                throw new NativeMaintenanceError({ reason: "identity" });
            } else {
              const descriptor = NodeFS.openSync(environmentFile, "wx", 0o600);
              try {
                NodeFS.writeFileSync(descriptor, request.environmentId + "\n");
                NodeFS.fsyncSync(descriptor);
              } finally {
                NodeFS.closeSync(descriptor);
              }
            }
          },
          catch: ioError,
        });
        if (!(yield* Effect.sync(() => NodeFS.existsSync(receipt)))) {
          const directory = yield* Effect.try({
            try: () =>
              NodeFS.mkdtempSync(
                NodePath.join(
                  NodePath.dirname(request.homeDirectory),
                  `.bootstrap-${request.bootstrapId}-`,
                ),
              ),
            catch: ioError,
          });
          const staged = NodePath.join(directory, "statev2.sqlite");
          yield* runMigrations().pipe(
            Effect.provide(NodeSqliteClient.layer({ filename: staged })),
            Effect.scoped,
            Effect.mapError(ioError),
          );
          yield* Effect.try({
            try: () => {
              assertEmptyBootstrapDatabase(staged);
              const db = new NodeSqlite.DatabaseSync(staged);
              try {
                db.exec(
                  "UPDATE orchestration_v2_projection_metadata SET schema_version=2 WHERE projection_name='thread-projections' AND last_sequence=0 AND schema_version=1; PRAGMA wal_checkpoint(TRUNCATE)",
                );
              } finally {
                db.close();
              }
              const state = {
                schemaVersion: 1,
                bootstrapId: request.bootstrapId,
                environmentId: request.environmentId,
                stagingDirectory: directory,
                databaseSha256: bootstrapDatabaseHash(staged),
              };
              const stagedReceipt = NodePath.join(directory, "native-bootstrap-state.json");
              const descriptor = NodeFS.openSync(stagedReceipt, "wx", 0o600);
              try {
                NodeFS.writeFileSync(descriptor, JSON.stringify(state) + "\n");
                NodeFS.fsyncSync(descriptor);
              } finally {
                NodeFS.closeSync(descriptor);
              }
              NodeFS.linkSync(stagedReceipt, receipt);
              NodeFS.unlinkSync(stagedReceipt);
            },
            catch: ioError,
          });
        }
        yield* Effect.try({
          try: () => {
            inspectBootstrapHome(request);
            publishBootstrapDatabase(request);
          },
          catch: ioError,
        });
        return yield* inspect(request);
      });
      return NativeMaintenance.of({ inspect, verify, bootstrap });
    }),
  );

type Snapshot = Omit<NativeMaintenanceRequest, "journalPath"> & {
  observedUtc: string;
  dataGeneration: string;
  workGeneration: string;
  processStopped: true;
  compiledIdentity: NativeBuildIdentity;
  activeRuns: number;
  queuedRuns: number;
  pendingRequests: number;
  backgroundAgents: number;
  scheduledWork: number;
  restartContinuations: number;
};
export class NativeMaintenance extends Context.Service<
  NativeMaintenance,
  {
    readonly inspect: (
      request: NativeMaintenanceRequest,
    ) => Effect.Effect<Snapshot, NativeMaintenanceError>;
    readonly verify: (
      request: NativeMaintenanceRequest,
    ) => Effect.Effect<Snapshot, NativeMaintenanceError>;
    readonly bootstrap: (
      request: NativeMaintenanceRequest,
    ) => Effect.Effect<Snapshot, NativeMaintenanceError>;
  }
>()("t3/lan/NativeMaintenance") {}
