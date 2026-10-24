// @effect-diagnostics nodeBuiltinImport:off -- The real migration engine is exercised only on a synthetic recovery staging database.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import { migrationManifest, runMigrations } from "../../apps/server/src/persistence/Migrations.ts";
import { migrateRepairStagedHome, validateRepairStagedHome } from "./home-repair-migrations.ts";

it.effect(
  "the existing engine upgrades a staged 67 schema to the current exact manifest and refuses live paths",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-repair-migrations-")),
        ),
        (directory) =>
          Effect.sync(() => {
            if (
              NodePath.dirname(NodePath.resolve(directory)) !== NodePath.resolve(NodeOS.tmpdir()) ||
              !NodePath.basename(directory).startsWith("t3-repair-migrations-")
            )
              throw new Error("Refusing unsafe fixture cleanup.");
            NodeFS.rmSync(directory, { recursive: true, force: true });
          }),
      );
      const home = NodePath.join(root, "T3CodeLAN", "recovery", "a".repeat(32), "staged-original");
      NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
      const file = NodePath.join(home, "userdata", "statev2.sqlite");
      const identity = "11111111-1111-4111-8111-111111111111\n";
      NodeFS.writeFileSync(NodePath.join(home, "userdata", "environment-id"), identity);
      yield* runMigrations({ toMigrationInclusive: 67 }).pipe(
        Effect.provide([
          NodeSqliteClient.layer({ filename: file }),
          NodeServices.layer,
          Logger.layer([], { mergeWithExisting: false }),
        ]),
        Effect.scoped,
      );
      yield* Effect.promise(() => migrateRepairStagedHome(home));
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        NodeAssert.equal(
          db.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get()!.n,
          migrationManifest.at(-1)![0],
        );
      } finally {
        db.close();
      }
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(home, "userdata", "environment-id"), "utf8"),
        identity,
      );
      yield* Effect.promise(() =>
        NodeAssert.rejects(migrateRepairStagedHome(NodePath.join(root, ".t3")), /staged original/),
      );
      const changed = new NodeSqlite.DatabaseSync(file);
      try {
        changed.exec(
          "UPDATE effect_sql_migrations SET name='foreign migration' WHERE migration_id=67",
        );
      } finally {
        changed.close();
      }
      yield* Effect.promise(() =>
        NodeAssert.rejects(validateRepairStagedHome(home), /exact supported/),
      );
    }).pipe(Effect.scoped),
);
