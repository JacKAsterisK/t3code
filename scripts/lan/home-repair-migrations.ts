// @effect-diagnostics nodeBuiltinImport:off -- Only a transaction-owned staged copy may be migrated; live homes are refused.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import { migrationManifest, runMigrations } from "../../apps/server/src/persistence/Migrations.ts";
import { assertOrdinaryNativePath } from "../../packages/shared/src/nativeHomeSelection.ts";

function stagedDatabase(home: string) {
  if (
    !NodePath.isAbsolute(home) ||
    NodePath.basename(home) !== "staged-original" ||
    !/^[a-f0-9]{32}$/.test(NodePath.basename(NodePath.dirname(home))) ||
    NodePath.basename(NodePath.dirname(NodePath.dirname(home))) !== "recovery" ||
    NodePath.basename(NodePath.dirname(NodePath.dirname(NodePath.dirname(home)))) !== "T3CodeLAN"
  )
    throw new Error("Migration is limited to the repair transaction's staged original home.");
  assertOrdinaryNativePath(home, true);
  const database = NodePath.join(home, "userdata", "statev2.sqlite");
  assertOrdinaryNativePath(database, false);
  return database;
}

export async function validateRepairStagedHome(home: string) {
  const database = stagedDatabase(home);
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get() !== undefined
    )
      throw new Error("Staged database integrity validation failed.");
    const recorded = db
      .prepare(
        "SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id LIMIT 1025",
      )
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
      throw new Error(
        "Staged schema is not an exact supported migration-manifest prefix; no downgrade or name reconciliation is allowed.",
      );
    for (const table of [
      "projection_projects",
      "orchestration_v2_projection_threads",
      "orchestration_v2_projection_messages",
      "orchestration_v2_projection_turn_items",
    ])
      db.prepare(`SELECT count(*) FROM ${table}`).get();
  } finally {
    db.close();
  }
}

export async function migrateRepairStagedHome(home: string) {
  const database = stagedDatabase(home);
  await validateRepairStagedHome(home);
  await Effect.runPromise(
    runMigrations().pipe(
      Effect.provide([
        NodeSqliteClient.layer({ filename: database }),
        NodeServices.layer,
        Logger.layer([], { mergeWithExisting: false }),
      ]),
      Effect.scoped,
    ),
  );
  await validateRepairStagedHome(home);
  const db = new NodeSqlite.DatabaseSync(database);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const metadata = NodeFS.statSync(database);
  if (!metadata.isFile()) throw new Error("Staged migration did not leave an ordinary database.");
}
