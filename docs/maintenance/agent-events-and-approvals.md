# Agent events and approvals for outside agents

Design and validation plan for two gaps found when Dan's OpenAI dot, Gecko
Butler, drove the fleet through BuildMachine's `/mcp` (OAuth sign-in from
[outside agents](../user/outside-agents.md), reached through a Cloudflare
tunnel):

1. **No incoming events.** Nothing woke the dot when a native approval
   appeared; it learned everything by polling.
2. **No supported way to submit a permission approval.** Dan approved
   "Allow Codex to use Google Chrome?" verbally, but no MCP tool can answer a
   provider permission request.

[Native feature sync](native-feature-sync.md) rows 4 and 5 point here. Status:
**phase 0 built on `lan/agent-events-phase0`, awaiting review and the live wake
test; phases 1–4 are design only.** [Phase 0 as built](#phase-0-as-built) is
authoritative where it differs from the design below. Evidence comes from fork
`main` at `7547aa4a5` (upstream `1854e14d0`), effect `4.0.5`, the task-owner
work in progress on `lan/task-owners` (read from its worktree, uncommitted on
2026-10-30), and OpenAI's
[MCP Events](https://developers.openai.com/plugins/build/mcp-events) page as
read on 2026-10-30.

## Summary

**Events.** BuildMachine's `/mcp` becomes an MCP 2.0 (`2026-07-28`) server that
advertises `capabilities.events` and implements `events/list`,
`events/subscribe` and `events/unsubscribe`, with Standard Webhooks delivery
as OpenAI specifies. Every machine derives a small, durable **fact log** from
its committed orchestration events: approvals, questions, blockers, finished
runs and owner changes. Fact IDs are deterministic, so re-deriving a fact after
a restart never produces a second event. BuildMachine pulls each linked peer's
fact log over the existing peer link with a link-only read tool and folds those
facts into its own log. A per-subscription outbox delivers each matching fact
once per subscription, with retries, replay cursors, `truncated`, and access
rechecks. Owner identity is part of every payload and is never used to filter.
The fact log replaces the fork's `RoutingStore` observation inbox, so there is
still one ledger.

**Approvals.** A new fork tool, `t3_approval_request` (`list`, `read`,
`respond`), answers exactly one pending provider approval with `accept` (the
provider's narrowest "once") or `decline`. The call must carry the request's
`presentationDigest`, a hash of exactly what was shown, plus the person the
approval is for and their words. Only outside clients whose grant carries a new
opt-in scope, `orchestration:approve`, may call it. The scope is off by default
and offered on the sign-in page for Supervised and above. The tool goes through
the same `runtime-request.respond` command the UI uses, so every native check
still runs. Single use is enforced twice: by the orchestrator's pending → resolved
transition, and by a receipts table. The resolved request records who approved,
for whom and via which machine, and the thread shows it. Through a native link,
BuildMachine checks the dot's grant before forwarding, and the receiving
machine separately requires its link to carry `orchestration:approve`.

Approvals can ship before events. A short transport and wake probe goes first,
because whether the dot actually wakes on MCP Events is the largest unknown and
the cheapest to test.

## Phase 0 as built

Everything is behind the per-machine `agentEventsEnabled` server setting (off
by default). Turning it on needs a restart, because `/mcp` fixes its protocol
list at startup. Turning it off stops answering `events/*` and stops delivery
at once.

### What runs

- **Protocol** (`mcp/McpHttpServer.ts` `layerMcpTransport`). With the setting
  on at startup, `/mcp` registers `2026-07-28` beside `2025-06-18`. Peers and
  existing clients keep `2025-06-18`.
- **Endpoint** (`mcp/events/McpEventsEndpoint.ts`). It runs inside the `/mcp`
  auth middleware, after authentication, the mode-limit check and the
  links-off refusal. It handles four kinds of request:
  - `events/list`, `events/subscribe` and `events/unsubscribe` on
    `2026-07-28`;
  - the same three methods inside a `2025-06-18` session that this endpoint saw
    `initialize` create, for the same signed-in session;
  - `server/discover` (`2026-07-28`) and session `initialize`, whose results
    effect builds and the endpoint then gains `capabilities.events: {}`. OpenAI
    documents events on both. An unexpected result shape is logged as a
    warning and left unpatched.

  Every other request, and every request while the setting is off, reaches
  effect unchanged.

- **Admission** (`mcp/events/McpEventsAdmission.ts`). An events request is
  answered only when effect 4.0.5 would admit it if the method were its own:
  - no browser `Origin`, a JSON `Content-Type`, and an `Accept` that includes
    both JSON and SSE;
  - a single JSON-RPC 2.0 request with a string or numeric id;
  - the version header and the `_meta` protocol claim agree, client
    capabilities are present, and `Mcp-Method` matches;
  - effect's own metadata decoder (`McpProtocol.v2026_07_28.runtime.profileFromRequestMetadata`)
    accepts the metadata.

  It may only be stricter than effect. Everything else, including malformed
  JSON, batches, notifications, unsupported versions and mismatched headers,
  goes to effect, which answers with its own error.

- **Who may call.** Outside OAuth clients only. Thread callers
  (`McpSessionRegistry`), linked peer sessions and task grants get `-32024`.
  Subscribe also needs the outside-sharing bar (below).
- **Store** (`agentEvents/AgentEventStore.ts`, migration 081). These are plain
  SQL functions, so the CLI, a second process on the same WAL database, uses
  the same code as the server.
- **Delivery worker** (`agentEvents/AgentEventDelivery.ts`). It polls every
  second and wakes early after a subscribe.
  - At most one request is in flight per subscription and four overall, each
    taking the subscription's lowest due sequence.
  - The worker owns its sends: a shutdown interrupts them, and a send left
    `sending` goes again on the next start with the same event id.
  - It sweeps every 60 seconds, and at once when a session is removed or fleet
    access changes. It prunes hourly and removes orphaned secret files at
    startup.
- **Sender** (`agentEvents/WebhookSender.ts`).
  - Standard Webhooks headers, and both signatures during a 10-minute rotation
    overlap.
  - HTTPS only. Every answer from one DNS lookup must pass
    `packages/shared/src/publicAddress.ts`, and the socket may connect only to
    those answers, with the original hostname kept for SNI and the certificate
    check.
  - Redirects are never followed; a 3xx is a verification failure
    (`redirect_refused`) and a retried delivery failure.
  - A 10-second timeout, and response bodies are capped at 64 KiB.
  - The dev harness's loopback exception
    (`T3CODE_AGENT_EVENTS_ALLOW_LOOPBACK_CALLBACKS=1`) is ignored, with a
    warning, unless the server has a `devUrl`.
- **CLI** (`cli/agentEvents.ts`):
  - `t3 agent-events status [--json] [--deliveries N]` lists the log head and
    floor, then each subscription: state, ended reason, client, session,
    arguments, redacted callback, `refreshBefore`, cursor, rotation, and its
    delivery counts. For each recent delivery it shows the event id, sequence,
    state, attempts, last status and error, and the last and next attempt. No
    secret, and no callback query string, is ever printed.
  - `t3 agent-events probe --subscription <sub_…> [--nonce <text>] [--note <text>]`
    queues one probe event.

### Subscriptions

- **Principal.** The principal is `session:<sessionId>`, the session that the
  sign-in approved.
  - Outside OAuth sessions have no refresh, so the session is the whole
    lineage. A second sign-in of the same app (same deterministic OAuth client
    id) is a different principal, with its own subscriptions.
  - A subscription stops when its session is revoked or expires. To renew
    after re-signing in, the client subscribes again.
  - Fleet attribution (`attribution_subject`, the session's subject) and the
    client label are stored beside the principal and never form it. The
    attribution must still match at delivery time.
  - Renewable grants are task-only and refused; a non-task grant would own as
    `grant:<grantId>`.
- **Outside-sharing gate** (`agentEvents/AgentEventAuthority.ts`). This is
  checked at subscribe and refresh, before every attempt and by the sweep,
  always from `SessionStore.listActive` and never from the subscribing
  request. All of these must hold:
  - the session is an active bearer MCP-client session;
  - after `CredentialAccessCap`, it still holds `orchestration:read`;
  - a fleet-attributed credential also holds `orchestration:operate`, so
    read-only fleet credentials are refused;
  - `CredentialAccessCap.administersFleet` is true. That is the bar `ws.ts`
    `sharingOutside` uses for guest shares and webhook URLs, so exception-only
    fleet credentials are refused.

  When authority cannot be established, the result fails closed: subscribe
  returns `-32603` and nothing is stored, and a delivery waits 30 seconds
  without sending. A refusal at delivery or sweep time makes the subscription
  `revoked`, drops its queue and deletes its secret.

- **TTL.** The default is 24 hours, bounded to 1 hour–7 days and never past the
  session's expiry. `ttlMs: null` still gets a finite grant.
- **Expiry.** Delivery stops exactly at `refreshBefore`, with no grace period.
  The claim query requires `expires_at > now`, and the time is checked again
  just before sending.
  - The sweep marks the subscription `expired` and keeps its queue, so a later
    subscribe resumes it.
  - An expired, gone or unsubscribed subscription becomes `active` again when
    its principal subscribes again.
- **Secrets.** Each secret gets a fresh flat `ServerSecretStore` name
  (`agent-events-<hash>-<random>`), so no subdirectory is needed.
  - Crash safety: the file is written before any row points at it, and files
    no row names are removed at startup once they are more than 10 minutes
    old.
  - A changed secret signs beside the old one for 10 minutes; the old one is
    then retired and deleted.
  - Unsubscribe, revocation and 410 delete the secret.
- **Verification.** Each subscribe sends a fresh single-use 32-byte challenge,
  signed with the new secret, and compares the echo in constant time. A
  success is trusted for 24 hours per principal and URL. A 410 clears that
  trust.

### Events, cursors and the probe

- **One log.** `agent_event_log_state` holds a random epoch, `head_seq` and
  `floor_seq`. Phase 0's only events are probes (`agent_event_probes`), and
  each takes its sequence from `head_seq`. Phase 2's facts will take theirs
  from the same counter, so cursors and the epoch stay valid when facts
  arrive.
- **Probes are replayable.**
  - A probe is a `t3.agent-event/1` envelope with `kind: "probe"`, null
    `thread`, `run` and `owner`, and `detail { nonce, note, subscriptionId }`.
    It targets one subscription only.
  - The body is fixed when the probe is made and stored with its occurrence
    time, so it survives restarts.
  - The event id is `eventIdFor("probe", factKey, "1")`, with factKey
    `probe:<env>:<subscriptionId>:<nonce>`. Re-running the CLI with the same
    nonce changes nothing.
- **Body.** `{ eventId, name, timestamp, data, cursor }`, built once by
  splicing the stored `data` in unchanged; those exact bytes are signed.
  - `timestamp` is the occurrence time and never changes.
  - Only `webhook-timestamp` and the signature change between attempts, and
    they change only when an attempt falls in a later second, since signing
    times are whole seconds.
- **Cursors.** A cursor is `c1.<epoch>.<seq>`.
  - **Watermark.** A subscription's watermark is recomputed each time it is
    needed, never carried forward: one less than its lowest unfinished
    (`pending` or `sending`) sequence, or the head when nothing is unfinished.
    A delivery body's `cursor` is capped the same way, so it never passes an
    earlier event that is still retrying.
  - **`cursor: null`.** The watermark is the head, and nothing is replayed.
  - **Same epoch.** Events after the cursor are requeued. Delivered ones are
    requeued too when the cursor is below the watermark (the client lost
    them), or the subscription is new or from another epoch. The returned
    cursor is then recomputed, so it falls back below the requeued events.
  - **Another epoch, or below `floor_seq - 1`.** What is retained is replayed,
    with `truncated: true`.
  - **Ahead of the head.** The call fails with `-32602`.
- **Retention.** Logged events go after 14 days or 50,000 sequences, but never
  while a delivery for them is unfinished; the floor rises past each pruned
  sequence. Finished deliveries, ended subscriptions and verifications go
  after 7 days, 7 days and 24 hours.
- **Responses.**

  | Callback answer                                  | Result                                                                                      |
  | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
  | 2xx                                              | `delivered`                                                                                 |
  | 410                                              | The subscription is `gone`: queue dropped, secret and verification removed, nothing retried |
  | 413                                              | That event is `rejected`, never retried                                                     |
  | 429                                              | Retried after `Retry-After` (seconds or a date, kept to 5 s–8 h)                            |
  | Anything else, a network or TLS error, a timeout | Retried at 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, then every 8 h, ±20%            |

  An event still failing 48 hours after it was queued is `abandoned`. A body
  over 256 KiB is `rejected` without being sent.

### Running the live wake test (L0–L2)

On BuildMachine only, with Dan:

1. Install the phase 0 build. Set `"agentEventsEnabled": true` in that
   machine's server settings, then restart T3.
2. **L0.** In ChatGPT, rescan the T3 Code app. Pass when the plugin page lists
   `t3.task_activity` and the server log shows `server/discover` or
   `initialize` and `events/list`.
3. **L1.** Dan asks the dot, in a fresh chat, to "watch T3 for anything that
   needs me". On BuildMachine, run `t3 agent-events status`. Pass when it shows
   one `active` subscription for `t3.task_activity` `{}` from the dot's
   client, with a `refreshBefore` in the future. (The callback was verified,
   or the subscription would not exist.) Note its `sub_…` id.
4. **L2.** After at least 30 minutes of chat idle, run:

   ```sh
   t3 agent-events probe --subscription <sub_…> --nonce <random-word>
   ```

   Then run `t3 agent-events status` until the probe's delivery shows
   `delivered` with last status 2xx, and record the time.

   Pass when the dot posts in that chat, unprompted, quoting the nonce.
   Record the latency from the `queuedAt` time to the dot's message. Repeat
   once with a new nonce.

5. If the dot does not wake but the delivery shows 2xx, ChatGPT received the
   event and did not wake on it: stop and revisit the plan with Dan. If the
   delivery keeps retrying, `status` shows the last HTTP status or error
   (`address_refused`, `tls_error`, `timeout`, `http_<n>`).

Use `--base-dir` (or `--dev-url`) on both commands when the server's home is
not the default. The probe never touches a thread or an agent.

### Divergences from the design below

- **Subscription table.** It is keyed and owned by the session principal, not
  by `mcpClientSubject` plus `client_id` (review item 5). A re-sign-in does not
  keep a subscription.
- **Deliveries.** `agent_event_deliveries` references log sequences. Phase 0
  logs only probes, in `agent_event_probes`, which phase 2 extends to facts
  under the same sequence counter. The design's 083 `agent_event_log_state`
  moves into 081, with `head_seq` added.
- **Expiry.** Delivery stops at `refreshBefore` itself, not ten minutes after.
- **Status tool.** The diagnostic is the `t3 agent-events status` CLI. The
  `t3_agent_events` MCP status tool stays in phase 2.
- **Events on `2025-06-18`.** Events are also served inside `2025-06-18`
  sessions and advertised on `initialize`, because OpenAI documents both.
- **Unknown cursor.** A malformed cursor or an unknown cursor version is
  `-32602`.

### Review changes

These are the changes made for the design review (Astra ultra):

1. **Transport admission.**
   - `events/*` are no longer intercepted before effect's checks. The
     admission reproduces effect's Origin, media-type, JSON-RPC, version,
     metadata, capability and routing-header checks, and calls effect's own
     metadata decoder. Anything it does not admit reaches effect unchanged.
   - A parity matrix in `McpEventsEndpoint.test.ts` pins, for 19 request
     variants, that `events/list` is admitted exactly when effect admits
     `tools/list`. Every rejection must equal effect's answer for an unknown
     method, byte for byte. The variants include missing or conflicting
     metadata and routing headers, malformed JSON, batches, notifications,
     unsupported versions and browser Origins.
   - Both protocols are tested.
   - A pin test fails if effect starts advertising or routing events itself.
   - Discovery with an unexpected shape logs a diagnostic.
   - `FleetMcpOrigin` is untouched, and no forwarded header is trusted.
2. **Outside-sharing gate.** The `administersFleet` bar from `ws.ts`
   `sharingOutside` applies at subscribe, refresh, every attempt and every
   sweep. Read-only and exception fleet credentials are refused, and the gate
   fails closed.
3. **Expiration and replay.**
   - Delivery stops exactly at expiry.
   - The occurrence `timestamp` is immutable; only the signing time changes.
   - Cursors are recomputed after a replay, so a replay below the watermark
     returns a lower cursor.
   - A pending payload is kept while a delivery references it.
   - A cursor ahead of the head is refused.
4. **A complete phase 0.**
   - The probe body is durable in `agent_event_probes`, and probes are
     replayable with non-null cursors.
   - The expiry and revocation sweeps run in phase 0.
   - `t3 agent-events status` provides the diagnostics, with no secrets.
   - Secrets use flat names, crash-safe rotation and orphan cleanup.
   - Auth and registration edits are limited to one middleware hook and the
     protocol list in `McpHttpServer.ts`, plus the layer in `server.ts`. No
     `auth/` file changed.
5. **Principal.** Ownership is the approving session, kept separate from fleet
   attribution and app identity. A second sign-in of the same app gets its own
   subscriptions, and revoking the session stops delivery.
6. **SSRF tests.** Real-socket tests cover:
   - the address actually reached;
   - mixed public and private answers;
   - IPv4-mapped, NAT64 and ULA forms;
   - DNS rebinding (exactly one lookup, connecting to the checked address);
   - TLS hostname checks and redirect refusal.

## Findings

### F1. The MCP transport

- `apps/server/src/mcp/McpHttpServer.ts` `layerMcpTransport` registers
  `McpServer.layerHttp({ protocols: [McpProtocol.v2025_06_18], … })`.
  **T3 serves only `2025-06-18`.** `PeerMcpClient.ts` hard-codes the same
  version ("The only MCP protocol version a T3 Code `/mcp` registers").
- effect 4.0.5 already ships a `2026-07-28` adapter
  (`effect/src/ai/internal/mcpProtocol/v2026_07_28.ts`) with a stateless
  `server/discover` handler. `layerHttp` accepts stateful and stateless
  protocols together. In that adapter, `getDiscovery` builds `capabilities`
  only from `completions`, `logging`, `tools`, `resources`, `prompts` and
  `extensions` (`ServerCapabilities` is a `StructWithRest`, but nothing sets
  extra keys). There is no `events` capability and no `events/*` method. Any
  unknown method gets `MethodNotFound` (`McpServer.ts` ~1176). So the earlier
  observation holds for T3 as deployed: effect knows the version string, but
  T3 never negotiates it, and neither effect nor T3 has events.
- We own the `/mcp` middleware (`makeMcpAuthMiddleware`), which already
  authenticates every POST and builds `McpInvocationContext`. On Node,
  `NodeHttpIncomingMessage.text` is memoised (`textEffect`), so the middleware
  can read the JSON-RPC `method` and still let effect's handler read the same
  body.

### F2. Provider permission requests today

- **Shape.** `OrchestrationV2RuntimeRequest` (`packages/contracts/src/orchestrationV2.ts`)
  has `kind` set to a `ProviderRequestKind` (`command`, `file-read`,
  `file-change`, `mcp-elicitation`, `permission`) or one of `user_input`,
  `dynamic_tool_call` and `auth_refresh`. It also carries `status`
  (`pending|resolved|expired|cancelled`) and `responseCapability`. `live`
  responses need the provider session that raised the request. What the user
  sees is the `approval_request` turn item: `requestKind`, `prompt`, `reason`,
  `appName`, `fullAccessOverride` (`ask_rule|provider_check`) and `options`
  (`ProviderApprovalOption`: `decision`, `label`, `warning`). Decisions are
  `accept`, `acceptForSession`, `acceptAlways`, `decline` and `cancel`
  (`providerPolicy.ts`).
- **Codex.** `CodexAdapterV2.ts` handles these requests:
  - `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
    `item/permissions/requestApproval`, `mcpServer/elicitation/request`, and
    the legacy `execCommandApproval` and `applyPatchApproval`.
  - Each one becomes artifacts (`buildApprovalRequestArtifacts`) plus an
    in-memory `Deferred`. Approvals are **live only**: after a restart the
    deferred is gone, so the request cannot be answered.
  - A permissions `accept` maps to `scope: "turn"` and `acceptForSession` to
    `"session"` (`permissionsResponseFromDecision`).
  - The "Allow … to use Google Chrome?" prompt is an MCP elicitation.
    `describeMcpElicitation` (`provider/CodexMcpElicitation.ts`) offers Cancel,
    Decline, optionally "Always allow this session" or "Always allow", and
    Approve (`accept`, no persistence). URL-mode elicitations always map
    `accept` to `decline`.
- **How the UI answers.** The web client sends
  `orchestration.dispatchCommand` (scope `orchestration:operate`,
  `auth/RpcAuthorization.ts`) with `runtime-request.respond`.
  `Orchestrator.dispatchRuntimeRequestRespond` (~8650) checks:
  - the request exists;
  - it is `pending`;
  - it is not `not_resumable`;
  - its live provider session exists;
  - feedback is allowed only for a live, decline-with-text approval that
    supports it;
  - the provider for the project is enabled (message-mode answers).

  It then marks the request resolved and queues a `runtime-request.respond`
  effect. `EffectWorker` sends that to the adapter's deferred, and a delivery
  failure records `runtime-request.delivery.fail`.

- **Gaps in those checks.** The orchestrator does **not** check that the
  decision is one of the item's `options`, and the command carries **no
  actor**. The UI only offers listed options, and the responder is implicitly
  the signed-in user. An MCP path needs both checks.

### F3. `t3_pending_request`

It lives in `apps/server/src/mcp/toolkits/thread/{tools,handlers}.ts`, not in
`OrchestratorMcpService`. It handles `list`, `read` and `respond` for
`user_input` requests only, and its description says it "cannot approve a
permission request". Writes go through `writesThread` (`McpToolAccess.writesThreads`),
and `environmentId` makes `routed()` forward the call to a linked environment.
Upstream deliberately keeps approvals out of it. Extending it would edit an
upstream file and change an upstream contract that a peer running stock T3
would interpret differently. A separate fork tool avoids both problems (see
[Approval tool](#approval-tool)).

### F4. The client grant model

- **Access levels.** `AuthMcpClientAccess` is `read-only`, `approval-required`
  (shown as **Supervised**), `auto-accept-edits`, `auto` or `full-access`.
  `mcpClientScopes` maps read-only to `orchestration:read`, full access to
  read, operate, `settings:write` and `source-control:write`, and every other
  level to read plus operate.
- **Session record.** `EnvironmentAuth.issueMcpClientSession` stores the
  scopes and a `runtimeModeCeiling`. `authenticateMcpClient` derives `access`
  from them after the fleet's `CredentialAccessCap` (`accessCap.scopes`), so a
  fleet policy can narrow a credential without reissuing it.
- **Sign-in page.** `McpOAuth.approve` refuses scopes the approving browser
  session or pairing code does not hold. Fork task grants (`taskOnly`,
  renewable) are confined to `t3_lan_*` by `McpToolAccess.gateTaskOnly`.
- **Write paths.** A read-only client is refused every write
  (`refuseReadOnlyClient`). `writesThreads` checks the target thread is within
  the caller's modes (`assertTargetWithinLimits`) and in the same link
  (`assertSameLink`), then passes `DispatchModeLimit` so the orchestrator
  rechecks under lock.
- **Requester side of a link.** `PeerForwarding.callerLimits` refuses linked
  callers (no chaining) and sends the caller's modes as `T3-Mode-Limit`.
  `PeerMcpClient` refuses writes while this machine's Machine access list makes
  the destination read-only (`PeerWriteCeiling`).
- **What the receiver sees.** Only the link's own credential: "the peer sees
  only the link's credential".
- **Fleet links.** Fleet standard maps to `full-access` links, which the
  `linkOrigin` fence does not cover
  ([native link adapter §4](native-link-adapter.md#4-access)).

### F5. The fork's existing event ledger

`t3_lan_task_observe` / `t3_lan_events_ack` (`EnvironmentRouting.ts`,
`RoutingStore.ts`, migrations 069 and 071) is a **pull** ledger:

- It is keyed by principal × thread for threads the gateway owns
  (`lan_owned_threads`).
- It ingests a page of thread events only when someone calls `observe`.
- It answers only `t3_lan_*` callers.
- It reports `wakeDelivery: "unsupported"`.

It cannot capture anything while nobody is asking, so it cannot drive push.
The dot does not use it at all: it uses native tools with `environmentId`.

### F6. Event sources

- `EventSink.stream({ afterSequence })` replays committed domain events from a
  global sequence and then follows live ones. It is the natural restart-safe
  source.
- `ProjectionStore.getRuntimeResponseContext(threadId, requestId)` returns the
  request, its turn item and its session.
- `AgentAwarenessRelay` and `resolveThreadAwarenessPhaseV2`
  (`packages/shared/src/agentAwareness.ts`) already classify threads as
  waiting, completed or failed for mobile alerts.

### F7. Prior art upstream

- **#22595** "tell outside agents when a watched thread needs them" (closed
  2026-10-26 under the prior-approval rule; Ideas discussion #19534 has no
  maintainer reply). Per-thread `t3_thread_watch` with a webhook URL and secret.
  Watch state lived in memory; only the registration and its secret were
  stored (`thread_watches`). It started fresh after a restart, had no replay,
  ID-based dedupe or fleet scope, and was not MCP Events. Reused here: the
  kinds (`completed`, `failed`, `question`, `approval`), keying attention by
  run and request, and keeping secrets out of the event log.
- **#26344** "remote delegated tasks surface their questions and approvals on
  the parent" (closed 2026-10-30, pending maintainer triage of #26527). It
  added a link-only tool, `t3_link_requests` (`watch`), and relayed answers on
  the link's own session, so `writesThreads` held them to the link's access and
  fence. It never offered "accept always" over a link below full access.
  Reused here: the link-only read tool pattern and the rule that a relayed
  answer runs on the link session.
- **#26492** (open) and **#26665** (closed): web and mobile fixes that open a
  linked child's thread in its own environment. No server contract; not needed
  here.

Upstream has nothing that wakes an outside assistant or approves through MCP.
Neither of the closed PRs could be reused as is: both were in-app and
per-thread, and neither had durable replay.

### F8. The owner feature (`lan/task-owners`, in progress)

- `OrchestrationV2ThreadShell.ownerId` (lenient `NullOr(TrimmedNonEmptyString)`)
  and the domain event `thread.owner-set` from the command `thread.owner.set`.
  It is the one write a read-only session may make.
- `ownerId` on `thread.create` and `ThreadLaunchInput`. When absent, the
  machine's default owner from `fleet-users.json` (`FleetUsersFile.machineOwners`)
  is used.
- `FleetUser { id, name, color? }`; `FleetUsersDirectory` for clients.
- Migration **080** `ScheduledTaskOwner`. `NativeMaintenance` gains
  `addedNullColumns = ["owner_id"]`. `home-repair.ts` `supportedMigrationIds`
  goes to 80.
- An owner "is a label only: it never grants or limits access". This design
  keeps it that way.

## Design

### Components and files

| Component            | File (new unless noted)                                                                                                       | Role                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MCP 2.0 enablement   | `mcp/McpHttpServer.ts` (edit)                                                                                                 | Adds `McpProtocol.v2026_07_28` beside `v2025_06_18`, behind `agentEvents.enabled`                             |
| Events interceptor   | `mcp/events/McpEventsEndpoint.ts`                                                                                             | In the `/mcp` middleware after auth: answers `events/*`, patches `capabilities.events` into `server/discover` |
| Catalog and schemas  | `packages/contracts/src/agentEvents.ts`                                                                                       | Event names, input schemas, payload schemas, cursor codec                                                     |
| Fact deriver         | `agentEvents/AgentFactDeriver.ts`                                                                                             | Follows `EventSink.stream` from a stored watermark and writes facts                                           |
| Fact store           | `agentEvents/AgentFactStore.ts`                                                                                               | The one ledger: append (idempotent), page by `fact_seq`, retention                                            |
| Fleet relay          | `agentEvents/AgentFactRelay.ts`                                                                                               | Per linked peer, long-polls `t3_link_agent_facts` and folds facts in                                          |
| Link fact tool       | `mcp/toolkits/agentEvents/{tools,handlers}.ts`                                                                                | `t3_link_agent_facts` (link-only read) and `t3_agent_events` (status read)                                    |
| Subscriptions        | `agentEvents/AgentEventSubscriptions.ts`                                                                                      | Deterministic IDs, TTL, refresh, unsubscribe, access rechecks                                                 |
| Webhook sender       | `agentEvents/WebhookSender.ts`                                                                                                | Standard Webhooks signing, verification challenge, public-address guard, no redirects                         |
| Delivery worker      | `agentEvents/AgentEventDelivery.ts`                                                                                           | Outbox claims, backoff, 410/413 handling, restart reset                                                       |
| Public-address guard | `packages/shared/src/publicAddress.ts`                                                                                        | Extracted from `htmlRender/publicProxy.ts` `isLocal` and `shared/hostClassification.ts`                       |
| Approval tool        | `mcp/toolkits/approvals/{tools,handlers}.ts`                                                                                  | `t3_approval_request` (`list`, `read`, `respond`)                                                             |
| Approval receipts    | `agentEvents/ApprovalReceipts.ts`                                                                                             | Single use, idempotent retry, audit                                                                           |
| Presentation digest  | `packages/shared/src/approvalPresentation.ts`                                                                                 | One canonical function used by the event, `read` and `respond`                                                |
| Approve scope        | `contracts/src/auth.ts`, `auth/McpOAuth.ts`, `auth/EnvironmentAuth.ts`, sign-in page (edits)                                  | `orchestration:approve`, an opt-in checkbox, and `client.approvals` on the invocation scope                   |
| `resolvedBy`         | `contracts/src/orchestrationV2.ts`, `Orchestrator.ts`, web `TimelinePendingApprovalRow`, mobile `PendingApprovalCard` (edits) | Optional actor on `runtime-request.respond` and on the resolved request, rendered on the thread               |
| Fleet link approvals | `lan/FleetAccessPolicy.ts`, `lan/FleetPeerLinks.ts` (edits)                                                                   | Per-machine `approvals` flag, default off, minted into the link code's scopes                                 |

All server paths are under `apps/server/src/`. Nothing in `apps/server/src/peer`
changes: the approval tool calls `PeerForwarding.call` with parameters the
server builds itself (see [Forwarded approvals](#forwarded-approvals)).

### Data model and migrations

The owner feature takes **080**. Each phase below adds one forward migration
with the next free fork ID at merge time. The numbers here assume no other
migration lands first. Every new migration must also:

- extend `scripts/lan/home-repair.ts` `supportedMigrationIds` and the release
  audits' current schema (as `b428bda9d` did);
- stay outside `NativeMaintenance` `workGeneration`. These tables are delivery
  state, not work: add a test that a home with rows in them verifies unchanged
  across candidate migrations, and list them as non-work in
  [native feature sync](native-feature-sync.md#data-constraints);
- leave fleet, peer-link, session and machine-grouping data alone. All changes
  are additive.

Webhook secrets never enter `statev2.sqlite`. They live in `ServerSecretStore`
under flat `agent-events-<hash>-<random>` names (phase 0 as built; the store
creates only its root directory), in the `userdata/secrets`
tree that home repair already preserves.

```sql
-- 081_AgentEventSubscriptions (phase 0)
CREATE TABLE agent_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,            -- sub_<base64url(sha256(key))[0..32]>
  principal_id TEXT NOT NULL,                  -- see "Principal"
  session_id TEXT NOT NULL,                    -- session that last created or refreshed it
  event_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,                -- canonical JSON
  callback_url TEXT NOT NULL,
  secret_ref TEXT NOT NULL,                    -- ServerSecretStore key
  previous_secret_until INTEGER,               -- rotation overlap end (ms)
  state TEXT NOT NULL,                         -- active|expired|revoked|gone|unsubscribed
  refresh_before INTEGER NOT NULL,             -- ms; always finite
  watermark_seq INTEGER NOT NULL,              -- returned cursor: every fact <= this is delivered or abandoned
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_reason TEXT
);
CREATE TABLE agent_event_deliveries (
  subscription_id TEXT NOT NULL REFERENCES agent_event_subscriptions ON DELETE CASCADE,
  event_id TEXT NOT NULL, fact_seq INTEGER NOT NULL,
  state TEXT NOT NULL,                         -- pending|sending|delivered|rejected|abandoned
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  last_status INTEGER, last_error TEXT, delivered_at INTEGER,
  PRIMARY KEY (subscription_id, event_id)
);
CREATE INDEX idx_agent_event_deliveries_due ON agent_event_deliveries(state, next_attempt_at);
CREATE TABLE agent_event_callback_verifications (
  principal_id TEXT NOT NULL, callback_url TEXT NOT NULL, verified_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, callback_url)
);

-- 082_AgentApprovalReceipts (phase 1)
CREATE TABLE agent_approval_receipts (
  receipt_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, request_id TEXT NOT NULL,
  role TEXT NOT NULL,                          -- local|forwarder|receiver
  client_request_key TEXT NOT NULL,            -- sha256(principal, clientRequestId)
  decision TEXT NOT NULL, presentation_digest TEXT NOT NULL,
  principal_id TEXT NOT NULL, client_label TEXT NOT NULL,
  on_behalf_of TEXT NOT NULL, authorization_text TEXT NOT NULL,
  via_environment_id TEXT, upstream_receipt_id TEXT,
  outcome TEXT NOT NULL,                       -- submitted|refused:<code>|delivery_failed
  command_id TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_approval_once
  ON agent_approval_receipts(environment_id, thread_id, request_id, role)
  WHERE outcome = 'submitted';
CREATE UNIQUE INDEX idx_agent_approval_retry ON agent_approval_receipts(client_request_key, role);

-- 083_AgentEventFacts (phase 2)
CREATE TABLE agent_event_facts (
  fact_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,               -- deterministic, see "Identity"
  fact_key TEXT NOT NULL, kind TEXT NOT NULL,
  origin_environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  relayed_from TEXT,                           -- null for facts derived here
  data_json TEXT NOT NULL                      -- payload "data", <= 16 KiB
);
CREATE INDEX idx_agent_event_facts_thread ON agent_event_facts(origin_environment_id, thread_id, fact_seq);
CREATE TABLE agent_event_log_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,                         -- random per fact log; changes if the log is rebuilt
  floor_seq INTEGER NOT NULL,                  -- lowest fact_seq still retained
  derived_through_sequence INTEGER NOT NULL    -- EventSink global sequence watermark
);
CREATE TABLE agent_event_peer_cursors (
  environment_id TEXT PRIMARY KEY, peer_epoch TEXT NOT NULL, peer_seq INTEGER NOT NULL,
  status TEXT NOT NULL,                        -- following|unsupported|unreachable|gap
  updated_at INTEGER NOT NULL, detail TEXT
);

-- 084_RetireLanObservationLedger (phase 4, needs Dan's approval)
DROP TABLE lan_observation_inbox; DROP TABLE lan_observation_cursors;
-- lan_owned_threads stays: task mutations use it.
```

**Retention.** Facts are kept for 14 days or 50,000 rows, whichever is
smaller. Delivered and rejected delivery rows are kept for 7 days. Ended
subscriptions are kept for 7 days so a re-subscribe can replay. Pruning raises
`floor_seq`.

### Identity

- **Fact key** (readable, in the payload):
  - `approval:<env>:<thread>:<requestId>`
  - `question:<env>:<thread>:<requestId>`
  - `secret:<env>:<thread>:<requestId>`
  - `blocked:<env>:<thread>:<runId>:<reason>`
  - `run:<env>:<thread>:<runId>`
  - `owner:<env>:<thread>`

  `<env>` is always the **origin** environment, so BuildMachine and CryoFrog
  produce the same key for the same fact.

- **Event ID** (`eventId`, `webhook-id`): `t3e1_` + the first 32 characters of
  `base64url(sha256(<transition>|<factKey>|<revision>))`. Each fact kind
  defines its revision:
  - approval and question opened: the `presentationDigest`;
  - closed: the terminal status;
  - run ended: `attemptId|status`;
  - owner changed: the owner revision.

  Hashing keeps the ID short whatever the thread IDs are (for example
  `mcp:launch:…`). The same underlying fact always produces the same ID: after
  a restart, after a relay, or on a second machine. `INSERT OR IGNORE` on
  `event_id` is the dedupe.

- **Subscription ID**: `sub_` + the first 32 characters of
  `base64url(sha256(canonicalJson([principalId, url, name, canonicalJson(arguments)])))`.
  Arguments compare as canonical JSON, so key order never creates a duplicate.
  The ID is output only.
- **Principal**: `CredentialAttribution.mcpClientSubject(approvalSubject)`
  plus the OAuth `client_id` the session was issued to. It must survive the
  30-day re-sign-in: a new session for the same subject and client produces
  the same subscription. If the session does not record `client_id` today,
  phase 0 adds it to `client` metadata at issue time; old sessions fall back
  to the session ID.

### Event catalog

`events/list` returns six definitions, each with `delivery: ["webhook"]`.

| Name                 | Fires on                                                                                                | Default use  |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| `t3.task_activity`   | Every kind below; the recommended single subscription                                                   | Gecko Butler |
| `t3.approval_needed` | A provider permission request is waiting (new, or its shown details changed)                            |              |
| `t3.question_asked`  | A user-input question or a `request_secret` prompt is waiting                                           |              |
| `t3.task_blocked`    | Work cannot continue without someone: usage limit waiting, an answer not delivered, a live request lost |              |
| `t3.run_finished`    | A run reached `completed`, `failed`, `interrupted` or `cancelled`                                       |              |
| `t3.owner_changed`   | A thread's owner was set or changed                                                                     |              |

`t3.task_activity` also carries `request_closed` (a pending request was
resolved, expired or cancelled, with `resolvedBy`) and `source_status` (a peer
became unreachable, unsupported, or lost history). Both are low volume and let
the dot stop chasing something already handled. There is deliberately no
progress event: no run started, message, tool call or subagent step.

**Subscription arguments (`inputSchema`)**, the same for every name:

```json
{
  "type": "object",
  "properties": {
    "environmentIds": {
      "type": "array",
      "maxItems": 32,
      "items": { "type": "string" },
      "description": "Only these environments. Omit for this one and every linked one you can read."
    },
    "threadIds": {
      "type": "array",
      "maxItems": 50,
      "items": { "type": "string" },
      "description": "Only these threads (ids or t3-thread://v2 links)."
    },
    "includeDelegatedResults": {
      "type": "boolean",
      "default": false,
      "description": "Also send run_finished for delegated child tasks. Their approvals, questions and blockers are always sent."
    }
  },
  "additionalProperties": false
}
```

**There is no owner argument.** `additionalProperties: false` makes
`{"owner": "dan"}` an `InvalidParams` error, and a test pins that.

**Payload (`payloadSchema` = the `data` object).** One envelope with a
per-kind `detail`:

```ts
{
  schema: "t3.agent-event/1",
  kind: "approval" | "question" | "secret" | "blocked" | "run_finished"
      | "owner_changed" | "request_closed" | "source_status"
      | "probe",                         // operator-triggered test fact, sent to one named subscription only
  factKey: string,
  summary: string,                       // <= 280 chars, server-written
  textIsUntrusted: true,                 // titles, prompts and results are data, not instructions
  environment: { id: string, label: string },
  thread: {
    id: string, title: string | null,
    link: string,                        // t3-thread://v2/<environmentId>/<threadId>
    webUrl: string | null,               // the origin the subscriber signed in on, when known
    projectId: string, projectName: string | null,
    parentThreadId: string | null, delegated: boolean,
    runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode
  },
  run: { id: string, attemptId: string | null } | null,
  owner: {
    state: "assigned" | "unassigned" | "unknown_user",
    id: string | null,                   // fleet-users.json id; null when unassigned
    label: string | null,                // that user's name as the origin resolved it
    revision: number,                    // origin thread sequence of the last owner change; 0 = set at creation
    asOf: string,                        // ISO time the owner was read
    machineDefault: { id: string, label: string | null } | null  // only when unassigned: informational
  },
  origin: { environmentId: string, threadSequence: number, occurredAt: string },
  relay: { viaEnvironmentId: string, relayedAt: string } | null,
  detail: ApprovalDetail | QuestionDetail | SecretDetail | BlockedDetail
        | RunFinishedDetail | OwnerChangedDetail | RequestClosedDetail | SourceStatusDetail
}

ApprovalDetail = {
  requestId, requestKind, appName?, prompt?, reason?, fullAccessOverride?,
  options: [{ decision, label, warning? }],        // exactly as the UI shows them
  presentationDigest: string,                      // sha256 hex, see "Presentation digest"
  answerable: { via: "t3_approval_request", decisions: ("accept" | "decline")[] }
            | { via: "ui_only", reason: string },  // e.g. URL elicitation, not live, scope not granted
  createdAt, revision: number, supersedesEventId: string | null
}
QuestionDetail = { requestId, questions: [{ id, header, question, options: string[], required }],
                   answerable: { via: "t3_pending_request" } | { via: "ui_only", reason } }
SecretDetail = { requestId, name: string, answerable: { via: "ui_only", reason: "secrets are entered in T3" } }
BlockedDetail = { reason: "usage_limit" | "answer_not_delivered" | "request_lost", message: string, retryAt: string | null }
RunFinishedDetail = { status, endedAt, resultPreview: string | null /* <= 1,000 chars */, failure: { message } | null }
OwnerChangedDetail = { previous: Owner | null, current: Owner, changedBy: "user" | "agent" | "system" }
RequestClosedDetail = { requestId, requestKind, status: "resolved" | "expired" | "cancelled",
                        decision?: ProviderApprovalDecision,
                        resolvedBy?: { kind: "user" | "mcp_client", label, onBehalfOf?, viaEnvironmentId? } }
SourceStatusDetail = { environmentId, status: "unreachable" | "unsupported" | "gap" | "following", since, detail }
```

**Size.** `data` is at most 16 KiB. Long text is cut with an ellipsis, and a
`truncatedFields` list says what was cut. The full record is always available
through `t3_thread_read` or `t3_approval_request read`, as OpenAI recommends
for large records. A body over 256 KiB is therefore impossible by
construction. The sender still checks the limit and records `rejected` rather
than sending.

**Owner semantics.**

- `owner` is read from the origin thread when the fact is derived:
  `ownerId`, plus the origin's `fleet-users.json` name for `label`.
- `unassigned` means the thread has no `ownerId` (threads from before the
  feature, or a machine without a default). `machineDefault` reports what that
  machine would default to, without asserting it.
- `unknown_user` means an ID the origin's directory cannot name. The ID is
  kept and `label` is null.
- `revision` lets the dot discard a stale label. An `owner_changed` with a
  higher revision supersedes the labels on every earlier event for that
  thread. Before relaying anything owner-dependent, the dot can re-read the
  thread. `t3_thread_read` must return the current owner and revision; that
  is a requirement on the owner feature, and its shell does not carry the
  revision yet.
- The owner feature must expose the sequence of the last `thread.owner-set`
  on the shell (for example `ownerSetSequence`). Until it does, the deriver
  reads it from `EventStore.read({ threadId, eventType: "thread.owner-set" })`.

### Presentation digest

`approvalPresentationDigest(request, item, environmentId)` = SHA-256 of the
canonical JSON of:

- `environmentId`, `threadId`, `runId`, `requestId`, `requestKind`;
- `nativeRequestRef.nativeId`;
- `appName`, `prompt`, `reason`, `fullAccessOverride`;
- `options` (ordered `decision`, `label`, `warning`);
- `createdAt`.

These are exactly the fields the approval row renders. The event, `read`,
`respond` and the UI test all use this one function from
`packages/shared/src/approvalPresentation.ts`. If a provider fills in details
late (upstream #26344 saw this), the digest changes. That produces a new
`approval` event (`revision + 1`, `supersedesEventId`), and a respond carrying
the old digest is refused.

### Fact derivation

`AgentFactDeriver` runs on every machine with `agentEvents.enabled`. It
follows `EventSink.stream({ afterSequence: derived_through_sequence })`. For
each committed event it inserts facts and advances the watermark in one SQL
transaction:

| Domain event                                                                                                                    | Fact                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime-request.updated` → `pending`, approval kinds; or `turn-item.updated` on an `approval_request` whose request is pending | `approval` once the request and its item both exist, through `getRuntimeResponseContext`. A changed digest gives a new revision.                             |
| Same for `user_input` with a `user_input_request` item                                                                          | `question`                                                                                                                                                   |
| `secret_request` turn item pending                                                                                              | `secret` (name only, never a value)                                                                                                                          |
| `runtime-request.updated` → `resolved`, `expired` or `cancelled`                                                                | `request_closed`, carrying `resolvedBy` when present. A pending live approval that becomes `expired` or `not_resumable` also raises `blocked: request_lost`. |
| `runtime-request.delivery.fail`                                                                                                 | `blocked: answer_not_delivered`                                                                                                                              |
| Thread `limitRecovery` becomes waiting                                                                                          | `blocked: usage_limit`                                                                                                                                       |
| `run.updated` to a terminal status (`ThreadManagement.isTerminalRunStatus`)                                                     | `run_finished`, with the last assistant message as `resultPreview`                                                                                           |
| `thread.owner-set`                                                                                                              | `owner_changed`                                                                                                                                              |

**Restart.** A crash between commit and derivation replays from the
watermark, and the deterministic IDs make re-insertion a no-op. Facts are
derived for **every** thread, whatever its owner or origin, including
scheduled-task and delegated threads.

**First start.** The watermark starts at `latestApplicationSequence`, so a
newly enabled machine does not flood the dot with history. Requests already
pending at that moment are backfilled once from the projection.

### Fleet relay

The dot only talks to BuildMachine, so BuildMachine must learn about facts on
other machines. Three options:

- **Subscribe to peers' shell streams over fleet credentials.** That gives
  state, not a log: an approval raised and resolved during a disconnect is
  missed, and there is no cursor to resume from.
- **Peers push facts to BuildMachine.** Every peer would need a write path
  into BuildMachine and its own retry outbox, which doubles the delivery
  machinery.
- **BuildMachine pulls each peer's fact log over the existing native link.**
  Chosen. It reuses link credentials, `PeerMcpClient` and the Machine access
  list. It needs only read access, has a durable cursor, and recovers by
  replay. It is the same pattern as upstream #26344's `t3_link_requests`.

**Peer side.** `t3_link_agent_facts { after: { epoch, seq } | null, limit <= 100, waitMs <= 45000 }`
is a read tool:

- **Who can call it:** linked callers only (`scope.client?.linked === true`;
  otherwise `capability_denied`). It is hidden from everyone else and while
  links are off (`hiddenWhileLinksOff`).
- **What it returns:** `{ epoch, facts, next, floorSeq, truncated }`, and
  only facts whose origin is that machine, so relays never loop or fan in
  twice.
- **Long poll:** it waits for new facts, like `t3_thread_wait`'s 50-second
  pieces.

**BuildMachine side.** `AgentFactRelay` runs one fiber per environment in
`PeerLinks`.

- **Folding facts in.** It calls the tool through `PeerMcpClient` (still
  `2025-06-18`), inserts each fact with `INSERT OR IGNORE` by `event_id` and
  sets `relayed_from`. It stores `(peer_epoch, peer_seq)` in the same
  transaction.
- **Restart.** It resumes from the stored cursor.
- **History lost on the peer.** A new peer epoch, or a cursor below its
  floor, replays from the peer's floor. IDs dedupe. It also records one
  `source_status: gap` fact, because events between the old cursor and the
  floor are gone.
- **Peer state changes.** An old peer that lacks the tool becomes
  `unsupported` and is retried hourly. A dropped link becomes `unreachable`
  and is retried with backoff. Each state change produces a single
  `source_status` fact.
- **Reads only.** A read-only link is enough to follow facts.

**Visibility.** When a fact is matched to a subscription, it is delivered only
if that subscriber could read the thread now. A local fact needs
`orchestration:read`. A relayed fact also needs this machine's link to the
origin, and the subscriber must not be a linked caller. That is the same rule
as `t3_thread_read` with `environmentId`. This is access control, not owner
filtering.

### MCP 2.0 transport and the events endpoint

1. **Protocol.** `layerMcpTransport` gets
   `protocols: [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28]` when
   `agentEvents.enabled` is on. It starts on BuildMachine only. Existing
   clients and every peer keep `2025-06-18`.
2. **Intercepting requests.** `makeMcpAuthMiddleware` authenticates first and
   then calls `McpEventsEndpoint.intercept(request, scope, inner)`. It handles
   `POST` requests with `MCP-Protocol-Version: 2026-07-28` (or a JSON body
   whose `_meta` carries the 2026 profile), reading the body through the
   memoised `request.text`:
   - `events/list`, `events/subscribe` and `events/unsubscribe` are answered
     here as JSON-RPC 2.0 and never reach effect.
   - `server/discover` runs `inner`. If the result is `application/json`, it
     adds `"events": {}` to `result.capabilities` and re-serialises; it
     **fails closed to unpatched** on any other shape.
   - Everything else passes through untouched.
3. **Who may call `events/*`.** Outside OAuth clients with
   `orchestration:read`. Thread callers (`McpSessionRegistry` tokens), linked
   peer sessions and task-only grants get `-32024 Forbidden` (OpenAI documents
   only `-32015`; `-32024` is the draft's code and is what we return for
   authorization).
4. **Removing the patch later.** If effect later supports custom capabilities
   or handlers, the patch is replaced by that API. A test pins today's
   behaviour so an effect upgrade cannot silently break it.

### Subscription lifecycle

- **Subscribe** (`name`, `arguments`, `delivery { mode: "webhook", url, secret }`,
  `cursor`, `ttlMs?`):
  1. Authorise (above), then validate the name and the arguments against the
     schema.
  2. Check the secret has the `whsec_` prefix and decodes to 24–64 bytes.
  3. Check the URL is `https:` and passes the public-address guard.
  4. Derive the ID.
  5. Verify the callback unless a verification for `(principal, url)` is
     younger than 24 hours. Failure is JSON-RPC `-32015 CallbackEndpointError`
     with `data.reason`: `challenge_failed`, `timeout`, `tls_error`,
     `address_refused`, `redirect_refused` or `http_<status>`.
  6. Upsert: a new secret starts a 10-minute overlap that signs with both
     keys. Bind `session_id` to the calling session.
  7. Compute the cursor (below) and return
     `{ id, refreshBefore, cursor, truncated }`.
- **TTL.** The default is 24 hours, with a minimum of 1 hour and a maximum of
  7 days. The granted TTL never exceeds the calling session's expiry.
  `ttlMs: null` is still granted a finite time, so `refreshBefore` is never
  null.
- **Refresh.** It is the same call with the last cursor. It is idempotent, and
  it rebinds to the current session (after a re-sign-in, too). The returned
  `refreshBefore` is new.
- **Expiry.** Ten minutes after `refreshBefore` with no refresh, the state
  becomes `expired` and delivery stops. The row and its pending deliveries are
  kept for 7 days, so a later subscribe with the old cursor replays.
- **Unsubscribe** (`name`, `arguments`, `delivery { mode, url }`). It is
  authorised against the principal and idempotent, and returns `{}`. The
  state becomes `unsubscribed`, pending deliveries are dropped and the secret
  is deleted.
- **Status tool.** `t3_agent_events` (read) lists the caller's own
  subscriptions, their state, pending counts, last delivery status and peer
  source states. The live test uses it for diagnosis.

### Delivery, signing and retry

- **Matching.** When a fact is inserted, the matcher adds a `pending` delivery
  row for every active subscription whose name and arguments match it. One
  fact delivers once per subscription.
- **Sending order.** At most one request is in flight per subscription, in
  `fact_seq` order. Up to four are in flight overall. All of a subscription's
  events go to the same URL, so ordering costs nothing a failure would not
  already cost.
- **Body.** One event per POST:
  `{ eventId, name, timestamp, data, cursor }`. It is serialised once, and
  those exact bytes are signed and sent.
- **Headers.** `Content-Type: application/json`, `webhook-id: <eventId>`,
  `webhook-timestamp: <unix s>`,
  `webhook-signature: v1,<base64(HMAC-SHA256(key, id.timestamp.body))>` (two
  space-separated signatures during rotation), and `X-MCP-Subscription-Id`.
- **Timeouts.** 10 s connect and response.
- **Public-address guard.** It is applied to every attempt and to every
  verification:
  - resolve the host;
  - refuse loopback, private, link-local, CGNAT and tailnet, multicast, ULA
    and IPv4-mapped forms of those;
  - connect to the validated address with the original hostname for SNI and
    certificate checks;
  - never follow a redirect.

  It reuses `htmlRender/publicProxy.ts`'s resolver logic, moved into
  `packages/shared/src/publicAddress.ts`.

- **Responses.**
  - **2xx:** `delivered`.
  - **410:** the subscription becomes `gone`. All of its deliveries stop and
    are dropped, with no retry.
  - **413:** `rejected`, with no retry.
  - **429:** honour `Retry-After`.
  - **Any other status, a network or TLS error, a timeout, or a 3xx:** retry
    with backoff of 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, then
    every 8 h. Jitter is ±20%. After 48 hours the event is `abandoned`. Every
    retry keeps the `eventId` and gets a fresh timestamp and signature.
- **Restart.** Rows left in `sending` go back to `pending`. That can produce a
  duplicate delivery with the same `eventId`, which the receiver dedupes.
- **Feedback loops.** Approving or answering through MCP produces
  `request_closed`. That event is informational and does not ask for anything,
  so it cannot start a loop.

### Cursors, replay and `truncated`

- **Format.** A cursor is opaque: `c1.<epoch>.<seq>`. The value returned is
  the subscription's `watermark_seq`, the highest `fact_seq` at or below which
  everything matching is `delivered`, `rejected` or `abandoned`. It never
  passes a pending event.
- **Subscribe with `cursor: null`.** Starts from the head; nothing is
  replayed.
- **Subscribe or refresh with a cursor.**
  - **Same epoch, at or above `floor_seq`:** every matching fact after it that
    is not `delivered` is (re)queued. If the cursor is below the stored
    watermark (the client lost events), delivered rows after it are requeued
    too. The receiver dedupes on `eventId`.
  - **Different epoch, or below the floor:** replay from the floor with
    `truncated: true`.
- **Relayed history.** A relayed peer's lost history is reported in the data
  (`source_status: gap`), not as `truncated`. The subscriber's own cursor is
  still complete for what this log holds.

### Revocation

Access is checked again in three places:

- **Before each delivery attempt:** the subscription's bound session is still
  valid and not revoked; after `CredentialAccessCap`, it still holds
  `orchestration:read`; and the subscriber can still read the fact (the
  visibility rule).
- **Every 60 seconds:** a sweep repeats the same check for idle
  subscriptions.
- **On notice:** `EnvironmentAuth` session-revocation and fleet
  policy-change notifications trigger an immediate sweep.

Losing session or read access makes the subscription `revoked`: delivery
stops and its pending rows are dropped. OpenAI's webhook mode has no
`terminated` control, so stopping is all we can do. Losing a link drops only
that environment's facts for the subscription, and records `source_status`.

### Approval tool

`t3_approval_request` lives in the fork toolkit `mcp/toolkits/approvals`,
registered beside `LanToolkit`. Its parameters:

```ts
{
  action: "list" | "read" | "respond",
  environmentId?: EnvironmentId,   // plain EnvironmentId, not OrchestratorMcpEnvironmentTarget:
                                   // the handler forwards it itself (see below)
  threadId: ThreadId,              // required; outside callers have no "this thread"
  requestId?: RuntimeRequestId,
  respond?: {
    decision: "accept" | "decline",
    presentationDigest: string,
    clientRequestId: string,       // 8–128 chars; a retry with the same id returns the first receipt
    onBehalfOf: string,            // 1–64: the person whose explicit approval this carries, e.g. "Dan"
    authorization: string,         // 1–500: their words, e.g. "Dan: approve the Chrome request on the probe task"
  },
  attestation?: ForwardAttestation // accepted only from a linked caller; set by the forwarding server
}
```

What each action returns:

- **`list`:** the pending approvals in the thread. Each has `requestId`,
  `requestKind`, `appName`, `createdAt`, `presentationDigest` and `answerable`.
- **`read`:** `ApprovalDetail` (above) and the thread's current owner.
- **`respond`:**
  `{ receiptId, status: "submitted" | "already_submitted", decision, sequence }`.

**Decision mapping.** `accept` sends the native `accept`:

- Codex permissions: `scope: "turn"`.
- Command and file-change approvals: that one call.
- Elicitations: accept with no persistence.
- Claude and ACP providers: their own single-use allow.

`decline` sends `decline`. `acceptForSession`, `acceptAlways`, `cancel` and
feedback cannot be expressed. If the item's options exist and do not include
the requested decision, the call is refused. A URL-mode elicitation, where
`accept` maps to `decline`, is `ui_only`.

**Refusals.** All are `OrchestratorMcpFailure`, with these codes:

- `approvals_not_granted`, `thread_caller_refused`, `task_only_refused`,
  `capability_denied` (read-only);
- `request_not_found`, `not_an_approval` (questions go to
  `t3_pending_request`);
- `not_pending`, `not_live` (not resumable, or the session is gone);
- `presentation_changed` (returns the current digest; nothing is done);
- `decision_not_offered`;
- `runtime_mode_escalation_denied` / `interaction_mode_escalation_denied`;
- `already_resolved` (a different `clientRequestId` already answered it);
- `link_not_approved` (receiver);
- `invalid_request` (attestation from a non-linked caller).

### Enforcement points

**Local** (the thread is on the machine the client signed in to). In order:

1. `/mcp` auth builds the scope. `client.approvals` is set when the session's
   scopes, after `CredentialAccessCap`, include `orchestration:approve`.
2. Tool visibility: `EnabledWhen` hides the tool from thread callers and from
   clients without `client.approvals`. The handler checks both again.
3. The new declaration `McpToolAccess.approves(…)`:
   - refuses thread callers, `taskOnly` grants, read-only clients, and clients
     without the approve scope;
   - runs `writingCaller` (live, non-read-only) and `writesThreads`'
     per-thread checks (`assertTargetWithinLimits`, `assertSameLink`);
   - provides `DispatchModeLimit`, so the orchestrator rechecks modes under
     its lock.

   It is a new kind of declaration, so it must be added to
   `taskOnlyTools`/`gateTaskOnly` review (it is **not** a task-only tool).

4. Request binding: `getRuntimeResponseContext`. The request must be an
   approval kind, `pending`, with `responseCapability.type === "live"`, a
   session present, and an item present. The digest must match. The decision
   must be offered.
5. Single use: insert the `agent_approval_receipts` row (role `local`,
   outcome `submitted`) **before** dispatch. The partial unique index refuses a
   second answer to the request. The retry index returns the first receipt for
   the same `clientRequestId`.
6. Dispatch `runtime-request.respond` with
   `resolvedBy = { kind: "mcp_client", label, principalId, onBehalfOf, authorization, viaEnvironmentId: null, receiptId }`.
   This runs the native checks unchanged; the pending → resolved transition is
   the second single-use guard. A dispatch error updates the receipt outcome
   and frees the request for a corrected retry.
7. The provider gets exactly the mapped decision through the existing effect.
   A delivery failure produces `runtime-request.delivery.fail`, which becomes a
   `blocked: answer_not_delivered` event.

#### Forwarded approvals

The thread is on CryoFrog and the dot is signed in to BuildMachine.

**On BuildMachine:**

- Steps 1–3 run against the dot's grant.
- `PeerForwarding.callerLimits` refuses linked callers and computes the dot's
  modes.
- A `forwarder` receipt is written (single use on this side too).
- The handler then calls `PeerForwarding.call(scope, ApprovalTool, cryoFrogEnv, params, writes = true)`
  with `params` it builds itself: the dot's `respond` fields, plus
  `attestation = { clientLabel, principalHash, viaEnvironmentId: BuildMachine, forwarderReceiptId, onBehalfOf, authorization }`.
  The agent cannot supply `attestation`: the handler refuses it from
  non-linked callers.
- `PeerMcpClient` still applies `PeerWriteCeiling` (BuildMachine's Machine
  access list) and sends `T3-Mode-Limit` = the dot's modes.

**On CryoFrog:**

- The caller is BuildMachine's link session.
- `approves(…)` requires the **link's** scopes to include
  `orchestration:approve` (after `FleetCredentialAccess`); otherwise
  `link_not_approved`.
- Then steps 3–7 run, with `T3-Mode-Limit` capping modes at the dot's and the
  `linkOrigin` fence applying if the link is below full access.
- The receipt (role `receiver`) records the attestation as **asserted by the
  link**.
- `resolvedBy` becomes
  `{ kind: "mcp_client", label: "<link label>", actingFor: attestation.clientLabel, onBehalfOf, authorization, viaEnvironmentId: BuildMachine, receiptId }`.

So an approval through a link needs both keys:

- the dot's grant on BuildMachine carries the approve scope;
- BuildMachine's link on CryoFrog carries it, which follows from fleet policy
  or a manual link's checkbox.

Neither alone is enough.

### Granting approval permission

- **Sign-in page.** For Supervised and above, a checkbox that is **off by
  default**: "Also let this agent answer permission requests: approve once or
  decline, one request at a time." It adds `orchestration:approve` to the
  session's scopes. `mcpClientScopes(access, { approvals })` is the single
  source of truth. Read-only never offers it.
- **Who can grant it.** The approving browser session or pairing code must
  hold the scope (`McpOAuth.approve` already refuses scopes the approver
  lacks). Owner sessions and standard pairing codes gain it; the scope is
  added to `AuthStandardClientScopes`.
- **Seeing and revoking it.** Settings → Sharing & access shows "can answer
  approvals" on the client. Revoking the session removes it. To keep the
  client but drop approvals, sign in again without the box.
- **Peer links.**
  - Fleet: `FleetAccessPolicy` gains a per-machine `approvals: boolean`,
    default `false`. D mints L's link code with the scope only when it is
    true, and a change re-offers a code, as access changes do today.
  - Manual links: the link-request card offers the same unchecked box.
  - A link without the scope still follows facts (read).

### Audit records

- **`agent_approval_receipts`** on every machine involved: who (`principal_id`,
  `client_label`), for whom (`on_behalf_of`, `authorization_text`), via
  (`via_environment_id`, `upstream_receipt_id`), the digest, decision, outcome
  and command ID. It is listed by `t3_agent_events` for the caller's own
  receipts, and by an owner-scope WebSocket read for Settings.
- **On the thread.** `resolvedBy` on the request is an optional, lenient fork
  field on the `runtime-request.respond` command and on
  `OrchestrationV2RuntimeRequest`; stock clients ignore it. The resolved
  approval row renders "Approved once by Gecko Butler for Dan · via
  BuildMachine" (or "Declined …"). It is visible in web and mobile and in
  `t3_thread_read`.
- **`request_closed` events** carry `resolvedBy`, so every subscriber sees
  who answered.

### The fork ledger: replace, not add

Row 5's rule is "do not add a second ledger". `RoutingStore`'s observation
inbox cannot be reused (F5): it captures only when polled and is keyed to
gateway-owned threads. **Decision (needs Dan's approval, since it changes row
5 from keep):**

- `agent_event_facts` becomes the ledger.
- The observation inbox is frozen from phase 0: no new callers.
- In phase 4, `t3_lan_task_observe` and `t3_lan_events_ack` are either:
  - reimplemented as a pull view over `agent_event_facts` for owned threads,
    keeping their contract (`sourceId` = fact-log epoch, events mapped to the
    existing `LanTaskObservation` kinds); or
  - retired with the gateway (row 10) if Dan drops it.
- Migration 084 then drops `lan_observation_inbox` and
  `lan_observation_cursors`. `lan_owned_threads` stays.

## Security analysis

| Constraint                            | How it holds                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native checks preserved               | The tool only dispatches `runtime-request.respond`. The orchestrator's pending, resumable, live-session and provider-enabled checks and the adapter's deferred are unchanged. `DispatchModeLimit` rechecks modes under lock.                                                              |
| Request freshness and identity        | Binding to `(environment, thread, requestId)`, `pending` and `live`, plus a `presentationDigest` of every displayed field. Late detail changes the digest. Live-only approvals cannot be answered after a provider restart (`not_live`).                                                  |
| Exact scope                           | Only `accept` (the provider's narrowest grant) or `decline`, and only if offered. No session or always options, no feedback, no URL elicitations. Codex permissions answer with `scope: "turn"`.                                                                                          |
| Caller permissions                    | The opt-in scope is off by default and requires Supervised or above. Read-only, task-only, thread and linked-chaining callers are refused. A target thread above the caller's modes is refused (`assertTargetWithinLimits`). Fleet caps narrow it live (`CredentialAccessCap`).           |
| Single-use replay protection          | Two layers: the receipts unique index per request and role, and the orchestrator's pending → resolved transition. `clientRequestId` makes network retries idempotent. A replayed `respond` with a new id gets `already_resolved`.                                                         |
| Auditability                          | Receipts on every hop, `resolvedBy` on the thread, `request_closed` events. `onBehalfOf` and `authorization` record the human claim, labelled as asserted by the agent.                                                                                                                   |
| No bypass via prompt or UI automation | Approval goes through a typed tool, never a message to the task, and never through preview or device tools. Nothing auto-approves. Runtime modes, project settings and provider policy are untouched.                                                                                     |
| Forwarding                            | Two independent keys (the dot's grant and the link's scope). BuildMachine checks before sending. The receiver checks its link. `T3-Mode-Limit` carries the dot's ceiling. The agent cannot forge `attestation`, because the server builds it and the receiver accepts it only from links. |
| Events: confidentiality               | Delivery is gated on the subscriber's current read access per fact. Secrets are never in payloads. Webhook secrets are in `ServerSecretStore`, not the DB or logs. Thread text is labelled untrusted.                                                                                     |
| Events: callback abuse (SSRF)         | HTTPS only. Addresses are resolved and validated on every connection, which is then pinned to the validated address. No redirects. The verification challenge proves intent. A 10 s timeout. One in flight per subscription, four overall.                                                |
| Events: revocation                    | Checked before each attempt, by a 60-second sweep, and immediately on revocation or policy notifications.                                                                                                                                                                                 |
| Owner never filters                   | No owner argument in any schema (`additionalProperties: false`). The deriver, relay, matcher and visibility checks never read `ownerId` except to fill the payload. Tests prove Dan's, Gavin's and unassigned events all deliver.                                                         |
| Data preservation                     | Additive migrations only. No change to fleet, peer-link, session or grouping tables. Home repair support for each ID. Delivery tables are outside the work hash.                                                                                                                          |

**Residual risks:**

- **The human claim is unverifiable.** T3 cannot tell whether Dan really said
  yes. The dot is trusted for that statement, which is why the scope is opt-in
  and the receipt records the claim verbatim.
- **A compromised BuildMachine** (or anyone holding its link credential with
  the approve scope) can approve on CryoFrog for any principal it claims.
  CryoFrog trusts the link, not the attestation. That is the same trust it
  already extends to a full-access link for every other write.
- **ChatGPT's callback endpoint** is a third party. Event data (titles,
  approval prompts, result previews) leaves the fleet. That is inherent in the
  feature, and the reason for `agentEvents.enabled` per machine.

## Validation

### Unit and integration tests (focused, per phase)

- `mcp/events/McpEventsEndpoint.test.ts`:
  - `server/discover` gains `capabilities.events` on `2026-07-28` and is
    unchanged on `2025-06-18`;
  - `events/*` are refused for thread, linked and task-only callers;
  - the JSON-RPC error shapes (`-32015` reasons);
  - a pinned effect-behaviour test, so an effect upgrade that changes
    discovery fails loudly.
- `McpHttpServer.test.ts`: every existing tool works under both protocols
  (tools/list and a representative call). `AgentContextBudget.test.ts` is
  unchanged.
- `AgentEventSubscriptions.test.ts`:
  - deterministic IDs regardless of argument key order; idempotent re-subscribe;
  - TTL bounds; `ttlMs: null` is granted a finite time; refresh rebinds the
    session;
  - secret validation and rotation overlap (two signatures);
  - unsubscribe is idempotent and authorised;
  - `{"owner": …}` is rejected.
- `WebhookSender.test.ts`:
  - signatures checked with the independent `standardwebhooks` library;
  - one serialisation for signing and sending;
  - the verification challenge is single-use and compared in constant time;
  - a redirect is refused;
  - private, loopback, CGNAT, ULA and mapped addresses are refused at connect
    time (DNS rebinding: first lookup public, second private);
  - the 256 KiB guard.
- `AgentEventDelivery.test.ts`:
  - the backoff schedule with `TestClock`;
  - same `eventId` with a new timestamp and signature per retry;
  - 410 → `gone` with no retry; 413 → `rejected` with no retry; 429 honours
    `Retry-After`;
  - `sending` → `pending` on restart;
  - the watermark never passes a pending event;
  - revocation mid-retry stops delivery.
- `AgentFactDeriver.test.ts` (with `OrchestratorScenario`):
  - every catalog kind from real domain events;
  - an approval whose detail lands late gives revision 2 with
    `supersedesEventId`;
  - a crash between commit and derive replays without duplicates;
  - first start backfills pending requests once;
  - delegated, scheduled and every-owner threads all produce facts.
- `AgentFactRelay.test.ts` (with `PeerLinks.testkit`):
  - cursor persistence across restart;
  - peer epoch change → replay plus a `gap` fact; dedupe by ID;
  - an old peer → `unsupported`;
  - relayed facts are never re-exported.
- `toolkits/approvals/handlers.test.ts`, one test per refusal code, plus:
  - an accept reaches the adapter as `accept` (Codex permissions
    `scope: "turn"`; elicitation without persist);
  - a decline;
  - the `clientRequestId` retry returns the same receipt;
  - a second answer → `already_resolved`;
  - a stale digest → `presentation_changed`;
  - a mode-escalation race → `runtime_mode_escalation_denied`;
  - `resolvedBy` is projected;
  - questions are refused (`not_an_approval`), and `t3_pending_request` is
    unchanged.
- `ApprovalForwarding.test.ts` (two in-process environments, as in
  `PeerForwarding.test.ts`):
  - a dot grant without the scope is refused on BuildMachine and nothing is
    sent;
  - a link without the scope → `link_not_approved` on the receiver;
  - with both, receipts on both sides and `resolvedBy.via` = BuildMachine;
  - a forged `attestation` from a non-linked caller is refused;
  - `PeerWriteCeiling` read-only blocks the call;
  - `T3-Mode-Limit` caps it.
- `McpOAuth.test.ts` / `EnvironmentAuth.test.ts`:
  - the checkbox is off by default;
  - the scope is offered only for Supervised and above;
  - an approver lacking the scope cannot grant it;
  - `CredentialAccessCap` stripping the scope removes `client.approvals`.
- `FleetAccessPolicy.test.ts`: the `approvals` flag defaults off, mints the
  scope only when true, and narrowing removes it live.
- Owner (`AgentFactDeriver.owner.test.ts`), with a `fleet-users.json` fixture
  `{dan, gavin}`, `machineOwners`, and threads owned by Dan, owned by Gavin,
  with no owner, and with an ID missing from the directory:
  - payloads are `assigned/Dan`, `assigned/Gavin`, `unassigned` (with
    `machineDefault`) and `unknown_user`;
  - reassigning Gavin → Dan gives `owner_changed` with a higher revision, and
    later events carry Dan;
  - **all** events are delivered to one `t3.task_activity` subscription (the
    count equals the number of facts).
- `NativeMaintenance.test.ts` and home-repair tests: new migration IDs are
  supported, and rows in the new tables leave `workGeneration` unchanged.

### Local end-to-end harness

`scripts/lan/agent-events-e2e.ts`, run with `node` from the build-tools
toolchain. It needs no paid model.

1. **Server A.** Start a T3 dev server from source with a temporary
   `--home-dir` and `--no-seed`. Being a dev server, it seeds the free
   `devReplay` ACP agent (`ProviderInstanceRegistryHydration.seedDevReplayInstance`),
   whose recorded `approval` scenario raises a real `session/request_permission`
   and whose `question` scenario raises a real elicitation.
2. **Callback receiver.** A Node HTTPS server with a throwaway CA. A has
   `NODE_EXTRA_CA_CERTS` set to that CA and the dev-only
   `T3CODE_AGENT_EVENTS_ALLOW_LOOPBACK_CALLBACKS=1`, which is refused when
   `config.devUrl` is unset, so it can never ship.
   - It answers verification challenges and verifies every signature with
     `standardwebhooks`.
   - It checks `webhook-id == eventId`, the headers, the body size and the
     payload against the published schema.
   - It records every delivery to JSONL.
   - A control endpoint can make it return 500, 410 or 413, or time out.
3. **MCP client.** A minimal `2026-07-28` JSON-RPC client. It completes OAuth
   with a pairing code from `t3 auth pairing create` and PKCE on a loopback
   redirect, once with the approve box checked and once without.
4. **Checks**, in order:
   - discover shows events; list returns the catalog;
   - subscribe (`t3.task_activity`, `{}`) verifies the callback;
   - launch a devReplay `approval` thread **from A's own API, not via the
     agent**, then expect an `approval` event with the correct digest;
   - `read` gives the same digest;
   - `respond` with a wrong digest → refused; without the scope → refused;
     with the scope and the correct digest → the provider proceeds (the
     replayed turn completes);
   - expect `request_closed` with `resolvedBy` and `run_finished`;
   - the same `respond` again → `already_submitted`; a new `clientRequestId`
     → `already_resolved`;
   - a `question` thread → `question` event → answered through
     `t3_pending_request`;
   - make the receiver return 500 three times, then restart server A while a
     delivery is pending. Expect the same `eventId` after restart, with a new
     timestamp and signature;
   - unique `eventId`s at the receiver equal facts produced;
   - stop A between commit and derive (test hook), then restart: no duplicate;
   - 410 → no further deliveries; 413 → no retry;
   - refresh with an older cursor → replay; a cursor below the floor →
     `truncated: true`;
   - revoke the session → delivery stops within 60 s;
   - unsubscribe → stops;
   - owners: the Dan, Gavin, unassigned and reassign sequence, all delivered.
5. **Native link run.** Start server B the same way, turn Linked environments
   on for both, and link B → A through the link-request flow with the approve
   box (Supervised).
   - Run the `approval` scenario on B.
   - The event arrives at A's subscriber through the relay, with
     `relay.viaEnvironmentId = A` and `factKey` naming B.
   - `respond` through A with `environmentId = B`: receipts on both sides, and
     B's thread shows "via A".
   - Repeat with a link without the scope: `link_not_approved`.
   - Stop B mid-stream: `source_status: unreachable`, then catch-up after
     restart without duplicates.

The harness also prints a manual checklist for the one Codex-specific path
it cannot replay: a real `mcpServer/elicitation/request`. That path is covered
by `CodexAdapterV2.test.ts` with the fake app-server.

### Live end-to-end with Gecko Butler

This test is run with Dan. It proves wake and approval submission separately
from task-launch success.

**Preconditions:**

- The phase's build is on BuildMachine, with `agentEvents.enabled` there
  only (CryoFrog too for L5).
- A disposable project, `agent-events-probe`, holds only probe threads. **No
  existing thread is touched**; the CryoFrog turtle task
  `mcp:launch:5b65d8be…` is explicitly out of scope.
- Probe threads are launched by the operator in T3's own UI, not by the dot,
  so launch success is never part of the evidence.

**Evidence for each step:** T3's delivery log (`t3_agent_events` and the
receipts) plus the dot's own message in the subscribed chat, with timestamps.

| Step                     | What happens                                                                                                                                         | Passes when                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 Discovery             | ChatGPT rescans the plugin                                                                                                                           | The log shows `server/discover` and `events/list`; the plugin page lists the events                                                                                       |
| L1 Subscribe             | Dan asks the dot, in a fresh chat, to "watch T3 for anything that needs me"                                                                          | `events/subscribe` for `t3.task_activity` with `{}` arguments; verification is 2xx; the subscription is stored                                                            |
| L2 Wake (phase 0)        | After ≥ 30 min of chat idle, the operator runs `t3 agent-events probe` with a random nonce. It is a `probe` fact delivered only to that subscription | 2xx delivered **and** the dot posts in that chat, unprompted, mentioning the nonce. Record latency. Repeat once                                                           |
| L3 Approval wake         | The operator starts a Supervised Codex probe thread: "run `echo t3-probe-<nonce>` exactly once"                                                      | `approval` delivered; the dot wakes and tells Dan, quoting the request and digest prefix                                                                                  |
| L4 Approval submit       | Dan tells the dot to approve that probe once                                                                                                         | `respond` receipt; the command runs; the thread row reads "Approved once by Gecko Butler for Dan · via BuildMachine"; `request_closed` and `run_finished` delivered       |
| L4b Decline and replay   | A second probe: Dan says decline. Then he asks the dot to submit the first approval again                                                            | Declined natively; the replay → `already_resolved`, and nothing runs                                                                                                      |
| L5 Forwarded (phase 3)   | As L3–L4, on a new probe thread on CryoFrog (`environmentId`), with the fleet `approvals` flag set for BuildMachine → CryoFrog for the test only     | The relay delivers it with CryoFrog's `factKey`; receipts on both; CryoFrog's row reads "via BuildMachine"; with the flag off → `link_not_approved`                       |
| L6 Owners                | The operator creates probe threads owned by Dan, owned by Gavin and unassigned, then reassigns Gavin's to Dan                                        | The log shows all four facts delivered with correct `owner` and rising `revision`; Dan asks the dot to list T3 events from the last 15 minutes and it reports all of them |
| L7 Revocation (optional) | Only with Dan's consent, at the end: revoke the dot's session, run a probe, then sign in again                                                       | No delivery after revocation (`revoked` in the log); subscribing again works                                                                                              |

The dot's choice to stay quiet about Gavin's threads is its own policy. It is
observed, not asserted as T3 behaviour.

## Phasing and effort

Effort is in focused developer-days, including tests. Live steps need Dan.

| Phase                           | Contents                                                                                                                                                                                                | Needs from the owner feature                                                                                                   | Effort |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **0. Transport and wake probe** | `2026-07-28` enablement behind `agentEvents.enabled`, discover patch, `events/*`, subscriptions (081), verification, signer, public-address guard, delivery worker, `t3 agent-events probe`, live L0–L2 | Nothing                                                                                                                        | 4–5 d  |
| **1. Approvals, local**         | `orchestration:approve` and the checkbox, `t3_approval_request`, receipts (082), `resolvedBy` and its rendering, digest helper, harness approval checks, live L4 by polling (no wake needed)            | Nothing (`read` shows the owner when the shell has it)                                                                         | 4–5 d  |
| **2. Facts and catalog, local** | Deriver, fact store (083), full catalog and payloads, cursors, replay, `truncated`, revocation sweep, `t3_agent_events`, harness restart, dedupe and owner checks, live L3 and L6 (local)               | **Landed:** `ownerId` on the shell, `thread.owner-set` with its sequence exposed, the server-side `fleet-users.json` directory | 5–6 d  |
| **3. Fleet**                    | `t3_link_agent_facts`, `AgentFactRelay`, forwarded approvals, the link `approvals` policy flag and link-card checkbox, two-server harness, live L5 and L6 across machines                               | Owner IDs that are the same fleet-wide (already so)                                                                            | 5–6 d  |
| **4. One ledger**               | Reimplement or retire `t3_lan_task_observe`/`ack` on the fact log, migration 084, rows 4 and 5 to replace                                                                                               | Nothing                                                                                                                        | 2–3 d  |

That is about 20–25 days in total, plus roughly 3 days of harness work spread
across phases.

**Order.** Phase 0 comes first because it settles the biggest unknown, whether
the dot wakes at all, for the least code. If L2 fails, phase 2 is still worth
building for the pull path (`t3_agent_events`, replay), but the plan must be
revisited with Dan. Phase 1 is independent of phases 0 and 2 and can be built
alongside phase 0 by a second agent, with no overlap in files: approvals
toolkit and auth versus `mcp/events` and `agentEvents`. Migration IDs and the
final integration are serialised. Phases 2 and 3 follow in order.

## Limitations

- **Whether the dot really wakes.** OpenAI documents MCP Events as supported
  "in Work chats on ChatGPT web, … and with dots", with workspace controls for
  event-triggered tasks. We have not verified that Dan's plan and workspace
  allow event-triggered tasks for a custom MCP app, or how fast and how
  reliably a dot is woken. Only L2 can show this. A 2xx from ChatGPT proves
  receipt, not wake.
- **Write tools on Pro and personal plans.** ChatGPT may restrict or confirm
  write tools on custom MCP apps for some plans. `t3_approval_request` is
  annotated destructive and open-world, so ChatGPT may ask Dan to confirm each
  call. That is an extra human gate we neither need nor control. If Dan's plan
  blocks write tools for this app, approval submission must use another client
  (for example Codex CLI on his machine with the same grant), and the dot's
  role becomes notifying only.
- **What can't be proven locally:**
  - ChatGPT's verification, refresh cadence, batching and wake;
  - behaviour behind the Cloudflare tunnel (timeouts, header forwarding of
    `MCP-Protocol-Version`);
  - OpenAI's callback-host reachability from BuildMachine;
  - the real Codex Chrome elicitation (fake app-server only).

  Locally, the public-address guard is unit-tested only. The harness runs it
  with the dev-only loopback exception.

- **What a forwarded approval's receiver trusts.** CryoFrog verifies only that
  the link holds `orchestration:approve` and that the thread is within the
  modes in `T3-Mode-Limit`. It records but cannot verify the dot's identity,
  the dot's grant, `onBehalfOf` or `authorization`; those are BuildMachine's
  assertions. A full-access fleet link is not fenced by `linkOrigin`, so with
  the flag on, BuildMachine can approve on any CryoFrog thread within the
  forwarded modes, Gavin's included. That is why the flag is per machine and
  off by default.
- **Human approval is a claim.** T3 records who the agent says approved, not
  proof that they did.
- **Ordering and loss.** Events may arrive out of order (a retry behind a later
  success). Lost peer history is reported as `source_status: gap`, not
  recovered. Abandoned events (after 48 hours) are recoverable only by a
  re-subscribe with an older cursor while the fact is retained.
- **Live-only approvals.** An approval pending when the provider process
  restarts cannot be answered by anyone. The dot gets `blocked: request_lost`
  and should say so rather than retry.
- **Upstream divergence.**
  - `2026-07-28` on `/mcp` with an intercepting patch for `events/*`. effect
    may later provide this; we replace the patch then.
  - A fork scope (`orchestration:approve`), a fork tool and an optional fork
    field (`resolvedBy`) on an upstream command and projection. A database or
    client moving between stock and fork builds already cannot happen
    (migration IDs), and stock clients ignore the field.
  - Upstream #22595 and #26344 were closed for lack of maintainer approval.
    Upstreaming this would need a triaged Ideas discussion (#19534 for events,
    #26527 for remote approvals) first. The approve scope and the MCP Events
    endpoint are the parts most worth proposing.
- **Error codes.** OpenAI documents `CallbackEndpointError` as `-32015`; the
  draft spec uses `-32027`. We follow OpenAI and will revisit if they align.

## Decisions for Dan

1. **Approval opt-in.** A sign-in checkbox, off by default, offered for
   Supervised and above, granting "approve once or decline" only. Confirm, and
   confirm that Full access does **not** imply it.
2. **Fleet link approvals.** A per-machine `approvals` flag in the fleet
   policy, default off. Which machines, if any, should BuildMachine approve on?
   With standard (full-access, unfenced) links, it covers every thread there
   within the dot's modes, Gavin's included. Or should approvals over links be
   limited to threads the link started (`linkOrigin`) even on full-access
   links?
3. **`ask_rule` approvals.** Should approvals raised by the user's own ask
   rule (`fullAccessOverride: "ask_rule"`) be answerable through MCP, or stay
   `ui_only`? Recommended: answerable, since the rule asks a human and Dan is
   the human.
4. **Ledger.** Approve changing row 5 from keep to replace: the fact log
   becomes the one ledger. In phase 4, reimplement `t3_lan_task_observe` on it,
   or retire it with the gateway (row 10)?
5. **Delegated results.** Child-task `run_finished` events are off by default
   in a subscription, while approvals, questions and blockers from child tasks
   are always sent. OK?
6. **Scope of the first live test.** BuildMachine only for phases 0–2; add
   CryoFrog in phase 3 with the flag set for the test and then cleared. A
   disposable `agent-events-probe` project on each. Is L7 (revoking the dot's
   session) acceptable?
7. **Retention.** Facts kept 14 days or 50k, deliveries 7 days,
   subscriptions up to 7 days per refresh. Adjust?
8. **Upstream.** Open an Ideas discussion proposing the approve scope and MCP
   Events before or after phase 1?
