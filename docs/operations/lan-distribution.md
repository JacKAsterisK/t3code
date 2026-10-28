# Preparing T3 Code LAN for Hub distribution

Every LAN release is one fresh local AnvilToad build and one ZIP, then the focused functional checks, sealing, and a copy of the ZIP, metadata and activation policy to `\\BuildMachine\BuildShare\T3CodeLAN` and the existing Portal publishing hook. Keep the focused updater, stopped-state, projection and data-preservation checks. Do not create GitHub releases, upload caches/artifacts to GitHub, use cloud runners, or require per-version Hub/Portal source-pin edits. T3 Actions is disabled; optional orchestration must use self-hosted machines. Upstream merges, dependency, toolchain and build-policy changes follow the same single-build path; there is no second build, reproducibility comparison or qualification baseline.

The LAN fork has an offline preparation contract in
[`scripts/lan/hub-distribution.ts`](../../scripts/lan/hub-distribution.ts).
It validates build inputs, artifact bytes, independent installation paths,
manual channel candidates, stopped-state activation and recovery decisions.
It does not build, publish, install, stop processes, change channels or mutate
installed T3 data. Unpublished Hub and Portal adapters implement staging and the
activation transaction boundary. Hub's concrete Windows lease and the fork's
offline maintenance helper are tested together on isolated database copies;
an explicit LAN packaging profile and runtime policy are implemented in source.
Approved release inputs, native acceptance and distribution remain separate
requirements.

## Inspect build readiness

From the fork checkout, after the repository dependencies are installed:

```powershell
node scripts/lan/prepare-hub.ts
node scripts/lan/prepare-hub.ts --lan-policy C:\ApprovedBuildInputs\public-lan-identity.json --lock C:\ApprovedBuildInputs\t3code-lan-build-lock.json
```

Both commands only read local files and Git metadata and print a dry-run report.
Without `--lan-policy`, the report inspects the ordinary upstream build defaults.
An explicit profile selects the independent LAN target and validates its inputs;
it does not establish that a compiled artifact passed native acceptance.
They never execute the reported build stages. `ready` means the supplied source
and input lock passed static preparation checks; build and distribution
authorization remain false. Run actual build tool verification in an isolated
native Windows build workspace after tool provisioning is approved.

For supplied artifacts, use the separate [Windows validation procedure](lan-windows-validation.md).
It verifies real tool/source/payload bytes and offline native signature evidence;
the preparation report and Hub's evidence schema alone do not prove reproducibility.

Use the exact Node and pnpm pins reported from the checkout's `package.json`.
The initial release-base checkout specifies Node **26.12.1**, pnpm **12.14.0**,
Electron **44.9.3** and electron-builder **26.16.1**. Earlier plan versions named
older Node and pnpm versions. The source's package versions also differ from
the release version; align all release package versions with
`update-release-package-versions.ts` before finalizing the source commit and
capturing the build lock. The LAN build refuses to rewrite tracked source inputs.

An approved schema-1 `BuildLock` records exact fork and upstream commits,
independent distribution and application versions, all `BUILD_INPUT_FILES`
hashes, and exact Node, pnpm, Rust, MSVC, Windows SDK and NSIS versions with
binary hashes. Use real captured inputs rather than `stable`, `latest`, version
ranges or example pins. Hashing a lockfile records the resolved dependency
inputs; it does not verify installed build tools. The isolated runner must
verify those binaries before use, install dependencies with the frozen lockfile,
and reject ambient build configuration. Desktop and server staging additionally
require reviewed lockfiles at `scripts/lan/locks/desktop.pnpm-lock.yaml` and
`scripts/lan/locks/server.pnpm-lock.yaml`, each pinned in `BuildLock.files`.
Staging uses `--offline --frozen-lockfile`; this constrains dependency resolution,
but does not prove that lifecycle scripts or native compilers avoided the network.
Network isolation is available with the optional Windows Sandbox runner; the
native-directory runner makes no OS or network isolation claim. All required
tools and caches must still match their reviewed inventory.

Every release builds one candidate from the final pushed commit, whatever changed
since the previous release. After an upstream merge or a dependency change,
refresh the offline pnpm store and staging locks, then capture a new build lock
and toolchain manifest for that commit. The build lock and native receipt record
what was actually built. The release then runs the packaged updater, stopped-state,
projection and home/data-preservation checks against that build, validates the
artifact, seals it and records the built component hashes in its policy and
evidence. No second build, byte-reproducibility comparison, qualification
baseline, per-release source review or green CI run is part of a release, and a
single build makes no reproducibility claim. `scripts/lan/release-profile.ts`
selects the mandatory release tests plus tests adjacent to changed source.

The LAN profile supports native Windows x64 portable ZIPs with no WSL runtime.
The resource monitor, Electron-hosted `server.asar`, native maintenance bundle
and native addons belong to the verified payload. Preserve third-party notices.

## Select and build the LAN profile

The public identity JSON contains exactly `appId`, `productName`,
`protocolScheme`, `homeDirectoryName: "T3CodeLAN"`, `telemetry: "disabled"`,
`cloudConfiguration: "disabled"`, `nativeUpdater: "disabled"`,
`protocolVersion: 2`, `applicationVersion` and `sourceCommit`. Select a reviewed
independent appId, product and URI scheme. The application version and final
source commit must match the approved build lock. No credential belongs in this
file. This checkout supplies synthetic test identities, not an approved release
identity or tool lock.

The ordinary packaging CLI is deliberately insufficient to start a LAN build:

```powershell
node scripts/build-desktop-artifact.ts --platform win --arch x64 --target zip --lan-policy C:\ApprovedBuildInputs\public-lan-identity.json --lan-build-lock C:\ApprovedBuildInputs\t3code-lan-build-lock.json
```

The LAN entry point refuses execution before ambient build probes unless invoked
programmatically by a verified native-directory runner or Windows Sandbox guest. There is no command-line
or environment-variable override. The execution adapter selects explicit native
Node/pnpm, Cargo/rustc, MSVC/SDK, Python, Vite and packaging paths from the reviewed
tool closure, uses copied offline caches and suppresses resource-monitor reuse.
Ordinary upstream builds retain their existing execution path. Source tests of
this adapter do not establish actual release-build acceptance.

The profile requires a fresh compile, clean source and matching Node binary hash
and version. It binds the exact identity-file digest through the web, desktop,
server and helper compiler stages, skips root `.env` loading and ambient Vite
exports, uses independent package metadata, and emits no native update feed.
It refuses the upstream signing workflow and mock update configuration. Signing
under a separately approved identity remains an external release step.

## Prepare production staging locks

The desktop and server locks are separate production dependency closures derived
from the existing workspace resolution. Each preserves the root pnpm 12 bootstrap
document and its projected application graph. Omitting the bootstrap document
makes frozen, lockfile-only acceptance fail on package-manager dependencies.
Projection preserves exact package integrity,
peer context, native optional edges and patch bytes, while binding the generated
staging manifest and workspace configuration. It does not perform a new online
resolution. In particular, the existing desktop peer context retains its
TypeScript compiler closure; do not silently remove those peers to reduce size.

```powershell
node scripts/lan/prepare-stage-locks.ts --check
```

`--write` is explicit creation of missing prepared inputs. It refuses existing
outputs instead of replacing them. Review a changed projection alongside its
root resolution and production manifest. A deterministic projection and matching
configuration checksum are preparation evidence; acceptance by the pinned
pnpm **12.14.0** with frozen/offline resolution remains a separate check. Missing
offline registry metadata must refuse preparation; do not substitute an unapproved
package manager or invent resolver output.

For a reviewed Windows preparation request, the acceptance command copies the
production manifests, configuration, patches and locks into a new workspace and
uses the hash-pinned native `pnpm.exe`. pnpm 12's JavaScript entry is a bootstrap
that can download another executable, so it is not an acceptable primary pin.

```powershell
node scripts/lan/accept-stage-locks.ts --request C:\ApprovedBuildInputs\windows-preparation.json --approved-request-sha256 <separately-reviewed-request-sha256>
```

This runs `--lockfile-only --offline --frozen-lockfile --ignore-scripts`, refuses
package hooks and ambient configuration, and checks source, tool and staged
input bytes again after each stage. A successful receipt proves lock acceptance;
it does not prove native build isolation or authorize a release. No installed
dependency tree or existing build output is overwritten.
The reviewed `toolchainRoot/pnpm-store` includes `metadata-cache/` for pnpm 12's
registry policy metadata. Acceptance copies this inventory-pinned tree and sets
its cache directory explicitly; an ambient user cache cannot satisfy a missing
offline input.

## Inspect pinned Windows inputs

The read-only preparation CLI verifies supplied public inputs without launching
compilers, installers, native signature tools or the application:

```powershell
node scripts/lan/windows-build-preparation.ts
node scripts/lan/windows-build-preparation.ts --request C:\ApprovedBuildInputs\windows-preparation.json --approved-request-sha256 <separately-reviewed-request-sha256>
```

The schema-1 request contains absolute `sourceRoot`, `buildRoot`, `toolchainRoot`,
`buildLockPath`, `identityPath` and `toolchainManifestPath`; exact
`buildLockSha256`, `identitySha256` and `toolchainManifestSha256`; and `toolFiles`
mapping `node`, `pnpm`, `rust`, `msvc`, `windowsSdk` and `nsis` to relative files
in the toolchain. Source, build and toolchain directories must be separate native
Windows paths outside installed T3 homes and caches. The build directory must
already exist and be empty; the CLI never cleans it.

The request hash must come from separate review. Verification checks the full
40-character commit, clean source, upstream ancestry, aligned versions, every
required source/stage input and exact toolchain inventory/primary hashes. The
standalone preparation command performs full inventory verification; release native
builds may use the local toolchain qualification described below. Git inspection
discards ambient repository/index/config redirection, disables replacement refs
and refuses grafts. It preserves normal repository access checks. Full inventory
verification refuses unlisted, linked or changed files. Version labels require prior toolchain
provenance review; no tool version command is executed to establish them.

`inputsVerified` concerns the supplied snapshot. `preparationNodeMatches`
separately reports whether this read-only CLI ran under the pinned Node binary.
`executionSupported`, `nativeExecutionVerified`, `buildAuthorized` and
`distributionAuthorized` remain false in this read-only report. Its
`executionBackends` lists the native-directory and optional Windows Sandbox implementations.
The runner and its complete tool/cache inputs still require actual native
acceptance. Neither this report nor a frozen pnpm invocation proves offline
native lifecycle/Cargo execution or the absence of undeclared Windows dependencies.

The compiled policy disables Connect/cloud initialization, Clerk storage and
bridges, analytics/OTLP exporters and native update installation at their service
boundaries, including CLI, remote update RPC and outdated-protocol update paths. Runtime
environment variables and persisted settings cannot re-enable them. Automatic
SSH installation of the upstream runtime is unavailable; existing direct native
connections and task transport retain their authentication and approval checks.
These source guards and fixture tests still require native acceptance against
the actual release components and selected artifact trust policy.

Manual desktop and `t3 update --check` discovery reads only the pinned fork's
public release metadata. It cannot install an archive or change the Hub channel.
See [preparing the fork descriptor](lan-windows-validation.md#prepare-the-fork-update-descriptor)
for the required release metadata and validation procedure.

## Prepare a native Windows build

The native-directory runner uses ordinary Windows processes and separate source,
toolchain, input and output directories. It does not require Windows Sandbox,
administrator feature changes or a restart. It pins the same source, tools,
offline caches and scrubbed subprocess environment as the Sandbox backend.
Its provenance explicitly records that OS and network isolation are not enforced;
an offline package-manager option cannot enforce that for arbitrary build scripts.

Freeze the clean source and tool inventory first, then use the pinned Node binary
to bundle the runner:

```powershell
node scripts/lan/windows-native-build.pack.ts --build-lock C:\ApprovedBuildInputs\t3code-lan-build-lock.json --approved-build-lock-sha256 <reviewed-lock-sha256> --output C:\LANBuild\new-native-runner
```

The native request uses schema 1 with absolute `preparationRequestPath` and
`executionRequestPath`, their SHA-256 hashes, the reviewed `runnerSha256`, and a
new `inputsRoot` directory. The preparation request selects the clean source,
verified toolchain and existing empty build directory.

For releases, set `validationMode: "candidate"` and
`toolchainQualification: { path: "C:\\LANBuildCache\\toolchain-qualified.json" }`
in the native request. The absolute receipt path must be outside the toolchain.
The first use, an explicit `refresh: true`, or changed manifest, physical root or
primary tool/version pins performs a full toolchain inventory check once.
Subsequent releases check the six primary files and the existing per-use archive/native input pins;
they do not enumerate or hash the complete toolchain tree. Retain this local
cache between releases, and refresh it after intentionally changing ancillary
toolchain files. A reused receipt records `qualified-primary-pins`, rather than
claiming a fresh full-tree check. Keep the frozen
`toolchain-qualification-evidence.json` beside the native build receipt for final artifact validation.

Run the self-contained bundle with the reviewed request hash:

```powershell
node C:\LANBuild\new-native-runner\native-runner.mjs --request C:\ApprovedBuildInputs\native-request.json --approved-request-sha256 <reviewed-request-sha256>
```

The runner snapshots committed source and input bytes before offline dependency
installation, then compiles and packages in its output directory. It never cleans
an existing output or writes to an installed T3 home. Runtime checks and artifact
validation of that one build remain required before publication.

## Optional Windows Sandbox build

The runner targets Windows Sandbox with networking, clipboard, audio/video,
printer and GPU redirection disabled. The generated `.wsb` uses protected client
mode, three read-only mappings and one writable, initially empty output mapping.
Preparation does not enable a Windows feature, launch Sandbox or change host
network/security settings. Those actions require separate approval. Supported
configuration fields are described in the
[Microsoft Windows Sandbox reference](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file).

First prepare the standalone guest bootstrap from clean, approved source using
the exact pinned Node executable:

```powershell
node scripts/lan/windows-sandbox-guest.pack.ts --build-lock C:\ApprovedBuildInputs\t3code-lan-build-lock.json --approved-build-lock-sha256 <reviewed-lock-sha256> --output C:\LANBuild\new-guest-bundle
```

This creates a new bundle directory and recipe receipt. Independently review the
bundle bytes, dependency provenance and source binding, then approve its SHA-256.
The receipt explicitly leaves bundle reproducibility acceptance pending; a local
bundle hash alone does not establish a reproducible release build.

Prepare an execution request using the schema in
[`windows-build-execution.ts`](../../scripts/lan/windows-build-execution.ts).
It binds the identity, build lock and complete tool inventory, the approved
commit's timestamp as `sourceDateEpoch`, and explicit relative tool/cache paths.
The Windows SDK version must match the lock. An exact `visualStudioVersion`
selects VS 2022 (17.x) or VS 2026 (18.x), with a matching MSVC toolset and
explicit compiler/MSBuild/SDK paths. Primary pins are native `node.exe`, `pnpm.exe`, `rustc.exe`,
`cl.exe` and `rc.exe`; helper executables, scripts, headers and libraries also
belong to the complete reviewed inventory. Do not substitute bootstrap shims.
The tracked workspace pnpm hook is pinned as a source input, but installation
disables hooks. Pinned pnpm 12.14 preserves the existing frozen hook checksum and
resolved peer graph with `--ignore-pnpmfile`; it does not rerun the hook's WSL
architecture expansion. Production stages use their separate reviewed configuration.
The pinned Node headers must declare the same Node version and x64 target.
LAN packaging keeps Electron rebuilding disabled and checks the packaged native
FFF and PTY bindings through Electron without starting a terminal or provider.
Enabling Electron rebuilding later requires separately reviewed Electron headers
and a matching target; the current Node-header selection is not a substitute.

The schema-1 Sandbox preparation request contains `preparationRequestPath` and
`preparationRequestSha256`, `executionRequestPath` and `executionRequestSha256`,
`guestRunnerPath` and `guestRunnerSha256`, and a new absolute `bundleRoot` separate
from source, tools and output. Approve this request independently, then run:

```powershell
node scripts/lan/prepare-windows-sandbox.ts --request C:\ApprovedBuildInputs\sandbox-request.json --approved-request-sha256 <reviewed-sandbox-request-sha256>
```

The command snapshots ordinary tracked Git blobs from the exact clean commit.
It never maps the raw checkout, `.git`, ambient installed dependencies, local T3
state or ignored configuration into the guest. The exact reviewed agent-skills
symlink and two reference submodules are recorded as exclusions without following
or initializing them. Committed dependency fixtures in two explicitly allowed
vendored test directories remain source bytes, bound by their Git object and
SHA-256 identities. Unexpected links, submodules and dependency directories
refuse preparation. Build-lock pins must match the committed blob bytes,
including line endings; required build inputs cannot be excluded. Preparation
writes a new source/input snapshot and `build.wsb`, then reports their hashes
without launching them.

After launch approval, the guest checks its actual account, lack of external
network interfaces and read-only mappings before writing build output. It
verifies the complete source/tool/input inventories, creates fresh working
source and cache copies, installs frozen offline dependencies and runs the
programmatic LAN packager with scrubbed subprocess environments. A missing cache,
changed input, unsupported tool layout or failed child command refuses the
build. Partial output is preserved for inspection and never automatically reused
or cleaned. The Windows base image and native dependency behavior still require
real acceptance; source fixtures cannot establish them. Final payloads remain
unsigned candidates requiring the separate signing, sealing and profile-specific
[artifact validation](lan-windows-validation.md) procedure.

## Candidate and installation contract

Ordinary upstream builds retain their existing defaults. The LAN profile keeps
its separate appId, product and protocol while defaulting to the original
`%USERPROFILE%\.t3` home and existing Electron protection context. It preserves
the original environment identity, projects, messages and saved connections.
Existing LAN-only installations continue on their initialized LAN home and profile;
this preservation path never creates a separate home or an empty original history.
Startup refuses ambiguous split homes until Hub previews them and the user
explicitly chooses the original or separate LAN home. Both complete homes and
matching profiles are preserved before selection; identities, credentials and
databases are never merged.

Existing PCs retain their currently selected data home and matching Electron profile. Fresh installations use `.t3`. No migration of existing homes is planned; observation improvements do not move or archive homes or uninstall an application.

The native repair interface is defined in
[`home-repair.contract.json`](../../scripts/lan/home-repair.contract.json).
Hub holds stopped-home/profile admission throughout Apply and reconciles its
active pointer and launch environment with the selected result. Retained LAN
conversations and provider settings remain available by explicitly selecting the
LAN home again; they do not appear in the original home's conversation list.
Apply remains pending until the app verifies readable history and saved
connections. Automatic rollback refuses source changes that could contain new
work; preserved snapshots remain available for reviewed recovery.

The preparation-only `CandidateManifest` binds the immutable artifact SHA-256 and length to fork and
upstream commits, build-lock and test-receipt hashes, desktop/backend versions,
protocol, architecture and application identity. Distribution versions are
independent `major.minor.patch` versions. Reusing a version with different bytes
or metadata and promoting a downgrade are refused. Metadata must arrive through
the authenticated Portal; an artifact hash from the same untrusted download is
not sufficient provenance. `verifyArtifact` verifies bytes only. Its result
always requires native Windows signature verification before distribution.
Unsigned artifacts remain developer candidates. Do not claim the upstream
publisher or disable Smart App Control to run unsigned native addons.

The coordinated Hub adapter follows its Moonlight delivery model: immutable
stored candidates, a manual channel pointer, authenticated resumable downloads,
bounded extraction that rejects links/duplicates/path traversal, a verified
native payload and separate studio versions. Portal owns
`/api/tools/t3code-lan/channels/stable` and
`/api/tools/t3code-lan/artifacts/{sha256}/download`. These are source changes;
they have not been deployed or provisioned.

The delivery channel uses schema 1 with `packageId: t3code-lan-<version>`,
`version`, `platform: Win64`, `artifactId` equal to `sha256`, `byteLength`,
`sourceCommit`, `upstreamCommit`, `manifestSha256`, `protocolVersion: 2` and the
exact relative `downloadPath`. The portable ZIP contains a root
`t3code-lan-package.json` with every payload file's path, length and SHA-256 plus
the independent identity and build/test evidence. Channel `manifestSha256`
hashes that manifest's bytes. Keep the ZIP's own hash outside the ZIP to avoid a
circular digest. Hub verifies both layers before staging. Portal publication
defaults to a read-only dry run; actual publication is a separate approval.
Include `t3code-lan-build-lock.json` and `t3code-lan-test-receipt.json` as hashed
payload files matching the manifest's evidence pins. The receipt links the fork
source and build lock to passed `focused-tests`, `windows-smoke` and
`identity-isolation` checks. Hub validates this recorded provenance; it does not
rerun the Windows build or prove reproducibility while staging.

Install in the intended Windows user's native context. The contract allows
versioned application directories below
`%LOCALAPPDATA%\Programs\T3CodeLAN\` and separate data below
`%LOCALAPPDATA%\T3CodeLAN\`, rejecting Codex/cache paths and the official home.
Before activation, inspect real filesystem paths for links/reparse points and
verify the native uninstall identity, shortcut target, executable, signatures
and running version from a second native context. The pure path validator is
lexical and cannot prove the absence of filesystem redirection.

Inventory keeps desired, installed-on-disk and running artifact IDs separate,
along with machine/environment IDs, desktop/backend/protocol versions,
executable path, observation time and native-context provenance. Inventory
contains no transcripts, tokens, Portal keys or provider credentials. Treat
offline inventory as stale rather than declaring installation failure.

## Activation and rollback

Hub's **Update and restart T3** button uses the existing manual action: normal close, approved update and reopen, with supported unfinished-work preservation. It never force-kills T3. Automatic updates and **Update when idle** retain their existing work/draft admission rules.

Download and stage candidates while work runs. The first activation policy
requires a deliberate stopped boundary and an exclusive activation lock held
through snapshot, activation and verification. Recheck the exact environment,
installed artifact and selected desired artifact under that lock. Evidence
older than 30 seconds, unknown state, an unverified candidate or an unverified
recovery snapshot defers activation.

Update admission splits six blocking counters from a `carriedWork` object
with the same category names. Blocking counters must be known and zero; carried
work remains intact across the migration. Original-home repair keeps its stricter
classification, including enabled schedules. Do not interrupt or cancel work to
drain a host. T3 remains stopped throughout the activation transaction; a live
probe alone does not close the race with new execution.

| Work                                                                                             | Normal restart behavior                                                              | Update admission                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Preparing, starting or running runs; running attempts, nodes, provider turns or effects          | Reconciled as interrupted/cancelled, or replayed after interruption                  | Blocks                                                                                          |
| Ordinary queued input with its retained message                                                  | Queue is held during provider recovery                                               | Carried; buffered provider notifications and unknown queue records block                        |
| Waiting run with a pending replayable checkpoint                                                 | Recovery leaves the run for checkpoint replay                                        | Carried; other waiting runs and a running checkpoint block                                      |
| App-owned message questions and their waiting nodes                                              | Kept for a later message response                                                    | Carried                                                                                         |
| Provider-bound approvals/questions                                                               | Shutdown cancels them; startup expires them and marks them not resumable             | Blocks; providers advertise `pendingRequestsSurviveRestart: false`                              |
| App-owned pending/waiting delegated tasks and their nodes/items                                  | Child settlement owns their completion                                               | Carried; running children and native provider work still block                                  |
| Warm ready provider session / active provider-thread label                                       | Reconciliation stops/detaches the warm session                                       | Carried when no blocking work refers to it                                                      |
| Active native goal or pending native background tasks                                            | Goal may continue beyond a terminal turn; background handles are cleared on recovery | Blocks                                                                                          |
| Pending replay-safe outbox effect                                                                | Process-loss recovery requeues/replays the request                                   | Carried; pending process-bound or unknown effects block                                         |
| Enabled idle schedule and pending webhook coalescing window                                      | Configuration and queued payload are persisted and reread                            | Carried; any running schedule, including a disabled one, and dispatching/running webhooks block |
| Delegated completion cohort, app-owned completion delivery and uncollected terminal child result | Startup delegated-task recovery resumes delivery/collection                          | Carried; unknown/native delivery ownership blocks                                               |
| Resolved unconsumed context transfer                                                             | Persisted transfer remains available for consumption                                 | Carried; pending export and open launch workflows block because safe completion is unproven     |

These decisions follow `ProviderRuntimeRecoveryService`, `EffectOutbox`,
`ScheduledTaskService` and `Orchestrator.recoverDelegatedTasks`. The native helper's
restart-effect subset is fail-closed and checked against the outbox replay policy
by a focused test. Unknown status, migration history, projection cursor or SQLite
integrity continues to refuse admission.

The helper adds a lease-free, read-only `probe` operation on its existing bounded
stdin/stdout protocol. It reads one coherent WAL snapshot and returns the blocking
counts, carried counts, work generation, process liveness and observation time.
The live close gate reads current/deferred work rather than terminal conversation bodies. It does not start the server or providers. It is advisory: automatic close also
requires an application-owned execution reservation and fresh draft readiness;
stopped inspect/verify and the native locks remain authoritative for activation.

Draft readiness is `userdata/native-update-readiness.json`, schema 1, bound to the
environment and the current `server-runtime.json` owner. Its `draftStateKnown`,
`hasUnsentPrompt` and `observedUtc` become probe fields `draftStateKnown`,
`hasUnsentPrompt` and `draftsObservedUtc`. Evidence older than 30 seconds, future
observations, an owner mismatch, unsupported clients or unknown draft state makes
a running app ineligible for unattended close. Unsent text or attachments in an
open client's prompt also blocks; there is no input-inactivity timer.
The probe also returns `serverProcessId`, `serverOwnerId`, `updateControlPipe`,
`updateControlVersion` and `guardedCloseSupported`. Control capability is trusted
only from a fresh owner-bound record advertising protocol 1 and the exact local
pipe derived from that owner. Missing/legacy capability returns null/false and
cannot authorize unattended close.

Legacy work generations hash durable projections, retained messages/thread lineage, session bindings, webhook queue/replay keys, events, receipts, workflows and schedule configuration. With the matching 1.0.22-or-newer helper, Hub negotiates `generationVersion: 2`: repeated data observations use main/WAL sizes, last-write timestamps and bounded SQLite/WAL headers, while work observations bind current/deferred work plus event heads and table counts. They avoid repeated whole-history body hashing and are change observations under held admission, not full-content checksums. A migration changing carried work still refuses with `changed`.

The pointer, activation journal and recovery snapshot retain the generation format used for that transaction. An absent version means legacy; old recovery continues with its original format, without silently reinterpreting its hashes as version 2.

Hub holds Windows `FileShare.None` handles
on the permanent `data/native-admission.lock` and existing
`data/userdata/server-owner.sqlite` throughout snapshot, swap, verification and
rollback. Ordinary fork startup and maintenance hold shared admission handles
before home writes. The second exclusive handle also excludes older servers
that predate the new gate. Neither lock file is truncated or deleted. An
unresolved activation journal blocks ordinary startup after a crash.

Native activation requires a separately reviewed per-invocation policy containing
exact artifact hashes, signer certificate pins and independent identity, plus an
explicit inspector package, environment ID and expected current artifact. Hub's
CLI exposes activation, rollback and journal recovery through this policy; it
does not create a persistent access grant or stop running T3 processes. Existing
initialized environment identity and database files are required; activation is
not an installation/bootstrap path. Unknown state or a busy home refuses the
operation, including an otherwise redundant selection of the current artifact.

The verified Electron executable runs `resources/native-maintenance.mjs` with
`ELECTRON_RUN_AS_NODE=1` and a sanitized environment. This dedicated helper loads
only SQLite migrations and read-only inspection services. It does not initialize
the normal server, HTTP listeners, providers, authentication, settings or secret
stores. Hub validates a bounded nonce-bound response, compiled build identity,
freshness, exact environment and data/work generations before migrations. It
retains both locks until a cancelled helper has actually exited. Inspecting
terminal run statuses alone is insufficient: delegated result delivery,
background work and other restart recovery records also affect admission.

For isolated helper tests, `scripts/lan/native-maintenance.pack.ts` takes explicit
absolute `--build-lock` and `--identity` JSON paths and writes a compile-time-bound
bundle under `.t3/native-maintenance`. Its manifest explicitly marks a nonrelease
test build. Rebuild cleanup is limited to the verified helper-owned inventory;
foreign or redirected output directories are refused. The helper's identity
metadata alone does not establish the main application's runtime policy.
Release acceptance additionally requires the
audited compiled components and runtime evidence described in the
[Windows validation procedure](lan-windows-validation.md). No real activation
policy, signing credentials or approved release lock is configured by these tests.

Windows desktop updates lack the service launcher's automatic data rollback.
Before replacement, capture and verify a coherent stopped-state SQLite recovery
set including any WAL/SHM files and required non-credential state. Full backup SHA-256 verification and matching-snapshot rollback remain required; version-2 snapshots also retain timestamps for restored observations. Keep recovery
copies separate from the live home and preserve the previous immutable binary.
Do not copy provider/harness OAuth homes. Protect any required native recovery
identity material under an explicitly reviewed policy.

`planRollback` requires the matching previous artifact and verified coherent
snapshot, stopped admission and no newly accepted work. It plans restoring both
data and binary. A binary-only downgrade is insufficient after a migration.
After new work is accepted, report manual recovery required rather than silently
discarding it. Restart continuation must be included in native acceptance tests.

Upstream synchronization is manual: inspect/fetch the exact upstream release,
prepare a candidate branch, review the fork patch delta and compatibility, then
run focused tests and packaging checks. Synchronization never changes the
installed version or promotes a channel. Hub's primary checkout requires its
normal fetch/sync workflow before edits; its `main` push publishes, so an
unpublished integration must not push or trigger release workflows.
