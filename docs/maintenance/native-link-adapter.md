# Fleet-managed native link adapter

Design for letting in-app agents work on other fleet machines through
upstream's linked environments (peer links), with the fleet doing the pairing,
renewal and removal. It replaces the in-app use of the `t3_lan_*` tools
([native feature sync](native-feature-sync.md) rows 2–4 and 7). Status:
proposed design, not implemented. Evidence is from fork `main` at `bb224f99b`
(upstream `9826dbb99`); `apps/server/src/peer` is unmodified from upstream.

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
- an MCP OAuth public origin for requests addressed to the fleet TLS endpoint
  (`mcpOAuthHttp.ts`)
- attribution of a pairing-code session to its fleet code (`McpOAuth.ts`,
  `EnvironmentAuth.ts`)
- a LAN-build default for `linkedEnvironmentsEnabled` (`serverSettings.ts`)

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
| `linkedEnvironmentsEnabled` on L (`PeerLinks.ts:402`) and on D (registration, `McpOAuth.ts:340`; `/mcp`, `McpHttpServer.ts`)                                            | LAN default on                                                            | answer 5 |
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
   `FleetTransport`. When the request's `Host` equals the running fleet TLS
   origin's host, the issuer and resource use that https origin.
   - A spoofed `Host` only renames the resource: the code, PKCE and pairing
     code are still required.
   - Setting `x-forwarded-proto` in the proxy instead was rejected. It would
     change `toURL` for DPoP, WebSocket and HTTP auth on every existing fleet
     client connection (`dpop.ts`, `EnvironmentAuth.ts`, `http.ts`, `ws.ts`).

Rejected: a server-side loopback gateway that reuses `startFleetProxy` as the
desktop does (`DesktopFleetGateway.ts`). Its port changes with every start, so
stored link URLs would go stale. Its resource would also never match, because
L would send `http://127.0.0.1:<port>/mcp`.

### 4. Access

The adapter asks D's access-policy function ("access for a peer
environment", provided by the access-policy work) what L may do on D. D is
authoritative: it mints the code's scopes and returns the granted access in
the sealed payload, and L links with exactly that. The adapter does not decide
which direction a per-machine "read-only" flag means; the policy work defines
that. Whichever it is, the effective value for the pair is what D's function
returns.

| Fleet policy | `AuthMcpClientAccess` | Code scopes (`mcpClientScopes`)                                                         |
| ------------ | --------------------- | --------------------------------------------------------------------------------------- |
| read-only    | `read-only`           | `orchestration:read`                                                                    |
| standard     | `full-access`         | `orchestration:read`, `orchestration:operate`, `settings:write`, `source-control:write` |

**`full-access` is the level that matches fleet standard today.**

- A standard fleet code carries `AuthStandardClientScopes` (`LanFleet.ts:293`),
  which includes `settings:write`, `source-control:write`, terminal and
  `access:write`.
- Through that connection, a person can start full-access threads and change
  projects and settings.
- Every lower native level is fenced (`apps/server/src/mcp/linkOrigin.ts`):
  linked work may change only threads that link started, and may not change
  projects, settings or scheduled runs.
- Each forwarded call is still capped at the calling agent's own runtime and
  interaction modes (`T3-Mode-Limit`).

If the owner prefers the fence over parity, map standard to `auto`. That gives
up only settings and source-control writes and unfenced changes. **Decision
for Dan.**

A policy change takes effect without approval:

- D's adapter subscribes to the policy's change notifications. For each
  affected peer it mints a code at the new access and seals it to L as an
  unsolicited offer.
- When access is narrowed, D also revokes L's attributed link sessions at
  once (Part C). Calls fail until L relinks, never with the old access.
- When access is widened, the old session stays until L's relink succeeds.
- L's adapter consumes the offer on its next pass, or immediately when it
  handles the same notification. `PeerLinks.link` then replaces the row with
  the new `access`.
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
- **Recommendation.** For LAN builds (`isLanDistribution`), override the
  setting's default to `true` in `apps/server/src/serverSettings.ts`, where
  defaults are merged.
  - Settings are stored sparse, with defaults stripped, so an unset value
    becomes on and an explicit `false` is kept.
  - The Labs switch stays and works. Turning it off stops the adapter and
    upstream links, and the fleet status reports it.
  - No setting is written on any machine, and no upstream read site changes.
- **Rejected.** Having the adapter write the setting (it would fight a user's
  explicit off). Bypassing the gate in each read site (five upstream files).

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
- **Tools: yes, until coexistence is handled.** In-app sessions on every
  machine get both the ten `t3_lan_*` tools (registered beside upstream's in
  `McpHttpServer.ts`) and, once links are on, `t3_environment_*` and
  `environmentId` on the native tools. Without `lan-routing.json`, every
  `t3_lan_*` call is denied, so agents see working native tools next to dead
  LAN tools.

Coexistence until retirement:

1. Fleet machines are adapter-owned: they never need the link card.
   `t3_environment_link` with a fleet `environmentId` returns `linked`. If a
   person links a fleet machine by hand, the adapter adopts the link and
   relinks it at the policy's access on its next pass. The adapter never
   touches links to machines outside the fleet.
2. After the proof, hide `LanToolkit` from sessions that aren't task-only
   (Part H). Use an `EnabledWhen` annotation like upstream's
   `hiddenWhileLinksOff`. Task-only grants (the deferred gateway) keep the
   tools, and the `taskOnlyTools` gate in `McpToolAccess.ts` is unchanged.
   This avoids running two sources of truth for in-app agents.
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

- Parts A–F are built.
- The candidate build is installed on CryoFrog and PandaMedic only.
- The policy grants each of them standard toward the other.
- A test-only override shortens the renewal window
  (`T3CODE_LAN_PEER_LINK_RENEW_WITHIN`, added in Part E).

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
| 8   | Optional: install on AnvilToad and sync                                                                                                                                                                                                                                        | Links that involve AnvilToad have the access its policy says (`read-only`), and writes are denied                                                                                                                                |

Removal (a machine leaves the fleet) is proven by the adapter's integration
tests. A live check means disabling a roster entry, which pauses that
machine's fleet deliveries. Do it only with Dan's approval.

**Undo**, in order:

1. Turn **Linked environments** off in Labs on CryoFrog and PandaMedic. This
   stops the adapter, which would otherwise relink.
2. **Forget** the link on CryoFrog.
3. Revoke "T3 Code · CryoFrog" in PandaMedic's Sharing & access.
4. Delete the throwaway threads and project (`t3_project_delete` with
   `environmentId`) and the clone folder.
5. Delete the pair's `*.peer-link*.json` files from the share, and
   `lan-fleet-peer-links.json` on both machines.
6. Reinstall the current release if needed, and set Labs back to unset.
7. Re-run step 0 and compare.

## Design

### Components

- **`FleetPeerLinks`** (new, `apps/server/src/lan/FleetPeerLinks.ts`): a
  scoped server service.
  - It runs a pass at startup, every 10 minutes, after each `LanFleet.sync`
    and `configure`, and on access-policy change notifications.
  - It does nothing unless fleet enrollment is active, shared-folder trust is
    on, and `PeerLinks.enabled`.
  - Share I/O happens under its own lock, `lan-fleet-peer-links.lock`.
    Network linking happens outside every lock, so client sync never reports
    `busy` because of it.
- **Share files** (signed and recipient-sealed with the existing keys):
  - `<L>-><D>.peer-link-request.json`, signed by L: request ID, the access L
    expects, `createdAt` and `expiresAt`.
  - `<D>-><L>.peer-link.json`: a `Delivery` whose header carries
    `purpose: "peer-link"` and whose payload carries the code and the
    `access` D granted.
  - `<D>-><L>.peer-link.receipt.json`, signed by L.

  `FleetCatalog` isn't extended. Its signature covers a fixed field list
  (`FleetDelivery.ts:92`), and 1.0.23 machines would reject a catalog with a
  new field. That would break today's deliveries while the fleet is on mixed
  versions.

- **Local state** (`<stateDir>/lan-fleet-peer-links.json`): machines L has
  linked (environment ID, access, delivery ID, `linkedAt`), outstanding
  requests and offers, and, on D, the session IDs attributed to each peer.
  There are no database tables, so no migration.

### Pass on L (for each trusted peer D)

1. Want a link when D is trusted, has a TLS identity with its endpoint
   enabled, and the link is one of: missing, expired, unfenced, inside the
   renewal window, failing with a revoked or unauthorized error, at an access
   that differs from D's last offer, or at a URL that isn't D's current
   `tls.origin`. If so, write a request file, unless a fresh one is
   outstanding.
2. If `<D>-><L>.peer-link.json` exists, opens with L's key, verifies, has
   `purpose: "peer-link"` and isn't expired, call `PeerLinks.link` with:
   `url: D.tls.origin`, `expectedEnvironmentId: D.environmentId`,
   `expectedLabel`, `pairingCode` and the granted `access`. On success, write
   the receipt, delete the request and record the link. On
   `pairing_rejected`, `incompatible` or `disabled`, record the reason for
   fleet status and don't retry until the next offer.
3. For each recorded link whose machine is no longer trusted, or whose roster
   entry is gone or disabled, call `PeerLinks.unlink`. Links the adapter
   didn't record and that aren't to fleet machines are never touched.

### Pass on D (for each trusted peer L)

1. For a valid request from L, or a policy change for L: compute
   `access = accessForPeer(L)` and mint with
   `createPairingLink({ ttl: 1h, subject: "lan-fleet-peer-link:<D>-><L>", scopes: mcpClientScopes(access) })`.
   Then seal the code to L and record the delivery.
2. When `consumeMcpApprovalCode` spends a `lan-fleet-peer-link:` code, the
   session that `exchangeCode` then issues is reported to `FleetPeerLinks`
   (Part C), which records it for L.
3. On L's receipt, revoke L's older attributed sessions and delete the
   delivery. On a narrowed policy, revoke all of L's sessions at once. When L
   leaves the fleet, revoke them all, and revoke any unused codes for L with
   `revokePairingLink`.

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

**Wave 4 (after the proof and Dan's approval):**

- **H. Tool coexistence.** `apps/server/src/mcp/toolkits/lan/tools.ts`: show
  the LAN tools only to task-only clients, via `EnabledWhen` and a helper in
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
  delivery formats changes.
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
