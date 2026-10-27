# Validating supplied Windows artifacts

Routine LAN delivery is a local AnvilToad build and one ZIP, followed by a copy of the ZIP, metadata and activation policy to `\\BuildMachine\BuildShare\T3CodeLAN` and the existing Portal publishing hook. Keep focused updater/data-preservation checks. Do not create GitHub releases, upload caches/artifacts to GitHub, use cloud runners, or require per-version Hub/Portal source-pin edits. T3 Actions is disabled; optional orchestration must use self-hosted machines. Full qualification is for changes that need it, not an ordinary release checklist.

[`validate-windows-artifact.ts`](../../scripts/lan/validate-windows-artifact.ts)
inspects existing local build inputs and portable ZIPs. It never provisions tools,
builds or executes the application, signs code, installs, publishes, changes a
channel, starts a provider or reads provider credentials. This checkout contains
source and policy definitions; approved toolchains, receipts and release ZIPs live
outside it. Running without arguments returns a failing readiness report.

```powershell
node scripts/lan/validate-windows-artifact.ts
node scripts/lan/validate-windows-artifact.ts --request C:\Approved\validation-request.json --approved-policy-sha256 <approved-policy-file-sha256>
```

The approved policy hash must come from separate owner review, rather than from
the artifact's download. The CLI does not treat possession of a hash as permission
to build, install or distribute. Validation writes only its JSON report to stdout.
The native signature helper compiles its small WinVerifyTrust adapter in memory;
it does not execute the inspected PE files. Use the repository's pinned toolchain
to run release validation; a successful test under another Node version is fixture
evidence only. The CLI hashes its own Node executable and compares its actual
version and binary hash to the approved Node pin before inspecting a build.

## Required local inputs

The request is schema 1 with absolute `policyPath`, `buildLockPath` and
`toolchainManifestPath`. Qualification uses two independent `runs`; a routine
release may use one candidate only after its reviewed qualification baseline,
source changes, actual build lock and toolchain inventory establish eligibility.
Each run has `sourceId`, `sourceRoot`, `buildRoot`, `artifactPath`,
`extractedRoot` and `toolchainRoot`. Provide clean source and build workspaces
with their existing artifacts and extracted files. The validator reads Git metadata without fetching
or changing either checkout. It requires the approved fork commit, upstream
ancestry, no dirty/untracked state, all required build input hashes and no
unaccounted submodules. It rejects symlinks, reparse traversal and hardlinked input
files rather than adopting or repairing a root.
Source Git inspection ignores ambient repository/index/config overrides,
disables replacement refs and refuses grafts when checking ancestry. This is
read-only provenance checking and does not change Git trust configuration.

`buildLockPath` uses the existing schema-1 `BuildLock`. Its Node/pnpm pins must
match package.json, and every named source file and six main tool binary hashes
must match actual bytes. The separate schema-1 toolchain manifest contains
`files: [{path,length,sha256}]`, relative to each supplied toolchain root. Its
approved SHA-256 and exact inventory bind the rest of the supplied compiler,
SDK/header/library, Rust/Cargo, Python, package-manager and packaging-tool closure.
Full inventory validation refuses extra or changed files and streams their
hashes without launching version commands. Routine candidate validation may
instead set the approved policy's `toolchainQualificationSha256` and each run's
`toolchainQualificationPath` to the frozen qualification from its native build.
The validator requires that exact existing receipt, manifest and physical root,
then verifies the six primary tool files without a full-tree scan. Missing or
changed evidence refuses; final validation never silently requalifies it.
The report states which verification mode ran. Version labels are bound to approved
binary hashes and require prior toolchain provenance review. The validator cannot
prove an undeclared OS/ambient dependency was absent from an earlier build.

The policy schema is exported as `WindowsArtifactPolicy` in
[`windows-artifact.ts`](../../scripts/lan/windows-artifact.ts). It requires:

- `buildLockSha256`, `toolchainManifestSha256` and six `toolFiles` relative paths.
- Independent `identity`: `appId`, `productName`, `protocolScheme`,
  `homeDirectoryName: "T3CodeLAN"`, and explicitly disabled `telemetry`,
  `cloudConfiguration` and `nativeUpdater`.
- `nativeTrust` defaults to `authenticode`, requiring a nonempty
  `certificateSha256` allowlist of approved signing certificate DER SHA-256
  hashes. The explicitly reviewed `portal-pinned` mode requires an empty list
  and binds trust to the exact package delivered by the authenticated HTTPS
  Portal. It does not create a certificate or modify Windows security policy.
- `reviewedComponents` with `role`, `location` and SHA-256. Required roles are
  `desktop-policy`, `server-policy`, `web-policy` and `native-maintenance`.
  A location is a payload path or `resources/app.asar::relative/entry` (similarly
  for `server.asar`). Native maintenance must be
  `resources/native-maintenance.mjs`. Packages containing home repair also require
  the `native-home-repair` role at `resources/native-home-repair.mjs` and an explicit
  `homeRepair` policy block: interface version 1, admission
  `hub-held-windows-handles-v1`, default mode `drop-in`, and SHA-256 pins for
  `native-home-repair.contract.json` and `native-home-repair.schema.json`. The helper's
  generated policy fragment is not approval. Repair packages require the
  `home-selection-and-retention` test receipt check and the
  `default-home-selection` runtime policy check in place of the former home
  isolation checks.
- `runtimePolicyEvidenceSha256`, pinning the packaged
  `t3code-lan-runtime-policy-evidence.json`.

The runtime policy evidence is schema 1 with the exact `sourceCommit`,
`buildLockSha256`, approved `identity`, approved `components` and passed checks
named `default-home-isolation`, `native-updater-disabled`, `cloud-disabled` and
`telemetry-disabled`. It records an independently reviewed runtime test; the
validator does not execute those tests itself. A new metadata assertion module
cannot establish disabled behavior. Audited component hashes and the enforcement
receipt must correspond to real policy hooks across desktop, server and web.
Source-level policy fixtures do not supply that release evidence. Until the
actual compiled components and native runtime evidence are reviewed, validation
remains blocked. The native helper's compiled identity
binding alone does not prove updater/cloud/telemetry enforcement.

## Artifact checks and proof limits

The CLI parses the supplied ZIP32 bytes without a shell extractor. It verifies
central/local records, UTF-8 paths, CRCs, bounded decompression, case-insensitive
duplicates, links, traversal, the manifest's complete file list and each file's
SHA-256 and length. The independently supplied extracted directory must match
that exact tree. It rejects unsupported ZIP variants, self-extracting preambles,
archives above 512 MiB, individual files above 256 MiB and expanded payloads above
2 GiB. Toolchain inventories, including the offline package store, are bounded to
400,000 files and 16 GiB with a 64 MiB manifest. Unsupported
size/format needs an explicit implementation extension, never a silent fallback.

It reads the actual ASAR package metadata, validates ASAR offsets/integrity and
unpacked files, checks independent app/product/protocol identity and aligned
versions, and compares the approved compiled component bytes. Electron-builder
removes the staging package's `build` property. The explicit LAN profile retains
`t3codeLanIdentity` in the ASAR's `package.json`: schema 1, exact
`sourceCommit`, `applicationVersion` and every approved identity field. This stamp
binds identity metadata; audited compiled components and runtime tests establish
that the application actually enforces it. It refuses native
update feed files and currently refuses WSL, whose separate runtime archive
validation has not been implemented. Ordinary upstream builds retain their
official identity/home/update behavior and cannot pass these LAN checks.

Every executable/DLL/native addon, including PE content under an unexpected file
extension, must be unpacked x64 PE with inspection bound to its exact hash.
In `authenticode` mode it must pass offline cache-only WinVerifyTrust with
an approved signer certificate from the exact successful WinVerifyTrust provider
chain. A separately parsed embedded signature cannot establish that signer binding
on a multiply signed file. Provider state is closed on every path. The main executable's native product name and
file version must match the approved identity/application version. A read-sharing handle prevents replacement/write
while the native helper checks the file; Node also checks hashes before/after.
Missing offline trust/revocation information refuses validation. No online trust
fetch or security-policy change is performed. Unsigned addons block
`authenticode` mode. `portal-pinned` mode retains the actual native trust result
without claiming Windows signature trust; all provenance, identity, compiled
policy, applicable qualification and file integrity checks still apply. Hub refuses this
mode on an HTTP route. The operating system may block an unsigned application;
installation does not bypass that decision.
Synthetic tests use a mock signature port. The local native smoke verified the
existing signed Node binary against cached Windows trust, refused a deliberately
wrong signer pin, and refused an unsigned nonexecuted PE fixture. No signer pin
was stored or printed. This validates the trust adapter, not a T3 release signature.

For qualification, the two archives must have identical length and SHA-256, including signatures,
timestamps, manifests and receipts. Different bytes fail, even when extracted
payload files match. This establishes equality of the supplied outputs. Separate
workspace IDs and matching bytes cannot prove two independent build executions
occurred; reviewed build provenance is still needed. Signing timestamps or
uncontrolled package timestamps may prevent exact reproducibility and must be
resolved in the approved build process. The validator neither normalizes away
differences nor claims an actual reproducible build from fixture data. A routine
single-candidate release does not claim independent rebuild reproducibility.

Hub continues to validate its existing schema-1 build/test evidence and package
hashes. Its minimum schema checks do not rerun this validator. Preserve the
validator report as separately reviewed evidence when preparing a new candidate;
do not create a circular digest by putting a final ZIP hash inside that ZIP.
Actual provisioning, clean fork finalization, audited compiled policy,
optional signing, native Windows smoke tests and distribution retain their approval
boundaries. No real approved pins or release identity are invented here.

## Seal supplied payloads

[`seal-windows-payload.ts`](../../scripts/lan/seal-windows-payload.ts) prepares a
Hub portable ZIP from the requested existing raw extracted payloads and separately supplied
evidence. It does not build, sign or manufacture passed test receipts. A schema-1
seal request contains absolute `validationRequestPath`, `testReceiptPath` and
`runtimePolicyEvidencePath`, plus `builtUtc` and the payload-relative
`executablePath`. The referenced validation request supplies the same policy,
lock, toolchain and profile-specific runs described above; each run's
`artifactPath` must name a new output ZIP.

```powershell
node scripts/lan/seal-windows-payload.ts --request C:\Approved\seal-request.json --approved-policy-sha256 <approved-policy-file-sha256>
```

The sealer adds the exact supplied build lock, test and runtime evidence and a
complete Hub package manifest. It creates deterministic ZIP32 bytes with fixed
archive timestamps, then applies the full artifact and native signature checks
to each candidate before exclusive output creation. Existing outputs are never
overwritten. Final output identity and hashes are checked again; publication
authorization remains false. Deterministic sealing cannot make different input
binaries or signatures reproducible, or prove independent build execution.

## Prepare Portal update metadata

Hub discovers T3 LAN versions through the configured Portal stable channel.
A release consists of the validated ZIP, its Portal metadata and its activation
policy. Copy those files to `\\BuildMachine\BuildShare\T3CodeLAN\<artifact SHA-256>`
and invoke the staged publication hook. The hook verifies the supplied hashes,
publishes through the existing Portal publisher, and verifies the download.
It does not deploy Portal or compile a new Hub approval for each T3 version.

Use the existing sealing result when preparing metadata so the routine path does
not repeat validation or build a second candidate. The legacy descriptor generator
remains available for explicit offline validation, but a GitHub release or asset
is not part of LAN delivery. Hub owns update discovery, stopped-state admission,
snapshots, data preservation and rollback; the native application updater stays
disabled.
