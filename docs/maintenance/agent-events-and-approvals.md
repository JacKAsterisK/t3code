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

[Native feature sync](native-feature-sync.md) rows 4 and 5 point here.
Phase 0 is merged at `8b12091c35`, disabled by default and not released.
Phases 1-4 remain implementation plans; the reviewed initial Phase 1 scope
is verified local Codex permission requests only. This design uses fork main
`45194c8c34` (task owners merged), the original Astra review of `5cf43fb64d`,
and the focused Sol follow-up reviews. Source locations below refer to
`45194c8c34` unless marked otherwise.

**Integration boundary.** The [Phase 0 as-built contract](#phase-0-as-built)
below and actual migration 081 are authoritative over the historical Phase 0
sketches elsewhere in this document. Reuse its session principals, epoch/head
sequence, flat secret names, immutable occurrence times, exact expiry and
durable probes. Keep the verified delivery cancellation and claim-recovery
behavior. Phase 1 reserves additive migration 082 and does not recreate those
services. The acknowledged native-write primitive and all approval guards
must pass before MCP acceptance is enabled. No release or live test is
authorized by this document.

## Summary

**Approvals (Phase 1).** Add a separate `t3_approval_request` tool for local
Codex `item/permissions/requestApproval` requests only. All other profiles
stay app-only initially. Full access never implies approval permission. A separate,
unchecked sign-in box grants `orchestration:approve`; every accepted response
also names the exact request incarnation, displayed grant and effective scope.
Some providers' narrowest accept grants an entire turn. Those require explicit
consent to that scope on that request. Unknown scope, persistent grants and
ask-rule approvals stay app-only. The native serialized command validates the
same presentation again when committing the response. Recoverable receipts
distinguish preparation, native commitment, provider delivery and uncertainty.

**Events (Phase 2).** Derive facts in source-event order with a persisted
reducer, never by replaying against today's projection. Request occurrences
and transitions have durable identities independent of their content hashes.
All readable Dan, Gavin, unassigned, scheduled and child-task attention events
are eligible. Owner assignment and directory-version metadata describe each
historical event and never confer authority. Child run-finished events are
off by default; child approvals, questions and blockers remain eligible.

**Fleet (Phase 3).** BuildMachine pulls origin facts through native links and
relays approved responses once. Destination authority defaults to threads
started through BuildMachine by the same initiating client. Other threads
need explicit destination-side delegation. Both machines recheck current
permission; no linked caller may forward again, even with Full access.

**Consolidation (Phase 4).** Keep `t3_lan_*` observe/ACK working through
Phases 1–3. Consolidate only after a contract-preserving adapter proves ACK,
generation, reset and snapshot parity, or Dan explicitly retires that
contract. No table drop is authorized by this plan.

Phase 1 works by polling without events. Phase 0's wake probe is a separate
proof; a webhook 2xx does not prove the dot woke. Posting an upstream
discussion and any live tests or release remain separate actions. This task
drafts the discussion only.

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
  - Disabling events or shutting down interrupts worker-owned sends and
    releases their claims to `pending`. A hard crash can leave `sending` rows;
    the next start retries them with the same event id.
  - An internal failure releases its claim with a 30-second backoff. Failed
    cleanup writes are retried on later ticks, even while events are disabled.
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
  The claim query requires `expires_at > now`, and the sender rechecks expiry
  after DNS and immediately before connecting. The earlier of subscription
  expiry and the normal 10-second timeout bounds DNS and socket work. Cancellation
  discards late DNS results and destroys sockets; it cannot retract bytes already
  sent.
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
- **Requester side of a link.** `PeerForwarding.callerLimits` uses
  `assertNotLinked`, but that helper refuses only fenced links:
  `apps/server/src/mcp/linkOrigin.ts:55`. Full-access links can pass.
  Phase 3 adds an approval-specific refusal for **every** linked caller
  naming a remote environment. `PeerMcpClient` also retains
  `PeerWriteCeiling` and the forwarded `T3-Mode-Limit`.
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

### F8. Task owners are merged

[Task owners](../operations/task-owners.md) landed in main `45194c8c34`,
including migration **080**. `ownerId` and `thread.owner-set` are available;
the sequence and directory-generation metadata needed here are new Phase 2
work, not already-present owner fields.

`apps/server/src/lan/FleetUsers.ts:46` exposes `current` and `changes`;
`directoryOf` resolves users and the machine default from the last good file.
The file's `version: 1` is a schema version, not a content revision. Refresh
retains last-good data on invalid/unreachable input and clears it on confirmed
absence (`FleetUsers.ts:95`). Names are resolved by `ownerName`
(`FleetUsers.ts:177`).

Owners are labels only. Read-only callers can change them on readable threads.
Never use owner, machine default, name, colour or directory membership to
authorize an approval or suppress events. The dot receives all authorized
events and chooses which person to notify.

## Design

### Components and files

| Component                 | File (new unless noted)                                                                                                   | Role                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MCP 2.0 enablement        | `mcp/McpHttpServer.ts` (edit)                                                                                             | Adds `McpProtocol.v2026_07_28` beside `v2025_06_18`, behind `agentEvents.enabled`                             |
| Events interceptor        | `mcp/events/McpEventsEndpoint.ts`                                                                                         | In the `/mcp` middleware after auth: answers `events/*`, patches `capabilities.events` into `server/discover` |
| Catalog and schemas       | `packages/contracts/src/agentEvents.ts`                                                                                   | Event names, input schemas, payload schemas, cursor codec                                                     |
| Fact deriver              | `agentEvents/AgentFactDeriver.ts`                                                                                         | Follows `EventSink.stream` from a stored watermark and writes facts                                           |
| Fact store                | `agentEvents/AgentFactStore.ts`                                                                                           | The one ledger: append (idempotent), page by `fact_seq`, retention                                            |
| Fleet relay               | `agentEvents/AgentFactRelay.ts`                                                                                           | Per linked peer, long-polls `t3_link_agent_facts` and folds facts in                                          |
| Link fact tool            | `mcp/toolkits/agentEvents/{tools,handlers}.ts`                                                                            | `t3_link_agent_facts` (link-only read) and `t3_agent_events` (status read)                                    |
| Subscriptions             | `agentEvents/AgentEventSubscriptions.ts`                                                                                  | Deterministic IDs, TTL, refresh, unsubscribe, access rechecks                                                 |
| Webhook sender            | `agentEvents/WebhookSender.ts`                                                                                            | Standard Webhooks signing, verification challenge, public-address guard, no redirects                         |
| Delivery worker           | `agentEvents/AgentEventDelivery.ts`                                                                                       | Outbox claims, backoff, 410/413 handling, restart reset                                                       |
| Public-address guard      | `packages/shared/src/publicAddress.ts`                                                                                    | Extracted from `htmlRender/publicProxy.ts` `isLocal` and `shared/hostClassification.ts`                       |
| Approval tool             | `mcp/toolkits/approvals/{tools,handlers}.ts`                                                                              | Local list/read/respond; explicit forwarding refusal until Phase 3                                            |
| Approval service          | `approvals/ApprovalService.ts`, `approvals/ApprovalReceipts.ts`, `auth/ApprovalAuthority.ts`                              | Native command submission, reconciliation and live authority admission                                        |
| Grant and digest          | `packages/contracts/src/approvals.ts`, `packages/shared/src/approvalPresentation.ts`                                      | Provider effect/scope and immutable request binding shared by read, native validation and events              |
| Approve scope             | `packages/contracts/src/auth.ts`, `auth/{McpOAuth,EnvironmentAuth,SessionStore}.ts`, consent surfaces                     | Independent opt-in, scope removal and replacement                                                             |
| Trusted audit             | `packages/contracts/src/orchestrationV2.ts`, `Orchestrator.ts`, `EventSink.ts`, `ProjectionStore.ts`, approval cards      | Server-only admission metadata and projected attribution                                                      |
| Fleet authority (Phase 3) | `approvals/ApprovalForwarding.ts`, `lan/FleetApprovalPolicy.ts`, `lan/FleetCredentialAccess.ts`, `peer/PeerForwarding.ts` | Destination-specific scope, provenance, explicit delegation and per-call cap                                  |

Server-relative paths are under `apps/server/src/`. Phase 1's exact file
list is in [Phase 1 build plan](#phase-1-build-plan). Phase 3 may extend peer
forwarding for namespacing and stable provenance; the earlier claim that no
peer code changes was incorrect. Shared auth and registration edits must be
integrated serially with Phase 0.

### Data model and migrations

Task owners use **080**; Phase 0 uses **081**. Reserve **082**
`AgentApprovalAuthorityAndReceipts` for Phase 1, **083**
`AgentEventFacts` for Phase 2 and **084** `AgentApprovalDelegations` for
Phase 3. Recheck the migration registry before implementation and use the next
free ID >= 082 if another lands. Phase 4 has no destructive migration number
reserved.

For each new ID, register it in `apps/server/src/persistence/Migrations.ts`,
extend `scripts/lan/home-repair.ts` `supportedMigrationIds`, and update the
schema expectations of release/home audits. Treat event delivery and approval
audit state as non-work in `NativeMaintenance`; test actual row, payload and
secret-reference preservation separately from `workGeneration`. Do not
modify unrelated work, grouping, fleet membership or existing peer sessions.

The 081 SQL below is the untouched historical sketch. Implement against
[the actual 081](https://github.com/JacKAsterisK/t3code/blob/a0c1fd7a74/apps/server/src/persistence/Migrations/081_AgentEventSubscriptions.ts):
it already creates `agent_event_log_state(epoch, head_seq, floor_seq)`,
replayable probes and deliveries with `log_seq`. Phase 2 extends that
sequence space rather than creating another log or epoch.

Webhook secrets never enter `statev2.sqlite`. They live in `ServerSecretStore`
under `agent-events/<subscriptionId>[/previous]`, in the `userdata/secrets`
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

-- 082_AgentApprovalAuthorityAndReceipts (phase 1; additive)
CREATE TABLE agent_approval_authorizations (
  session_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL, consent_family_id TEXT NOT NULL,
  initiating_client_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  replaced_by_session_id TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_approval_family
  ON agent_approval_authorizations(application_id, consent_family_id);
CREATE TABLE agent_approval_receipts (
  receipt_id TEXT PRIMARY KEY, role TEXT NOT NULL, -- local|forwarder|receiver
  principal_id TEXT NOT NULL, client_request_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL, operation_json TEXT NOT NULL,
  environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, request_id TEXT NOT NULL,
  request_incarnation TEXT NOT NULL, provider_session_id TEXT NOT NULL,
  provider_generation TEXT NOT NULL, presentation_digest TEXT NOT NULL,
  decision TEXT NOT NULL, effective_scope TEXT NOT NULL, grant_digest TEXT NOT NULL,
  command_id TEXT NOT NULL, state TEXT NOT NULL,
  -- prepared|committed|delivery_admitted|response_written|provider_acknowledged
  -- refused|delivery_withheld|delivery_failed|delivery_unknown
  delivery_evidence_json TEXT, delivery_admitted_revision INTEGER,
  authority_revision INTEGER NOT NULL, actor_json TEXT NOT NULL,
  via_environment_id TEXT, upstream_receipt_id TEXT,
  result_sequence INTEGER, failure_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_approval_retry
  ON agent_approval_receipts(principal_id, client_request_id, role);
CREATE UNIQUE INDEX idx_agent_approval_command
  ON agent_approval_receipts(command_id, role);
-- Native command commitment is the winner guard, not a pre-dispatch submitted row.

-- 083_AgentEventFacts (phase 2; log state/counter already exists in 081)
ALTER TABLE agent_event_log_state ADD COLUMN derived_through_sequence INTEGER NOT NULL DEFAULT 0;
CREATE TABLE agent_event_facts (
  log_seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
  fact_key TEXT NOT NULL, kind TEXT NOT NULL,
  origin_environment_id TEXT NOT NULL, origin_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL, transition_ordinal INTEGER NOT NULL,
  thread_id TEXT, occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  relayed_from TEXT, data_json TEXT NOT NULL
);
CREATE TABLE agent_event_derivation_state (
  state_key TEXT PRIMARY KEY, source_sequence INTEGER NOT NULL, state_json TEXT NOT NULL
);
CREATE TABLE agent_event_directories (
  generation TEXT PRIMARY KEY, content_digest TEXT NOT NULL,
  observed_at INTEGER NOT NULL, directory_json TEXT NOT NULL
);
CREATE TABLE agent_event_source_directories (
  source_generation TEXT NOT NULL, source_sequence INTEGER NOT NULL,
  directory_generation TEXT NOT NULL REFERENCES agent_event_directories(generation),
  PRIMARY KEY (source_generation, source_sequence)
);
CREATE TABLE agent_event_peer_cursors (
  environment_id TEXT PRIMARY KEY, peer_epoch TEXT NOT NULL, peer_seq INTEGER NOT NULL,
  status TEXT NOT NULL, status_transition INTEGER NOT NULL,
  authorization_generation TEXT, updated_at INTEGER NOT NULL, detail TEXT
);
-- Facts, reducer state, matching outbox inserts and watermark advance commit atomically.

-- 084_AgentApprovalDelegations (phase 3)
-- Add durable thread creation provenance and destination-side grants as described below.
-- No DROP TABLE in Phases 1–4.

```

**Retention (Phases 1–4).** Keep ordinary facts for 14 days or 50,000
sequences, whichever prunes first; share Phase 0's sequence counter with probes.
Never prune past an unfinished delivery: pin its payload and the contiguous
suffix after the oldest pinned sequence, so the floor represents a real
contiguous retained range. This makes 50,000 a soft cap while deliveries are
unfinished. Retry abandonment is 48 hours after queueing, including expiry
time; never send while expired. After abandonment, pruning can resume and the
diagnostic cursor reports the gap. The soft-cap overrun is limited by the 48-hour unfinished-delivery horizon;
report pinned rows and bytes in status. Never silently advance a cursor
across missing payloads.

Keep finished delivery rows and ended subscriptions 7 days, callback
verification 24 hours, and renew subscriptions by the granted expiry (default
24 hours, maximum 7 days, bounded by session expiry). Phase 0 owns transport
expiry/replay implementation. Phase 2 extends its recomputed watermark and
ahead-of-head rejection to facts; occurrence timestamps remain fixed.

Approval audit is independent: retain full terminal receipts 90 days.
Never prune a prepared, committed-with-pending-delivery, delivery-admitted
or uncertain receipt.
Retain compact retry-key/operation/command/incarnation tombstones until the
issuing authorization and every expressly linked replacement are revoked or
expired and native delivery has settled. A retired tombstone can never name
an approvable incarnation again; a reused old key then fails `not_live`,
never targets a newer request. No approval receipt is pruned by event limits.
Owner directory snapshots and reducer checkpoints survive as long as any
retained fact or replay source needs them.

### Identity

- **Request incarnation.** Allocate a fresh durable identifier at native
  request admission, even if the native request ID is reused. Carry
  `{ requestIncarnation, providerSessionId, providerGeneration }` through
  the request, turn item, command and response effect. Late presentation
  updates increment `presentationRevision`; they do not change incarnation.
  A genuinely new request gets a new incarnation.
- **Fact key.** An attention occurrence is keyed by origin environment,
  source generation, thread, request incarnation (approval/question/secret),
  blocker entry occurrence, run attempt, or owner assignment sequence.
  Two approvals on one thread never share an occurrence. A blocker that
  clears and recurs gets a new entry occurrence.
- **Event ID.** `t3e1_` plus a hash of canonical
  `[originEnvironmentId, sourceGeneration, sourceSequence,
  transitionOrdinal, kind, occurrenceId]`. The ordinal is a stable reducer
  output order within that source event. A → B → A changes produce three
  transitions despite equal content hashes. Close, secret, blocker and
  source-status transitions each have an occurrence/revision; hashes guard
  content, never deduplicate distinct transitions.
- **Sequence.** `log_seq` comes from 081's shared head counter in the same
  transaction as the fact insert. A fact-log rebuild changes its cursor
  epoch but preserves source generation and event IDs. An actual source
  reset changes source generation and reports a gap. Imported facts retain
  their original IDs and source coordinates.
- **Principal.** Reuse Phase 0's `session:<sessionId>` (or an explicitly
  supported non-task `grant:<grantId>`). Never combine OAuth application ID
  with `mcp-client:local` to identify a principal. Separate sign-ins have
  separate receipt keys and subscription ownership. Consent family and
  initiating-client provenance below are separate concepts, not principals.
  Credential renewal preserves provenance only by authenticated, explicit
  replacement; it never merges unrelated sign-ins.
- **Subscription identity.** Reuse the Phase 0 helper and canonical
  arguments. No owner ID enters identity, filtering or read authorization.

### Event catalog

Phase 2 extends the Phase 0 probe-only catalog to these six definitions,
each with `delivery: ["webhook"]`. The event's `answerable` field describes
provider support, not subscriber authority; `read` supplies current caller
rights before a response. Never bake a subscriber-specific grant into an
immutable shared fact.

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
  } | null,                              // null only for source_status/probe
  run: { id: string, attemptId: string | null } | null,
  owner: {
    state: "assigned" | "unassigned" | "unknown_user",
    id: string | null,                   // fleet-users.json id; null when unassigned
    label: string | null,                // that user's name as the origin resolved it
    assignmentRevision: number,          // source sequence of create/last owner-set
    sourceGeneration: string,            // distinguishes source reset/rebuild
    directoryGeneration: string | null,   // origin-local observation generation
    directoryDigest: string | null,       // hash of canonical validated users file, not schema version 1
    directoryObservedAt: string | null,
    asOfSourceSequence: number,
    machineDefault: { id: string, label: string | null } | null  // only when unassigned: informational
  } | null,                              // null for facts without a thread
  origin: { environmentId: string, sourceGeneration: string,
            sourceKind: "orchestration" | "peer_status" | "bootstrap",
            sourceSequence: number, transitionOrdinal: number, occurredAt: string },
  relay: { viaEnvironmentId: string, relayedAt: string } | null,
  detail: ApprovalDetail | QuestionDetail | SecretDetail | BlockedDetail
        | RunFinishedDetail | OwnerChangedDetail | RequestClosedDetail | SourceStatusDetail
}

ApprovalDetail = {
  requestId, requestIncarnation, providerSessionId, providerGeneration,
  requestKind, appName?, prompt?, reason?, fullAccessOverride?,
  options: [{ decision, label, warning? }],
  grant: ApprovalGrant,                            // actual resources, native reply and effective scope
  presentationDigest: string,                      // includes the underlying grant and binding
  answerable: { via: "t3_approval_request", decisions: ("accept" | "decline")[],
                requiredConsentScope: "once" | "turn" | null }
            | { via: "ui_only", reason: string },
  createdAt, presentationRevision: number, supersedesEventId: string | null
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

**Owner semantics.** Every fact describes the assignment at its source
transition, with separate `assignmentRevision`, `sourceGeneration`,
`directoryGeneration` and `directoryDigest`. The directory digest covers
the validated users file and machine defaults, not its constant schema
`version: 1`. The generation identifies an origin observation; a rename
therefore cannot masquerade as the same label revision. Last-good data is
marked with its original observation time. Confirmed absence, never-read and
unknown-user states are explicit. A machine default is informational and
never overwrites a historical unassigned owner.

Phase 2 first extends `lan/FleetUsers.ts` with a separate observation feed:
`{ status: fresh|unavailable|invalid|absent|never_read, observedAt,
observationGeneration, directoryDigest?, lastGoodObservedAt? }`. Emit every
refresh outcome, including unchanged successful reads and failed reads that
retain last-good values. Existing `current/changes` expose values only and
cannot establish freshness (`FleetUsers.ts:44`, `:109-145`). Persist the
observation feed before binding its generation to source commitment; reading
the share or waiting for it never happens inside an EventSink transaction.

Phase 2 adds `agentEvents/AgentEventOwnerJournal.ts`: snapshot each accepted
`FleetUsers` directory observation with a persisted generation/digest and
bind that generation to source events **at source commitment**, inside the
EventSink transaction. Extend stored-event metadata (and its SQL storage)
with this immutable reference. Directory changes and event capture serialize
at that boundary; the deriver never asks today's `FleetUsers.current` for
an old event. Retain the referenced snapshots when rebuilding facts.

The ordered reducer gets assignment changes from `thread.create` and
`thread.owner-set`; no new owner-shell field is assumed. Phase 2 extends
`t3_thread_read`/approval `read` with current assignment/source/directory
coordinates and freshness status. Before person-specific notification, the
dot **must** resolve the current owner at the origin. If the origin or
directory freshness cannot be established, report the historical assignment
and the uncertainty; do not guess who should be notified. A delayed fact keeps
its original owner even after reassignment. This routing rule never removes
Dan's, Gavin's or unassigned facts from delivery.

### Presentation digest

`ApprovalGrant` is a new adapter-produced contract in
`packages/contracts/src/approvals.ts`:

```ts
{
  version: 1,
  provider: string, providerVersion: string | null, nativeMethod: string,
  nativeDecision: unknown,              // validated, exact outbound permission decision
  permission: unknown,                  // validated authorization-relevant native payload
  resources: { commands?: string[], cwd?: string, paths?: unknown[],
               network?: unknown, tool?: string, input?: unknown },
  effectiveScope: "once" | "turn" | "session" | "persistent" | "unknown",
  appliesTo: string,                     // human-readable exact authority, no reason-only summary
  expiresWhen: string,
  persistence: "none" | "provider_session" | "disk" | "unknown",
  supported: boolean, unsupportedReason?: string
}
```

`unknown` above means a provider-specific decoded JSON union in the real
schema, not arbitrary unvalidated input. Never infer scope from button text,
`requestKind` or the provider's reason. Retain the complete permission
payload in the authoritative request/event; sanitize secrets, not
authorization-relevant fields. If safe presentation cannot describe the
whole grant, refuse MCP accept. Capture and validate the original native
request **before lossy schema decoding**. For the initial Codex profile,
`effect-codex-app-server/src/client.ts` validates a recursively closed,
versioned raw profile at `dispatchRequest`, before `decodeOptionalPayload`
in `_internal/shared.ts` can discard excess properties. Preserve the raw
request plus supported/unsupported validation evidence with its binding;
unknown keys at any permission/network/filesystem nesting make it app-only.
Do not change unrelated native decoding globally or hash a stripped object
as proof that the original authority was fully presented. Unsupported raw
shapes retain a safe bounded app presentation without authorizing MCP replies.
Event previews may truncate text but
`read` must return the full safe grant (or `ui_only: incomplete_grant`).

`approvalPresentationDigest` hashes canonical, versioned JSON containing
environment/thread/run/request/incarnation, provider session/generation,
native request/method, presentation revision, created time, ordered offered
options, prompt/reason/app/override, and the full `ApprovalGrant`.
`grantDigest` separately hashes its grant portion. The UI, read tool,
events, native command validator and adapter delivery guard use the same
helpers. Missing metadata on an old pending request is `ui_only`; never
backfill by guessing.

A provider update increments presentation revision even for A → B → A.
The native response command receives the expected binding and digest and
validates them again under the target thread lock, immediately before
resolution/commit. A handler-side read is for presentation only.

### Fact derivation

`AgentFactDeriver` consumes committed `EventSink.stream` source events in
global sequence order and feeds a persisted reducer. It applies each event
to its own thread/run/item/request/owner state, then derives transitions
from before/after state **at that sequence**. Do not call
`getRuntimeResponseContext`, today's shell or the latest assistant message
when replaying history.

| Source transition                                                         | Fact                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Pending approval and its item become present, or its version changes      | `approval`, keyed by incarnation and transition; include the full grant binding            |
| Pending user input or secret request appears/changes                      | `question` or `secret`; secrets contain only the requested name                            |
| Runtime request resolves/expires/cancels                                  | `request_closed`; native commitment is separate from provider delivery                     |
| Live request becomes unrecoverable, or answer delivery definitively fails | `blocked: request_lost` or `answer_not_delivered`                                          |
| Limit recovery enters waiting, clears, then enters again                  | One blocker entry per occurrence, with explicit revisions                                  |
| Run attempt enters a terminal state                                       | `run_finished`; result preview reduced from messages committed by that sequence            |
| Thread create/owner-set changes assignment                                | `owner_changed`, with immutable source-time owner snapshots                                |
| Relay connection/status changes                                           | A durable status-transition occurrence; repeated unreachable/following cycles are distinct |

Commit reducer/checkpoint updates, every emitted fact, log-head allocation,
all matching durable outbox rows (or an explicit replayable matcher
watermark), and source watermark in one SQL transaction. A crash cannot
advance derivation past undelivered matching work. Duplicate replay of one
source event is a no-op; equal content on a new transition is not.

**Activation/bootstrap.** Take one consistent read transaction at source
sequence S, snapshot required reducer state and the directory observation,
and atomically store activation generation, snapshot, watermark S and
pending-attention bootstrap facts. Those facts say `bootstrap_snapshot`
and observed-at S; they do not claim the request originally opened then.
Resume events after S. Do not emit old terminal runs. For historical events
predating the owner journal, keep label revision unknown, or use the S
snapshot only for the explicitly marked bootstrap; never rewrite their past
labels with current names. A supported rebuild uses the retained checkpoint,
immutable source events and directory references. Missing source history
produces an explicit gap, not invented transitions.

Derive every readable thread irrespective of owner, launch source or
delegation. Suppress child `run_finished` only during subscription matching
unless `includeDelegatedResults`; always match child attention kinds.
Parent completion/failure remains based on native child accounting, not
synthetic completion from suppressed child facts.

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
- **First follow.** `after: null` starts at the peer's current head without replaying retained facts, matching a new subscription. The initial read uses `waitMs: 0`; facts emitted after that head, including newly emitted bootstrap/pending facts, are ordinary new facts. Existing pending requests remain inspectable through approval read/list; old facts are never relabelled as new occurrences.
- **Restart.** It resumes from the stored cursor.
- **History lost on the peer.** A new peer epoch, a cursor below its
  floor, or a same-epoch cursor ahead of a restored head replays from the peer's floor. IDs dedupe. It also records one
  `source_status: gap` fact, because events between the old cursor and the
  floor are gone.
- **Peer state changes.** An old peer that lacks the tool becomes
  `unsupported` and is retried hourly. A dropped link becomes `unreachable`
  and is retried with backoff. Each state change produces a single
  `source_status` fact.
- **Reads only.** A read-only link is enough to follow facts.
- **Status identity.** Persist each peer status transition counter with the
  cursor update and its fact. Use source kind `peer_status`, the peer ID
  and that counter as its occurrence; do not pretend it is an orchestration
  event. A repeated unreachable/following cycle gets new events.

**Visibility (Phase 3 integration).** Reuse Phase 0's outside-sharing
authority predicate at subscribe, refresh, pull and each send. Extend it with
one `canReadFactNow` predicate shared by relay export, cached reads, replay,
matching and delivery. Check current thread existence/visibility, enabled
Linked environments on both ends, the authenticated link's current
credential/read cap, source authorization generation and requester limits.
Owner is never consulted. Threadless source-status facts contain only
current local connection diagnostics, not cached thread content; they use
current local link/read authority rather than requiring a successful poll
of the unavailable source. When remote authority cannot be established for
thread facts, hold
cached facts without sending; an old successful poll is not permission to
send after an outage or revocation. Permanent deletion/revocation records a
reasoned skip; uncertainty does not advance delivery progress.

The Phase 3 link read contract additionally returns an authorization
generation and supports validating a bounded set of cached thread/fact
references immediately before external delivery. A restarted, expired,
disabled or narrowed link invalidates cached authority. Remote access
changes after the final check and an already-in-flight network request are
an unavoidable boundary; record check time/generation and never claim bytes
already sent can be recalled. Relayed payloads/IDs remain immutable, and
received facts are never re-exported as local origin facts.

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

Phase 1 registers a fork toolkit `mcp/toolkits/approvals`. It is available
over both existing tool-call protocols and independent of events. The handler
calls `approvals/ApprovalService.ts`; it does not implement native policy.
`t3_pending_request` remains user-input-only.

```ts
type ApprovalToolInput =
  | { action: "list"; threadId: ThreadId; environmentId?: EnvironmentId }
  | {
      action: "read";
      threadId: ThreadId;
      requestId: RuntimeRequestId;
      environmentId?: EnvironmentId;
    }
  | {
      action: "respond";
      threadId: ThreadId;
      requestId: RuntimeRequestId;
      environmentId?: EnvironmentId;
      clientRequestId: string; // top-level; 8–128 chars
      expected: {
        requestIncarnation: string;
        providerSessionId: string;
        providerGeneration: string;
        presentationRevision: number;
        presentationDigest: string;
      };
      decision: "accept" | "decline";
      consent: {
        effectiveScope: "once" | "turn";
        grantDigest: string;
        onBehalfOf: string;
        authorization: string;
      };
    };
```

List/read require ordinary current read authority and return
`ApprovalDetail`, current owner coordinates and `answerable` for this
caller. Respond requires the separate approval permission, including for a
decline. Thread and task-only callers are refused; unknown extra fields
(including a public `attestation` or `resolvedBy`) are rejected. Phase 1
returns `forwarding_unavailable` for any remote `environmentId`; it does
not accidentally route through the generic thread toolkit.

A receipt result is
`{ receiptId, commandId, state, replayed, decision, effectiveScope,
sequence?, failureCode?, deliveryEvidence? }`. `committed` means the native
resolution and response effect are durable, with no claim of transmission.
`delivery_admitted` names the irreversible handoff authorization boundary.
`response_written` means a command-bound native response write completed;
`provider_acknowledged` is available only for an explicit correlated peer
acknowledgment. Neither means the tool executed. Codex has no such peer
acknowledgment for JSON-RPC responses, so Phase 1 reports `response_written`.
Resolving an in-memory deferred or inserting into an outgoing queue never
counts as a completed write. `prepared`, `committed` and `delivery_admitted`
remain visibly pending; `delivery_unknown` is uncertain. Exact retry returns
the same operation/receipt and its latest state.

Refusal codes extend `OrchestratorMcpFailure` in
`packages/contracts/src/orchestratorMcp.ts`: `approvals_not_granted`,
`thread_caller_refused`, `task_only_refused`, `request_not_found`,
`not_an_approval`, `not_live`, `request_changed`,
`presentation_changed`, `decision_not_offered`, `scope_consent_required`,
`scope_unsupported`, `ui_only`, `idempotency_conflict`,
`already_answered`, `authority_revoked`, `forwarding_unavailable`;
Phase 3 adds `link_not_approved`, `thread_not_delegated`,
`forwarding_chain_refused`. Preserve native capability/mode refusal codes.
`already_answered` returns safe resolution status/actor/sequence when
readable, including when the T3 app won. It never says this MCP call succeeded.

### Provider approval matrix

These are **effective** grants at main `45194c8c34`, not promises derived
from a label. Phase 1 adds adapter-produced grant descriptors and focused
protocol tests for supported rows. Missing/unknown payload or scope remains
`ui_only`. For every accept, bind the selected native reply and full
authorization-bearing input to the digest.

**Initial Phase 1 support is local Codex `item/permissions/requestApproval`
only**, for a verified raw native version/profile, with exact turn consent
and both accept/decline through the guarded service. All other profiles are
app-only initially. The matrix records conditions for later support, not
permission to enable them in this implementation. A nonpersistent Chrome
elicitation profile needs its own verified reply/lifetime tests before a
later enablement; it is not inferred from form labels or defaults.

| Provider/request                                                            | Actual accept and lifetime                                                                                                                                                                         | Profile requirements (permissions row only in initial Phase 1)                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex `item/commandExecution/requestApproval`, legacy `execCommandApproval` | Native `accept` / legacy `approved`; does not enter T3's session allowance. `acceptForSession` and `acceptAlways` do.                                                                              | App-only initially. Later profile requirements: Support request-once only when the native contract is known. Show full command/argv, cwd, requested execution/network/filesystem authority and policy-amendment proposal; do not use `reason ?? command` as the permission. No amendment/session choice.             |
| Codex `item/fileChange/requestApproval`, legacy `applyPatchApproval`        | Nonempty `grantRoot` requests session-wide root writes with uncertain native semantics (`schema.gen.ts:49278`, `:47113`); native accept does not narrow it.                                        | App-only initially and always app-only for nonempty `grantRoot`, for both methods. Rootless support additionally requires verified complete proposed changes and native lifetime; never classify a root grant as once.                                                                                               |
| Codex `item/permissions/requestApproval`                                    | Returns the **whole** requested permissions with `scope: "turn"`; decline returns empty permissions.                                                                                               | Support `effectiveScope: "turn"` only with explicit per-request turn consent and full filesystem read/write paths, network fields from the verified raw profile; unknown raw fields make it app-only. Plain “approve once” is refused. Never infer from mapped command/file-read/file-change kind.                   |
| Codex `mcpServer/elicitation/request`                                       | Form accept uses `toMcpElicitationResponse`; no requested persistence. URL accept maps to decline (normally rejected before a card).                                                               | App-only initially. Later profile requirements: Support only representable nonpersistent form acceptance. Show app/server, request/schema and exact generated content, including defaults. If no true nonpersistent option exists, or persistence is ambiguous, app-only. URL/forms needing user data stay app-only. |
| Claude `canUseTool`                                                         | `behavior: "allow"` with exact `updatedInput`, `user_temporary`; once adds no `updatedPermissions`. Session choice adds permission updates.                                                        | App-only initially. Later profile requirements: Support once; show actual tool name and effective input, not its title. Session/disk rules are excluded. `fullAccessOverride: "ask_rule"` stays app-only, including decline.                                                                                         |
| Claude MCP elicitation                                                      | Supported form path reuses the Codex elicitation acceptance helper; unsupported/URL forms are declined.                                                                                            | App-only initially. Later profile requirements: Same representability/nonpersistence requirement; exact generated form content is part of the grant.                                                                                                                                                                 |
| ACP command permission                                                      | `allow_once` is selected, **and** `makeAcpClientPolicyGrants.recordApproval` enables command execution for the remainder of that provider turn. ACP cannot bind the grant to one terminal command. | App-only initially. Later profile requirements: Support explicit turn consent only. Show the requested tool call and the broader permission to execute additional commands in that turn; expiry names the provider turn.                                                                                             |
| ACP file read/change and other known permission kinds                       | Selects offered `allow_once`; T3's extra client-policy execution grant applies only to command kind. `allow_always` may persist beyond a session.                                                  | App-only initially. Later profile requirements: Support once only for a verified flavor/request profile with complete tool call, locations, inputs and native options. Unknown kinds, missing `allow_once` or unverifiable provider semantics stay app-only. Never fall back to `allow_always`.                      |
| Antigravity, Grok, Fx, ACP registry agents                                  | Use the shared ACP adapter, with flavor-specific classification and question extraction.                                                                                                           | App-only initially. Later profile requirements: Inherit the ACP command turn grant and verified file profiles. Questions extracted from permission requests remain questions. New registry providers default unsupported until profiled; no inference from a familiar name.                                          |
| Pi extension `confirm`                                                      | Sends `confirmed: true` once; `acceptForSession` adds a title/message-based T3 session grant. The arbitrary extension decides what true means.                                                     | Default app-only: a prompt is not proof of permission scope. Only a verified extension profile describing the action, input and lifetime can expose once. Other extension UI methods are questions.                                                                                                                  |
| OpenCode v1                                                                 | `accept` maps to `permission.reply(..., reply: "once")`; both session/always map to native `always`.                                                                                               | App-only initially. Later profile requirements: Support only a verified version/profile whose native once semantics are known, with permission, patterns/resources, metadata and request/session identity shown. Unknown coalescing or persistence => app-only. Never send `always`.                                 |
| OpenCode v2                                                                 | Native reply `decision: "once"`; session/always additionally persist T3 rules for the asking subagent's project.                                                                                   | App-only initially. Later profile requirements: Same verified-once gate; show action/resources/save proposals and asking session/project. Accept writes no standing rules. Decline may send a steer and reject; disclose that effect.                                                                                |
| Muse                                                                        | Sends the selected native `choiceId` and `currentRequirementId`. Decision names alone do not establish scope: an `approved` choice can have a different scope. Decline may map to abort.           | App-only initially. Later profile requirements: Support only an offered choice with explicit `scope: "once"`, complete subject/raw args/requirement revision and no amendment. Show abort semantics when that is the offered decline. Session/localPersistent and unknown scopes stay app-only.                      |
| Cursor SDK                                                                  | No interactive approval callback; `respondToRuntimeRequest` returns unsupported.                                                                                                                   | App-only/unsupported, never synthesize a native permission request.                                                                                                                                                                                                                                                  |
| Future/other adapters                                                       | Unspecified.                                                                                                                                                                                       | Deny MCP accept until an explicit provider profile and protocol-effect tests exist.                                                                                                                                                                                                                                  |

Evidence: Codex mappings at
`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:563`,
`:591`, `:5216`, `:5287`, `:5359`, `:5421`, `:5500`;
elicitation at `apps/server/src/provider/CodexMcpElicitation.ts:184`.
Claude at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:3414`, `:9757`, `:9841`.
ACP at `packages/provider-acp/src/server/adapter.ts:1025`, `:6050`,
`:6167`, `clientPolicy.ts:235`; flavor entrypoints at
`apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts:256`,
`packages/provider-{grok,fx,acp-registry}/src/server/adapter.ts`.
Pi at `packages/provider-pi/src/server/adapter.ts:1305`, `:2787`,
`:3374`. OpenCode at
`packages/provider-opencode/src/server/OpenCodeRuntime.ts:370`,
`server/adapter.ts:3533`, `server/v2/adapter.ts:3830`. Muse at
`packages/provider-muse/src/server/protocol.ts:203`, `:228`,
`server/adapter.ts:1062`. Cursor at
`packages/provider-cursor/src/server/adapter.ts:2709`.

Session/persistent approvals are not supported over MCP in Phase 1.
The opt-in permission is never blanket consent to turn scope. Every accept
carries `consent.effectiveScope` and the exact `grantDigest`; a turn grant
requires the owner's words to explicitly acknowledge that turn-wide authority.
T3 validates that the structured consent matches, and records the words as an
agent assertion; it cannot prove what Dan actually said. Decline can refuse
a supported request without consenting to grant its permission. Unsupported
types and ask-rule requests remain app-only for both decisions.

### Enforcement points

**Authoritative local path.** Preserve native pending/resumable/live-session,
provider-enabled and runtime/interaction-mode checks. The important source
boundaries are `Orchestrator.ts:8732` (response plan), `:13385` (thread
lock), `EventSink.ts:635` (atomic events/projections/command receipt/outbox)
and `EffectWorker.ts:389` (provider response).

1. Authenticate an outside client and re-read current session authority,
   approval opt-in and credential caps. List/read may run without approval
   scope; respond may not. Tool visibility is convenience, never enforcement.
   `McpToolAccess.approves` refuses thread/task-only/read-only callers and
   provides `DispatchModeLimit`.
2. Compute the complete immutable operation digest, including principal,
   target, expected binding, decision, grant/scope and consent/claimed actor
   text. Look up `(principal, clientRequestId, role)` **before** testing
   pending status. A matching operation reconciles/returns its receipt;
   different arguments give `idempotency_conflict`. Unauthorized old tokens
   cannot use retry to regain approval rights.
3. Insert `prepared` with stable `commandId = approval:<receiptId>` and
   immutable operation JSON. Preparation does not reserve or resolve the
   request. A crash here leaves a recoverable intent, not success.
4. Dispatch a server-only guarded `runtime-request.respond`. Under the
   target thread lock and native-update admission, re-read request/item and
   recompute binding/digest, offered decision, provider profile, scope and
   live session/generation. Check ask-rule exclusion and current modes.
   A changed incarnation/session is `request_changed`; a changed
   presentation/grant is `presentation_changed`. The decision must be
   offered by the current native profile/options. Never infer an offer from
   absence of the options array.
5. At that same commit boundary, recheck approval authority/revision through
   `ApprovalAuthority`'s admission gate. Revocation/downgrade and approval
   commitment serialize on that gate; a call authorized before revocation
   cannot commit after it. Lock order is thread lock, then authority gate;
   revocation takes no thread locks. No network I/O inside this gate.
6. Native request resolution, trusted actor, approval receipt `committed`,
   command receipt and guarded response outbox effect commit in **one**
   EventSink SQL transaction. The app and MCP race has exactly one native
   winner. If the app or another operation won, this receipt is
   `refused: already_answered`; do not report submission.
7. The guarded effect also carries the authenticated approval principal,
   authorization identity/revision and original credential/mode ceiling,
   alongside incarnation/session/generation/grant binding. Immediately
   before irreversible adapter handoff, **delivery admission** rechecks
   current approval authority, credential caps, effective modes and current
   immutable native binding. Admission and removal serialize on the same
   authority gate. Keep the adapter response gate held through this check
   and handoff; follow a fixed thread/native-admission -> adapter-response
   -> authority-gate lock order, and never acquire those locks in reverse.
   Local receipt SQL may run under that gate; provider/network waits may not.
8. Admission durably records `delivery_admitted` with the checked revision
   and passes a command-bound admission token into the provider response
   path. Before admission, removal wins and withholds delivery. After this
   boundary the native handoff may be irreversible and cannot be recalled;
   describe that boundary honestly, including a crash before write evidence.
   Revalidation is not an earlier check outside the removal gate.
9. Carry a typed result through deferred handoff, queue admission and the
   actual writer. Codex's current `respondToRuntimeRequest` only resolves a
   deferred (`CodexAdapterV2.ts:7716`); `protocol.ts:248,339,482` subsequently
   encodes, queues and writes. Add stable command/native-response IDs and
   completion/failure hooks to the owned client/protocol writer. Queueing
   produces pending evidence, completed transport write produces
   `response_written`, and only an actual correlated peer acknowledgment
   can produce `provider_acknowledged`. Preserve actual provider differences;
   do not wrap the existing adapter return as a delivery acknowledgment.
   This requires extending/replacing the owned `_internal/stdio.ts`
   transport-creation bridge as well as the client/protocol hooks. Its
   current opaque `handle.stdin` sink can finish after `writable.write`
   accepts bytes into Node's buffer, before a write-completion callback.
   Add a command-bound acknowledged-write primitive at the actual child
   stdin writer, with completion/failure/interruption evidence. If the
   existing child handle hides that callback, extend the owned creation
   bridge or local spawn wiring rather than inferring completion from the
   sink, queue, return value or `drain`. Serialize message writes, honor
   backpressure and preserve the same stdin across messages; close it only
   at the owning process/scope boundary. No vendored Effect source edits.
   MCP acceptance remains disabled until this primitive and its delayed-
   callback, failure and interruption tests pass.
10. A trusted delivery-result command persists receipt/outbox evidence.
    Definite failure before handoff is `delivery_failed` (or the policy
    refusal below); ambiguous or interrupted admitted writes are
    `delivery_unknown`. These are typed terminal outcomes of the response
    effect, not ordinary execution errors routed into EffectWorker's
    generic retry policy (`EffectWorker.ts:819`). Suppress blind resend.

**Withheld-response recovery.** A committed response denied at delivery
admission becomes terminal `delivery_withheld`, with `authority_revoked`,
`mode_changed` or `request_changed` as appropriate, and an app-visible
attention state. If the exact native deferred is still live and proof says
no handoff occurred, a guarded internal recovery command re-exposes it in
the app with a new T3 request incarnation/revision. The old receipt and
consent remain terminal and cannot resolve that incarnation. Otherwise
show `request_lost` and the existing app restart/retry path. Uncertain or
already admitted sends are never reopened as provably unanswered requests.

The guarded expected fields and actor live on an internal
`OrchestrationV2ServerCommand` variant/context, not an optional
client-authored `resolvedBy` field. Public UI RPC rejects those fields.
Ordinary UI responses still use native dispatch and receive trusted
user/session attribution. UI does not acquire MCP approval scope merely
because the request is shared. Add offered-decision validation to the shared
native path so the UI cannot submit an unoffered answer either.

**Recovery.** Startup and matching retries reconcile by stable command ID
against `CommandReceiptStore` and the effect outbox **before** resubmission.
A prepared receipt with no command receipt may dispatch only while its
original authority and exact request remain valid. A committed receipt
with no completed-write evidence is pending delivery, not completion. Recover
from native receipt acceptance even if the caller lost the HTTP response.
If the provider session died, report `request_lost`/delivery failure;
never claim the command ran.

Adapter idempotency uses the same response command ID plus request binding.
A duplicate send to a known completed deferred returns its recorded response
outcome. For a native transport with no dedupe/query facility, an ambiguous
write is not blindly replayed: retain `delivery_unknown` and require
reconciliation or app inspection. A new approval requires a new incarnation
and fresh consent. An uncertain receipt never prevents inspection or falsely
marks an unanswered request as done.

#### Forwarded approvals

Phase 3 adds `approvals/ApprovalForwarding.ts`; Phase 1 refuses all remote
targets. Use A = BuildMachine, B = CryoFrog, and A's authenticated native
link **to B**. A is the requester/forwarder; B owns the request and commits
the native response.

**Authority is the intersection of these checks:**

- The dot's current session on A explicitly holds `orchestration:approve`,
  remains non-read-only and is within its modes.
- A's current outbound Machine access list permits writes to B.
- B's authenticated link from A currently holds the approval scope after
  destination credential caps. B's destination-specific approval policy
  enables that link; mode ceilings still apply.
- The target's immutable creation provenance names that authenticated A link
  **and** the same initiating-client identity, or B has an explicit,
  unrevoked delegation for that link/client/thread. This additional approval
  restriction applies even to Full access links.
- All native request/incarnation/presentation/scope/consent checks pass at B.

Neither owner labels nor `onBehalfOf: "Dan"` establish any of those rights.
Dan's events and Gavin's events are delivered on the same read basis, but
event delivery does not grant permission to answer them.

**Stable provenance.** In migration 084 persist
`agent_thread_approval_origins(thread_id PRIMARY KEY,
source_environment_id, link_identity_id, initiating_client_id,
creation_command_id, created_sequence)`, plus
`agent_approval_delegations(delegation_id PRIMARY KEY, thread_id,
link_identity_id, initiating_client_id, policy_revision, created_by,
created_at, revoked_at)`. Foreign keys/uniqueness bind a delegation to that
destination. Link identity is server-assigned and survives authenticated link
credential renewal; environment label, subject text or owner is not identity.
A assigns an opaque initiating-client ID at consent and passes it only in
server-built launch/forwarding metadata. B stores it with authenticated
immediate-link provenance at creation. Explicit owner-approved replacement
may carry that client ID forward; a fresh sign-in otherwise gets a new ID.
Existing threads/provenance without both values need explicit delegation.
For this approval path only, target authorization accepts the ordinary
same-link fence **or** a current destination delegation for this exact
link/client/thread. Do not change the thread's creation provenance or loosen
other native write tools. Mode ceilings and native request checks still hold.
Add provenance to the actual shared launch service and all MCP launch routes,
not only to `t3_thread_launch`.

**No chaining.** On **every** approval forwarding entry, reject
`scope.client.linked === true` whenever it names a remote environment,
regardless of access level. A linked receiver accepts only a local target.
Do not rely on `assertNotLinked`'s fenced-link behavior. Export only origin
facts; that separate event rule is not an approval-chain guard.

**Wire contract.** The public approval schema has no attestation field.
Use a separate hidden, link-only `t3_link_approval_request` schema in the
same toolkit, with operation `prepare | commit | status`, a receiver-local
target and server-built asserted initiating client/consent/forwarder receipt.
B derives immediate sender and link identity from authenticated invocation
metadata. It records the initiating client and human words as **asserted by
A**, never independently authenticated facts.

A's retry key is explicitly namespaced by
`hash(["approval-v1", A, initiatingPrincipal, clientRequestId])` before
forwarding. B keys retries by stable authenticated link identity plus that
key and verifies the complete operation digest. Keep the key top-level;
`PeerForwarding.ts:153` only namespaces a top-level `clientRequestId`.
Credential rotation must not create a second remote operation.

A persists a prepared forwarder receipt, B persists an immutable prepared
receiver operation, then B commits through the same guarded local service.
A stores B's receipt/command ID. Lost replies are reconciled through the
link-only `status` operation; A never retries with a new key or reports
success from its own preparation. Status access is limited to the originating
link and operation. Neither side's `prepared` state reserves native success.
B must recheck current link policy/delegation at commit, not only at prepare.

**Compatible destination policy.** Do not add `approvals` to the strict
signed `FleetAccessEntry` machine shape (`FleetAccessPolicy.ts:32`).
Use a separate versioned file
`fleet-approval-policy/<destinationMachineId>.json`, signed by that
destination's existing fleet identity. It is a complete snapshot with
`version: 1, fleetId, destinationMachineId, revision, previousDigest,
createdAt, grants: [{ callerMachineId, enabled }], signature`.
Validate signer/destination against the current trusted roster. Only that
destination's authorized owner/admin may write it. Existing readers ignore
the new directory and continue reading unchanged fleet-access files.
A local destination revision is authoritative immediately; distribution
copies, old links and relink offers cannot override a newer local revocation.
Invalid/unknown/conflicting or rollback revisions grant no approvals.
Use the same strict canonical signing/atomic-write patterns as FleetFiles.
A manual link uses the same destination-local record keyed by stable link
identity; no unsigned client label grants permission.

`FleetCredentialAccess` strips `orchestration:approve` on **every**
linked call unless the current destination policy permits it. Removal works
with the retained old link token and with an already-prepared receiver
operation; reissuing credentials alone is insufficient. Restoring policy
never silently restores a revoked client session. UI exposes the destination
scope separately from read/full-access and thread delegation.

**Revocation boundary.** A rechecks the dot's live authority at forwarding
admission and before each commit send; B rechecks its own current link and
delegation under native commit admission. Source revocation cancels queued
forwards and notifies B to refuse uncommitted prepared operations. If a
commit was already sent and its outcome is unknown, retain an uncertain
receipt and reconcile; do not claim that remote work stopped. A network
partition cannot recall an already-admitted remote request. Phase 3's review
must verify these linearization points and fail-closed behavior; no cached
attestation becomes ongoing approval authority.

### Granting approval permission

The accepted sign-in checkbox is separate from access level, unchecked,
and unavailable for read-only/task-only grants:

> Also let this agent answer permission requests. Each approval must name
> the permission and its duration. Broader permissions require my explicit
> consent for that request.

`mcpClientScopes(access, { approvals: false })` stays the default,
including Full access. Check opt-in during both browser and pairing-code
flows and token exchange; persist it in pending OAuth code state. The OAuth
scope response must describe actual granted scopes. No legacy
`orchestration:operate` parent/alias may imply approval rights. Existing
MCP sessions and peer credentials start without the new scope. Do not
retroactively grant it by widening a common scope array.

The approving owner session must have explicit grantor authority. Pairing
codes can grant approvals only when deliberately created with an approval
grant option; ordinary agent codes cannot mint that authority. New scope
schema, token decoding, protected-resource metadata and scope compatibility
tests must cover this, not just the checkbox. Permission controls work for
web, desktop's web surface and the mobile outside-agent connection flow.

**Identity and downgrade.** Keep Phase 0's session principal. Migration 082
stores a distinct approval authorization row for each session and an opaque
initiating-client ID. `application_id` is registered OAuth application
identity, not client name. `consent_family_id` is the server's local
consenting authority/fleet-attribution lineage; it groups revocation only.
Its family key comes from the authenticated grantor's normalized attribution
root (a server-owned local-owner family when no fleet root exists), never
client-supplied metadata. It must not be `mcp-client:local` used as a receipt
principal.

A completed sign-in **without** approvals atomically disables approvals on
all prior sessions in that same registered application/consenting-authority
family, and issues the new session without them. The consent page makes
that replacement effect explicit. This scope removal does not merge session
identities or subscriptions, and does not revoke other scopes. An explicit
owner-selected replacement may preserve initiating-client provenance.
Never infer provenance continuity solely from equal application metadata.

Settings → Sharing & access also has an explicit **Remove approval
permission** operation for one session/family; full session revocation
continues to stop event delivery. All permission changes bump the live
authority revision and publish a notice. `ApprovalAuthority` and
`EnvironmentAuth` consult the row/cap on every respond and at native
commit and again at serialized delivery admission; an earlier authenticated
invocation cannot retain removed rights before either boundary.
Keep the authoritative disable in the same transaction/admission gate as
replacement issuance. If it fails, do not finish the sign-in claiming that
older rights were removed. Test an old retained bearer, including
in-flight approvals paused before commitment and after commitment but before
delivery admission. Already admitted handoff is the explicit recall boundary.

### Audit records

Receipt actor data is server-built. Record authenticated session principal,
application, current authority revision, immediate linked sender (if any),
asserted initiating client/person/words, exact grant/scope, expected
incarnation, native command/effect IDs and state transitions.

Project `resolvedBy` only from trusted server metadata; do not accept it
from an optional public command property. The thread row reads, for example,
“Approved this request by Gecko Butler for Dan” or “Granted command execution
for this turn by Gecko Butler for Dan · via BuildMachine”. A native
commitment awaiting delivery shows that state; delivery failure/uncertainty
remains visible. Never label a turn grant “Approved once”.

Expose current receipt/status through `t3_approval_request` exact retry and
a scoped read operation on `ApprovalService`, with owner-authorized Settings
access. Extend Phase 0 diagnostics rather than claiming an MCP
`t3_agent_events` tool already exists. Phase 2 `request_closed` carries
trusted `resolvedBy`, effective scope and delivery state; later failure
produces its own attention transition.

### The fork ledger: contract-preserving consolidation

`t3_lan_task_observe` and `t3_lan_events_ack` keep accepting existing and
new authorized callers throughout Phases 1–3. There is no freeze in Phase 0.
Keep their tables and behavior until an explicitly reviewed Phase 4 cutover.

The fact log becomes the eventual single source of event facts. A
compatibility adapter still needs per-principal delivery/ACK state: that is
consumer state, not a second source of facts. Before switching observe/ACK:

1. Extend the internal fact/reducer model to cover legacy nonterminal
   `run_state`, work-state snapshots and all existing observation kinds.
   High-volume compatibility facts need not become webhook catalog events.
2. Preserve principal/environment/thread ownership fencing, native source
   identity, independent delivery generation, sequence and anchor-based
   reset detection. A fact-log epoch is not a drop-in delivery generation.
3. Copy pending inbox payloads, ACK bits, cursor anchors and delivery
   generations into an additive compatibility state table without changing
   issued event/source IDs. Translate only newly ingested observations.
   An old ACK remains valid only for its original principal/generation;
   a stale ACK can never acknowledge a new delivery generation.
4. Run old and adapter reads in shadow against the same immutable input
   and compare exact pending observations, snapshots and reset outcomes.
   During cutover, serialize observe/ACK writes; advance only one active
   ingestion cursor. Exercise disconnect/restart/reset/ACK races.
5. Take a validated backup and verify every retained fact, subscription,
   receipt and secret reference plus both work-generation and explicit
   non-work row/payload invariants. Keep old tables for rollback and record
   the active adapter generation. Rollback must preserve post-cutover ACKs,
   not resurrect acknowledged deliveries.

The recommendation is adapter compatibility until Dan explicitly retires the
gateway contract. Retirement requires his separate decision, a caller
inventory and cutover evidence. No `DROP TABLE` belongs in 084 or a later
migration until retirement/cutover verification is complete and the
destructive cleanup is separately approved. `lan_owned_threads` remains
while task mutations rely on it. This design authorizes neither retirement
nor data deletion.

### Phase 1 build plan

This is implementation work for the next phase, not changes made by this
design revision. Integrate Phase 0's reviewed auth/registration changes first;
keep 080/081 and all probe behavior. Forwarding and facts are not Phase 1
dependencies.

| Files (new unless marked edit)                                                                                                                                                                                                              | Contract/work                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/approvals.ts`; edit `src/index.ts`, `src/orchestratorMcp.ts`                                                                                                                                                        | Grant/provider-profile union, request binding, consent, receipt-state/result and refusal schemas; discriminated action inputs with top-level retry ID                                                                                                     |
| Edit `packages/contracts/src/auth.ts`                                                                                                                                                                                                       | Independent approval scope, explicit grantor/consent options, live scope-removal command; no operate/full-access alias                                                                                                                                    |
| Edit `packages/contracts/src/orchestrationV2.ts`                                                                                                                                                                                            | Optional lenient read fields for grant/binding/delivery/audit; internal guarded server response command and effect, not public actor input                                                                                                                |
| `packages/shared/src/approvalPresentation.ts`; edit `packages/shared/package.json`                                                                                                                                                          | Versioned canonical presentation/grant/operation hashing; explicit subpath export                                                                                                                                                                         |
| `apps/server/src/approvals/{ApprovalService,ApprovalReceipts}.ts`                                                                                                                                                                           | One typed service for list/read/respond/reconcile; receipt SQL helpers participate in caller transactions                                                                                                                                                 |
| `apps/server/src/auth/ApprovalAuthority.ts`; edit `EnvironmentAuth.ts`, `EnvironmentAuthPolicy.ts`, `SessionStore.ts`, `McpOAuth.ts`, `mcpOAuthHttp.ts`, `RpcAuthorization.ts`, `apps/server/src/ws.ts`                                     | Persist/strip live opt-in; atomic sign-in downgrade; owner-authorized removal; admission gate; both browser and pairing-code consent                                                                                                                      |
| Edit `apps/web/src/components/auth/ConnectAgentSurface.tsx`, `apps/web/src/components/settings/{SessionPermissions,ConnectionsSettings,SavedEnvironmentRows}.tsx`                                                                           | Separate checkbox and current approval state/removal, including desktop's shared UI and one-click sign-in path                                                                                                                                            |
| `apps/server/src/mcp/toolkits/approvals/{tools,handlers}.ts`; edit `mcp/{McpHttpServer,McpInvocationContext,McpToolAccess}.ts`                                                                                                              | Register thin toolkit, correct list/read vs respond authority, task-only classification, remote refusal; reuse both negotiated protocols                                                                                                                  |
| Edit `apps/server/src/orchestration-v2/{Orchestrator,EventSink,ProjectionStore,EffectWorker,RuntimeRequestService,EffectOutbox,runtimeLayer}.ts`                                                                                            | Under-lock guards, trusted actor, atomic receipt commitment, stable guarded effects, delivery-result events and reconciliation; wire services once                                                                                                        |
| Edit `packages/provider-core/src/server/ProviderAdapter.ts`; `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`                                                                                                                  | Guarded response command/admission identity, typed handoff/write/uncertain outcomes and verified Codex permission descriptor. Shared fallback keeps all other profiles app-only without changing their native behavior.                                   |
| Edit `packages/effect-codex-app-server/src/{client,protocol}.ts`, `_internal/{shared,stdio}.ts` and owned transport-creation bridge/spawn wiring as needed; extend `client.test.ts`, `protocol.test.ts`, `_internal/{shared,stdio}.test.ts` | Raw closed-profile validation before decoding, safe unsupported evidence, command-bound writer completion/failure and cancellation outcomes. Preserve unrelated decoding; do not hand-edit generated schemas. Other provider-package support is deferred. |
| Edit `apps/web/src/components/chat/TimelinePendingApprovalRow.tsx`, `apps/mobile/src/features/threads/PendingApprovalCard.tsx`                                                                                                              | Show complete permission/effective lifetime, safe attribution and delivery state; no misleading once label                                                                                                                                                |
| `apps/server/src/persistence/Migrations/082_AgentApprovalAuthorityAndReceipts.ts`; edit `Migrations.ts`, `lan/NativeMaintenance.test.ts`, `scripts/lan/home-repair.ts`, home-repair migration fixtures/tests                                | Additive 082 schema and preservation checks; fresh/080/081 upgrades supported                                                                                                                                                                             |
| Extend `scripts/lan/agent-events-e2e.ts`; test fixtures under `apps/server/src/orchestration-v2/testkit/`                                                                                                                                   | Phase-selectable approval harness without callbacks, real accounts, paid models, live installs or live links                                                                                                                                              |

Cursor remains explicitly unsupported. Native SDK version/profile uncertainty
must result in app-only behavior, not a guessed grant. Phase 1 can ship a
verified Codex permissions subset only. The shared unsupported fallback and
profile tests enforce app-only for every other provider/request in the matrix.
Mobile sign-in uses the same hosted consent surface; if its connection entry bypasses that page, route it
through the shared consent API before exposing approvals. The new server
scope-removal operation uses the existing access-management permission and
typed client-runtime RPC command wrapper; neither read-only nor MCP approve
alone grants session-management authority.

Build order: define contracts and migration; implement authority/removal and
raw Codex validation and descriptor; implement the guarded transaction,
serialized delivery admission and native write evidence/recovery; expose MCP
and UI only after these gates pass; run focused tests and the local harness.
No editor, live release, model run or event delivery is needed to prove this
phase.

## Security analysis

| Constraint                    | Enforcement                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact provider authority      | Initial verified Codex permissions profile only; complete raw payload validated before lossy decoding and bound to exact turn consent. Every other profile stays app-only.           |
| Apply-time consent            | Expected incarnation, session/generation, presentation revision/digest, grant and offered decision revalidated under native thread admission and at adapter delivery.                |
| Single native winner          | UI and MCP resolve through the same native lock and EventSink transaction. A loser gets `already_answered`, never a success receipt.                                                 |
| Recoverable retries           | Immutable operation/retry key, stable command ID, prepared/committed/delivery states and command/outbox reconciliation; no pre-dispatch success marker.                              |
| Immediate local removal       | Commit and delivery admission serialize with removal and recheck live authority/caps/modes/binding; retained tokens and paused calls cannot cross either boundary after revocation.  |
| Trusted actor                 | Authenticated principal/immediate link are server-derived. Human words and upstream client identity are labelled assertions. Public commands cannot forge `resolvedBy`.              |
| Forwarded authority           | Current source grant, outbound write cap, destination link approval cap, link/client provenance or explicit thread delegation, modes and native checks all intersect.                |
| No forwarding chain           | Every linked caller naming another remote environment is refused, including Full access.                                                                                             |
| Event confidentiality         | Phase 0 outside-sharing admission plus current per-fact read authorization; relayed access uncertainty holds delivery. No secrets in payloads; prompt/result text is untrusted data. |
| Callback transport            | Phase 0 owns HTTPS verification, Standard Webhooks, actual-address validation/pinning, redirect refusal and expiry/revocation. This revision does not change that implementation.    |
| Owners never authorize/filter | No owner argument. Reducer, relay, matcher and wake deliver all authorized owners; directory/assignment coordinates are historical metadata only.                                    |
| Preservation                  | Additive migrations; independent non-work row/payload/secret checks; legacy ACK/generation contract retained until verified cutover and separately approved cleanup.                 |

Residual trust: T3 cannot prove the dot's account of Dan's consent. B
authenticates A's link, not the dot or Dan; a compromised A can lie within
the authority B deliberately delegates. Remote revocation cannot recall a
commit already admitted at B. A 2xx callback is not a wake or human response.
Event text leaves the fleet only through the separately authorized
outside-sharing path.

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
    The Phase 0 tests above are unchanged and remain its builder's responsibility.
    Add the following Phases 1–4 cases at the lowest relevant layer; extend
    existing tests where possible.

**Phase 1:**

- `packages/shared/src/approvalPresentation.test.ts`: canonical hashing
  binds native payload, resource/scope/expiry, incarnation/generation,
  revision and ordered decisions. Equal reason text with different
  permissions changes the digest.
- `packages/contracts/src/approvals.test.ts`, existing auth and
  orchestration schema tests: reject public actor/attestation fields,
  malformed/unknown grant profiles, nonconsented turn scope and session/
  persistent decisions; old read projections decode as app-only.
- Existing `CodexAdapterV2.test.ts` and owned Codex `client.test.ts`,
  `_internal/shared.test.ts`, `protocol.test.ts`: verified permissions
  return the exact complete payload and turn scope only after turn consent.
  Unknown raw authority fields at top-level, permission, filesystem and
  network nesting stay app-only before any lossy decode. Both file methods
  with nonempty `grantRoot` are refused, and rootless/command/elicitation/
  other-provider profiles stay app-only initially. Exercise the actual
  writer: deferred completion and queue insertion cannot advance write
  evidence; failure before enqueue, queue-to-write interruption, completed
  write and ambiguous post-write failure produce distinct outcomes. No
  peer-acknowledged result exists without a genuine peer acknowledgment.
  Extend `_internal/stdio.test.ts` at the acknowledged-write primitive:
  delay the actual native callback for a small buffered write and assert no
  `response_written`; then complete/fail/interrupt it. Prove ordering and
  backpressure across multiple messages without closing stdin between them.
  A sink-progress result or `drain` alone must fail this regression.
- `apps/server/src/approvals/ApprovalService.test.ts`,
  `ApprovalReceipts.test.ts`: exact retry before pending checks, argument
  change under one key, two clients with the same key, crash after prepare,
  before/after native commit and after provider send. Reconcile committed
  native receipt with lost reply; no false success, duplicate response or
  automatic retry after ambiguous non-idempotent native delivery.
- Existing `Orchestrator.test.ts` scenarios and
  `McpToolAccess.race.test.ts`: barrier-controlled UI-vs-MCP race has one
  winner; request A changes before lock acquisition; same native ID reused
  in a new session/incarnation; offered decision removed; modes increase;
  provider payload changes before effect delivery. Check returned code and
  exact resulting native authority, not just a mock handler call.
  Pause after EventSink commit but before delivery admission; remove rights,
  narrow caps/modes or replace binding, then resume. No native handoff may
  occur; persist `delivery_withheld` and safely reopen only a provably unsent
  live request under a fresh incarnation. An admitted uncertain send must
  bypass generic effect-worker retries and must not reopen as unanswered.
- `mcp/toolkits/approvals/handlers.test.ts`: one representative allowed
  local flow; action validation, task/thread/read-only refusal, local
  `environmentId`, remote `forwarding_unavailable`, ask-rule app-only,
  unchanged `t3_pending_request`. Auth remains enforced if tool visibility
  is bypassed. Exercise both negotiated tool-call protocols.
- Existing `McpOAuth.test.ts`, `EnvironmentAuth.test.ts`,
  `EnvironmentAuthPolicy.test.ts`, `SessionStore.test.ts`, and new
  `auth/ApprovalAuthority.test.ts`: Full access/ordinary pairing codes
  do not imply approve; unchecked one-click sign-in stays unchecked; grantor
  must hold authority; caps strip approve live; independent sign-ins remain
  different principals. Sign in without approve, then use the retained old
  bearer. Pause an old call before native commitment, remove permission,
  resume, and assert no response effect. Full session revocation also stops
  event delivery in the disposable harness.
- Migration `082_AgentApprovalAuthorityAndReceipts.test.ts`,
  `Migrations.test.ts`, `NativeMaintenance.test.ts`,
  `scripts/lan/home-repair-migrations.test.ts`: fresh/080/081 upgrade,
  no new rights on old sessions, prepared/uncertain receipt preservation,
  explicit row/payload/secret-reference verification and work hash stability.
- One client integration pass on web/desktop and mobile for truthful grant/
  duration, attribution and pending/failed delivery rendering. Keep UI-only
  details out of backend policy tests.

**Phase 2:**

- `AgentFactDeriver.test.ts`: stopped deriver replays approval open/change/
  close in order after projections are already resolved; two approvals on
  one thread; reused native ID; A → B → A; recurring blockers; secret and
  source-status occurrences; source/checkpoint gaps; crash around fact/
  reducer/matcher/watermark transaction. Bootstrap is a single consistent
  snapshot and accurately marked.
- `AgentFactDeriver.owner.test.ts` / `AgentEventOwnerJournal.test.ts`:
  Dan/Gavin/unassigned/unknown owners, reassignment, rename with unchanged
  assignment, directory absent/unreachable, rebuild after rename, delayed
  delivery before owner-change arrival, and unavailable fresh routing.
  Extend `FleetUsers.test.ts` for unchanged successful refresh, stale
  last-good values, absent/invalid/unavailable results and observation
  generation/time. Persist each observation before source commitment binds
  its journal reference; missing freshness never guesses current routing.
  All authorized events arrive at one subscription without owner filtering.
- Extend Phase 0 store/delivery tests for facts in the same sequence space:
  pruning while payloads are pinned, exact expiry, immutable occurrence
  time, low-cursor replay recomputation, ahead-of-head rejection, explicit
  pruning/abandonment gaps and separate approval retention. Child attention
  always matches; child run-finished is off by default.

**Phase 3:**

- `AgentFactRelay.test.ts`: origin-only export, transactional peer cursor/
  import, replay/dedupe/epoch gaps, recurring source transitions, old peer
  unsupported, expired/revoked peer, disabled Labs switch, deleted thread,
  cached authority uncertainty and current access generation revalidation.
  Include Dan and Gavin without owner-based filtering.
- `ApprovalForwarding.test.ts`: explicit A → B usable link; authorized
  link/client-created thread succeeds, unrelated operator thread fails;
  explicit destination delegation succeeds; wrong initiating client and
  missing provenance fail. Repeat under Supervised and Full access.
  Linked A → B → C is refused for both access levels.
- Retain old receiver token after destination policy removal; pause prepare
  before commit and revoke delegation; test source grant removal and an
  in-flight lost remote reply. The result stays uncertain until reconciled,
  never falsely completed or falsely stopped. Two clients using equal retry
  keys cannot collide. Validate immediate sender identity independently of
  asserted human/client fields.
- `FleetApprovalPolicy.test.ts`: default off, strict canonical signature,
  destination-only writer, rollback/conflict/invalid data fail closed,
  newer local revocation wins; old strict FleetAccessPolicy fixtures remain
  readable/unchanged. `FleetCredentialAccess.test.ts` strips approval scope
  live without relinking. `PeerWriteCeiling` and `T3-Mode-Limit` still hold.

**Phase 4:** Extend `RoutingStore.test.ts` / `EnvironmentRouting.test.ts`
and maintenance/repair tests with pending ACKs, independent delivery
generations, anchored resets, work-state snapshots and nonterminal run-state
parity. Shadow comparison, restart during cutover, stale ACK and rollback
must preserve post-cutover acknowledgements. Row counts plus work hash alone
are not proof.

### Local end-to-end harness

Extend `scripts/lan/agent-events-e2e.ts` with explicit phase selection.
Keep the reviewed Phase 0 mode/default intact. All new modes use temporary
homes outside installed userdata, `--no-seed`, free replay/fake providers,
isolated loopback ports and captured child PIDs for cleanup. Print machine-
readable JSONL with operation/receipt/native command IDs and native-response
evidence. No model subscription, live fleet credential or dot is needed.

**Phase 1 command:** `node scripts/lan/agent-events-e2e.ts --phase approvals`
with the build-tools Node directory on PATH/PATHEXT.

1. Start one source dev server A with a fresh temporary home. Drive the
   actual OAuth authorization-code + PKCE flow using disposable local
   grantor authority, first without the approval checkbox, then with it.
   A test fixture may create a deliberately approval-capable pairing code;
   the ordinary code must remain insufficient. No callback subscription
   or Phase 2 catalog is required.
2. Use a local fake Codex app-server permission-request fixture through
   A's actual provider and protocol path. Read its exact incarnation, raw
   verified profile, binding and digest. Once consent fails; explicit turn
   consent sends the exact permission payload. Observe actual write evidence
   separately from deferred/queue handoff. A new request tests decline.
3. Use wrong digest, wrong scope, missing opt-in, unsupported profile and
   ask-rule fixtures. Nothing resolves. Race a paused MCP response with an
   app response and with a presentation/grant update; prove one accurate
   winner/refusal. A request that reuses the native ID cannot inherit consent.
4. Retry an accepted operation with the same key: same receipt/command and
   current state. Change an argument under that key: conflict. Use a new
   key on the answered request: `already_answered`, including app winner.
5. Controlled testkit barriers inject crashes after receipt preparation,
   before/after EventSink commit, and after adapter send before reply.
   Restart A and reconcile; demonstrate no false success, duplicate grant
   or blind resend after uncertainty. Keep the same stored request binding.
   Test hooks are testkit/dev injection only, not production MCP methods.
6. **Mandatory local revocation:** retain old tokens, complete sign-in
   without approvals, and try an old bearer; it cannot respond. Pause a call
   before native commit, remove its approval permission, release it and
   assert no response effect. Also pause a committed effect before delivery
   admission, remove permission/caps or narrow modes, and assert no native
   write, a withheld receipt and safe app recovery. Separately revoke a whole
   disposable session and prove subsequent calls fail. Phase 2 adds a queued-delivery stop test.
7. Use the existing fake Codex app-server fixture for complete permissions,
   unknown raw permission fields and command/file/elicitation payloads
   without a paid run. Unsupported profiles, including both file-change
   methods with `grantRoot`, never send an MCP response. Inject writer
   failures before/after queueing and after write, proving truthful evidence
   and no blind retries or accidental persistent defaults.
   The same local harness reports the supported/unsupported provider matrix.

**Phase 2 command:** `--phase facts`. Reuse the approval checks and add
a local callback, event replay/restart/retention tests, historical reducer
cases and all-owner delivery. Keep occurrence time fixed across retries;
only signing time changes. A failed callback, expiry, session revocation
and outside-sharing cap stop sending. This is a disposable mandatory test,
not an optional live-session action.

The callback setup from the shared Phase 0 harness is retained here:

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

**Phase 3 command:** `--phase fleet`. Start B with a second isolated home.
Enable native links on A and B; construct A's usable outbound link **to B**
through B's owner-approved link flow. The reverse B → A link is not a
substitute. Use two explicitly different initiating client authorizations.

- Launch one B thread through A's linked launch service as client C1; store
  authenticated link identity + C1 provenance. Forward its approval as C1
  successfully, then try C2 and refuse.
- Create a separate operator thread on B. Wake/relay read succeeds but
  forwarded approval fails until B's operator explicitly grants that
  link/C1/thread delegation. This keeps wake testing independent of launch.
- Repeat under both Supervised and Full access links. For the delegated
  operator thread, the approval-specific target guard permits the exact
  destination delegation as an alternative to the ordinary same-link fence.
  Keep native mode/request checks and refuse every other unrelated write;
  never rewrite the operator thread's creation provenance.
- Remove destination approval scope/policy while retaining the link token:
  refuse. Revoke C1 on A before send: nothing is forwarded. Pause remote
  prepare, revoke B delegation, then commit: refuse. Drop the response after
  B commits: reconcile one receipt/native answer. Report uncertain in-flight
  outcomes honestly.
- Attempt a third hop with a linked caller under Full access: refuse.
  Disable links, revoke/expire peer credentials, delete the source thread
  and interrupt peer connectivity; cached facts are withheld until present
  read authority is established.
- Relay two different B approvals, recurring blockers, A → B → A details
  and owner reassign/rename histories without duplicates or lost transitions.

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

| Step                   | What happens                                                                                                                                                 | Passes when                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 Discovery           | ChatGPT rescans the plugin                                                                                                                                   | The log shows `server/discover` and `events/list`; the plugin page lists the events                                                                                  |
| L1 Subscribe           | Dan asks the dot, in a fresh chat, to "watch T3 for anything that needs me"                                                                                  | `events/subscribe` for `t3.task_activity` with `{}` arguments; verification is 2xx; the subscription is stored                                                       |
| L2 Wake (phase 0)      | After ≥ 30 min of chat idle, the operator runs `t3 agent-events probe` with a random nonce. It is a `probe` fact delivered only to that subscription         | 2xx delivered **and** the dot posts in that chat, unprompted, mentioning the nonce. Record latency. Repeat once                                                      |
| L3 Approval wake       | Phase 2: operator starts a supported disposable local approval on BuildMachine                                                                               | All-owner event delivered; dot wakes and reports exact permission, duration and digest; launch is independent evidence                                               |
| L4 Approval submit     | Phase 1 by polling, or Phase 2 after L3: Dan consents to the displayed grant/scope                                                                           | Receipt reaches committed then response_written with command-bound evidence; truthful turn label; observe provider continuation separately                           |
| L4b Decline and replay | Dan declines a second request, then retries the first operation                                                                                              | Native decline; exact retry returns same receipt; new key gives already_answered; nothing runs twice                                                                 |
| L5 Forwarded (Phase 3) | Operator creates a fresh CryoFrog probe, explicitly delegates this link/client/thread through the approval-specific target guard; A has its usable link to B | Event wake independent of linked launch; B commits one response; both receipts correlate; removal or unrelated thread/client refuses, including Full access          |
| L6 Owners              | Operator creates Dan/Gavin/unassigned probes, reassigns Gavin's to Dan, renames one directory label and delays a delivery                                    | All events delivered with source assignment/directory coordinates; old fact owner unchanged; dot resolves current owner before person-specific notification          |
| L7 Revocation          | Mandatory end of the agreed disposable-session live sequence: revoke the dedicated dot test session, emit a probe, then explicitly sign in/subscribe again   | No new delivery/call after revocation; local retained-token and queued-attempt evidence confirms enforcement; a new authorization works only with a new subscription |

The dot's choice to stay quiet about Gavin's threads is its own policy. It is
observed, not asserted as T3 behaviour.

## Phasing and effort

Effort is in focused developer-days, including tests. Live steps need Dan.

| Phase                           | Contents                                                                                                                                                                                                | Needs from the owner feature                                                                                             | Effort |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| **0. Transport and wake probe** | `2026-07-28` enablement behind `agentEvents.enabled`, discover patch, `events/*`, subscriptions (081), verification, signer, public-address guard, delivery worker, `t3 agent-events probe`, live L0–L2 | Nothing                                                                                                                  | 4–5 d  |
| **1. Approvals, local**         | Additive 082, separate opt-in/removal, accurate provider grants, guarded native response, recoverable receipts, trusted audit and `--phase approvals` harness                                           | Merged owner label can be read; no new owner metadata required                                                           | 7–10 d |
| **2. Facts and catalog, local** | Additive 083, ordered reducer and owner-directory journal, full catalog, matching in shared 081 sequence/outbox, retention and `--phase facts`                                                          | Add source-time directory references and current assignment/directory coordinates; do not assume they landed with owners | 6–8 d  |
| **3. Fleet**                    | Additive 084, origin-only fact relay/current access validation, link/client provenance and explicit delegation, separate signed policy, one-hop responses, `--phase fleet`                              | Stable owner IDs for attribution only                                                                                    | 7–10 d |
| **4. Compatible consolidation** | Shadow adapter and legacy event/ACK/generation/snapshot parity, verified cutover and rollback; retain tables                                                                                            | No owner dependency                                                                                                      | 4–6 d  |

Phases 1–4 are roughly 24–34 focused developer-days including the added race,
provider and crash checks; these are planning ranges, not release dates.
Live steps require Dan. No live tests, release or merge are authorized by
this design-edit task.

Phase 1 can be built after this design review and Phase 0 integration,
without waiting for event delivery or a successful wake. Phase 0 and 1
touch shared auth/registration files: serialize integration, not parallel
overlapping writes. Phase 2 follows the native approval metadata contract;
Phase 3 follows both and must pass its own forwarding-authority review.
Phase 4 may consolidate while maintaining compatibility; explicit retirement
and destructive cleanup are separate later decisions. Draft the upstream
discussion before Phase 1, but posting/maintainer response does not block
authorized fork work.

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

- **Forwarded trust.** The destination authenticates its immediate link,
  current destination policy and thread/client delegation. It cannot
  independently prove Dan's words or the dot's identity asserted by
  BuildMachine. Full access does not remove approval-specific fencing.
  Source removal prevents new sends; a remote commit already admitted
  before cancellation may need status reconciliation. No design claims
  distributed instantaneous recall.
- **Human approval is a claim.** T3 records who the agent says approved, not
  proof that they did.
- **Ordering and loss.** Arrival/retry order is not source order; clients
  deduplicate event IDs and use occurrence/transition coordinates. History
  gaps, abandoned deliveries and unavailable owner freshness are explicit.
  Replaying requires retained source/fact history.
- **Live-only approvals.** Durable consent cannot resurrect a lost native
  deferred. Recovery reconciles the exact old incarnation; a new provider
  session/request requires a new approval. Uncertain provider delivery
  remains uncertain rather than “done”.
- **Upstream divergence.**
  - `2026-07-28` on `/mcp` with an intercepting patch for `events/*`. effect
    may later provide this; we replace the patch then.
  - A fork scope (`orchestration:approve`), a fork tool and an optional fork
    read field (`resolvedBy`) on an upstream projection and guarded internal
    command. A database or client moving between stock and fork builds already cannot happen
    (migration IDs), and stock clients ignore the field.
  - Upstream #22595 and #26344 were closed for lack of maintainer approval.
    Upstreaming this would need a triaged Ideas discussion (#19534 for events,
    #26527 for remote approvals) first. The approve scope and the MCP Events
    endpoint are the parts most worth proposing.
- **Error codes.** OpenAI documents `CallbackEndpointError` as `-32015`; the
  draft spec uses `-32027`. We follow OpenAI and will revisit if they align.

## Accepted decisions and remaining choices

Accepted for this design: separate approval checkbox with Full access not
implying it; per-request accurate scope consent; ask-rule app-only; forwarded
approvals limited to link/client-started threads or explicit delegation;
all-owner events without source/transport/wake filtering; child finished
events off by default while attention remains; BuildMachine first then
CryoFrog with a dedicated revocable test session; event retention 14 days or
50,000 with pending-payload pins, deliveries 7 days and refresh at least every
7 days; upstream **draft only**; no release.

Implementation choices settled here: default subscription renewal 24 hours,
7-day maximum bounded by session expiry; 48-hour delivery abandonment;
90-day full approval audit plus authorization-lifetime replay tombstones;
unknown/session/persistent provider scope app-only. A turn grant still
requires explicit consent on that request, not a broad opt-in.

Remaining consequential choices do not block Phase 1 design:

- Before Phase 3 live use, name the exact destination links/threads/clients
  to delegate. CryoFrog's disposable test authority expires/revokes after
  the test; no unrelated existing task receives it.
- Before Phase 4 retirement, Dan must explicitly choose to retire the old
  gateway contract. The default remains a compatible adapter and retained
  tables; later deletion requires separate approval.
- Actual live wake/approval timing, discussion posting and any release need
  their own requested action. This document is not that action.

## Review changes (Phases 1–4)

The numbered mapping refers to the full Astra review of design
`5cf43fb64d`. Phase 0 findings are listed for integration ownership only;
their sections/code are not edited in this revision.

| Finding                                      | Handling                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Accept is not always once                 | Provider matrix, complete native grant descriptor/digest, explicit turn consent, no session/persistent fallback; truthful scope labels and native-effect tests                                                                     |
| 2. Apply-time race                           | Expected incarnation/session/generation/revision/digest and offered decision checked under native response lock; adapter last check; UI race has one winner and accurate already_answered                                          |
| 3. Incorrect receipts/retries                | Durable prepared/committed/delivery/uncertain states, atomic native commitment, stable command ID, reconcile before pending rejection, immutable operation-key binding and explicit forwarding namespace                           |
| 4. Full-access chaining/forged actor         | Every linked caller naming a remote target refused; hidden link-only contract; authenticated immediate link and server-only actor metadata; other identity claims labelled asserted                                                |
| 5. Broad machine switch/policy compatibility | Destination link plus initiating client/thread provenance or explicit delegation; owner never ACL; separate signed policy file and live scope stripping preserve strict old readers                                                |
| 6. Outside sharing/cached access             | Phase 0 owns outside-sharing admission. Phase 3 integrates its predicate with current per-fact source/credential/link/delete checks; cache uncertainty withholds delivery, without owner filtering                                 |
| 7. Transport admission                       | Phase 0 builder/reviewer owns admission, both protocols, fleet origin marker and discovery diagnostics; dedicated sections untouched                                                                                               |
| 8. Nonhistorical derivation/identity         | Ordered persisted source reducer, durable occurrence/transition IDs, A → B → A and reused-native-ID cases; reducer/fact/matching/watermark transaction and consistent bootstrap                                                    |
| 9. Old-token downgrade                       | Explicit scope removal and atomic same-app consent-family downgrade; retained old bearer and paused pre-commit tests; live destination policy cap independent of relinking                                                         |
| 10. Merged OAuth principals                  | Reuse Phase 0's distinct session principals; consent-family revocation and stable initiating-client provenance are separate, never subscription/receipt identity                                                                   |
| 11. Expiry/replay/retention                  | Phase 0 owns exact expiry, immutable occurrence time and recomputed cursors. Phase 2 shares its counter, pins unfinished payloads/contiguous range, reports gaps and keeps approval replay retention separate                      |
| 12. Stale owner labels                       | Source-time assignment revision plus directory generation/digest/observation time, immutable journal and old facts; mandatory fresh origin owner read before personal routing, explicit uncertainty                                |
| 13. Destructive/incomplete ledger migration  | No drops; keep observe/ACK working; additive compatibility state, nonterminal/snapshot parity, independent ACK generations/anchors and verified cutover/rollback with direct row checks                                            |
| 14. Incomplete Phase 0 slice/shared edits    | Phase 0's pinned as-built 081/probes/identity/secrets/diagnostics is authoritative; reserve 082+ and serialize shared auth/registration integration                                                                                |
| 15. Invalid forwarded harness provenance     | Explicit A → B usable link; link/client-started success and unrelated-thread refusal under both access levels; explicitly delegated operator probe keeps wake independent of launch                                                |
| Additional validation                        | Crash barriers, same-key changed args, actual provider grant effects, old-token/in-flight removal, full-access chaining, expired/revoked peer, retention during retries and delayed owner routing; disposable revocation mandatory |
| SSRF tests                                   | Phase 0 builder/reviewer owns actual socket-address, mixed DNS and IPv4-in-IPv6 tests; no duplicate transport work here                                                                                                            |

### Sol follow-up review at `16d8c8bfbd`

The initial Phase 1 implementation is narrowed to verified local Codex
permissions requests. This revision addresses its five findings:

1. Both file approval methods with nonempty `grantRoot` stay app-only;
   rootless file support is also deferred pending verified changes/lifetime.
2. Validate the complete raw request before excess fields are discarded;
   include owned Codex client/decoder files and nested-unknown-field tests.
3. Serialize current authority/caps/modes/binding checks with removal at
   delivery admission, carry authorization identity/revision, and persist
   withheld responses with a guarded fresh-incarnation app recovery path.
4. Add command-bound protocol writer completion/failure evidence; distinguish
   handoff, written and actual peer acknowledgment, and keep uncertain sends
   outside generic execution retries. No unsupported adapter is enabled.
5. Before Phase 2 journaling, add/persist the FleetUsers observation feed,
   including unchanged confirmation and failed/absent observations.

The focused Sol recheck at `b392a04532` accepted the narrowed Phase 1
subject to the acknowledged-write prerequisite. The owned stdio/creation
bridge, native callback boundary and delayed/failing/interrupted write tests
are now explicit above. Sink progress cannot satisfy that enablement gate.

## Appendix: upstream Ideas discussion draft

**Draft only — do not post from this task.** Prepare before Phase 1;
maintainer triage can proceed without blocking authorized fork work. Recheck
upstream discussion/PR status before an authorized post rather than assuming
the historical closed PR status is current.

**Title:** Outside assistants: explicit provider-approval authority and
durable task events

T3 can receive work from an outside MCP client, but that client cannot
currently be notified when a thread needs attention or submit a provider
approval through a supported tool. In our LAN fork an OpenAI dot reached T3
through native MCP and links; polling found the request, but a verbal
approval could not be delivered to the provider.

We would like feedback on two independently useful capabilities:

1. A separate permission-approval tool, leaving user-input answers unchanged.
   Approval authority would be explicit opt-in, independent of Full access.
   Every response would bind the exact provider request incarnation and a
   digest of the actual permission payload, displayed choices and lifetime,
   checked again at native commitment. “Accept” is not reliably “once”:
   Codex permissions and ACP command grants can last for a turn. Broader
   scope would require per-request consent; unsupported/unknown and
   ask-rule cases would initially stay in the app.
2. Durable attention facts for approvals, questions, blockers and terminal
   runs, with stable occurrence IDs, replay cursors, explicit history gaps
   and current read/outside-sharing checks. We are prototyping MCP Events
   while preserving both MCP protocol versions. A callback receipt is
   separate evidence from waking a real outside assistant.

Responses would use T3's existing native command/receipt/outbox path, with
recoverable idempotency and trusted responder attribution. For native links,
the receiver would require explicit destination authority and default to
threads started by that link and initiating client; existing threads would
need delegation. Full access would not exempt that check, and another
forwarding hop would be refused. Owner labels would remain informational:
they neither authorize responses nor filter readable events.

We intend to retain existing fork observation/ACK contracts until a
compatibility transition is proven. We are not proposing that upstream
adopt fork tables, fleet policy or every event category.

Would maintainers prefer a provider-neutral effective-grant/request-binding
contract first, a separate approval scope/tool, and/or a minimal event-source
extension point? Is there a preferred MCP transport integration rather than
an adapter around effect's current capability handling? We can split the
proposal into those boundaries and contribute focused protocol, race,
revocation and crash-recovery tests after triage.

Related historical discussions are Ideas #19534 (outside-agent events) and
#26527 (remote delegated approvals). This draft requests architectural
feedback; it does not ask maintainers to accept an untriaged implementation.
