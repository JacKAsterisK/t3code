// @effect-diagnostics nodeBuiltinImport:off -- Synthetic handoff data only: genuine migration schemas, generated messages and opaque profile placeholders; never installed homes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import { runMigrations } from "../../apps/server/src/persistence/Migrations.ts";
import { assertOrdinaryNativePath } from "../../packages/shared/src/nativeHomeSelection.ts";

export async function createHomeRepairFixture(root: string) {
  if (!NodePath.isAbsolute(root) || NodePath.resolve(root) !== root)
    throw new Error("Fixture requires a canonical absolute root.");
  assertOrdinaryNativePath(root, true);
  if (NodeFS.existsSync(root) && NodeFS.readdirSync(root).length)
    throw new Error("Fixture root must be new or empty; existing data is never overwritten.");
  NodeFS.mkdirSync(root, { recursive: true });
  const homes = [
    {
      homeDirectory: NodePath.join(root, ".t3"),
      migration: 67,
      messages: 1,
      environmentId: "11111111-1111-4111-8111-111111111111",
    },
    {
      homeDirectory: NodePath.join(root, "AppData", "Local", "T3CodeLAN", "data"),
      migration: 71,
      messages: 2,
      environmentId: "22222222-2222-4222-8222-222222222222",
    },
  ];
  for (const home of homes) {
    const state = NodePath.join(home.homeDirectory, "userdata");
    NodeFS.mkdirSync(NodePath.join(state, "attachments"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(state, "environment-id"), home.environmentId + "\n", {
      flag: "wx",
    });
    NodeFS.writeFileSync(
      NodePath.join(home.homeDirectory, "native-admission.lock"),
      "synthetic coordinator",
      { flag: "wx" },
    );
    NodeFS.writeFileSync(NodePath.join(state, "server-owner.sqlite"), "synthetic owner", {
      flag: "wx",
    });
    NodeFS.writeFileSync(
      NodePath.join(state, "attachments", "retained.txt"),
      "synthetic retained attachment",
      { flag: "wx" },
    );
    const database = NodePath.join(state, "statev2.sqlite");
    await Effect.runPromise(
      runMigrations({ toMigrationInclusive: home.migration }).pipe(
        Effect.provide([
          NodeSqliteClient.layer({ filename: database }),
          NodeServices.layer,
          Logger.layer([], { mergeWithExisting: false }),
        ]),
        Effect.scoped,
      ),
    );
    const db = new NodeSqlite.DatabaseSync(database);
    try {
      db.exec(
        "UPDATE orchestration_v2_projection_metadata SET schema_version=2,last_sequence=0 WHERE projection_name='thread-projections'",
      );
      for (const table of [
        "projection_projects",
        "orchestration_v2_projection_threads",
        "orchestration_v2_projection_messages",
      ]) {
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .filter((row) => row.pk || (row.notnull && row.dflt_value === null));
        for (let i = 0; i < home.messages; i++) {
          const values = columns.map((column) =>
            String(column.type).includes("INT")
              ? i
              : String(column.name).endsWith("json")
                ? JSON.stringify({ fixture: `retained message ${i}` })
                : `fixture-${i}`,
          );
          db.prepare(
            `INSERT INTO ${table} (${columns.map((column) => column.name).join(",")}) VALUES (${values.map(() => "?").join(",")})`,
          ).run(...values);
        }
      }
    } finally {
      db.close();
    }
  }
  const appDataDirectory = NodePath.join(root, "AppData", "Roaming");
  const localAppData = NodePath.join(root, "AppData", "Local");
  for (const profile of [
    NodePath.join(appDataDirectory, "t3code-v2"),
    NodePath.join(localAppData, "T3CodeLAN", "electron-profile"),
  ]) {
    NodeFS.mkdirSync(profile, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(profile, "Local State"),
      "opaque synthetic profile placeholder, no valid DPAPI key",
      { flag: "wx" },
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(localAppData, "T3CodeLAN", "data", "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        claudeFixture: {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: NodePath.join(root, "synthetic-claude-home") },
          environment: [],
        },
      },
    }),
    { flag: "wx" },
  );
  const report = {
    schemaVersion: 1,
    synthetic: true,
    genuineMigrationSchemas: true,
    usableCredentials: false,
    electronProfiles: "opaque-placeholders",
    userHomeDirectory: root,
    localAppData,
    appDataDirectory,
    homes,
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "synthetic-fixture.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--root" || !args[1])
      throw new Error("Usage: native-home-repair-fixture --root ABSOLUTE_NEW_OR_EMPTY_DIRECTORY");
    process.stdout.write(JSON.stringify(await createHomeRepairFixture(args[1])) + "\n");
  } catch {
    process.stderr.write("synthetic_home_repair_fixture_refused\n");
    process.exitCode = 1;
  }
}
