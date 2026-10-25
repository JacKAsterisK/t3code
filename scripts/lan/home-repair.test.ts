// @effect-diagnostics nodeBuiltinImport:off -- Synthetic per-user homes and read-only SQLite metadata; no installed state or provider is used.
import * as NodeTest from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { previewHomeRepair, homeRepairMain, supportedMigrationIds } from "./home-repair.ts";

import {
  resolveNativeHomeSelection,
  assertNativeHomeMatchesSelection,
} from "../../packages/shared/src/nativeHomeSelection.ts";

const oldId = "32e921e2-dd27-488d-a7d5-bb7f27b33674";
const newId = "92bf1499-4a9f-48b7-9796-5440ef9d499a";

function removeFixture(root: string) {
  if (
    NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(root).startsWith("t3-home-repair-fixture-")
  )
    throw new Error("Unsafe fixture cleanup target.");
  NodeFS.rmSync(root, { recursive: true, force: true });
}

function fixture(
  run: (input: {
    root: string;
    original: string;
    lan: string;
    options: Parameters<typeof previewHomeRepair>[0];
  }) => void,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-home-repair-fixture-"));
  try {
    const options = {
      userHomeDirectory: root,
      localAppData: NodePath.join(root, "AppData", "Local"),
      appDataDirectory: NodePath.join(root, "AppData", "Roaming"),
      supportedMigrationIds,
    };
    run({
      root,
      original: NodePath.join(root, ".t3"),
      lan: NodePath.join(options.localAppData, "T3CodeLAN", "data"),
      options,
    });
  } finally {
    removeFixture(root);
  }
}

function home(directory: string, identity: string, migrations: number, messages: number) {
  NodeFS.mkdirSync(NodePath.join(directory, "userdata", "attachments"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "userdata", "environment-id"), identity + "\n");
  const database = NodePath.join(directory, "userdata", "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(database);
  db.exec(
    "CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY); CREATE TABLE orchestration_v2_projection_threads(id TEXT); CREATE TABLE orchestration_v2_projection_messages(id INTEGER, text TEXT); CREATE TABLE orchestration_v2_projection_runs(status TEXT); CREATE TABLE orchestration_v2_effect_outbox(status TEXT);",
  );
  for (let n = 1; n <= migrations; n++)
    db.prepare("INSERT INTO effect_sql_migrations VALUES(?)").run(n);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?)").run("fixture-thread");
  for (let n = 0; n < messages; n++)
    db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES(?,?)").run(
      n,
      `private message ${n}`,
    );
  db.close();
  NodeFS.writeFileSync(
    NodePath.join(directory, "userdata", "attachments", "fixture.txt"),
    "attachment bytes retained",
  );
  return database;
}

const hash = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

NodeTest.test("fresh install recommends the original home and preview creates nothing", () =>
  fixture(({ root, options }) => {
    const before = NodeFS.readdirSync(root);
    const report = previewHomeRepair(options);
    NodeAssert.equal(report.state, "fresh");
    NodeAssert.equal(report.recommendedAction, "create-original");
    NodeAssert.equal(report.canApply, false);
    NodeAssert.equal(report.applySupported, false);
    NodeAssert.deepEqual(NodeFS.readdirSync(root), before);
  }),
);

NodeTest.test(
  "original-only history is counted without changing messages, attachments, or identity",
  () =>
    fixture(({ original, options }) => {
      const dbPath = home(original, oldId, 67, 4);
      const before = hash(dbPath);
      const report = previewHomeRepair(options);
      NodeAssert.equal(report.state, "original-only");
      NodeAssert.equal(report.original.environmentId, oldId);
      NodeAssert.equal(report.original.counts.messages, 4);
      NodeAssert.equal(report.original.migrationIds.at(-1), 67);
      NodeAssert.equal(hash(dbPath), before);
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      NodeAssert.equal(
        db.prepare("SELECT text FROM orchestration_v2_projection_messages WHERE id=3").get()!.text,
        "private message 3",
      );
      db.close();
      NodeAssert.equal(
        NodeFS.readFileSync(
          NodePath.join(original, "userdata", "attachments", "fixture.txt"),
          "utf8",
        ),
        "attachment bytes retained",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(original, "userdata", "environment-id"), "utf8").trim(),
        oldId,
      );
      NodeAssert.ok(!JSON.stringify(report).includes("private message"));
    }),
);

NodeTest.test(
  "split homes retain both histories and summarize new providers without secret values",
  () =>
    fixture(({ original, lan, options }) => {
      const oldDb = home(original, oldId, 67, 10);
      const lanDb = home(lan, newId, 71, 2);
      const secret = "FAKE_SECRET_MUST_NOT_APPEAR";
      NodeFS.mkdirSync(NodePath.join(original, "userdata", "secrets"));
      NodeFS.writeFileSync(NodePath.join(original, "userdata", "secrets", "opaque"), secret);
      NodeFS.writeFileSync(
        NodePath.join(lan, "userdata", "settings.json"),
        JSON.stringify({
          providerInstances: {
            claude_second: {
              driver: "claudeAgent",
              config: { homePath: "private-account-directory" },
              environment: [{ name: "ANTHROPIC_API_KEY", value: secret, sensitive: true }],
            },
          },
        }),
      );
      const profile = NodePath.join(options.appDataDirectory, "t3code-v2");
      NodeFS.mkdirSync(profile, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(profile, "Local State"), secret);
      const before = [hash(oldDb), hash(lanDb), hash(NodePath.join(profile, "Local State"))];
      const report = previewHomeRepair(options);
      NodeAssert.equal(report.state, "split");
      NodeAssert.equal(report.recommendedAction, "adopt-original-retain-lan");
      NodeAssert.equal(report.original.counts.messages, 10);
      NodeAssert.equal(report.lan.counts.messages, 2);
      NodeAssert.deepEqual(report.lan.providerInstances[0]!.environmentNames, [
        "ANTHROPIC_API_KEY",
      ]);
      NodeAssert.ok(report.conflicts.includes("lan-only-history-or-settings"));
      NodeAssert.deepEqual(
        [hash(oldDb), hash(lanDb), hash(NodePath.join(profile, "Local State"))],
        before,
      );
      NodeAssert.ok(
        report.preservePaths.includes(original) &&
          report.preservePaths.includes(lan) &&
          report.preservePaths.includes(profile),
      );
      NodeAssert.ok(!JSON.stringify(report).includes(secret));
      NodeAssert.ok(!JSON.stringify(report).includes("private-account-directory"));
    }),
);

NodeTest.test("a newer schema fails closed instead of suggesting downgrade", () =>
  fixture(({ original, options }) => {
    const dbPath = home(original, oldId, Math.max(...supportedMigrationIds) + 1, 1);
    const before = hash(dbPath);
    const report = previewHomeRepair(options);
    NodeAssert.equal(report.state, "blocked");
    NodeAssert.ok(report.blockers.includes("original:unsupported-schema"));
    NodeAssert.equal(hash(dbPath), before);
  }),
);

NodeTest.test("missing identity, malformed settings, and overlapping roots fail closed", () =>
  fixture(({ root, original, lan, options }) => {
    home(original, oldId, 67, 1);
    NodeFS.unlinkSync(NodePath.join(original, "userdata", "environment-id"));
    NodeAssert.ok(previewHomeRepair(options).blockers.includes("original:incomplete-home"));
    home(lan, newId, 71, 1);
    NodeFS.writeFileSync(NodePath.join(lan, "userdata", "settings.json"), "{bad settings");
    NodeAssert.ok(previewHomeRepair(options).blockers.includes("lan:invalid-settings"));
    NodeAssert.ok(
      previewHomeRepair({ ...options, originalHomeDirectory: root }).blockers.includes(
        "overlapping-homes",
      ),
    );
  }),
);

NodeTest.test("LAN-only state is preserved rather than replaced by an empty original home", () =>
  fixture(({ lan, options }) => {
    home(lan, newId, 71, 2);
    const report = previewHomeRepair(options);
    NodeAssert.equal(report.state, "lan-only");
    NodeAssert.equal(report.recommendedAction, "retain-lan");
    NodeAssert.equal(report.original.state, "missing");
  }),
);

NodeTest.test("foreign content in a noninitialized home is not treated as an empty install", () =>
  fixture(({ original, options }) => {
    NodeFS.mkdirSync(original);
    NodeFS.writeFileSync(NodePath.join(original, "preserve-me"), "existing state");
    NodeAssert.ok(
      previewHomeRepair(options).blockers.includes("original:unrecognized-home-content"),
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(original, "preserve-me"), "utf8"),
      "existing state",
    );
  }),
);

NodeTest.test("active or pending work is reported and never stopped", () =>
  fixture(({ original, options }) => {
    const dbPath = home(original, oldId, 67, 1);
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec(
      "INSERT INTO orchestration_v2_projection_runs VALUES('running'); INSERT INTO orchestration_v2_effect_outbox VALUES('pending');",
    );
    db.close();
    const before = hash(dbPath);
    NodeAssert.equal(previewHomeRepair(options).original.activeWork, 2);
    NodeAssert.equal(hash(dbPath), before);
  }),
);

NodeTest.test("redirected directories are refused", () =>
  fixture(({ root, original, options }) => {
    const target = NodePath.join(root, "redirected");
    NodeFS.mkdirSync(target);
    NodeFS.symlinkSync(target, original, "junction");
    NodeAssert.ok(previewHomeRepair(options).blockers.includes("original:unsafe-path"));
  }),
);

NodeTest.test("preview CLI refuses apply and unknown options", () => {
  NodeAssert.throws(() => homeRepairMain(["apply", "--json"]));
  NodeAssert.throws(() => homeRepairMain(["preview", "--json", "--overwrite"]));
  NodeAssert.throws(() => homeRepairMain(["preview", "--json", "--original-home"]));
});

NodeTest.test("preview schema allowance follows the current migration manifest", () => {
  const text = NodeFS.readFileSync(
    new URL("../../apps/server/src/persistence/Migrations.ts", import.meta.url),
    "utf8",
  );
  const ids = [...text.matchAll(/\[(\d+),\s*"[^"]+",\s*Migration\d+\]/g)].map((match) =>
    Number(match[1]),
  );
  NodeAssert.deepEqual(supportedMigrationIds, ids);
});

NodeTest.test("transient SQLite shared-memory metadata does not invalidate the reviewed plan", () =>
  fixture(({ original, options }) => {
    home(original, oldId, 67, 1);
    const before = previewHomeRepair(options);
    NodeFS.writeFileSync(
      NodePath.join(original, "userdata", "statev2.sqlite-shm"),
      "transient read marks",
    );
    const after = previewHomeRepair(options);
    NodeAssert.equal(after.planId, before.planId);
    NodeAssert.equal(after.original.files["userdata/statev2.sqlite-shm"]!.present, true);
  }),
);

NodeTest.test("a fresh drop-in home can finish initialization under admission", () =>
  fixture(({ original, options }) => {
    NodeAssert.equal(resolveNativeHomeSelection(options).homeDirectory, original);
    NodeFS.mkdirSync(NodePath.join(original, "userdata", "logs"), { recursive: true });
    NodeAssert.doesNotThrow(() => assertNativeHomeMatchesSelection(original, options));
  }),
);

NodeTest.test("an incomplete repair is reported and blocks a new Apply preview", () =>
  fixture(({ options }) => {
    const parent = NodePath.join(options.localAppData, "T3CodeLAN");
    NodeFS.mkdirSync(parent, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(parent, "home-repair.json"),
      "public transaction metadata fixture",
    );
    const report = previewHomeRepair(options);
    NodeAssert.equal(report.state, "blocked");
    NodeAssert.ok(report.blockers.includes("incomplete-home-repair"));
  }),
);
