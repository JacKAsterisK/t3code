// @effect-diagnostics nodeBuiltinImport:off -- Generated Windows-only fixtures exercise the packaged helper under real parent-owned admission handles.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as HostProcess from "../../packages/shared/src/HostProcess.ts";
import { createHistoryImportFixture } from "./home-repair-history.fixture-builder.ts";
import { treeDigest } from "./home-repair-executor.ts";
import { inspectNativeUpdateWork } from "../../apps/server/src/lan/NativeMaintenance.ts";

const powerShell = String.raw`
param([string]$HelperExe,[string]$Helper,[string]$FixtureRoot,[string]$SourceNode)
$ErrorActionPreference='Stop'
$env:USERPROFILE=$FixtureRoot
$env:LOCALAPPDATA=Join-Path $FixtureRoot 'AppData\Local'
$env:APPDATA=Join-Path $FixtureRoot 'AppData\Roaming'
function Invoke-Fixture([string]$Exe,[string]$Arguments,[string]$InputText,[bool]$Electron) {
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$Exe
  $start.Arguments=$Arguments
  $start.WorkingDirectory=$FixtureRoot
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  $start.EnvironmentVariables.Clear()
  foreach($name in @('SystemRoot','WINDIR')) {
    $value=[Environment]::GetEnvironmentVariable($name)
    if($value) {$start.EnvironmentVariables[$name]=$value}
  }
  $start.EnvironmentVariables['TEMP']=$FixtureRoot
  $start.EnvironmentVariables['TMP']=$FixtureRoot
  $start.EnvironmentVariables['USERPROFILE']=$FixtureRoot
  $start.EnvironmentVariables['LOCALAPPDATA']=$env:LOCALAPPDATA
  $start.EnvironmentVariables['APPDATA']=$env:APPDATA
  if($Electron) {$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'}
  $child=[Diagnostics.Process]::Start($start)
  $stdout=$child.StandardOutput.ReadToEndAsync()
  $stderr=$child.StandardError.ReadToEndAsync()
  if($InputText) {$child.StandardInput.Write($InputText)}
  $child.StandardInput.Close()
  $child.WaitForExit()
  $result=@{exitCode=$child.ExitCode;output=$stdout.Result;error=$stderr.Result}
  $child.Dispose()
  return $result
}
function Invoke-Repair([string]$Operation,[object]$Request) {
  $inputText=if($null -eq $Request) {''} else {$Request | ConvertTo-Json -Depth 30 -Compress}
  return Invoke-Fixture $HelperExe ('--no-warnings "'+$Helper+'" '+$Operation+' --json') $inputText $true
}
function Require-Success([object]$Run,[string]$Label) {
  if($Run.exitCode -ne 0) {throw ($Label+': '+$Run.error)}
  return $Run.output | ConvertFrom-Json
}
$initial=Require-Success (Invoke-Repair 'preview' $null) 'preview'
if($initial.original.homeDirectory -ne (Join-Path $FixtureRoot '.t3') -or
   $initial.lan.homeDirectory -ne (Join-Path $env:LOCALAPPDATA 'T3CodeLAN\data')) {
  throw 'Synthetic home override not honored; refusing import'
}
if(-not $initial.importRetainedLanHistorySupported -or -not $initial.canImportRetainedLanHistory -or
   $initial.historyImportPreview.summary.newThreads -ne 2) {throw ('Import preview unavailable: '+($initial.historyImportBlockers | ConvertTo-Json -Compress))}
$native=[IO.File]::ReadAllText((Join-Path $FixtureRoot 'native-before.json')) | ConvertFrom-Json
$request=@{
  schemaVersion=1; repairId=('b'*32); expectedPlanId=$initial.planId;
  expectedReviewGeneration=$initial.historyImportPreview.reviewGeneration;
  expectedSourceEnvironmentId=$initial.historyImportPreview.sourceEnvironmentId;
  expectedTargetEnvironmentId=$initial.historyImportPreview.targetEnvironmentId;
  expectedSourceDataGeneration=$native.source.dataGeneration;
  expectedSourceWorkGeneration=$native.source.workGeneration;
  expectedTargetDataGeneration=$native.target.dataGeneration;
  expectedTargetWorkGeneration=$native.target.workGeneration;
  opaqueBackupApproved=$true; admissionOwnerPid=$PID
}
$denied=Invoke-Repair 'import-retained-lan-history' $request
if($denied.exitCode -eq 0) {throw 'Import accepted without held admission'}
$held=[Collections.Generic.List[IDisposable]]::new()
try {
  foreach($fixtureHome in @($initial.original.homeDirectory,$initial.lan.homeDirectory)) {
    foreach($relative in @('native-admission.lock','userdata\server-owner.sqlite')) {
      $held.Add([IO.File]::Open((Join-Path $fixtureHome $relative),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None))
    }
  }
  foreach($profile in $initial.electronProfiles) {
    if($profile.localState.present) {
      $held.Add([IO.File]::Open((Join-Path $profile.profileDirectory 'Local State'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
    }
  }
  $fresh=Require-Success (Invoke-Repair 'preview' $null) 'held preview'
  $request.expectedPlanId=$fresh.planId
  $request.expectedReviewGeneration=$fresh.historyImportPreview.reviewGeneration
  $appliedRun=Invoke-Repair 'import-retained-lan-history' $request
  $applied=Require-Success $appliedRun 'held import'
  if($applied.operation -ne 'import-retained-lan-history' -or $applied.status -ne 'imported-pending-verification' -or
     -not $applied.existingWorkPreserved -or -not $applied.eventPrefixPreserved -or -not $applied.sourcePreserved) {
    throw 'Import reply contract mismatch'
  }
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'import-result.json'),$appliedRun.output,[Text.UTF8Encoding]::new($false))
  $check=Invoke-Fixture $SourceNode ('--no-warnings "'+(Join-Path $FixtureRoot 'check-import.mjs')+'" "'+$FixtureRoot+'"') '' $false
  $checked=Require-Success $check 'independent imported-data verification'
  if(-not $checked.richHistoryPreserved -or -not $checked.attachmentsPreserved -or
     -not $checked.targetEventPrefixPreserved -or -not $checked.targetWorkPreserved) {throw 'Imported-data verification failed'}
  $recovery=@{schemaVersion=1;repairId=$request.repairId;expectedReviewGeneration=$request.expectedReviewGeneration;
    expectedSourceEnvironmentId=$request.expectedSourceEnvironmentId;expectedTargetEnvironmentId=$request.expectedTargetEnvironmentId;
    admissionOwnerPid=$PID;recoveryOperation='recover'}
  $ordinary=Invoke-Repair 'rollback' @{schemaVersion=1;repairId=$request.repairId}
  if($ordinary.exitCode -eq 0) {throw 'Ordinary recovery accepted a history-import receipt'}
  $repeat1=Require-Success (Invoke-Repair 'recover-import-retained-lan-history' $recovery) 'repeat recovery'
  $repeat2=Require-Success (Invoke-Repair 'recover-import-retained-lan-history' $recovery) 'repeat recovery twice'
  if(($repeat1 | ConvertTo-Json -Depth 30 -Compress) -ne ($repeat2 | ConvertTo-Json -Depth 30 -Compress)) {throw 'Recovery was not idempotent'}
  $repeatPreview=Require-Success (Invoke-Repair 'preview' $null) 'idempotent history preview'
  $summary=$repeatPreview.historyImportPreview.summary
  if($summary.newThreads -ne 0 -or $summary.alreadyImportedThreads -ne 2 -or $summary.importMessages -ne 0 -or
     $summary.importCards -ne 0 -or $summary.attachments -ne 0) {throw 'Repeated history preview proposed duplicate content'}
  $settings=Join-Path $initial.original.homeDirectory 'userdata\settings.json'
  $settingsBefore=[IO.File]::ReadAllBytes($settings)
  try {
    [IO.File]::AppendAllText($settings,([Environment]::NewLine+'changed synthetic user state'),[Text.UTF8Encoding]::new($false))
    $recovery.recoveryOperation='rollback'
    $changed=Invoke-Repair 'recover-import-retained-lan-history' $recovery
    if($changed.exitCode -eq 0) {throw 'Rollback accepted changed target user state'}
  } finally {[IO.File]::WriteAllBytes($settings,$settingsBefore)}
  $rolledBack=Require-Success (Invoke-Repair 'recover-import-retained-lan-history' $recovery) 'exact rollback'
  if($rolledBack.status -ne 'rolled-back' -or $rolledBack.targetDataGenerationAfter -ne $native.target.dataGeneration -or
     $rolledBack.targetWorkGenerationAfter -ne $native.target.workGeneration) {throw 'Rollback did not preserve pre-import target generations'}
  @{passed=$true;missingAdmissionRefused=$true;distinctRecovery=$true;changedStateRollbackRefused=$true;
    idempotent=$true;richHistoryPreserved=$checked.richHistoryPreserved;attachmentsPreserved=$checked.attachmentsPreserved;
    targetEventPrefixPreserved=$checked.targetEventPrefixPreserved;targetWorkPreserved=$checked.targetWorkPreserved} | ConvertTo-Json -Compress
} finally {foreach($handle in $held) {$handle.Dispose()}}
`;

const checker = String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqlite from 'node:sqlite';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
const root=process.argv[2], target=path.join(root,'.t3');
const before=JSON.parse(fs.readFileSync(path.join(root,'existing-before.json'),'utf8'));
const result=JSON.parse(fs.readFileSync(path.join(root,'import-result.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'AppData','Local','T3CodeLAN','recovery','b'.repeat(32),'history-import-manifest.json'),'utf8'));
const db=new sqlite.DatabaseSync(path.join(target,'userdata','statev2.sqlite'),{readOnly:true});
try {
  const plain=(value)=>JSON.parse(JSON.stringify(value));
  const rows=(table)=>plain(db.prepare('SELECT * FROM '+table).all());
  for(const [table,expected] of Object.entries(before.work)) assert.deepEqual(rows(table),expected);
  assert.deepEqual(plain(db.prepare('SELECT * FROM orchestration_events WHERE sequence<=? ORDER BY sequence').all(before.eventHead)),before.events);
  const payloads=(table)=>rows(table).map(row=>JSON.parse(row.payload_json));
  const threads=payloads('orchestration_v2_projection_threads');
  assert.equal(threads.length,3);
  assert.equal(threads.find(t=>t.id==='parent').title,'Existing target thread');
  const parent=threads.find(t=>t.title==='Retained parent'), child=threads.find(t=>t.title==='Retained child');
  assert.ok(parent && child && parent.id!=='parent');
  assert.equal(child.lineage.parentThreadId,parent.id);
  assert.equal(child.forkedFrom,null);
  assert.equal(child.settledOverride,'settled');
  const cards=payloads('orchestration_v2_projection_turn_items');
  const own=cards.filter(c=>c.threadId===parent.id).sort((a,b)=>a.ordinal-b.ordinal);
  assert.ok(own.some(c=>c.type==='reasoning' && c.text==='Full reasoning'));
  assert.ok(own.some(c=>c.type==='command_execution' && c.output==='Complete stored output'));
  assert.ok(own.some(c=>c.type==='dynamic_tool' && c.output.result==='Full tool result'));
  for(const kind of ['proposed_plan','todo_list','file_change']) assert.ok(own.some(c=>c.type===kind));
  for(const text of ['kept-checkpoint.ts','Full original subagent prompt','Full original subagent result','Complete historical approval'])
    assert.ok(own.some(c=>c.type==='system_notice' && c.message.includes(text)),text);
  assert.ok(own.some(c=>c.type==='user_message' && c.text==='Message without a source card'));
  assert.ok(!cards.some(c=>c.threadId===child.id && c.text==='Visible fork prefix'));
  assert.ok(cards.every(c=>c.runId===null && c.providerThreadId===null && c.providerTurnId===null && c.nativeItemRef===null));
  assert.ok(manifest.attachmentManifest.length>=2);
  for(const entry of manifest.attachmentManifest) {
    assert.match(entry.targetRelativePath,/^userdata\/attachments\/[a-z0-9_-]+\.[a-z0-9]+$/i);
    const bytes=fs.readFileSync(path.join(target,entry.targetRelativePath));
    assert.equal(bytes.length,entry.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
  }
  assert.ok(manifest.attachmentManifest.some(e=>e.targetRelativePath.endsWith('.html')));
  assert.equal(result.proof.targetEventHeadBefore,before.eventHead);
  for(const key of ['eventPrefixGeneration','existingRowsGeneration','existingWorkGeneration'])
    assert.equal(result.proof[key+'Before'],result.proof[key+'After']);
  console.log(JSON.stringify({targetWorkPreserved:true,targetEventPrefixPreserved:true,richHistoryPreserved:true,attachmentsPreserved:true}));
} finally {db.close()}
`;

const helper = process.argv[2];
const helperExecutable = process.argv[3];
const powerShellExecutable = process.argv[4];
if (
  HostProcess.Platform.defaultValue() !== "win32" ||
  !helper ||
  !helperExecutable ||
  !powerShellExecutable ||
  ![helper, helperExecutable, powerShellExecutable].every(NodePath.isAbsolute)
)
  throw new Error(
    "Use Windows with absolute helper, packaged Electron and pinned PowerShell paths.",
  );
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-history-import-windows-"));
try {
  const fixture = await createHistoryImportFixture(root);
  const observe = (home: string) => {
    const work = inspectNativeUpdateWork(NodePath.join(home, "userdata", "statev2.sqlite"));
    const hash = NodeCrypto.createHash("sha256");
    for (const name of ["statev2.sqlite", "statev2.sqlite-wal"]) {
      const file = NodePath.join(home, "userdata", name);
      hash.update(name);
      if (name.endsWith("-wal") && (!NodeFS.existsSync(file) || NodeFS.statSync(file).size === 0))
        hash.update("absent");
      else hash.update(NodeFS.readFileSync(file));
    }
    return { dataGeneration: hash.digest("hex"), workGeneration: work.workGeneration };
  };
  const nativeBefore = { source: observe(fixture.source), target: observe(fixture.target) };
  const preservedPaths = [
    fixture.source,
    NodePath.join(fixture.appDataDirectory, "t3code-v2"),
    NodePath.join(fixture.localAppData, "T3CodeLAN", "electron-profile"),
  ];
  const preservedBefore = preservedPaths.map((directory) => treeDigest(directory).sha256);
  const selection = NodePath.join(fixture.localAppData, "T3CodeLAN", "home-selection.json");
  const selectionBefore = NodeFS.readFileSync(selection);
  const targetBefore = treeDigest(fixture.target).sha256;
  const db = new NodeSqlite.DatabaseSync(
    NodePath.join(fixture.target, "userdata", "statev2.sqlite"),
    { readOnly: true },
  );
  try {
    const work = Object.fromEntries(
      [
        "orchestration_v2_projection_runs",
        "orchestration_v2_projection_runtime_requests",
        "orchestration_v2_projection_provider_sessions",
        "orchestration_v2_projection_provider_threads",
        "orchestration_v2_projection_provider_turns",
        "orchestration_v2_projection_subagents",
        "orchestration_v2_projection_checkpoints",
        "orchestration_v2_effect_outbox",
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    );
    const events = db.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
    NodeFS.writeFileSync(
      NodePath.join(root, "existing-before.json"),
      JSON.stringify({ work, events, eventHead: events.at(-1)?.sequence ?? 0 }),
    );
  } finally {
    db.close();
  }
  NodeFS.writeFileSync(NodePath.join(root, "native-before.json"), JSON.stringify(nativeBefore));
  NodeFS.writeFileSync(NodePath.join(root, "check-import.mjs"), checker);
  const script = NodePath.join(root, "parent.ps1");
  NodeFS.writeFileSync(script, powerShell);
  const child = NodeChildProcess.spawnSync(
    powerShellExecutable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-HelperExe",
      helperExecutable,
      "-Helper",
      helper,
      "-FixtureRoot",
      root,
      "-SourceNode",
      process.execPath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  NodeAssert.equal(child.status, 0, child.stderr || String(child.error));
  const result = JSON.parse(child.stdout.trim());
  NodeAssert.equal(result.passed, true);
  NodeAssert.deepEqual(
    preservedPaths.map((directory) => treeDigest(directory).sha256),
    preservedBefore,
  );
  NodeAssert.deepEqual(NodeFS.readFileSync(selection), selectionBefore);
  NodeAssert.equal(treeDigest(fixture.target).sha256, targetBefore);
  NodeAssert.deepEqual(observe(fixture.target), nativeBefore.target);
  const receipt = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(fixture.localAppData, "T3CodeLAN", "recovery", "b".repeat(32), "receipt.json"),
      "utf8",
    ),
  );
  NodeAssert.equal(receipt.operation, "import-retained-lan-history");
  NodeAssert.equal(receipt.phase, "rolled-back");
  NodeAssert.equal(receipt.snapshots.length, 4);
  for (const snapshot of receipt.snapshots)
    NodeAssert.equal(treeDigest(snapshot.backup).sha256, snapshot.sha256);
  process.stdout.write(
    JSON.stringify({
      ...result,
      sourceBytesPreserved: true,
      opaqueBackupsPreserved: true,
      packagedRuntime: true,
    }) + "\n",
  );
} finally {
  if (
    NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(root).startsWith("t3-history-import-windows-")
  )
    // eslint-disable-next-line no-unsafe-finally -- Only this verified generated fixture root can be removed.
    throw new Error("Refusing unsafe fixture cleanup.");
  NodeFS.rmSync(root, { recursive: true, force: true });
}
