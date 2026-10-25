// @effect-diagnostics nodeBuiltinImport:off -- Real Windows sharing handles and packaged CLI, exclusively generated synthetic homes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import { createCancellationFixture } from "./home-repair-cancel.fixture-builder.ts";
import { treeDigest } from "./home-repair-executor.ts";
import { previewHomeRepair, supportedMigrationIds } from "./home-repair.ts";
import { inspectStoppedRepairWork } from "../../apps/server/src/lan/NativeMaintenance.ts";

const script = String.raw`
param([string]$NodeExe,[string]$Helper,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$env:USERPROFILE=$FixtureRoot
$env:LOCALAPPDATA=Join-Path $FixtureRoot 'AppData\Local'
$env:APPDATA=Join-Path $FixtureRoot 'AppData\Roaming'
function Invoke-Repair([string]$Operation,[object]$Request){
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$NodeExe
  $start.Arguments='--no-warnings "'+$Helper+'" '+$Operation+' --json'
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($name in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','NODE_OPTIONS','NODE_PATH')){$start.EnvironmentVariables.Remove($name)}
  $child=[Diagnostics.Process]::Start($start);$childId=$child.Id
  $out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync()
  if($null-ne$Request){$child.StandardInput.Write(($Request|ConvertTo-Json -Depth 20 -Compress))};$child.StandardInput.Close()
  $child.WaitForExit();if(-not$child.HasExited){throw 'Child has not exited'}
  $result=@{exitCode=$child.ExitCode;output=$out.Result;error=$err.Result;childId=$childId;ownerPid=$PID}
  $child.Dispose();return $result
}
function Expect-Ok([string]$Operation,[object]$Request){$run=Invoke-Repair $Operation $Request;if($run.exitCode-ne0){throw ('Synthetic '+$Operation+' refused: '+$run.error)};return ($run.output|ConvertFrom-Json)}
$initial=Expect-Ok 'preview' $null
if($initial.original.homeDirectory-ne(Join-Path $FixtureRoot '.t3')){throw 'Wrong synthetic original; no mutation permitted'}
if(-not$initial.canCancelOriginalWork-or$initial.canApply){throw 'Initial busy preview capability mismatch'}
$cancelId='b'*32;$applyId='c'*32
$request=@{schemaVersion=1;expectedPlanId=$initial.planId;repairId=$cancelId;cancelUnfinishedWorkApproved=$true;opaqueBackupApproved=$true;admissionOwnerPid=$PID}
if((Invoke-Repair 'cancel-original-work' $request).exitCode-eq0){throw 'Cancellation accepted without held admission'}
$handles=[Collections.Generic.List[IDisposable]]::new();$locked=[Collections.Generic.List[string]]::new()
try{
  $installation=Join-Path $env:LOCALAPPDATA 'T3CodeLAN\synthetic-installation.lock';[IO.File]::WriteAllText($installation,'synthetic installation owner')
  $handles.Add([IO.File]::Open($installation,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None));$locked.Add($installation)
  foreach($fixtureHome in @($initial.original,$initial.lan)){
    if($fixtureHome.state-ne'initialized'){continue}
    foreach($relative in @('native-admission.lock','userdata\server-owner.sqlite')){$path=Join-Path $fixtureHome.homeDirectory $relative;$handles.Add([IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None));$locked.Add($path)}
  }
  foreach($profile in $initial.electronProfiles){if($profile.localState.present){$path=Join-Path $profile.profileDirectory 'Local State';$handles.Add([IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read));$locked.Add($path)}}
  function NodeAssert-Held{
    foreach($path in $locked){$opened=$null;try{$opened=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)}catch [IO.IOException] {};if($null-ne$opened){$opened.Dispose();throw 'Owner released a required sharing handle'}}
  }
  NodeAssert-Held
  $wrong=@{};foreach($key in $request.Keys){$wrong[$key]=$request[$key]};$wrong.admissionOwnerPid=$PID+999
  if((Invoke-Repair 'cancel-original-work' $wrong).exitCode-eq0){throw 'Wrong owning parent was accepted'}
  $cancelled=Expect-Ok 'cancel-original-work' $request
  if($cancelled.status-ne'unfinished-work-cancelled'-or$cancelled.summary.providerLaunches-ne0){throw 'Cancellation result mismatch'}
  NodeAssert-Held
  $fresh=Expect-Ok 'preview' $null
  if($cancelled.expectedPlanId-ne$fresh.planId){throw 'Native post-cancellation plan differs from fresh preview'}
  if(-not$fresh.canApply-or$fresh.original.activeWork-ne0-or$fresh.original.counts.messages-ne16-or$fresh.lan.counts.messages-ne2){throw 'Fresh preview lost history or did not become idle'}
  $apply=@{schemaVersion=1;expectedPlanId=$fresh.planId;repairId=$applyId;choice='adopt-original-retain-lan';opaqueBackupApproved=$true}
  $applied=Expect-Ok 'apply' $apply
  NodeAssert-Held
  if($applied.status-ne'selected-pending-verification'-or$applied.environmentId-ne'11111111-1111-4111-8111-111111111111'){throw 'Ordinary Apply did not preserve original identity'}
  $rolledSelection=Expect-Ok 'rollback' @{schemaVersion=1;repairId=$applyId}
  NodeAssert-Held
  $rolledWork=Expect-Ok 'rollback-work-cancellation' @{schemaVersion=1;repairId=$cancelId;admissionOwnerPid=$PID}
  NodeAssert-Held
  $restored=Expect-Ok 'preview' $null
  if($restored.original.activeWork-ne17){throw 'Cancellation rollback did not restore original unfinished intent'}
  @{schemaVersion=1;status='real-windows-cancellation-apply-and-rollbacks-passed';ownerPid=$PID;exclusiveHandles=5;profileHandles=2;distinctRepairIds=$true;nativePreviewTokenMatched=$true;missingAdmissionRefused=$true;wrongParentRefused=$true;heldThroughAllChildren=$true;summary=$cancelled.summary}|ConvertTo-Json -Depth 12 -Compress
}finally{foreach($handle in $handles){$handle.Dispose()}}
`;
const helper = process.argv[2],
  node = process.argv[3];
if (!helper || !node || !NodePath.isAbsolute(helper) || !NodePath.isAbsolute(node))
  throw new Error("Supply absolute candidate helper and Node24 executable paths.");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cancel-windows-"));
try {
  const report = await createCancellationFixture(root);
  const options = {
    userHomeDirectory: root,
    localAppData: report.localAppData,
    appDataDirectory: report.appDataDirectory,
    supportedMigrationIds,
  };
  previewHomeRepair(options);
  inspectStoppedRepairWork(NodePath.join(root, ".t3", "userdata", "statev2.sqlite"));
  inspectStoppedRepairWork(
    NodePath.join(report.localAppData, "T3CodeLAN", "data", "userdata", "statev2.sqlite"),
  );
  const originalBefore = treeDigest(NodePath.join(root, ".t3")),
    lanBefore = treeDigest(NodePath.join(report.localAppData, "T3CodeLAN", "data"));
  const file = NodePath.join(root, "run-held-cancellation.ps1");
  NodeFS.writeFileSync(file, script);
  const child = NodeChildProcess.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-File", file, "-NodeExe", node, "-Helper", helper, "-FixtureRoot", root],
    { encoding: "utf8", windowsHide: true, maxBuffer: 262144 },
  );
  if (child.status !== 0)
    throw new Error(`Synthetic Windows fixture failed: ${child.stderr || child.stdout}`);
  const output = JSON.parse(child.stdout.trim());
  NodeAssert.equal(output.status, "real-windows-cancellation-apply-and-rollbacks-passed");
  NodeAssert.equal(treeDigest(NodePath.join(root, ".t3")).sha256, originalBefore.sha256);
  NodeAssert.equal(
    treeDigest(NodePath.join(report.localAppData, "T3CodeLAN", "data")).sha256,
    lanBefore.sha256,
  );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(root, ".t3", "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    NodeAssert.equal(
      db.prepare("SELECT MAX(migration_id) n FROM effect_sql_migrations").get()!.n,
      67,
    );
  } finally {
    db.close();
  }
  process.stdout.write(
    JSON.stringify({
      ...output,
      originalRestoredByteForByte: true,
      lanUnchanged: true,
      originalSchemaRestored: 67,
    }) + "\n",
  );
} finally {
  if (
    NodePath.dirname(root) !== NodeOS.tmpdir() ||
    !NodePath.basename(root).startsWith("t3-cancel-windows-")
  )
    throw new Error("Unsafe fixture cleanup");
  NodeFS.rmSync(root, { recursive: true, force: true });
}
