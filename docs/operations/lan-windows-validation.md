# Validating supplied Windows artifacts

[`validate-windows-artifact.ts`](../../scripts/lan/validate-windows-artifact.ts)
inspects existing local build inputs and portable ZIPs. It never provisions tools,
builds or executes the application, signs code, installs, publishes, changes a
channel, starts a provider or reads provider credentials. No approved real lock,
toolchain closure, audited compiled policy or independent LAN artifact is supplied
by this checkout. The explicit LAN build profile and runtime guards are implemented
in source; they have not produced an approved Windows candidate. Running
without arguments returns a failing readiness report.

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

The request is schema 1 with absolute `policyPath`, `buildLockPath`,
`toolchainManifestPath` and exactly two `runs`. Each run has a distinct `sourceId`,
`sourceRoot`, `buildRoot`, `artifactPath`, `extractedRoot` and `toolchainRoot`.
Provide two separate clean checkouts and build workspaces with their existing
artifacts and extracted files. The validator reads Git metadata without fetching
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
Extra or changed files refuse validation. Hashing streams toolchain files; it
does not launch a tool's version command. Version labels are bound to approved
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
policy, reproducibility and file integrity checks still apply. Hub refuses this
mode on an HTTP route. The operating system may block an unsigned application;
installation does not bypass that decision.
Synthetic tests use a mock signature port. The local native smoke verified the
existing signed Node binary against cached Windows trust, refused a deliberately
wrong signer pin, and refused an unsigned nonexecuted PE fixture. No signer pin
was stored or printed. This validates the trust adapter, not a T3 release signature.

The two archives must have identical length and SHA-256, including signatures,
timestamps, manifests and receipts. Different bytes fail, even when extracted
payload files match. This establishes equality of the supplied outputs. Separate
workspace IDs and matching bytes cannot prove two independent build executions
occurred; reviewed build provenance is still needed. Signing timestamps or
uncontrolled package timestamps may prevent exact reproducibility and must be
resolved in the approved build process. The validator neither normalizes away
differences nor claims an actual reproducible build from fixture data.

Hub continues to validate its existing schema-1 build/test evidence and package
hashes. Its minimum schema checks do not rerun this validator. Preserve the
validator report as separately reviewed evidence when preparing a new candidate;
do not create a circular digest by putting a final ZIP hash inside that ZIP.
Actual provisioning, clean fork finalization, audited compiled policy,
optional signing, native Windows smoke tests and distribution retain their approval
boundaries. No real approved pins or release identity are invented here.

## Seal supplied payloads

[`seal-windows-payload.ts`](../../scripts/lan/seal-windows-payload.ts) prepares a
Hub portable ZIP from two existing raw extracted payloads and separately supplied
evidence. It does not build, sign or manufacture passed test receipts. A schema-1
seal request contains absolute `validationRequestPath`, `testReceiptPath` and
`runtimePolicyEvidencePath`, plus `builtUtc` and the payload-relative
`executablePath`. The referenced validation request supplies the same policy,
lock, toolchain and two independent runs described above; each run's
`artifactPath` must name a new output ZIP.

```powershell
node scripts/lan/seal-windows-payload.ts --request C:\Approved\seal-request.json --approved-policy-sha256 <approved-policy-file-sha256>
```

The sealer adds the exact supplied build lock, test and runtime evidence and a
complete Hub package manifest. It creates deterministic ZIP32 bytes with fixed
archive timestamps, then applies the full artifact and native signature checks
to both candidates before exclusive output creation. Existing outputs are never
overwritten. Final output identity and hashes are checked again; publication
authorization remains false. Deterministic sealing cannot make different input
binaries or signatures reproducible, or prove independent build execution.

## Prepare the fork update descriptor

The LAN application's update check reads public metadata only from
`JacKAsterisK/t3code`. It requires `t3code-lan-channel.json` and its matching ZIP
in a stable release tagged `lan-v<distributionVersion>`. A copied upstream
release or a release without this descriptor is unavailable to the LAN updater;
it never falls back to the main T3 channel. The descriptor carries the independent
native identity, application/distribution versions, source commit, ZIP size and
SHA-256. GitHub's ZIP asset metadata must agree with it.

Generate the descriptor from the two already validated archives:

```powershell
node scripts/lan/prepare-update-channel.ts --request C:\Approved\validation-request.json --approved-policy-sha256 <approved-policy-file-sha256> --output-directory C:\Approved\release-metadata
```

This reruns local artifact validation and creates the descriptor,
`t3code-lan-portal-metadata.json`, and `t3code-lan-activation-policy.json` without
overwriting existing outputs. The Portal metadata pins the policy's exact SHA-256;
the policy approves only that artifact and carries the validated trust mode.
Pass both generated files to the Portal publisher (`--metadata` and
`--activation-policy`) alongside the exact ZIP. The generator publishes nothing.
After publication approval, the
descriptor and exact ZIP belong to the same fork release. Desktop Settings and
`t3 update --check` report that candidate and link to its exact release tag.
Hub still verifies the downloaded package and handles stopped-state activation,
snapshots and rollback; discovery metadata never grants installation authority.
