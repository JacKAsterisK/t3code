# Fleet-managed native link adapter

Design for letting in-app agents work on other fleet machines through
upstream's linked environments (peer links), with the fleet doing the pairing,
renewal and removal. It replaces the in-app use of the `t3_lan_*` tools
([native feature sync](native-feature-sync.md) rows 2–4 and 7). Status: the
adapter (waves 1 and 2) and tool coexistence (wave 4) are built, and from LAN
1.0.26 `fleetLinkedEnvironmentsEnabled` is on by default on every machine. Links
form once the fleet has a Machine access list, adopted from a starting list or
saved in Settings; before that the adapter neither offers nor links. The
fleet status UI (wave 3) is not built, and the adapter has only run in the test
runner, not yet between two real servers (see [How to run the proof](#how-to-run-the-proof)).
Evidence is from fork `main` at `bb224f99b` (upstream `9826dbb99`);
`apps/server/src/peer` is unmodified from upstream.

## Summary

Each machine runs a server-side **fleet peer-link adapter**. For every trusted
fleet peer, the adapter on the linking machine (L) asks the destination (D) for
a pairing code through the shared folder. D mints a one-time code scoped to
the access its fleet policy grants L, and seals it to L with the fleet's
existing recipient-encrypted, signed delivery format. L then calls upstream's
`PeerLinks.link` with D's pinned-TLS fleet origin. The result is an ordinary
peer link, shown in **Connections → Linked environments** and used by the
native tools through `environmentId`.

Renewal is a re-link with a fresh fleet-delivered code, started a week before
expiry. `PeerLinks.link` upserts by environment ID, so the link stays in place
and only its token and dates change. D attributes each link session to the
fleet machine that asked for it. That lets D revoke a replaced session, revoke
at once when the policy is narrowed, and offer a new code when the policy
changes. When a machine leaves the fleet, L forgets the link and D revokes the
session.

The fork changes upstream in four small places, each an optional hook. None
of them touches `apps/server/src/peer`:

- a pinned-TLS HTTP client provided to the peer services in `server.ts`
- an MCP OAuth public origin for requests the fleet TLS endpoint forwarded
  (`mcpOAuthHttp.ts`)
- attribution of a pairing-code session to its fleet code (`McpOAuth.ts`,
  `EnvironmentAuth.ts`). The fleet access policy builds on it: every MCP
  session and task grant also carries its approver in its subject, and
  `auth/CredentialAttribution.ts` maps any credential to its fleet machine
- `fleetLinkedEnvironmentsEnabled`, which reads `linkedEnvironmentsEnabled` as
  on while it is on and the fleet links this machine (`serverSettings.ts`,
  through an optional `FleetAccess`)

The fleet's existing client-connection deliveries, the roster, enrollment and
saved connections are not changed. The adapter keeps its state in JSON, so it
needs no database migration.

## Answers

### 1. Pairing

**Yes, with a separate delivery kind.** No human approval is needed on either
side once both machines allow linked environments.

- **Minting.** The fleet already mints with
  `EnvironmentAuth.createPairingLink({ ttl, subject, scopes })`
  (`apps/server/src/lan/LanFleet.ts:291`). That issues a `one-time-token`
  bootstrap grant.
- **Delivery.** `FleetDelivery.sealDelivery` and `openDelivery` encrypt the
  code to the recipient's X25519 key and sign it with the sender's key
  (`apps/server/src/lan/FleetDelivery.ts:201`, `:271`). The client receives it
  as `LanFleetSyncResult.incoming[].pairingCode`
  (`packages/contracts/src/lanFleet.ts:76`).
- **Acceptance.** `PeerLinks.link` signs in to D's `/mcp` with dynamic
  registration, authorization code with PKCE, and a
  `{ _tag: "pairing-code", access, code }` decision
  (`apps/server/src/peer/PeerLinks.ts:269`). D checks the code with
  `consumeMcpApprovalCode`, which accepts any unused `one-time-token` or
  `reusable-dev-token` grant whose scopes cover `mcpClientScopes(access)`
  (`apps/server/src/auth/EnvironmentAuth.ts:1372`). It does not check the
  subject, and it shows nothing to a person. The approval card
  (`PeerLinkRequests.ts`) is only for links an agent asks for. The adapter
  calls `PeerLinks.link` directly, so no card appears.
- **Why the existing delivery can't be reused.** It is consumed by the desktop
  client to create a client session (`apps/web/src/connection/lanFleet.ts`,
  `connectPairing`). One delivery per sender and recipient is journaled as
  `sent:<key>`, and a one-time code can be spent only once. The adapter
  therefore uses its own files, journal and code subject. It reuses the seal,
  open and receipt functions.

Conditions and changes:

| Condition                                                                                                                                                               | Change                                                                    | Where    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| `linkedEnvironmentsEnabled` on L (`PeerLinks.ts:402`) and on D (registration, `McpOAuth.ts:340`; `/mcp`, `McpHttpServer.ts`)                                            | On wherever the fleet links the machine                                   | answer 5 |
| Code scopes cover the access. Today's read-only fleet scopes include `orchestration:read`, and standard scopes are a superset of the `full-access` scopes               | Mint exactly `mcpClientScopes(access)` for the policy's access            | Part E   |
| L may send the code only to https, loopback or tailnet (`PeerLinks.ts:133`)                                                                                             | Pinned-TLS client                                                         | answer 3 |
| The `resource` L sends must equal D's computed `${origin}/mcp` (`McpOAuth.ts:127`)                                                                                      | D-side origin hook                                                        | answer 3 |
| D's descriptor advertises `mcpModeLimitHeader` and `linkFence` (`PeerLinks.ts:159`)                                                                                     | None; current `main` has both. All five machines need the adapter release | rollout  |
| The code outlives the round trip. The default one-time TTL is 5 minutes (`PairingGrantStore.ts:249`), and a delivery may last at most 24 hours (`FleetDelivery.ts:261`) | Mint with a 1-hour TTL                                                    | Part E   |

### 2. Renewal

**Upstream cannot refresh a peer link.**

- Outside-agent and peer-link sessions are issued once for
  `MCP_CLIENT_SESSION_TTL = Duration.days(30)` (`EnvironmentAuth.ts:74`), and
  `PeerLinks.link` stores `expiresAt = now + expires_in` (`PeerLinks.ts:437`).
- `peer_environment_links` has no refresh-token column, and `resolve()` fails
  with `expired` once that date passes.
- The fork's refresh tokens exist only for task-only grants.
  `validateAuthorization` refuses `offline_access` without `task_only`, and
  refuses task access to peer-link clients because "task grant sessions do not
  carry the link marker" (`McpOAuth.ts:403`, `:412`).

| Option                                            | Changes                                                                                                                                                                                                                                                                                                                                   | Distance from upstream                                                                                                                                                                   | Verdict         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| (a) Re-link before expiry with a fresh fleet code | None to upstream auth or `peer`. Uses `PeerLinks.link`'s upsert on `environment_id`, which replaces the token and deletes the old secret (`PeerLinks.ts:460`). D revokes the superseded session (Part C).                                                                                                                                 | Closest. Uses only public `PeerLinks` behavior.                                                                                                                                          | **Recommended** |
| (b) Renewable links via refresh tokens            | A new "renewable peer link" grant kind in `McpOAuthGrants`; the link marker and fence on grant sessions; exempting it from `gateTaskOnly`; storing and using a refresh token in `PeerLinks.ts` (`resolve`, schema). A new column means a migration, and the fork's migration IDs already diverge from upstream (see native feature sync). | Furthest. Rewrites upstream's link client and its auth model.                                                                                                                            | Reject          |
| (c) Longer-lived links                            | `issueMcpClientSession` would pick a longer TTL when `peerLink` (and fleet) is set                                                                                                                                                                                                                                                        | One line, but in upstream auth. The link still expires, so (a) is needed anyway. A leaked token lives longer, and a manual link would get it too unless the subject is threaded through. | Reject          |

Renewal starts when `expiresAt − now < 7 days`, so a machine that is off for a
week still renews. An expired, unfenced (`fenced = 0`) or revoked link is
treated as missing and relinked on the next pass. Under the hood a renewal is
a relink about every 23 days, with no human step.

### 3. TLS

**No.**

- `PeerLinks` and `PeerMcpClient` use the server's `FetchHttpClient`
  (`server.ts:1134`). Its global fetch trusts only system CAs, so it rejects
  the fleet's self-signed certificate.
- The plain-http fleet origin is refused before any request is sent
  (`PeerLinks.ts:133`).
- This confirms what native feature sync row 7 inferred from the source.

A second problem shows up only once TLS works. D's fleet endpoint is a TLS
proxy to its plain-http backend. It keeps the `Host` header and strips
`x-forwarded-proto` (`packages/shared/src/fleetTlsProxy.ts:114`, `:124`). D
therefore computes its MCP resource as `http://<ip>:<tls-port>/mcp`
(`McpOAuth.requestUrls` through effect's `HttpServerRequest.toURL`), while L
sends `https://<ip>:<tls-port>/mcp`. `sameResource` fails, and the sign-in
ends as `invalid_target`, which L reports as `pairing_rejected`.

Smallest hooks:

1. **L: pinned peer HTTP client.** A fork layer, `FleetPeerHttpClient`, wraps
   `HttpClient.HttpClient` and is provided only to the
   `PeerForwarding`/`PeerMcpClient`/`PeerLinks` group (`server.ts:793`).
   - For a request whose origin exactly equals a trusted peer's
     `tls.origin`, it provides `FetchHttpClient.Fetch` as `undici.fetch` with
     an `Agent`. The Agent's `connect` uses `fleetTlsRequestOptions`: pinned
     CA, SPKI hash check and the `connectHost` route.
   - It keeps the caller's `RequestInit`. `PeerLinks` sets
     `redirect: "manual"`, so the code and token never follow a redirect.
   - Any other origin passes through unchanged. Upstream code is untouched.
   - Links store D's stable https fleet origin, so `peerOrigin`, `describe`
     and `resolve` work unchanged, and every call rides the fleet's encrypted
     endpoint.
2. **D: OAuth public origin.** In `mcpOAuthHttp.ts`, `requestUrls` consults an
   optional `McpOAuthPublicOrigin` service. The fork provides it from
   `FleetTransport`. When the fleet TLS endpoint forwarded the request, the
   issuer and resource use its https origin.
   - The endpoint marks what it forwards with a per-process secret header
     (`FLEET_TLS_FORWARD_HEADER`) and drops any copy a client sent. `Host`
     alone proves nothing: a plain-http client can name the endpoint's host,
     and must not be told it is on https.
   - Setting `x-forwarded-proto` in the proxy instead was rejected. It would
     change `toURL` for DPoP, WebSocket and HTTP auth on every existing fleet
     client connection (`dpop.ts`, `EnvironmentAuth.ts`, `http.ts`, `ws.ts`).

Rejected: a server-side loopback gateway that reuses `startFleetProxy` as the
desktop does (`DesktopFleetGateway.ts`). Its port changes with every start, so
stored link URLs would go stale. Its resource would also never match, because
L would send `http://127.0.0.1:<port>/mcp`.

### 4. Access

The adapter asks D's `FleetAccess.accessFor(L's environment ID)`
(`apps/server/src/lan/FleetAccessPolicy.ts`) what L may do on D, and follows
`FleetAccess.changes`. A machine's entry in the fleet policy is what that
machine may do on the others. D is authoritative: it mints the code's scopes
and returns the granted access in the sealed payload, and L links with exactly
that.

| Fleet policy | `AuthMcpClientAccess` | Code scopes (`mcpClientScopes`)                                                         |
| ------------ | --------------------- | --------------------------------------------------------------------------------------- |
| read-only    | `read-only`           | `orchestration:read`                                                                    |
| standard     | `full-access`         | `orchestration:read`, `orchestration:operate`, `settings:write`, `source-control:write` |

**`full-access` is the level that matches fleet standard today.**

- A standard fleet code carries `AuthStandardClientScopes` (`fleetCredentialScopes`),
  which includes `settings:write`, `source-control:write`, terminal and
  `access:write`.
- Through that connection, a person can start full-access threads and change
  projects and settings.
- Every lower native level is fenced (`apps/server/src/mcp/linkOrigin.ts`):
  linked work may change only threads that link started, and may not change
  projects, settings or scheduled runs.
- Each forwarded call is still capped at the calling agent's own runtime and
  interaction modes (`T3-Mode-Limit`).

**Decided: standard maps to `full-access`.** The mapping is `linkAccess` in
`apps/server/src/lan/FleetPeerLinks.ts`; mapping standard to `auto` instead
would give up only settings and source-control writes and unfenced changes.

A policy change takes effect without approval:

- D's adapter runs a pass on each policy change notification. Every
  attributed session records the access of the code it came from.
- When access is narrowed, D revokes L's sessions above the new access at
  once (Part C). Calls fail until L relinks, never with the old access.
- D offers L a code unasked whenever L's last link is at another access, or
  L holds no live session here (revoked by hand, for example), and re-offers
  after each code expires until L takes one.
- When access is widened, the old session stays until L's relink succeeds.
- Before the fleet has a list, `accessFor` gives every peer its issuer's setup
  access, normally standard, so a code would carry full access even for a
  machine the fleet means to make read-only. So until a list exists
  (`policyApplies`), neither side asks for or offers a code: whether a starting
  list (`fleet-access-seed.json`) waits, is refused or was never placed, and
  when a machine with no saved list finds no `fleet-access` folder. Once the
  list exists, links form at its access
  ([LAN machine links](../operations/lan-machine-links.md#machine-access)).
- L's adapter consumes the offer on its next pass. `PeerLinks.link` then
  replaces the row with the new `access`.
- L also holds itself to its own accepted list (`selfAccess`), since D's copy
  may lag or be missing:
  - An offer must carry the list revision D minted it under
    (`policyRevision`). LAN 1.0.25 offers carry none: its adapter, turned on by
    hand, offers its setup access even with no list. L never uses such an offer.
  - L links at no more than its own access. A code minted for `full-access`
    also signs in at `read-only`, and the session gets only that. A link made
    this way is marked `clamped` and relinked once L's own access widens.
  - L reads its own access from its live list, not a copy taken when the pass
    started: right before each sign-in, and again right after it, unlinking at
    once a link the list narrowed meanwhile. Each pass first unlinks every link
    above L's access, before it reads the share or calls a peer, so a slow or
    failing one never keeps it. D likewise reads L's access again right before
    it mints.
  - A link L holds above its own access is unlinked at once and requested again.
  - D's cap on every call stays authoritative.
- Everything above is local to one machine. A list change made in Settings
  reaches each other machine at its next fleet read, within a sync interval
  (about five minutes). Until then that machine still offers, mints and caps at
  the revision it has, exactly as it still serves its ordinary fleet
  connections. Each machine enforces its own copy of the list; nothing waits for
  the others to agree. At first adoption no link exists yet (links need a list),
  so the rollout itself never meets this.
- Neither machine shows a prompt.

### 5. Gating

- **Upstream gates.** The feature ships in nightlies only (not stable v0.1.3).
  The fork, which tracks upstream `main`, already contains it and always
  advertises `capabilities.peerLinks: true`
  (`apps/server/src/environment/ServerEnvironment.ts:273`). The only gate left
  is the server setting `linkedEnvironmentsEnabled`. It defaults to `false`
  (`packages/contracts/src/settings.ts:1226`) and is read by `PeerLinks`,
  `McpOAuth.register`, the `/mcp` middleware, `hiddenWhileLinksOff` (which hides
  the link tools), `McpToolAccess` (which refuses forwarded calls) and the
  client's `offersLinkedEnvironments`.
- **Built.** A fork server setting, `fleetLinkedEnvironmentsEnabled`, on by
  default since LAN 1.0.26, runs the adapter. An explicit `false` in a machine's
  `settings.json` turns it off there. While it is on and the fleet links this
  machine, settings readers see `linkedEnvironmentsEnabled` as on
  (`resolveReadSettings` in `apps/server/src/serverSettings.ts`), so every
  upstream read site, both machines' sign-in gates and the client follow
  without changes. The derived value is never written to `settings.json`.
  - "The fleet links this machine" is `fleetLinksApply`: as of its last fleet
    read its own enrollment checks out (record enabled, identity matching its
    signed authority entry and the running environment) and its roster row is
    enabled (`FleetAccessState.member`), and a list exists. The policy's peer set
    is not used for this: it keeps a machine whose roster row was just disabled,
    for credential enforcement. Settings reads it from an
    optional `FleetAccess` (which depends only on the server config, so there is
    no cycle); `server.ts` provides the same instance the rest of the server
    uses, and a flip re-emits settings. Readers see it as the read-only
    `fleetLinkedEnvironmentsActive`.
  - A development or unenrolled install, or a member before its fleet has a
    list, keeps upstream's Labs setting in charge.
  - The Labs switch keeps its own stored value. While
    `fleetLinkedEnvironmentsActive` it reads as on and is locked; to stop
    linking, turn the fleet setting off.
  - Off is off. The next pass forgets the links this machine's adapter made,
    revokes every peer-link code and session it issued (including ones its
    state lost track of), and removes its offers and requests from the share.
    A peer that still has it on is refused: no code is offered, and a session
    from a code redeemed just before is not recorded, so it is revoked. Links
    made by hand and the fleet's own client connections are untouched. A
    settings read error changes nothing.
  - The origin hook (answer 3) also applies only while
    `fleetLinkedEnvironmentsActive`, so an off machine behaves exactly as
    before.
  - `ServerSettings.layerTest` keeps the real default. Without a
    `FleetAccess` that lists the machine, linked environments still read as off,
    so upstream's tests keep upstream's off default.
- **Rejected.** A LAN-build default of on for `linkedEnvironmentsEnabled`
  (it would turn links on for every machine in the next release). Having the
  adapter write the setting (it would fight a user's explicit off). Bypassing
  the gate in each read site (five upstream files).

### 6. Duplicates

- **Environments: no duplicates.**
  - A peer link isn't a client environment. It adds no catalog entry and no
    sidebar group.
  - The link carries the same `environmentId` as the fleet's saved connection.
    The client names it by the catalog label (`linkedEnvironmentNames`,
    `packages/client-runtime/src/linkRequest.ts`), and `linkableMachines`
    marks the catalog machine as `linked`.
  - Threads that native tools or remote `delegate_task` start on D are
    ordinary D threads, so they appear in the user's existing D group.
- **What does double.**
  - D's **Sharing & access** lists two entries for L: the desktop's client
    session from the fleet delivery, and the MCP session "T3 Code · L" from
    the link.
  - D's pairing-link list briefly shows the minted code. The existing fleet
    codes already appear there too.
- **Tools: no.** The ten `t3_lan_*` tools are registered beside upstream's in
  `McpHttpServer.ts`, but in-app threads don't see them (below), so they see
  only `t3_environment_*` and `environmentId` on the native tools.

Coexistence until retirement:

1. Fleet machines are adapter-owned: they never need the link card.
   `t3_environment_link` with a fleet `environmentId` returns `linked`. If a
   person links a fleet machine by hand, the adapter adopts the link and
   relinks it at the policy's access on its next pass. The hand-made session
   on D is not attributed, so the fleet never revokes it; revoke it in D's
   **Sharing & access**. The adapter never touches links to machines outside
   the fleet.
2. `LanToolkit` is hidden from in-app threads (Part H), by an `EnabledWhen`
   annotation (`hiddenFromThreads` in `McpInvocationContext.ts`). Routing
   refuses every thread caller anyway (`principal` in `EnvironmentRouting.ts`,
   since `ddfb97717d`), so hiding them took no reach from in-app threads.
   Outside clients, task-only grants (the deferred gateway) included, keep the
   tools, and the `taskOnlyTools` gate in `McpToolAccess.ts` is unchanged.
3. `lan-routing.json`, `EnvironmentRouting` and `RemoteTaskTransport` stay
   for the gateway only, with no in-app caller.

### 7. Retirement

| `t3_lan_*`              | Native equivalent (with `environmentId`)                                                                                   | Gap                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3_lan_environments`   | `t3_environment_links`; `t3_project_list` and `orchestrator_capabilities` for projects and models                          | No per-grant project, thread or model allowlist, and no `canLaunch`/`canOperate`: one access level per link                                                                                                    |
| `t3_lan_task_launch`    | `t3_thread_launch`, or `delegate_task` with `target.environmentId`                                                         | Allowlist as above. `delegate_task` remotely runs in the project's checkout only (no worktree isolation)                                                                                                       |
| `t3_lan_task_list`      | `t3_thread_list`                                                                                                           | The LAN tool lists only exposed or client-created threads. Native reads aren't fenced, so a link sees every thread on D                                                                                        |
| `t3_lan_task_read`      | `t3_thread_read`                                                                                                           | Same read-exposure difference                                                                                                                                                                                  |
| `t3_lan_task_send`      | `t3_thread_send` (`auto`, `queue`, `steer`, `restart`)                                                                     | None; native has more modes                                                                                                                                                                                    |
| `t3_lan_task_interrupt` | `t3_thread_interrupt` (`runId`, `stop`)                                                                                    | None                                                                                                                                                                                                           |
| `t3_lan_task_requests`  | `t3_pending_request` `list`/`read`                                                                                         | None for questions                                                                                                                                                                                             |
| `t3_lan_task_respond`   | `t3_pending_request` `respond`                                                                                             | None; neither can approve a permission request                                                                                                                                                                 |
| `t3_lan_task_observe`   | `t3_thread_wait` (long poll in 50-second pieces); for in-app parents, the `delegate_task` remote follower wakes the parent | No durable cursor or generation replay, no `reset_required`, no `taskWorkState` page, no external-assistant wake. The observation ledger (`RoutingStore.ts`, migrations 069 and 071) has no native counterpart |
| `t3_lan_events_ack`     | None                                                                                                                       | No ack ledger. Only the gateway needs it                                                                                                                                                                       |

For in-app agents, the gaps are the allowlist and the read-exposure
difference. Both are policy narrowing that the fleet policy (per machine, not
per project) does not express today. The ledger, ack and renewable task grants
are gateway concerns (rows 5, 6 and 10) and stay with the deferred gateway.

### 8. Proof plan

**Pair: CryoFrog links to PandaMedic, both on standard.** Neither machine is
read-only in the planned policy, so the mutating steps can run. AnvilToad (and
SPDevMachine) appear only in the optional read-only step. Prerequisites:

- LAN 1.0.26 or later is installed on CryoFrog and PandaMedic. The adapter is
  on by default there and on every other machine that has it.
- The fleet has a Machine access list (adopted from the starting list) that
  grants each of them standard toward the other.
- A test-only override shortens the renewal window
  (`T3CODE_LAN_PEER_LINK_RENEW_WITHIN`, a duration such as `31 days`).

| #   | Step                                                                                                                                                                                                                                                                           | Shows                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Baseline on both: the Linked environments list, Sharing & access sessions, fleet sync statuses, hashes of `lan-fleet-state.json` and `settings.json`, and the share file list                                                                                                  | Reference for the existing fleet links and settings                                                                                                                                                                              |
| 1   | Sync now on CryoFrog, then on PandaMedic, then CryoFrog again (or wait one adapter interval)                                                                                                                                                                                   | Request → mint → seal → link with no prompt on either side (answer 1). The link lists PandaMedic as `full-access` at its `https://…` fleet origin, expiring in about 30 days (answer 3). `settings.json` is unchanged (answer 5) |
| 2   | On PandaMedic: Sharing & access shows "T3 Code · CryoFrog", and the minted pairing code shows as used                                                                                                                                                                          | The session is attributed (Part C)                                                                                                                                                                                               |
| 3   | A CryoFrog thread calls `t3_environment_links`, then `t3_project_clone` into a new throwaway folder on PandaMedic and `t3_project_create`, both with `environmentId`                                                                                                           | Native discovery and project setup over the link                                                                                                                                                                                 |
| 4   | In that project: `t3_thread_launch` (cheapest model, "reply OK"), `t3_thread_wait`, a queued `t3_thread_send`, `t3_thread_interrupt` by `runId`, a question answered with `t3_pending_request`, then `delegate_task` to PandaMedic and a restart of CryoFrog's server mid-task | Parity for answer 7. The remote follower wakes the parent after the restart                                                                                                                                                      |
| 5   | Set the renewal override on CryoFrog and sync                                                                                                                                                                                                                                  | New `linkedAt` and `expiresAt`. PandaMedic has exactly one CryoFrog session; the old one is revoked (answer 2)                                                                                                                   |
| 6   | Change PandaMedic's policy for CryoFrog to read-only, then back to standard                                                                                                                                                                                                    | Narrowing: the old session is revoked at once, the relinked access is `read-only`, `t3_thread_send` is denied and `t3_thread_read` works. Widening returns to `full-access`. No prompts (answer 4)                               |
| 7   | Compare with step 0                                                                                                                                                                                                                                                            | Fleet client connections, their deliveries, the journal and the settings are unchanged (answer 6, and no existing fleet link touched)                                                                                            |
| 8   | On AnvilToad (1.0.26), sync                                                                                                                                                                                                                                                    | Links that involve AnvilToad have the access its policy says (`read-only`), and writes are denied                                                                                                                                |

Removal (a machine leaves the fleet) is proven by the adapter's integration
tests. A live check means disabling a roster entry, which pauses that
machine's fleet deliveries. Do it only with Dan's approval.

**Undo**, in order:

1. Add `"fleetLinkedEnvironmentsEnabled": false` to the server's
   `settings.json` on CryoFrog and PandaMedic (or on every machine to stop the
   adapter fleet-wide). This turns Linked environments back to its own Labs
   value, and on its next
   pass each machine forgets the link its adapter made and revokes the
   peer-link sessions and codes it issued ("T3 Code · CryoFrog" on PandaMedic).
2. Delete the throwaway threads and project (`t3_project_delete` with
   `environmentId`) and the clone folder.
3. Check that no `*.peer-link*.json` files for the pair remain on the share;
   delete any that do.
4. Remove that `false` again once the fleet should link.
5. Re-run step 0 and compare.

### How to run the proof

1. Place `fleet-access-seed.json` at any time (older builds ignore it), then
   install 1.0.26. It is adopted once every enabled machine has signed its
   1.0.26 marker, however long that takes; a machine that is off delays it
   until it is turned on and updated, or disabled in the roster. Until then
   Machine access lists the machines not yet on 1.0.26. Nothing is added to
   `settings.json`. What each machine sees during the rollout:
   [LAN machine links](../operations/lan-machine-links.md#rolling-out-1026-with-a-starting-list).
2. Run the table above. **Sync now** requests a pass after it finishes;
   otherwise passes run every 10 minutes, at startup, and on every policy or
   settings change. A first link takes two passes on each machine.
3. For step 5, start CryoFrog's server with
   `T3CODE_LAN_PEER_LINK_RENEW_WITHIN="31 days"`, sync both machines twice,
   then restart it without the variable. With the variable left set, the link
   renews on every pass.
4. Undo as listed above.

## Design

### Components

- **`FleetPeerLinks`** (`apps/server/src/lan/FleetPeerLinks.ts`): a scoped
  server service.
  - It runs a pass at startup, every 10 minutes, after each `LanFleet.sync`
    and `configure`, and on every access-policy or settings change.
  - It links nothing unless `fleetLinkedEnvironmentsEnabled` is on, fleet
    enrollment is active and shared-folder trust is on (`FleetContext.ts`),
    and it neither offers nor links until the fleet has a Machine access list.
    While the setting is off, each pass undoes what it made (answer 5). When
    the fleet cannot be read, it removes nothing, and a machine only missing
    from the trust check keeps its links until it stays missing (see
    [LAN machine links](../operations/lan-machine-links.md#machine-access)).
    A policy the share could not just give narrows no link; each call is
    still capped.
  - Each share file has one writer (L writes requests and receipts, D writes
    offers), so there is no share lock. Passes are serialized in-process. A
    session attributed during a pass never waits for it: the two machines
    may be linking to each other at the same moment.
  - Linking happens outside LanFleet's lock, so client sync never reports
    `busy` because of it.
- **`FleetPeerHttpClient`** (answer 3) holds the trusted peers' TLS identities,
  which each pass replaces. Off, the list is empty.
- **`FleetMcpOrigin`** (answer 3) is the D-side origin hook.
- **Share files** (signed and recipient-sealed with the existing keys), named
  by the same sender/recipient hash as deliveries (`peerLinkFileNames`):
  - `<L>-><D>.peer-link-request.json`, signed by L: request ID, `createdAt`
    and `expiresAt` (one hour). D decides the access, so L sends none.
  - `<D>-><L>.peer-link.json`: a `Delivery` whose header carries
    `purpose: "peer-link"` and whose payload carries the code, the `access` D
    granted and, from 1.0.26, the `policyRevision` it granted it under.
  - `<D>-><L>.peer-link.receipt.json`, signed by L.

  `FleetCatalog` isn't extended. Its signature covers a fixed field list
  (`FleetDelivery.ts:92`), and 1.0.23 machines would reject a catalog with a
  new field. That would break today's deliveries while the fleet is on mixed
  versions.

- **Local state** (`<stateDir>/lan-fleet-peer-links.json`): links L made
  (environment ID, access, delivery ID, `linkedAt`), outstanding requests,
  and, on D, each peer's offer, last linked access and attributed sessions
  with the access of the code each came from. There are no database tables,
  so no migration.

### Pass on L (for each trusted peer D with a TLS identity)

1. If `<D>-><L>.peer-link.json` exists, opens with L's key, verifies, has
   `purpose: "peer-link"` and a `policyRevision`, isn't expired and wasn't
   already used, call `PeerLinks.link` with `url: D.tls.origin`,
   `expectedEnvironmentId: D.environmentId`, `expectedLabel`, `pairingCode`
   and the granted `access`, lowered to L's own access if that is less. On
   success, write the receipt, delete the request and record the link. Any
   refusal, and an offer without a `policyRevision`, is recorded and the code
   isn't retried; an unreachable peer is retried on the next pass.
2. Unlink at once a link above L's own access. Want a link when it is missing,
   expired, unfenced, inside the renewal window, at a URL that isn't D's
   current `tls.origin`, not the link the adapter recorded (a hand-made one), or
   lowered to L's access when L's access has since widened. If so, write a
   request file, unless a fresh one is outstanding.
3. For each recorded link whose machine is no longer trusted, or whose roster
   entry is gone or disabled, call `PeerLinks.unlink`. Links the adapter
   didn't record and that aren't to fleet machines are never touched.

### Pass on D (for each trusted peer L)

1. Revoke L's attributed sessions whose code carried more than
   `accessFor(L)` now allows.
2. On L's receipt for the current offer, record the linked access, revoke L's
   other attributed sessions and delete the offer and receipt. Drop an offer
   that expired or is at another access, revoking its unused code.
3. With no offer outstanding, offer a code for a valid unanswered request
   from L, or unasked when L's last link is at another access or L holds no
   live session here. Revoke L's unused codes, mint with
   `createPairingLink({ ttl: 1h, subject: "lan-fleet-peer-link:<L>:<delivery ID>", scopes: mcpClientScopes(linkAccess(access)) })`,
   then seal the code to L.
4. When `consumeMcpApprovalCode` spends a `lan-fleet-peer-link:` code, the
   session that `exchangeCode` then issues is reported to `FleetPeerLinks`
   (Part C), which records it for L with its delivery's access. A session it
   cannot record is revoked and the sign-in fails.
5. When L leaves the fleet, revoke all its attributed sessions and unused
   codes, and delete its offer and receipt.

### Fleet status

`LanFleetSetupState` (or a sibling contract) gains a per-peer link status:
`linked`, `renewing`, `waiting for peer`, `peer needs update`, `linked
environments off here/there`, `no encrypted endpoint`. Fleet settings show it.
Links themselves stay in upstream's Linked environments list.

## Implementation plan

The parts in each wave can be built in parallel. ⚠ marks files the
access-policy work also touches (`LanFleet.ts`, `packages/contracts/src/lanFleet.ts`,
`McpToolAccess.ts`, the fleet settings UI).

**Wave 1 (independent):**

- **A. Pinned peer client (L).**
  - New `apps/server/src/lan/FleetPeerHttpClient.ts` and test.
  - New `apps/server/src/lan/FleetPeerTrust.ts`: trusted peers' `tls`
    identities from `FleetEnrollment.resolve` or private config, plus
    `connectHost` from catalogs, re-read with a short cache.
  - `apps/server/src/server.ts`: provide the layer to the peer group at
    `:793`.
  - Tests: pinned origin succeeds, a changed key fails, other origins pass
    through, and `redirect: "manual"` is kept.
- **B. OAuth public origin (D).**
  - `apps/server/src/auth/mcpOAuthHttp.ts` gets an optional
    `McpOAuthPublicOrigin`.
  - New `apps/server/src/lan/FleetMcpOrigin.ts`, backed by `FleetTransport`'s
    running origin.
  - `server.ts`: provide it.
  - Tests in `McpOAuth.test.ts` and an integration test through
    `startFleetProxy`: register, decision and token all succeed with an
    https resource.
- **C. Session attribution (D).**
  - `apps/server/src/auth/EnvironmentAuth.ts`: `consumeMcpApprovalCode`
    returns the grant's subject.
  - `apps/server/src/auth/McpOAuth.ts`: carry it on the pending code. After
    `issueMcpClientSession`, call an optional `McpPeerLinkSessionObserver`
    with `(subject, sessionId)`.
  - The fork's observer lives in `FleetPeerLinks`.
  - Tests: attribution happens only for `lan-fleet-peer-link:` subjects, and
    revoking an attributed session ends `/mcp` access.
- **D. Delivery format.** In `apps/server/src/lan/FleetDelivery.ts`
  (additive):
  - optional `purpose` in the header, covered by AAD and the signature
  - optional `access` in the payload
  - `PeerLinkRequest` sign and verify
  - `deliveryFileName` variants

  Tests: a peer-link delivery never opens as a client delivery, and the
  reverse holds too.

- **F. Gate default.**
  - `apps/server/src/serverSettings.ts`: a LAN-build default for
    `linkedEnvironmentsEnabled`.
  - Labs row copy in `apps/web/src/components/settings/LabsSettingsPanel.tsx`
    ("on by default in T3 Code LAN").
  - Test: unset is on, and an explicit `false` is kept.

**Wave 2 (after D, and after the access-policy work merges):**

- **E. Adapter.**
  - New `apps/server/src/lan/FleetPeerLinks.ts` and tests (passes on L and D,
    renewal, policy change, removal, mixed versions, offline peer, Labs off).
  - Extract config loading and trust (`resolveFleetBootstrap`, roster
    validation, `trusted()`) from `LanFleet.sync` into a shared
    `apps/server/src/lan/FleetContext.ts` ⚠ (`LanFleet.ts`).
  - Hook a pass after `sync` and `configure` ⚠ (`LanFleet.ts`).
  - Register it in `server.ts`.
  - Consumes the policy function and its change stream.

**Wave 3 (after E):**

- **G. Status.**
  - Peer-link status in `packages/contracts/src/lanFleet.ts` ⚠, or a new
    `lanFleetPeerLinks.ts` contract to avoid the conflict.
  - Show it in `apps/web/src/components/settings/LanFleetSettings.tsx` ⚠.
- **Docs.** Update `docs/operations/lan-machine-links.md` and
  `docs/maintenance/native-feature-sync.md` rows 2, 3 and 7.

**Wave 4 (built in 1.0.26):**

- **H. Tool coexistence.** `apps/server/src/mcp/toolkits/lan/tools.ts`: show
  the LAN tools only to callers outside a thread, via `EnabledWhen` and a helper in
  `McpInvocationContext.ts`. `McpToolAccess.ts` ⚠ keeps its `taskOnlyTools`
  gate unchanged.
- Check `AgentContextBudget.test.ts`, which measures the advertised tool set.

## Risks

- **Upstream churn.** Peer links are a nightly beta, and the sign-in flow,
  `PeerLinkCreateInput` or the gate may change. The hooks are optional
  services at three upstream seams (`server.ts` composition,
  `mcpOAuthHttp.ts`, the `McpOAuth`/`EnvironmentAuth` attribution) plus one
  default. Re-check them on each upstream sync, under row 2.
- **Mixed versions.** A machine without the adapter ignores the new files,
  and its peers show `peer needs update`. Nothing in today's catalog or
  delivery formats changes. A starting list waits until every enabled machine
  has said it runs 1.0.26, since 1.0.25 revokes a downgraded peer's fleet
  session at once, while 1.0.24 cannot take the replacement. 1.0.26 issuers keep that
  session, capped, until the peer uses its replacement
  ([LAN machine links](../operations/lan-machine-links.md#machine-access)).
  Offers from a 1.0.25 adapter, which carry no list revision, are never used.
- **Revocation depends on Part C.** Without it, each renewal leaves the
  superseded session valid on D until it expires (up to about 30 days). Its
  token is deleted on L, but a narrowed policy wouldn't be enforced on D
  until then. Ship C with E.
- **Gaps between revoke and relink.** A narrowed policy, or a link revoked by
  hand, breaks calls until the next pass (at most 10 minutes; immediate on a
  notification). Calls report the link error. They never fall back to
  plaintext or the old access.
- **Labs explicitly off** on either machine stops linking. That is
  intentional, and the status shows it.
- **No encrypted endpoint.** A peer without TLS, or with **Stop encrypted
  endpoint** set, gets no link. There is no plaintext fallback.
- **TLS identity change.** A new IP or a re-setup changes `tls.origin`; the
  adapter relinks to the new origin. A key change without fleet re-approval
  fails closed in the pinned client.
- **Runtime fetch compatibility.** Pinned requests use `undici.fetch` with a
  matching `Agent` rather than handing a dispatcher to the global fetch.
  Prove it on the Electron-hosted server runtime.
- **Clock skew.** Code TTLs (1 hour) and the 24-hour delivery cap assume
  clocks within minutes of each other, as the fleet already does.
- **Access-policy semantics.** Which direction "AnvilToad read-only" restricts
  is defined by the policy work. The adapter follows D's function, and the
  proof pair avoids depending on that answer.
- **`full-access` mapping.** Parity means unfenced linked work on D (answer
  4). Dan decides between `full-access` and `auto`.
