// @effect-diagnostics nodeBuiltinImport:off -- Explicit Windows-only package smoke test uses generated homes, profiles, and real kernel sharing handles.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import { runMigrations } from "../../apps/server/src/persistence/Migrations.ts";

const script = String.raw`
param([string]$NodeExe, [string]$Helper, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$env:USERPROFILE = $FixtureRoot
$env:LOCALAPPDATA = Join-Path $FixtureRoot 'AppData\Local'
$env:APPDATA = Join-Path $FixtureRoot 'AppData\Roaming'
function Invoke-Repair([string]$Operation, [string]$Request) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $NodeExe
  $start.Arguments = '--no-warnings "' + $Helper + '" ' + $Operation + ' --json'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [Diagnostics.Process]::Start($start)
  $outTask = $child.StandardOutput.ReadToEndAsync()
  $errTask = $child.StandardError.ReadToEndAsync()
  if ($Request) { $child.StandardInput.Write($Request) }
  $child.StandardInput.Close()
  $child.WaitForExit()
  $result = @{ exitCode=$child.ExitCode; output=$outTask.Result; error=$errTask.Result }
  $child.Dispose()
  return $result
}
$previewRun = Invoke-Repair 'preview' ''
if ($previewRun.exitCode -ne 0) { throw 'Fixture preview failed' }
$preview = $previewRun.output | ConvertFrom-Json
if ($preview.original.homeDirectory -ne (Join-Path $FixtureRoot '.t3')) { throw 'Fixture home override was not honored; refusing any Apply' }
$choice = if ($preview.state -eq 'lan-only') { 'side-by-side-retain-original' } else { 'adopt-original-retain-lan' }
$expectedHome = if ($preview.state -eq 'lan-only') { $preview.lan.homeDirectory } else { $preview.original.homeDirectory }
$request = @{ schemaVersion=1; expectedPlanId=$preview.planId; choice=$choice; opaqueBackupApproved=$true; repairId=('b' * 32) } | ConvertTo-Json -Compress
$denied = Invoke-Repair 'apply' $request
if ($denied.exitCode -eq 0) { throw 'Apply incorrectly accepted missing admission' }
$held = [Collections.Generic.List[IDisposable]]::new()
try {
  foreach ($fixtureHome in @($preview.original,$preview.lan)) {
    if ($fixtureHome.state -ne 'initialized') { continue }
    $fixtureHome = $fixtureHome.homeDirectory
    foreach ($relative in @('native-admission.lock','userdata\server-owner.sqlite')) {
      $held.Add([IO.File]::Open((Join-Path $fixtureHome $relative),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None))
    }
  }
  foreach ($profile in $preview.electronProfiles) {
    if ($profile.localState.present) {
      $held.Add([IO.File]::Open((Join-Path $profile.profileDirectory 'Local State'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
    }
  }
  $applied = Invoke-Repair 'apply' $request
  if ($applied.exitCode -ne 0) { throw ('Held fixture Apply failed: ' + $applied.error) }
  $result = $applied.output | ConvertFrom-Json
  if ($result.status -ne 'selected-pending-verification' -or $result.homeDirectory -ne $expectedHome -or $result.restoredHistoryVerified) { throw 'Apply receipt contract mismatch' }
  $rollback = Invoke-Repair 'rollback' (@{schemaVersion=1;repairId=('b' * 32)} | ConvertTo-Json -Compress)
  if ($rollback.exitCode -ne 0 -or ($rollback.output | ConvertFrom-Json).status -ne 'rolled-back') { throw ('Fixture rollback failed: ' + $rollback.error) }
  @{schemaVersion=1;status='fixture-apply-and-rollback-passed';missingAdmissionRefused=$true;environmentId=$result.environmentId;restoredHistoryVerified=$false} | ConvertTo-Json -Compress
} finally {
  foreach ($handle in $held) { $handle.Dispose() }
}
`;

const helper = process.argv[2];
const fixtureMode = process.argv[3] ?? "split";
if (!["split", "lan-only"].includes(fixtureMode)) throw new Error("Unknown synthetic smoke mode.");
if (!helper || !NodePath.isAbsolute(helper))
  throw new Error("Supply the absolute staged native-home-repair.mjs path.");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-repair-windows-smoke-"));
try {
  for (const [home, count, id, migration] of [
    [NodePath.join(root, ".t3"), 1, "11111111-1111-4111-8111-111111111111", 67],
    [
      NodePath.join(root, "AppData", "Local", "T3CodeLAN", "data"),
      2,
      "22222222-2222-4222-8222-222222222222",
      71,
    ],
  ] as const) {
    NodeFS.mkdirSync(NodePath.join(home, "userdata", "attachments"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, "userdata", "environment-id"), id + "\n");
    NodeFS.writeFileSync(NodePath.join(home, "native-admission.lock"), "fixture coordinator");
    NodeFS.writeFileSync(NodePath.join(home, "userdata", "server-owner.sqlite"), "fixture owner");
    NodeFS.writeFileSync(
      NodePath.join(home, "userdata", "attachments", "retained.txt"),
      "fixture attachment",
    );
    const database = NodePath.join(home, "userdata", "statev2.sqlite");
    await Effect.runPromise(
      runMigrations({ toMigrationInclusive: migration }).pipe(
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
        for (let i = 0; i < count; i++) {
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
  for (const profile of [
    NodePath.join(root, "AppData", "Roaming", "t3code-v2"),
    NodePath.join(root, "AppData", "Local", "T3CodeLAN", "electron-profile"),
  ]) {
    NodeFS.mkdirSync(profile, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(profile, "Local State"),
      "opaque fixture protection context",
    );
  }
  if (fixtureMode === "lan-only")
    NodeFS.renameSync(
      NodePath.join(root, ".t3"),
      NodePath.join(root, "fixture-unselected-original"),
    );
  const file = NodePath.join(root, "host.ps1");
  NodeFS.writeFileSync(file, script);
  const child = NodeChildProcess.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      file,
      "-NodeExe",
      process.execPath,
      "-Helper",
      helper,
      "-FixtureRoot",
      root,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1_048_576 },
  );
  NodeAssert.equal(child.status, 0, child.stderr || String(child.error));
  NodeAssert.match(child.stdout, /fixture-apply-and-rollback-passed/);
  for (const [home, messages, migration] of [
    [
      NodePath.join(root, fixtureMode === "lan-only" ? "fixture-unselected-original" : ".t3"),
      1,
      67,
    ],
    [NodePath.join(root, "AppData", "Local", "T3CodeLAN", "data"), 2, 71],
  ] as const) {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
      readOnly: true,
    });
    try {
      NodeAssert.equal(
        db.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_messages").get()!.n,
        messages,
      );
      NodeAssert.equal(
        db.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get()!.n,
        migration,
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(home, "userdata", "attachments", "retained.txt"), "utf8"),
        "fixture attachment",
      );
    } finally {
      db.close();
    }
  }
  process.stdout.write(child.stdout);
} finally {
  if (
    NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(root).startsWith("t3-repair-windows-smoke-")
  )
    // eslint-disable-next-line no-unsafe-finally -- Never delete an unchecked fixture path after an earlier failure.
    throw new Error("Refusing unsafe fixture cleanup.");
  NodeFS.rmSync(root, { recursive: true, force: true });
}
