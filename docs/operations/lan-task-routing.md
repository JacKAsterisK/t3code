# LAN task routing

The fork exposes one AnvilToad `/mcp` entry point with `t3_lan_*` tools. It acts
as a native T3 MCP client to each enrolled destination. Tasks retain the
destination's environment, thread and run IDs. There is no local wrapper thread
or Switchyard run. Existing same-environment delegation is unchanged.

## Enroll an environment

Enrollment is an administrator operation. Obtain approval before provisioning
credentials, persistent access, certificates, routes or network settings. Desktop
saved connections and provider-injected credentials are not enrollment grants.

Install a compatible fork candidate on the selected hosts only after the separate
[distribution gates](lan-distribution.md) are satisfied. Stock 0.1.2 lacks this
routing/retry/replay capability and is refused by the router. Its public descriptor
must report protocol 2 and `capabilities.lanTaskRouting: 1`.

Choose independently approved HTTPS routes with valid host trust. The OAuth
adapter permits HTTP only for exact `localhost`, `127.0.0.1` or `[::1]` origins.
Plain HTTP LAN addresses, redirects, URL credentials, query strings and path
prefix proxies are refused. The existing private LAN descriptors establish
identity advertisements; they do not establish authenticated task control or a
route reachable by a cloud-hosted caller.

Put nonsecret policy in `<T3 stateDir>/lan-routing.json`. A missing, invalid,
oversized or duplicate configuration denies access. No default file is created.
Use an administrator-controlled file and replace it atomically. New operations
re-read it, including after metadata awaits before mutation dispatch.

```json
{
  "version": 1,
  "environments": [
    {
      "environmentId": "<native-environment-id>",
      "label": "<approved-machine-name>",
      "origin": null,
      "credentialRef": null,
      "enabled": true,
      "protocolVersion": 2,
      "routingVersion": 1,
      "runtimeCeiling": "auto",
      "models": [{ "instanceId": "<native-provider-instance-id>", "model": "<approved-model-id>" }]
    }
  ],
  "grants": [
    {
      "principalId": "grant:<OAuth-grant-id>",
      "environmentId": "<native-environment-id>",
      "enabled": true,
      "projectIds": ["<native-project-id>"],
      "threadIds": [],
      "allowLaunch": true,
      "allowOperate": true,
      "runtimeCeiling": "auto"
    }
  ]
}
```

A null origin selects this server and must match its actual native identity.
A remote entry uses an approved HTTPS origin and a separate `credentialRef`.
Remote credentials reside in OS keyring entries, never in this JSON. The
`RemoteTaskTransport` credential port defines the account encoding. Provision
through an approved host workflow; do not extract desktop tokens or copy provider
credentials. Each destination needs its own explicit task-only OAuth grant and
matching local policy. An AnvilToad token is never forwarded to a destination.

The authenticated grant ID is stable across refresh. A legacy nonrenewable client
can be bound as `session:<session-id>`; reapproval creates a new identity and
requires administrator rebinding. Labels and caller-supplied actor IDs are not
identity. Environment enumeration returns only approved projects, configured
models and effective ceilings. Launch is disabled without an approved model.
Existing transcripts require explicit thread IDs; newly launched task ownership
is persisted. A project allowlist alone does not expose all of its transcripts.
Inherited timeline items from other threads are filtered from task reads.

## Connect the existing gateway

`vp run --filter @t3tools/scripts lan:bundle-gateway` produces an unconfigured
ES module bundle under `.t3/lan-gateway`. It creates no listener, credential or
registration. Package all emitted chunks together with their hashes and license
notices. Verify the bundle against its source before installing outside Codex's
virtualized runtime/cache paths.

The gateway adapter exports `makeGatewayT3OAuthClient`; its credential port must
use approved OS-backed atomic storage with one writer. `makeGatewayTaskSurface`
exports an injectable Request/Response handler for the existing gateway's
authentication boundary. It exposes the task toolkit and never starts a
Switchyard task. The existing gateway's unpublished
`Maintenance/Direct/Transport/T3TaskSelection.mjs` keeps selection disabled. When
separately approved, its composition preserves the existing nine tools and adds
the ten native T3 tools to the same authenticated endpoint. The original strict
ingress checks run before native dispatch; tool arguments use this fork's exact
shared schemas. The issuer, native environment ID and bundle hashes are pinned
before credential use. A legacy gateway grant does not authorize this selection.
Selecting its callback, external bundle/private roots, task control and OAuth
enrollment requires separate approval; source integration does not change the
running gateway.

After approval, invoke `beginAuthorization` from the trusted host setup surface,
then complete its fixed callback with PKCE/state/issuer validation. Consent shows
task-only access and optional renewable access. Use Auto or lower. Task-only
sessions cannot call native project administration, scheduling, environment
maintenance or any other non-task toolkit, even though the underlying native
scope includes `orchestration:operate`.

Unchanged native OAuth remains a fixed 30-day session without refresh. Opt-in
renewable task grants use one-hour access tokens and rotating hash-stored refresh
tokens, with a fixed 90-day family limit. Refresh cannot widen the approved
ceiling. Token reuse revokes the family. Revocation through Connections, the
revocation endpoint or the adapter invalidates access and renewal. An ambiguous
refresh response requires reapproval; the adapter never blindly replays a spent
refresh token. Reapproval at the absolute limit is deliberate, not indefinite
unattended access.

The gateway's source adapter uses CurrentUser DPAPI in an existing owner-private
external root with atomic encrypted writes and an exclusive lifetime owner lock.
It verifies ownership, ACLs and link safety without modifying them. There is no
plaintext or alternate-root fallback. A crash owner marker requires reviewed
recovery; it is not automatically adopted. Owner revocation disables local task
use before attempting identity-checked remote revocation. It reports durable
local denial and remote confirmation separately when either step fails.

## Observe and recover

Every operation selects an environment explicitly. Keep the same
`clientRequestId` and payload after an uncertain launch or message result.
Destination-backed native receipts reject conflicting reuse. Unknown/offline or
incompatible destinations fail; there is no local execution fallback. Interrupts
require the native run ID; `interrupt_requested` is not a stopped confirmation.
Messages support auto/queue. Provider approval decisions remain with the native
approval holder; the response tool answers fresh user-input questions only.

Observation replays bounded committed events with source IDs and anchored
cursors. It stores delivery facts and cursor progress in one transaction.
Unacknowledged facts repeat after reconnect. Deduplicate using environment,
thread, source and event ID, and acknowledge only after durable receipt.
Every ACK includes the observed `sourceId`; an old-generation ACK cannot consume
facts from a restored source that reused an event ID.
AnvilToad acknowledges a downstream host only after its own inbox commits.
The gateway sends its saved anchored cursor on reconnect. Explicit replay starts
a new delivery generation even when a restored database retains its original
first event. Late responses and ACKs from the previous generation cannot advance
the new cursor or consume its facts.

`run_terminal` describes one run, not the whole task. Each observation also
returns fresh `taskWorkState`, `taskResultRunId` and `taskResultStatus` using native
progress and restart-outbox rules. `result_available` means work settled, which
can include failure or cancellation. Check this snapshot even on empty event
pages: restart-outbox settlement can change state without a new source event.

On `reset_required`, reconcile the native task and explicitly request
`replayFromStart: true`. Old-source inbox facts are retained but not relabeled as
new-source facts. `observeGatewayTask` provides a durable-receiver/ACK adapter.
The gateway source stores observations and fresh task state before ACK and
deduplicates replay in its encrypted ledger. It refuses unrecorded or
wrong-generation ACKs. This ledger is bounded to 1,000 facts and 100 task states;
capacity requires reviewed export/retirement and never silently drops facts.
No unattended scheduler is installed or enabled; that needs a separate approved
runtime integration and acceptance test.
Continue while `observeGatewayTask.hasMore` is true, including empty filtered
pages. `replayDrained` is independent of `taskWorkState`: settled work can still
have undelivered historical events. The optional `acceptState` receiver can
persist fresh native task state before acknowledgement.

Detection and acknowledgement do not prove dot can be woken. No supported dot
wake receiver is installed or tested by this change. Responses report
`wakeDelivery: "unsupported"`. A separate supported delivery adapter and an
acknowledged live acceptance are required before claiming wake delivery.
