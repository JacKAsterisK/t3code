// @effect-diagnostics nodeBuiltinImport:off -- This standalone preview reads only metadata and read-only SQLite aggregates; it never initializes T3 services.
import { nativeWorkStatusDefinitions } from "../../apps/server/src/lan/nativeWorkStates.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export interface PreviewOptions {
  readonly userHomeDirectory: string;
  readonly localAppData: string;
  readonly appDataDirectory: string;
  readonly originalHomeDirectory?: string;
  readonly supportedMigrationIds: readonly number[];
}

interface FileMetadata {
  readonly present: boolean;
  readonly bytes?: number;
  readonly modifiedMs?: number;
}

interface Counts {
  readonly projects: number;
  readonly threads: number;
  readonly messages: number;
  readonly runs: number;
  readonly turnItems: number;
  readonly legacyEvents: number;
  readonly legacyThreads: number;
  readonly legacyMessages: number;
}

interface HomeInventory {
  readonly homeDirectory: string;
  readonly state: "missing" | "empty" | "initialized" | "blocked";
  readonly environmentId: string | null;
  readonly migrationIds: readonly number[];
  readonly counts: Counts;
  readonly activeWork: number | null;
  readonly providerInstances: readonly {
    instanceId: string;
    driver: string;
    configKeys: readonly string[];
    environmentNames: readonly string[];
  }[];
  readonly files: Readonly<Record<string, FileMetadata>>;
  readonly blockers: readonly string[];
}

export interface HomeRepairPreview {
  readonly schemaVersion: 1;
  readonly operation: "preview";
  readonly planId: string;
  readonly state: "fresh" | "original-only" | "lan-only" | "split" | "blocked";
  readonly recommendedAction:
    | "create-original"
    | "adopt-original"
    | "retain-lan"
    | "adopt-original-retain-lan"
    | "resolve-blockers";
  readonly canApply: false;
  readonly applySupported: false;
  readonly original: HomeInventory;
  readonly lan: HomeInventory;
  readonly electronProfiles: readonly { profileDirectory: string; localState: FileMetadata }[];
  readonly conflicts: readonly string[];
  readonly blockers: readonly string[];
  readonly preservePaths: readonly string[];
  readonly requirements: readonly string[];
}

const emptyCounts: Counts = {
  projects: 0,
  threads: 0,
  messages: 0,
  runs: 0,
  turnItems: 0,
  legacyEvents: 0,
  legacyThreads: 0,
  legacyMessages: 0,
};
export const supportedMigrationIds = Array.from({ length: 81 }, (_, index) => index + 1);
const trackedFiles = [
  "userdata/environment-id",
  "userdata/statev2.sqlite",
  "userdata/statev2.sqlite-wal",
  "userdata/statev2.sqlite-shm",
  "userdata/state.sqlite",
  "userdata/settings.json",
  "userdata/client-settings.json",
  "userdata/desktop-settings.json",
  "userdata/connection-catalog.json",
  "userdata/keybindings.json",
] as const;
const maxPreviewBytes = 131_072;

function statIfPresent(file: string): NodeFS.Stats | undefined {
  try {
    return NodeFS.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function ordinaryAncestors(file: string): void {
  for (let directory = NodePath.resolve(file); ;) {
    const stat = statIfPresent(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("unsafe-path");
    const parent = NodePath.dirname(directory);
    if (directory === parent) return;
    directory = parent;
  }
}

function fileMetadata(file: string): FileMetadata {
  const stat = statIfPresent(file);
  if (!stat) return { present: false };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe-file");
  return { present: true, bytes: stat.size, modifiedMs: stat.mtimeMs };
}

function readSmallMetadata(file: string, maxBytes: number): string | undefined {
  const before = statIfPresent(file);
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("unsafe-file");
  if (before.size > maxBytes) throw new Error("oversized-metadata");
  const descriptor = NodeFS.openSync(file, "r");
  try {
    const opened = NodeFS.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("unsafe-file");
    const buffer = Buffer.alloc(maxBytes + 1);
    const length = NodeFS.readSync(descriptor, buffer);
    if (length > maxBytes) throw new Error("oversized-metadata");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-settings");
  return value as Record<string, unknown>;
}

function inspectProviders(home: string): HomeInventory["providerInstances"] {
  const text = readSmallMetadata(NodePath.join(home, "userdata", "settings.json"), 1_048_576);
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid-settings");
  }
  const settings = record(parsed);
  if (settings.providerInstances === undefined) return [];
  const instances = record(settings.providerInstances);
  if (Object.keys(instances).length > 256) throw new Error("oversized-settings");
  return Object.entries(instances).map(([instanceId, raw]) => {
    const entry = record(raw);
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(instanceId) ||
      typeof entry.driver !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(entry.driver)
    )
      throw new Error("invalid-settings");
    const environmentNames = Array.isArray(entry.environment)
      ? entry.environment
          .map((variable) => record(variable).name)
          .filter(
            (name): name is string =>
              typeof name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(name),
          )
      : [];
    return {
      instanceId,
      driver: entry.driver,
      configKeys:
        entry.config === undefined
          ? []
          : Object.keys(record(entry.config))
              .filter((key) => /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(key))
              .slice(0, 256),
      environmentNames: environmentNames.slice(0, 256),
    };
  });
}

function inspectDatabase(file: string, supportedMigrationIds: readonly number[]) {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = ?")
        .all("table")
        .map((row) => String(row.name)),
    );
    if (!tables.has("effect_sql_migrations")) throw new Error("unrecognized-schema");
    const migrationIds = db
      .prepare("SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id LIMIT 1025")
      .all()
      .map((row) => Number(row.migration_id));
    if (
      migrationIds.length > 1_024 ||
      migrationIds.some((id, index) => !Number.isSafeInteger(id) || id !== index + 1)
    )
      throw new Error("unrecognized-schema");
    if (migrationIds.some((id) => !supportedMigrationIds.includes(id)))
      throw new Error("unsupported-schema");
    const count = (table: string) =>
      tables.has(table) ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) : 0;
    const counts = {
      projects: count("projection_projects"),
      threads: count("orchestration_v2_projection_threads"),
      messages: count("orchestration_v2_projection_messages"),
      runs: count("orchestration_v2_projection_runs"),
      turnItems: count("orchestration_v2_projection_turn_items"),
      legacyEvents: count("orchestration_events"),
      legacyThreads: count("projection_threads"),
      legacyMessages: count("projection_thread_messages"),
    };
    const activeTables = [
      "orchestration_v2_projection_runs",
      "orchestration_v2_effect_outbox",
      "orchestration_v2_projection_runtime_requests",
      "scheduled_tasks",
    ];
    let activeWork: number | null = 0;
    for (const table of activeTables) {
      if (!tables.has(table)) continue;
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name));
      if (table === "scheduled_tasks" && columns.includes("enabled")) {
        const scheduledStates = db
          .prepare("SELECT enabled, count(*) AS n FROM scheduled_tasks GROUP BY enabled")
          .all();
        for (const state of scheduledStates) {
          if (state.enabled !== 0 && state.enabled !== 1) activeWork = null;
          else if (state.enabled === 1 && activeWork !== null) activeWork += Number(state.n);
        }
        continue;
      }
      if (!columns.includes("status")) {
        if (count(table) > 0) activeWork = null;
        continue;
      }
      const states = db.prepare(`SELECT status, count(*) AS n FROM ${table} GROUP BY status`).all();
      const definition = nativeWorkStatusDefinitions.find(([name]) => name === table);
      for (const state of states) {
        if (
          !definition ||
          typeof state.status !== "string" ||
          !(definition[1] as readonly string[]).includes(state.status)
        ) {
          activeWork = null;
          continue;
        }
        // Native inspection counts queued runs separately from active runs.
        const busy =
          (definition[2] as readonly string[]).includes(state.status) ||
          (table === "orchestration_v2_projection_runs" && state.status === "queued");
        if (busy && activeWork !== null) activeWork += Number(state.n);
      }
    }
    if (tables.has("orchestration_v2_projection_metadata")) {
      try {
        const work = inspectStoppedRepairWork(file);
        activeWork =
          work.activeRuns +
          work.queuedRuns +
          work.pendingRequests +
          work.backgroundAgents +
          work.scheduledWork +
          work.restartContinuations;
      } catch {
        activeWork = null;
      }
    }
    db.exec("ROLLBACK");
    return { migrationIds, counts, activeWork };
  } finally {
    db.close();
  }
}

function inspectHome(home: string, supportedMigrationIds: readonly number[]): HomeInventory {
  const files: Record<string, FileMetadata> = {};
  let environmentId: string | null = null;
  let migrationIds: readonly number[] = [];
  let counts = emptyCounts;
  let activeWork: number | null = null;
  let providerInstances: HomeInventory["providerInstances"] = [];
  const blockers: string[] = [];
  try {
    ordinaryAncestors(home);
    if (!statIfPresent(home))
      return {
        homeDirectory: home,
        state: "missing",
        environmentId,
        migrationIds,
        counts,
        activeWork: 0,
        providerInstances,
        files,
        blockers,
      };
    for (const relative of trackedFiles)
      files[relative] = fileMetadata(NodePath.join(home, relative));
    const identity = readSmallMetadata(NodePath.join(home, "userdata", "environment-id"), 256);
    if (identity !== undefined) {
      environmentId = identity.trim();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(environmentId))
        throw new Error("invalid-identity");
    }
    const database = files["userdata/statev2.sqlite"]!.present;
    if (!database && !environmentId && !Object.values(files).some((file) => file.present)) {
      const entries = NodeFS.readdirSync(home);
      if (
        entries.some((entry) => entry !== "userdata") ||
        (entries.includes("userdata") &&
          NodeFS.readdirSync(NodePath.join(home, "userdata")).length > 0)
      )
        throw new Error("unrecognized-home-content");
      return {
        homeDirectory: home,
        state: "empty",
        environmentId,
        migrationIds,
        counts,
        activeWork: 0,
        providerInstances,
        files,
        blockers,
      };
    }
    if (!database || !environmentId)
      throw new Error(
        files["userdata/state.sqlite"]!.present
          ? "legacy-database-review-required"
          : "incomplete-home",
      );
    ({ migrationIds, counts, activeWork } = inspectDatabase(
      NodePath.join(home, "userdata", "statev2.sqlite"),
      supportedMigrationIds,
    ));
    if (activeWork === null) blockers.push("active-work-inspection-unknown");
    providerInstances = inspectProviders(home);
    for (const directory of ["userdata/attachments", "userdata/secrets", "worktrees"])
      ordinaryAncestors(NodePath.join(home, directory));
  } catch (error) {
    const code = error instanceof Error ? error.message : "inspection-failed";
    blockers.push(
      [
        "unsafe-path",
        "unsafe-file",
        "oversized-metadata",
        "invalid-settings",
        "oversized-settings",
        "unrecognized-schema",
        "unsupported-schema",
        "invalid-identity",
        "legacy-database-review-required",
        "incomplete-home",
        "unrecognized-home-content",
      ].includes(code)
        ? code
        : "inspection-failed",
    );
  }
  return {
    homeDirectory: home,
    state: blockers.length ? "blocked" : "initialized",
    environmentId,
    migrationIds,
    counts,
    activeWork,
    providerInstances,
    files,
    blockers,
  };
}

export function previewHomeRepair(options: PreviewOptions): HomeRepairPreview {
  for (const directory of [
    options.userHomeDirectory,
    options.localAppData,
    options.appDataDirectory,
    options.originalHomeDirectory ?? options.userHomeDirectory,
  ])
    if (!NodePath.isAbsolute(directory))
      throw new Error("Home discovery requires absolute per-user paths.");
  const originalHome = NodePath.resolve(
    options.originalHomeDirectory ?? NodePath.join(options.userHomeDirectory, ".t3"),
  );
  const lanHome = NodePath.resolve(options.localAppData, "T3CodeLAN", "data");
  const original = inspectHome(originalHome, options.supportedMigrationIds);
  const lan = inspectHome(lanHome, options.supportedMigrationIds);
  const initialized = (home: HomeInventory) => home.state === "initialized";
  const conflicts: string[] = [];
  const blockers = [
    ...original.blockers.map((code) => `original:${code}`),
    ...lan.blockers.map((code) => `lan:${code}`),
  ];
  if (statIfPresent(NodePath.join(options.localAppData, "T3CodeLAN", "home-repair.json")))
    blockers.push("incomplete-home-repair");
  const contains = (parent: string, child: string) => {
    const relative = NodePath.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${NodePath.sep}`) &&
        relative !== ".." &&
        !NodePath.isAbsolute(relative))
    );
  };
  if (contains(originalHome, lanHome) || contains(lanHome, originalHome))
    blockers.push("overlapping-homes");
  if (initialized(original) && initialized(lan)) {
    conflicts.push(
      original.environmentId === lan.environmentId
        ? "duplicated-environment-identity"
        : "different-environment-identities",
    );
    conflicts.push("two-state-homes-require-retention-review");
    const oldIds = new Set(original.providerInstances.map((instance) => instance.instanceId));
    if (lan.providerInstances.some((instance) => oldIds.has(instance.instanceId)))
      conflicts.push("provider-instance-id-collision");
    if (lan.counts.threads || lan.counts.messages || lan.providerInstances.length)
      conflicts.push("lan-only-history-or-settings");
  }
  const electronProfiles: HomeRepairPreview["electronProfiles"][number][] = [];
  for (const profileDirectory of [
    NodePath.join(options.appDataDirectory, "t3code-v2"),
    NodePath.join(options.appDataDirectory, "T3 Code (Alpha)"),
    NodePath.join(options.appDataDirectory, "t3code"),
    NodePath.join(options.localAppData, "T3CodeLAN", "electron-profile"),
  ]) {
    try {
      ordinaryAncestors(profileDirectory);
      electronProfiles.push({
        profileDirectory,
        localState: fileMetadata(NodePath.join(profileDirectory, "Local State")),
      });
    } catch {
      blockers.push("electron-profile:unsafe-or-unreadable");
    }
  }
  const state: HomeRepairPreview["state"] = blockers.length
    ? "blocked"
    : initialized(original) && initialized(lan)
      ? "split"
      : initialized(original)
        ? "original-only"
        : initialized(lan)
          ? "lan-only"
          : "fresh";
  const recommendedAction =
    state === "blocked"
      ? "resolve-blockers"
      : state === "split"
        ? "adopt-original-retain-lan"
        : state === "original-only"
          ? "adopt-original"
          : state === "lan-only"
            ? "retain-lan"
            : "create-original";
  const metadata = { state, original, lan, electronProfiles, conflicts, blockers };
  // SQLite read marks change during harmless readers; they are not durable state.
  const fingerprint = JSON.stringify(metadata, (key, value: unknown) =>
    key.endsWith("-shm") ? undefined : value,
  );
  const report: HomeRepairPreview = {
    schemaVersion: 1,
    operation: "preview",
    planId: NodeCrypto.createHash("sha256").update(fingerprint).digest("hex"),
    ...metadata,
    recommendedAction,
    canApply: false,
    applySupported: false,
    preservePaths: [
      originalHome,
      lanHome,
      ...electronProfiles
        .filter((profile) => profile.localState.present)
        .map((profile) => profile.profileDirectory),
    ],
    requirements: [
      "explicit-user-approval",
      "stop-and-exclusively-lease-both-homes-and-electron-profiles",
      "coherent-full-state-backup-including-wal-and-encrypted-protection-context",
      "validate-existing-migrations-on-staged-backup-no-downgrade",
      "retain-lan-history-attachments-worktrees-and-provider-configurations",
      "record-authoritative-home-without-identity-or-credential-merge",
      "validate-old-history-and-trusted-client-continuity-before-retiring-any-state",
      "rollback-matching-binary-data-profile-and-selection-before-new-work",
    ],
  };
  if (Buffer.byteLength(JSON.stringify(report)) > maxPreviewBytes)
    throw new Error("Preview metadata exceeds the bounded report size.");
  return report;
}

export function homeRepairMain(args: readonly string[]): HomeRepairPreview {
  if (args[0] !== "preview" || !args.includes("--json"))
    throw new Error("Usage: home-repair preview --json [--original-home <absolute path>]");
  const originalIndex = args.indexOf("--original-home");
  const known = new Set([
    0,
    args.indexOf("--json"),
    ...(originalIndex < 0 ? [] : [originalIndex, originalIndex + 1]),
  ]);
  if (
    args.some((_, index) => !known.has(index)) ||
    (originalIndex >= 0 && !args[originalIndex + 1])
  )
    throw new Error("Unsupported home-repair arguments.");
  return previewHomeRepair({
    userHomeDirectory: NodeOS.homedir(),
    localAppData: process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local"),
    appDataDirectory: process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Roaming"),
    ...(originalIndex < 0 ? {} : { originalHomeDirectory: args[originalIndex + 1]! }),
    supportedMigrationIds,
  });
}

if (
  process.argv[1] &&
  NodePath.basename(process.argv[1]) === "home-repair.ts" &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(`${JSON.stringify(homeRepairMain(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write("Home-repair preview failed; no repair was performed.\n");
    process.exitCode = 1;
  }
}
