# Native feature sync

This file records, for each fork behavior that overlaps upstream T3 Code, what
upstream supplies, what the fork still needs and the decision. The policy is in
[AGENTS.md](../../AGENTS.md#prefer-native-t3-capabilities). Update the affected
rows on every upstream sync. A decision other than `keep` needs the owner's
approval before code or runtime changes.

## Baseline

- Upstream: `pingdotgg/t3code` `main` at `9826dbb99` (2026-10-28), fully merged
  into fork `main` at `e8f65e9fe`. Latest stable is v0.1.3 (2026-10-27), which
  predates linked environments. Nightlies from `0.1.4-nightly.20261027.3796` on include them.
- Shipping release: T3 Code LAN 1.0.23, fork `b428bda9d`, upstream `40d335a7b`,
  app and server version 0.1.3, installed by Hub 0.5.114
  (`%LOCALAPPDATA%\Programs\T3CodeLAN\active.json`, `app\t3code-lan-package.json`).
  Upstream PRs #16684 and #17130 are ancestors of `b428bda9d`.
- AnvilToad configuration observed 2026-10-28: `linkedEnvironmentsEnabled` unset
  (off); no `userdata\lan-routing.json`, so every `t3_lan_*` call is denied; no
  peer-link secrets; eight connected fleet link deliveries;
  `sidebarThreadGrouping: "machine"` and `boringSidebarEnabled: false`.

## Data constraints

- **Migration IDs diverge.** The fork puts LAN migrations at 68–71
  (`McpOAuthGrants`, `LanRouting`, `LanTaskMutations`,
  `LanObservationGenerations`) and moves upstream's 68–72 to 72–76. Upstream
  and the fork mean different things by IDs 68–76, so a database must never
  move between a stock build and a fork build. Retiring a LAN table keeps its
  migration file. Dropping the table takes a new forward migration plus
  home-repair support.
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
  design, answers and proof plan. The adapter is built and ships off
  (`fleetLinkedEnvironmentsEnabled`); the live proof is next. Keep
  `t3_lan_environments` for the gateway's grant path until rows 5, 6 and 10
  are settled.
- **Tests:** `EnvironmentRegistry.test.ts`, `FleetPeerLinks.test.ts`,
  `FleetPeerHttpClient.test.ts`; upstream `PeerLinks.test.ts` and
  `PeerLinkRequests.test.ts`.
- **Owner:** Dan. **Rollback:** set `fleetLinkedEnvironmentsEnabled` off,
  **Forget** the link here and revoke it in the destination's **Sharing &
  access**.
- **Revisit:** when linked environments leave Labs or ship in a stable release,
  or when links become renewable.

### 3. Remote task lifecycle

- **Local:** `t3_lan_task_{launch,list,read,send,interrupt}`, routed by
  `EnvironmentRouting.ts` to `NativeTaskService.ts` (which wraps
  `ThreadLaunchService`, `ThreadManagementService` and `OrchestratorMcpService`)
  or to `RemoteTaskTransport.ts` (an OAuth MCP client that calls the same
  `t3_lan_*` tools on a fork destination). Receipts are stored by migration 070.
  These files total about 1.6k lines, plus 1.7k lines of tests. The only
  intended caller is the unpublished gateway (row 10). In-app agents also see
  the ten tools, but with no routing policy installed the tools deny every call.
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
- **Owner:** Dan. **Rollback:** restore the in-app `LanToolkit` registration and
  turn Labs off.
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
  mode, narrowed per call by `T3-Mode-Limit`.
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
  LAN profile sets `nativeUpdater: "disabled"`.
- **Decision:** keep. The independent identity and offline BuildShare are
  product requirements. Retire Hub's import pieces only together with row 12.
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
  has no offline repair across homes.
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
  (a read-only machine forwards no task changes) and **Machine access** in
  `LanFleetSetup.tsx`. See [LAN machine links](../operations/lan-machine-links.md#machine-access).
- **Upstream:** each peer link and outside-agent grant has one
  `AuthMcpClientAccess` mode, set by whoever approves it on the destination.
  There is no fleet-wide policy and no way to change a link's mode without
  relinking. Enforcement reuses upstream's read scopes, `refuseReadOnlyClient`
  and the `orchestration:operate` checks on RPCs and in the web client.
- **Must preserve:** the receiving machine enforces; one signed, synced policy; a
  read-only machine cannot lift its own restriction; changes need no approval or
  relink; links between unaffected machines are untouched.
- **Gaps:** outside-agent task grants are not tied to a machine, so a destination
  cannot narrow them (none are installed). Owner-approval fleets get no automatic
  credential replacement.
- **Data:** signed revisions in `fleet-access` on the share and the accepted chain
  in `userdata\lan-fleet-access.json`. No database migration.
- **Decision:** keep. A fleet adapter that creates native peer links must take
  each link's access from `FleetAccess.accessFor` and follow `FleetAccess.changes`
  instead of choosing one itself.
- **Tests:** `FleetAccessPolicy.test.ts`, `FleetEnrollment.test.ts` (sync and
  refused lifts), `LanFleet.test.ts` (replacement), `EnvironmentRouting.test.ts`.
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
   4. Stop registering `LanToolkit` for in-app sessions, and keep it for
      task-only grants.
2. **Gateway on native tools (rows 3, 5, 6, 10)**, after gateway activation is
   approved. Then retire `NativeTaskService`, `EnvironmentRouting`,
   `RemoteTaskTransport`, `EnvironmentRegistry` and the routing half of the LAN
   toolkit and docs, and keep migrations 068–071.
3. **Retained import (row 12)**, if #16731 lands.
