# Native feature sync

This file records, for each fork behavior that overlaps upstream T3 Code, what
upstream supplies, what the fork still needs and the decision. The policy is in
[AGENTS.md](../../AGENTS.md#prefer-native-t3-capabilities). Update the affected
rows on every upstream sync. A decision other than `keep` needs the owner's
approval before code or runtime changes.

## Baseline

- Upstream: `pingdotgg/t3code` `main` at `dd1484815` (2026-10-29), merged by
  `a7bd75470` on `lan/upstream-sync-2026-10-29` for LAN 1.0.26 (previous sync
  `9826dbb99` at `e8f65e9fe`). Latest stable is v0.1.5. Linked environments
  first shipped in nightlies from `0.1.4-nightly.20261027.3796`.
- Shipping release: T3 Code LAN 1.0.26, fork `80a58cfc2`, upstream `dd1484815`,
  app and server version 0.1.5, installed by Hub 0.5.115
  (`%LOCALAPPDATA%\Programs\T3CodeLAN\active.json`, `app\t3code-lan-package.json`).
  Upstream PRs #16684 and #17130 are ancestors of `b428bda9d`.
- AnvilToad configuration observed 2026-10-28: `linkedEnvironmentsEnabled` unset
  (off); no `userdata\lan-routing.json`, so every `t3_lan_*` call is denied; no
  peer-link secrets; eight connected fleet link deliveries;
  `sidebarThreadGrouping: "machine"` and `boringSidebarEnabled: false`.

## Data constraints

- **Migration IDs diverge.** The fork puts LAN migrations at 68–71
  (`McpOAuthGrants`, `LanRouting`, `LanTaskMutations`,
  `LanObservationGenerations`) and moves upstream's 68–73 to 72–77 (upstream
  `073_ActiveTurnItemIndexes` is the fork's 77, from the 2026-10-29 sync).
  Upstream and the fork mean different things by IDs 68–77, so a database must
  never move between a stock build and a fork build. Retiring a LAN table keeps
  its migration file. Dropping the table takes a new forward migration plus
  home-repair support.
- Upstream now compares migration numbers across builds: the environment
  descriptor carries `databaseMigration`, the npm `t3` manifest carries the
  release's head, and a Stable/Nightly switch refuses a target whose head is
  lower than the database's (`trackSwitchBlockReason` in `cloud/selfUpdate.ts`).
  A fork head is not comparable with a stock one. This stays inert while LAN
  builds report no self-update capability (`resolveServerSelfUpdateCapability`
  returns null when native updates are off), so they never offer or accept a
  track switch.
- Every upstream migration must also be added to `supportedMigrationIds` in
  `scripts/lan/home-repair.ts` and to the release audits' current schema (see
  `b428bda9d`).
- `apps/server/src/lan/NativeMaintenance.ts` and `nativeWorkStates.ts` read a
  closed `statev2.sqlite` by table and status names. An upstream projection
  change can break them without causing a type error.

## Summary

| #   | Behavior                                         | Native equivalent                                              | Upstream status                   | Decision                                  |
| --- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| 1   | Fleet membership and machine links               | None (T3 Connect needs the cloud)                              | —                                 | keep                                      |
| 2   | Agent target discovery                           | `t3_environment_links`, link-request card                      | nightly, Labs beta                | adapt ([design](native-link-adapter.md))  |
| 3   | Remote task lifecycle                            | `environmentId` on thread tools, remote `delegate_task`        | nightly, Labs beta                | replace (in-app agents) · defer (gateway) |
| 4   | Remote questions and approvals                   | `t3_pending_request` with `environmentId`                      | nightly, Labs beta                | replace with row 3                        |
| 5   | Task observation and notifications               | `t3_thread_wait`; delegated-task wake inside T3 only           | partial                           | keep                                      |
| 6   | Renewable task-only OAuth grants                 | 30-day outside-agent OAuth, no refresh                         | released                          | keep                                      |
| 7   | Encrypted LAN endpoint, startup, reconnect       | None for Windows LAN (Connect, Tailscale, Linux/macOS service) | —                                 | keep                                      |
| 8   | Task grouping by machine                         | Boring sidebar project folders                                 | nightly Labs, no machine grouping | keep (protected)                          |
| 9   | Hub install, update and launch adapter           | Electron updater from GitHub, `t3 update`                      | released                          | keep                                      |
| 10  | Switchyard gateway adapter                       | Outside agents on `/mcp` with `environmentId`                  | nightly, Labs beta                | defer                                     |
| 11  | LAN build, distribution and update gate          | Upstream release and updater pipeline                          | released                          | keep                                      |
| 12  | Native maintenance, home repair, retained import | `t3_thread_import` (#16731), "Continue threads after restarts" | proposed / released               | keep                                      |
| 13  | Per-machine fleet access                         | One `AuthMcpClientAccess` mode per peer link                   | nightly, Labs beta                | keep                                      |

## Rows

### 1. Fleet membership and machine links

- **Local:** `apps/server/src/lan/{LanFleet,FleetAuthority,FleetEnrollment,FleetDelivery,FleetFiles,FleetBootstrap,FleetVault}.ts`
  (about 2.1k lines, plus 2.3k lines of tests), `apps/web/src/connection/lanFleet*.ts`,
  `LanFleetSettings.tsx` and `LanFleetSetup.tsx`. Hub supplies
  `T3CODE_LAN_FLEET_ROSTER_PATH`. The output is saved client connections in each
  desktop's catalog. See [LAN machine links](../operations/lan-machine-links.md).
- **Upstream:** no non-cloud way to share client connections between desktops.
  The T3 Connect account list depends on the cloud, and the LAN profile sets
  `cloudConfiguration: "disabled"`. Linked environments (row 2) connect servers
  for agents, not client catalogs.
- **Must preserve:** owner approval with verification codes, signed membership,
  recipient-encrypted deliveries, identity by environment ID, and no plaintext
  credentials on the share.
- **Data:** OS credential-store vault, `userdata\lan-fleet-state.json`, the
  shared roster directory and saved connections.
- **Tests:** `Fleet*.test.ts`, `LanFleet.test.ts`, `LanFleetSetup.browser.test.tsx`.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when upstream shares connections between desktops without the
  cloud, or when the fleet can create native peer links from which the client
  catalog is derived.

### 2. Agent target discovery

- **Local:** `t3_lan_environments` (`apps/server/src/mcp/toolkits/lan`) and
  `EnvironmentRegistry.ts`, which reads `<stateDir>/lan-routing.json`
  (environments, grants, project and thread allowlists, models, runtime
  ceilings). A destination must advertise `capabilities.lanTaskRouting: 1`, so it
  has to run the fork.
- **Upstream:** `t3_environment_links`, `t3_environment_link` (a link-request card
  from a hint such as "my vps") and `t3_environment_unlink`, in
  `apps/server/src/peer/PeerLinks.ts` and `PeerLinkRequests.ts`. Merged PRs:
  #16684, #16695, #16698 and #17130. Nightly only, behind the Labs beta
  `linkedEnvironmentsEnabled`, which is off by default on both machines. Open:
  #26475 (Tailscale 100.x addresses), #26551 and #26567 (performance).
- **Must preserve:** explicit selection by environment ID, and denial reported
  separately from an absent or offline machine.
- **Gaps:**
  - A link has one access mode. There is no project, thread or model allowlist.
  - Links last 30 days and cannot be renewed, so relinking is a recurring manual
    step.
  - A link requires HTTPS, or HTTP to a loopback or tailnet address. Fleet
    endpoints use self-signed, pinned TLS that the server-side peer fetch does
    not trust (inferred from the source; `apps/server/src/peer` is unmodified in
    the fork; not tested).
  - When Labs is off on the destination, the call returns 403
    `linked_environments_off`, which is reported as retryable.
- **Data:** the upstream peer-link tables (fork migrations 74–76) are empty on
  AnvilToad.
- **Decision:** adapt. Use native discovery for in-app agents as the first
  replacement (see Sequence). The fleet creates, renews and removes the links;
  see [Fleet-managed native link adapter](native-link-adapter.md) for the
  design, answers and proof plan. From LAN 1.0.26 the adapter is on by default
  on every machine (`fleetLinkedEnvironmentsEnabled`). It neither offers nor
  links until the fleet has a Machine access list, adopted from
  `fleet-access-seed.json` or saved in Settings, and linked environments count
  as on only for an enrolled member with an enabled roster row and a list;
  elsewhere Labs decides. A starting list waits for every enabled machine to
  run 1.0.26; after 24 hours it stops waiting only for machines silent for a
  day. A machine never links above its own access, and ignores 1.0.25 offers.
  It has not yet run between two real servers. Keep
  `t3_lan_environments` for the gateway's grant path until rows 5, 6 and 10
  are settled.
- **Tests:** `EnvironmentRegistry.test.ts`, `FleetPeerLinks.test.ts`,
  `FleetPeerHttpClient.test.ts`, `serverSettings.test.ts` (default on, only
  with a list), `McpHttpServer.test.ts` (link tools with the real default);
  upstream `PeerLinks.test.ts` and `PeerLinkRequests.test.ts`.
- **Owner:** Dan. **Rollback:** `"fleetLinkedEnvironmentsEnabled": false` in a
  machine's `settings.json` (its next pass forgets and revokes what its adapter
  made), or restore the `false` default in a release.
- **Revisit:** when linked environments leave Labs or ship in a stable release,
  or when links become renewable.

### 3. Remote task lifecycle

- **Local:** `t3_lan_task_{launch,list,read,send,interrupt}`, routed by
  `EnvironmentRouting.ts` to `NativeTaskService.ts` (which wraps
  `ThreadLaunchService`, `ThreadManagementService` and `OrchestratorMcpService`)
  or to `RemoteTaskTransport.ts` (an OAuth MCP client that calls the same
  `t3_lan_*` tools on a fork destination). Receipts are stored by migration 070.
  These files total about 1.6k lines, plus 1.7k lines of tests. The only
  intended caller is the unpublished gateway (row 10). Since LAN 1.0.26 in-app
  threads don't see the ten tools, which refuse every thread caller
  (`hiddenFromThreads`); outside clients still do.
- **Upstream:** an `environmentId` parameter on `t3_thread_launch/list/read/send/wait/interrupt`,
  `t3_queue`, `t3_project_*` and scheduling (#16684). `delegate_task` can run in
  a linked environment, with a restart-safe follower that wakes the parent
  (#16719, `RemoteDelegation.ts`). `clientRequestId` retries are hashed per
  caller. `T3-Mode-Limit` caps a link at the caller's modes. The `linkOrigin`
  fence keeps work below full access inside its link (#16695). Open: #16751
  (hand a thread off), #16758 (Continue on…) and #26625.
- **Must preserve:** a task keeps the destination's environment, thread and run
  IDs; project and model options; queueing; interrupting a specific run; retry
  safety.
- **Gaps:**
  - No per-grant project or thread allowlist.
  - A full-access link is not fenced.
  - Upstream adds `steer` and `restart` send modes; the fork exposes only `auto`
    and `queue`.
- **Data:** the LAN mutation and ownership tables (migrations 069–070) stay as
  they are. The native path writes ordinary threads on the destination.
- **Decision:** replace for in-app agents; defer for the gateway.
- **Tests:** `NativeTaskService.test.ts`, `EnvironmentRouting.test.ts`,
  `RemoteTaskTransport.test.ts`; upstream `PeerForwarding.test.ts`,
  `RemoteDelegation.test.ts`, `linkOrigin.test.ts` and
  `OrchestratorMcpToolkit.integration.test.ts`.
- **Owner:** Dan. **Rollback:** drop the `hiddenFromThreads` annotations in
  `toolkits/lan/tools.ts` and turn the fleet adapter off.
- **Revisit (gateway):** when upstream offers project- or thread-scoped link
  access, or when the gateway can accept a link-scoped client.

### 4. Remote questions and approvals

- **Local:** `t3_lan_task_requests` and `t3_lan_task_respond` answer new
  user-input questions only. Approvals stay with the native approval holder.
- **Upstream:** `t3_pending_request` (`list`, `read`, `respond`) with
  `environmentId`. It cannot approve a permission request. Open: #26344
  (questions and approvals from remote delegated tasks appear on the parent),
  #26492 and #26665.
- **Gaps:** none known for questions. Surfacing approvals from remote delegated
  tasks is still a proposal.
- **Decision:** replace together with row 3, which has the same callers.
- **Tests:** planned: a forwarded `respond` cannot approve a permission request.
- **Owner, rollback and revisit:** as row 3.

### 5. Task observation and notifications

- **Local:** `t3_lan_task_observe` and `t3_lan_events_ack`, with `RoutingStore.ts`
  and migrations 069 and 071. Cursors are anchored, ACKs are scoped to a source,
  replay starts a new generation, and a `taskWorkState` snapshot accompanies
  each page. The gateway's ledger is encrypted and holds at most 1,000 facts
  and 100 task states. There is no wake receiver: responses report
  `wakeDelivery: "unsupported"`.
- **Upstream:** no event or push stream for outside agents. `t3_thread_wait`
  long-polls, and forwarded waits are split into calls of at most 50 s. A
  delegated task wakes its parent thread inside T3. Mobile push goes through the
  cloud relay.
- **Must preserve:** durable capture, deduplication, replay, restart recovery,
  quiet routine events and a real assistant wake. Test each one separately; an
  HTTP success proves none of them.
- **Gaps:** neither upstream nor the fork can wake an external assistant.
- **Decision:** keep for the gateway. For in-app agents, native `delegate_task`
  and `t3_thread_wait` take over with row 3. Do not add a second ledger.
- **Tests:** `EnvironmentRouting.test.ts`, `GatewayTaskSurface.test.ts`.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when upstream adds MCP events, notifications or webhooks for
  thread state, or when a supported assistant wake receiver exists.

### 6. Renewable task-only OAuth grants

- **Local:** `apps/server/src/auth/McpOAuthGrants.ts` and migration 068.
  Renewable grants are opt-in: one-hour access tokens, rotating refresh tokens
  and a 90-day family limit, and reusing a refresh token revokes the family.
  `taskOnlyTools` in `McpToolAccess.ts` limits a grant to the task tools.
  `GatewayT3OAuthClient.ts` uses PKCE and a pinned issuer.
- **Upstream:** outside-agent OAuth and peer links both use a fixed 30-day
  session with no refresh (`docs/user/outside-agents.md`). Scope is an access
  mode, narrowed per call by `T3-Mode-Limit`. Since #25222 (synced 2026-10-29)
  an approval code is checked for the requested scopes before it is consumed,
  so a refused code stays usable; the fork's `consumeMcpApprovalCode` still
  returns the grant subject for credential attribution.
- **Gaps:** upstream has no renewal and no task-only scope, and its lifetimes
  differ. Never swap one kind of grant for the other silently.
- **Data:** grant tables, refresh-token hashes and the server secret store.
- **Decision:** keep.
- **Tests:** `McpOAuthGrants.test.ts`, `GatewayT3OAuthClient.test.ts`.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when upstream adds renewable or narrower outside-agent grants.

### 7. Encrypted LAN endpoint, startup and reconnect

- **Local:** `FleetTransport.ts`, `FleetNetwork.ts`, `FleetVault.ts`,
  `packages/shared/src/fleetTls{Certificate,Proxy}.ts` and
  `apps/desktop/src/lan/DesktopFleetGateway.ts`, a loopback proxy that pins peer
  certificates. Since `fdc282140`, an enabled endpoint restarts with its
  existing key when T3 reopens, and saved encrypted connections reconnect
  without another endpoint or access choice. **Stop encrypted endpoint** stays
  off across restarts. Pickup stops when the desktop app closes.
- **Upstream:** no pinned-TLS LAN endpoint. The supported routes are T3 Connect
  (cloud, disabled here), Tailscale HTTPS and plain HTTP pairing on a private
  LAN. The background service runs only on Linux and macOS. "Continue threads
  after restarts" resumes threads but does not restore endpoints.
- **Must preserve:** automatic restore with no recurring manual step, offline
  and reconnect behavior, and no plaintext fallback.
- **Gaps:** there is no native replacement. This row also blocks native links
  over fleet routes (row 2).
- **Decision:** keep. If native links are adopted over fleet routes, add one
  small adapter that gives the peer fetch the fleet's pinned trust, or use
  Tailscale routes instead. The
  [native link adapter](native-link-adapter.md#3-tls) design covers it.
- **Tests:** `FleetTransport.test.ts`, `DesktopFleetGateway.test.ts`,
  `fleetTlsProxy.test.ts`. The restart behavior has no runtime proof from this
  review.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when upstream ships a Windows background service or LAN HTTPS.

### 8. Task grouping by machine

- **Local:** the client setting `sidebarThreadGrouping: "none" | "machine"`;
  web in `97c00ec39` (`Sidebar.tsx`, `SidebarMachineGroupHeader.tsx`, the
  command palette and Settings); mobile in `b48277a17`; shared ordering in
  `packages/client-runtime/src/state/machineGroups.ts`. Grouping shipped in
  1.0.23. Per-device machine ordering is `a275a2d1d`, not yet released.
- **Upstream:** the boring sidebar (Labs, `boringSidebarEnabled`; nightly only,
  not in v0.1.3) puts threads in project folders
  (`SidebarProjectFolderHeader`). Upstream `main` at
  `9826dbb99` has no grouping by machine or environment. The fork turns machine
  grouping off while the boring sidebar is on (`canGroupByMachine`).
- **Must preserve:** a group is an environment ID; a thread belongs to the
  group of the environment it runs on; groups are ordered by the device's saved
  order, otherwise primary first and then by label; the setting persists across
  restarts; behavior holds across machines.
- **Data:** client settings only (`client-settings.json` and mobile
  preferences). No server data.
- **Decision:** keep. This is protected local work, owned by Dan's orchestrator
  thread. It reuses upstream's folder-header pattern, and it should stay that
  way.
- **Tests:** `machineGroups.test.ts`, `Sidebar.drag.test.ts`.
- **Rollback:** set the grouping to `none`.
- **Revisit:** if upstream adds environment grouping or puts machines into
  project folders. Compare how ordering is persisted before migrating the
  setting.

### 9. Hub install, update and launch adapter

- **Local:** `JacKAsterisK/ReprintHub` (`src/ReprintWorkspaceCore/T3Code*.cs`):
  installation and activation (`active.json`); automatic updates at logon and
  every 15 minutes; an idle-close reservation through the fork's
  `NativeUpdateControl` pipe; home repair, including a bundled
  `native-home-repair-*.mjs`; adopting the original home; importing connections
  and history; replacing the stock app; and the fleet roster variable.
- **Upstream:** the Electron updater pulls from GitHub releases, the "update
  everything" button updates every machine, and servers update through npm. The
  LAN profile sets `nativeUpdater: "disabled"`. Since #26288 (synced
  2026-10-29) Settings → About → Update track switches this app and every
  connected machine between Stable and Nightly in one step, after checking each
  database's migration head against the target release.
- **Decision:** keep. The independent identity and offline BuildShare are
  product requirements. Retire Hub's import pieces only together with row 12.
  The fleet track switch overlaps Hub's fleet updates but relies on GitHub and
  npm releases and upstream migration numbering, so LAN builds hide it:
  the track select renders only with native updates on, the app never counts
  itself as off-track, and servers advertise no self-update capability.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** if upstream supports a custom update feed with stopped-state
  gates, or if Hub no longer needs a side-by-side home.

### 10. Switchyard gateway adapter

- **Local:** the fork exports `GatewayT3OAuthClient.ts` and
  `GatewayTaskSurface.ts`, bundled with `lan:bundle-gateway`. The Switchyard
  composition `Maintenance/Direct/Transport/T3TaskSelection.mjs` is
  unpublished, its selection is disabled, and it is not installed. Switchyard
  `HEAD` `32a2793` contains no T3 task code.
- **Upstream:** outside agents use `/mcp` with OAuth. Once links exist, they can
  reach other machines through `environmentId`.
- **Gaps:** rows 5 and 6.
- **Decision:** defer. Nothing is running. When gateway activation is approved,
  prefer native tools with `environmentId` through one destination, and keep
  only the observe/ACK and renewable-grant adapters.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when gateway activation is requested.

### 11. LAN build, distribution and update gate

- **Local:** `scripts/lan` (about 10.2k lines, not counting home repair),
  `scripts/lib/lan-build-policy.ts`, `ForkUpdateDiscovery.ts`,
  `NativeUpdate{Gate,Readiness,Control}.ts`, `DesktopNativeUpdateClose.ts` and
  `NativePromptReadiness.ts`. The per-release scripts live outside this repo.
  See [LAN distribution](../operations/lan-distribution.md).
- **Upstream:** a GitHub release workflow, the Electron updater and signing.
  "Update everything" counts the threads a restart will interrupt. Upstream has
  no offline build and no independent app identity.
- **Decision:** keep. The fork's idle and draft gate is stricter than upstream's
  interrupt-then-resume approach.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when upstream changes the desktop updater APIs these modules wrap.

### 12. Native maintenance, home repair and retained import

- **Local:** `NativeMaintenance.ts`, `nativeWorkStates.ts`,
  `OfflineWorkCancellation.ts`, `NativeDataGeneration.ts`, and
  `scripts/lan/home-repair*.ts` (about 7.5k lines). The scripts include the
  retained-conversation import from the original `~/.t3` (`fb25f39f9`). Hub
  calls them from `T3CodeHomeRepair*`.
- **Upstream:** `DatabaseMaintenance.ts`, and "Continue threads after restarts"
  (`docs/user/updating.md`). Open: #16731 (`t3_thread_import`, conversation only)
  and #25494 (nightly starts on databases a preview build migrated). Upstream
  has no offline repair across homes. Synced 2026-10-29: startup removes
  abandoned `.v2-import-*` copies beside the database (#25301), and
  `databaseMigrationHead.ts` reads the migration history read-only. Upstream
  changed no table, column or status that `NativeMaintenance.ts` or
  `nativeWorkStates.ts` read; its migration 77 only adds two partial indexes on
  `orchestration_v2_projection_turn_items` over the same `pending`, `running`
  and `waiting` states.
- **Gaps:** the proposed import works per thread, not per home. Resuming threads
  is not the same as cancelling work offline.
- **Data:** `statev2.sqlite` and recovery receipts under `T3CodeLAN\recovery`.
  The original home is left unchanged.
- **Decision:** keep. If #16731 lands, evaluate it as a replacement for the
  retained-conversation import. Do not resume the cancelled history migration.
- **Tests:** `NativeMaintenance.test.ts`, `NativeDataGeneration.test.ts`,
  `scripts/lan/home-repair*.test.ts`, and the release receipt's
  `retained-lan-history-import` check.
- **Owner:** Dan. **Rollback:** not applicable.
- **Revisit:** when #16731 merges or upstream adds offline maintenance commands.

### 13. Per-machine fleet access

- **Local:** `apps/server/src/lan/FleetAccessPolicy.ts` (the `FleetAccess`
  service), `LanFleet.ts` (issue, revoke and replace peer credentials),
  `FleetEnrollment.ts` (the `access` setup operation), `EnvironmentRouting.ts`
  (a read-only machine forwards no task changes), `FleetCredentialAccess.ts`
  (each credential capped at its machine's access per use, and revocation) and
  **Machine access** in `LanFleetSetup.tsx`. Attribution is
  `apps/server/src/auth/CredentialAttribution.ts`, shared with the peer-link
  adapter: subjects `lan-fleet-by:<root>` and `mcp-client:<root>|local`, a
  `CredentialAccessCap` applied to verified sessions in `EnvironmentAuth.ts`, to
  task grants in `authenticateMcpClient`, and per call in `RpcAuthorization.layer`
  and the WebSocket handlers that check scopes themselves (`layerWsRpc`).
  `FleetGrantAttribution.ts` attributes pre-attribution task grants to their
  holder through a signed `fleet_assertion` on refresh (`McpOAuthGrants.refresh`).
  `FleetMembership.ts` keeps a machine a trust check only misses until it stays
  missing. See [LAN machine links](../operations/lan-machine-links.md#machine-access).
- **Upstream:** each peer link and outside-agent grant has one
  `AuthMcpClientAccess` mode, set by whoever approves it on the destination.
  There is no fleet-wide policy and no way to change a link's mode without
  relinking. Enforcement reuses upstream's read scopes, `refuseReadOnlyClient`
  and the `orchestration:operate` checks on RPCs and in the web client.
- **Must preserve:** the receiving machine enforces; one signed, synced policy; a
  read-only machine cannot lift its own restriction; changes need no approval or
  relink; links between unaffected machines are untouched. Exceptions (a
  read-only machine standard on named machines) are evaluated per pair on the
  receiver and stored in the signed `machines` array as hashed entries 1.0.26
  reads as unknown machines; never add a field to revision files, which 1.0.26
  decodes strictly and skips with everything after them. Which revisions count
  is 1.0.26's rule, applied to the entries as signed (`revisionCounts`), so both
  versions follow the same chain; exceptions change only what a counted
  revision grants, and a read-only machine can neither grant nor remove one.
  An exception applies only while its receiver's own level is read-only
  (`exceptionApplies`, inside `pairAccess`, which every consumer reads):
  standard on a machine includes its reach, meaning its agents and shell and
  through them its credentials, its peer links to other machines and owner
  access to its own server (`t3` on the host configures the fleet as that
  machine). An exception onto a standard machine would reach every machine
  that one writes to and could administer the fleet through it. One onto a
  machine that is or becomes standard stays stored and does nothing; it narrows
  that pair like any downgrade and applies again if the receiver turns
  read-only. A save that adds one onto a machine standard in the resulting list
  is refused (`LanFleetError.refusal` `exception-onto-standard`), and so is one
  whose caller or receiver is not a fleet machine (`exception-unknown-machine`;
  stored ones are kept). This is evaluation only; revision acceptance is
  unchanged.
  While it applies, an exception gives the caller full control of the receiver:
  standard includes its shell. Removing it stops further use of the caller's
  fleet credentials and peer links there, but not what the caller did there
  meanwhile, such as an unattributed credential from `t3 auth pairing create`, a
  scheduled task or a key. Making the receiver standard extends trust to all of
  that, which passes as the receiver's own; Settings names the machines with
  stored exceptions onto it and asks before such a save. This is inherent to
  standard access and is documented, not prevented.
  An exception never grants fleet administration: `server.syncLanFleet`,
  `server.getLanFleetSetup` and `server.configureLanFleet` from a fleet-attributed
  credential need the caller's own standard level
  (`CredentialAccessCap.administersFleet`, checked per call in `layerWsRpc`).
  The same bar holds for handing access outside the fleet, which would outlive
  the exception: `guestShare.create` (`sharingOutside` in `layerWsRpc`),
  webhook URLs in scheduled-task lists and mutation results over WebSocket and
  in MCP summaries (`McpClientSession.sharesOutside`), and T3 Connect
  `linkProof`/`relayConfig` (`cloud/http.ts`), the step that installs the key
  the cloud then mints `cloud-connect` credentials with. Every other credential
  a fleet credential mints or approves stays attributed and capped with it:
  pairing credentials (`lan-fleet-by:`), MCP sign-ins and task grants
  (`mcp-client:<root>`), peer-link and fleet codes (machine-issued).
  An entry with an exception's or writer mark's ID is always read as one,
  whatever the fleet's membership (no machine set enters evaluation); machine
  IDs starting `pair-access-` are never admitted, trusted, approved or given
  access, and their credentials are refused, while `evaluateAccess` still
  verifies signers against the full 1.0.26 peer set (`fleetPeers`). Narrowing
  is make-before-break for fleet credentials, task grants and peer links alike:
  the receiver caps each call at once, keeps the session reading, and retires
  it only after its replacement is in use. The requester also holds every
  peer-link call to its own live list: writes, as each MCP tool's
  `McpToolAccess` declaration classifies them, are refused locally
  (`PeerWriteCeiling` in `PeerMcpClient.call`), read again right before every
  `tools/call` send, retries and new sessions included. A link that signs in
  above a list that narrowed meanwhile is kept for reads and receipted as usual,
  first link or not, and a narrower one is requested; dropping it would leave a
  1.0.26 receiver holding the spent offer for up to an hour. A code, fleet or
  peer-link, is re-checked against the live list before minting and after
  publishing, the first list adopted mid-sync included, and withdrawn (revoked,
  offer removed) if it narrowed.
  Only a successful
  read revokes: an unreadable policy caps at the last accepted one and revokes
  nothing, and with none accepted changes nothing; a machine leaves only when
  shown disabled or missing for the departure grace. A grant holder's claim
  re-attributes only an unattributed grant, and only to the claim's signer.
- **Gaps:** task grants approved before attribution only read while any machine
  is restricted until their holder's next refresh, and indefinitely for a holder
  that is not a fleet server. Sessions from codes minted before attribution keep
  their issued access until they expire (at most 30 days). Webhook URLs a
  connection saw while standard stay usable after it is downgraded, until rotated;
  one standard only by an exception never sees them, but a full-access thread it
  starts there can list them, like anything else that machine's shell can read
  (the documented full-control limit). Guest shares made before this rule stay
  until they expire or are closed. The requester's write re-check and the send
  are not atomic: a list that narrows between them lets that one write go.
  Owner-approval fleets get no automatic credential replacement. Software forging
  share files is out of scope (shared-folder trust). Accepted propagation delay:
  the desktop client's own fleet connections to peers, and the codes fleet sync
  collects, are capped by the receiver, not the requester, so after a narrowing
  they keep their old access until the receiver reads the list, within its sync
  delay. Agents reach peers through peer links, on which the requester already
  refuses writes locally; the remaining window is the receiver's sync delay. A
  1.0.26 machine still revokes or unlinks a
  narrowed peer link rather than keeping it for reads; this ends once every
  machine is updated.
- **Data:** signed revisions in `fleet-access` on the share, an optional one-time
  starting list `fleet-access-seed.json` beside the roster (removed once
  adopted) with signed readiness markers in `fleet-access-ready`, the accepted
  chain in `userdata\lan-fleet-access.json`; trust-check misses in
  `lan-fleet-members.json` and `lan-fleet-trusted.json`. No database migration.
- **Decision:** keep. A fleet adapter that creates native peer links must take
  each link's access from `FleetAccess.accessFor` and follow `FleetAccess.changes`
  instead of choosing one itself.
- **Tests:** `FleetAccessPolicy.test.ts` (competing and orphaned revisions, the
  starting list and its readiness wait, departed signers, locks, floods,
  exceptions and their 1.0.26 encoding, the same reading from cache, with a
  machine disabled and after a save, forged exception-shaped IDs, exceptions
  only onto read-only receivers and between fleet machines, saves refused
  otherwise), `FleetAccessPolicy.parity.test.ts` (revision acceptance against
  `FleetAccessPolicy.v1026.fixtures.ts`, a frozen copy of 1.0.26's verifier
  that must never be edited to match newer code),
  `FleetCredentialAccess.test.ts` (receiver caps, revocation, unreadable
  policy, holder attribution, exceptions, capped peer-link sessions, fleet
  administration and outside sharing by base level, reserved IDs refused),
  `FleetPeerLinks.test.ts` (per-pair widen and narrow, reads kept through
  narrowing whichever side reads it first, a receiver turning standard, writes refused by the requester at
  once, a link signed in above a narrowed list kept for reads and receipted
  with a receiver that never sees the request, a peer-link code withdrawn when
  the list narrows while it is published, under the real receiver cap),
  `PeerMcpClient.test.ts` (writes re-checked at every send: narrowing during
  resolve, session start and the 404 retry), `McpToolAccess.test.ts` (each linked call carries its declaration's
  write flag), `RpcAuthorization.test.ts` (per-call scopes), `ws.test.ts`
  (webhook URLs, fleet administration refused, guest shares and webhook URLs
  withheld from a connection standard by an exception),
  `OrchestratorMcpService.test.ts` (MCP webhook URLs withheld likewise),
  `FleetEnrollment.test.ts` (sync, refused lifts, departure grace, reserved
  IDs), `LanFleet.test.ts` (replacement, renewal, stale sync lock, codes
  withdrawn when the list narrows mid-sync, the first list included),
  `GatewayT3OAuthClient.test.ts`, `EnvironmentRouting.test.ts`.
- **Owner:** Dan. **Rollback:** set every machine to Standard in **Machine
  access**; each machine replaces the read-only credentials on its next sync.
- **Revisit:** when upstream adds per-link access changes or project-scoped links.

## Sequence

Proposed; each step needs Dan's approval.

1. **In-app agents use native linked environments (rows 2–4).**
   1. Write down the contract: launch, read, send, queue, interrupt and answer a
      question on a named machine, with denial and offline reported distinctly.
      Add fork tests only where upstream's tests leave a gap.
   2. With Labs on for two fleet machines, link one test environment at
      read-only access over a route the peer client accepts. Prove
      `t3_environment_links` and `t3_thread_list`/`t3_thread_read` with
      `environmentId`.
   3. Exercise the mutations on a disposable project: launch, a queued send,
      wait, interrupt by run, `t3_pending_request`, and a remote
      `delegate_task` that survives a restart.
   4. Done in LAN 1.0.26: in-app threads no longer see `LanToolkit`; outside
      clients, task-only grants included, keep it. Steps 2 and 3 are still owed.
2. **Gateway on native tools (rows 3, 5, 6, 10)**, after gateway activation is
   approved. Then retire `NativeTaskService`, `EnvironmentRouting`,
   `RemoteTaskTransport`, `EnvironmentRegistry` and the routing half of the LAN
   toolkit and docs, and keep migrations 068–071.
3. **Retained import (row 12)**, if #16731 lands.
4. **LAN Android app**, wanted eventually and not scheduled. The official app
   can likely pair with each machine over plain HTTP on the home network, once
   its server is opened to the LAN; that is unverified against the fork's
   server version. It cannot use T3 Connect (off in LAN builds) or the fleet's
   self-signed endpoints, and it shows no fork features. A sideloaded build of
   `apps/mobile` would add machine grouping (`b48277a17`), trust in the fleet's
   pinned certificates and, with a VPN or our own relay, access away from home.

## Known bugs

- **Fixed in `9a8adb212f`, not yet released: thread tools rejected the
  `thread_` ID that T3 gives agents** (reported 2026-10-30 from a Reprint
  thread on CryoFrog). A thread mention carries the
  context ID `thread_<uuid>`: in `t3-context://v1/thread/thread_<uuid>`, in
  `ref=` and in the `<t3_context>` block's `id`. The same block's `threadId`,
  and every thread tool, take the bare UUID. `t3_thread_read("thread_<uuid>")`
  fails with `thread_not_found`, "Thread … is no longer available."
  (`OrchestratorMcpService.ts:1201`; upstream `main` `9b1d351ba0` has the same
  path), even for a running thread. Agents read that as deleted: CryoFrog thread
  `e9a40c65` skipped a coordination check the user asked for. Only
  `t3_thread_read` was tested; `t3_thread_send`, `_wait`, `_interrupt` and
  `_update` likely share the lookup.
  - **Fix:** `McpToolAccess.toLayer` resolves `threadId` and `targetThreadId`
    for every tool before its checks and route. It accepts the ID,
    `thread_<id>`, `t3-context://v1/thread/<id>` and `t3-thread://` links; a
    v2 link's environment becomes `environmentId`, and a conflicting one is
    refused. `thread_` is dropped only before a UUID or an ID that names a
    thread, so `thread:provider:…` IDs stay intact. An unknown ID says "No
    thread … exists here." with the accepted forms; only a deleted thread is
    "no longer available". Codes are unchanged. `<t3_context>` labels
    `threadId` as the ID tools take.
  - **Limit:** a thread whose ID holds characters a context ID cannot, such
    as `:`, gets a hashed context ID, which still names no thread. The error
    points agents at `threadId`.
  - **Next:** ships in the next release. Worth offering upstream; upstream
    `main` has the same lookup.
