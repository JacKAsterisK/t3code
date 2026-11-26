# Stopped T3 work maintenance

Hub invokes the verified T3 Code LAN 1.0.49-or-later helper at
`resources/native-maintenance.mjs` with no arguments. Send one JSON request on
stdin and close stdin. The request limit is 8 KiB. A success writes one JSON
response to stdout. A refusal writes `native_maintenance_refused:<reason>` to
stderr and exits 1. The existing native activation operations retain their wire
format.

Hub holds its installer lock, the exclusive Windows native-admission handle and
the exclusive `userdata/server-owner.sqlite` handle for the selected, stopped
home. The helper checks the lease conflicts, canonical layout, environment ID
and absence of an activation journal. The mutation rechecks both leases and
launcher liveness after the backup and before committing. The Hub must keep its
handles until the helper exits and place the writer in a Windows job that
terminates the helper if Hub exits. Bind the launch to the selected artifact
and the held helper files as for ordinary native maintenance.

## Review stopped work

Send `schemaVersion: 1`, `operation: "inspect-unfinished-work"`, a fresh
64-character lowercase hexadecimal `nonce`, `homeDirectory`, `environmentId`
and `journalPath`. Both `includeScheduledWork` and
`includeRestartContinuations` default to true. The home is the selected LAN
`T3CodeLAN\data` or bound `.t3`; supply the ordinary native activation journal
path for that layout. The helper does not open a provider or start T3.

The response echoes the operation, nonce, environment and path. It includes
`compiledIdentity`, `processStopped: true`, `generationVersion: 2`,
`workGeneration`, `reviewSha256`, the normalized `scope` and the
`blocking`, `carriedWork` and `staleWork` counts. In `threads`, each group
has `threadId`, `title`, and `items`. Each item has `id`, `kind`,
`status`, `category`, `count`, `blocking`, `stale`, `canSettle`, `selected` and
`title`. Top-level store records can have a null thread ID. One record can
explain more than one category. Reviewable future schedules are included even when they do not block. A waiting
input card with exact links to a pending message-capable request is carried with
that request. The card remains answerable after restart.
Display the review before cancellation, including any selected future schedules
that will be disabled. The restart scope lists queued provider continuations and
workspace rollbacks that can replay on startup. The response stays local to Hub.

## Settle or cancel

1. Before update or fleet switch while stopped, inspect. If `staleWork` is
   nonempty and an item has `canSettle: true`, invoke `settle-stale-work` with the same scope and home, a fresh
   nonce, `expectedWorkGeneration` and `expectedReviewSha256` from the inspect.
   The operation settles eligible stale entries only and may leave genuinely
   unfinished work. Save the returned receipt and inspect again if newly eligible
   stale work was discovered. Then run ordinary admission.
2. If admission still defers, offer the reviewed list to the owner. On
   confirmation, invoke `cancel-unfinished-work` with the same scope and home,
   a fresh nonce, and the two expected hashes from that exact review.
   If an excluded category still blocks, the helper refuses with `busy` before
   writing. On `changed`, inspect again and ask the owner to review the new list.
3. Save the receipt and recheck stopped admission before update or switch.
   A changed generation after a lost response requires a new inspect.

Mutation takes a SQLite backup in a Windows user-only protected directory before
opening the cancellation transaction. Domain updates are appended to T3 history.
Outbox, workflow and scheduler state is transitioned to terminal status and
retained. The helper runs the classifier inside the same transaction before
committing. The mutation reply contains the post-operation inspection,
`backupDirectory`, `cancelled` counts, `providerLaunches: 0`, and, when work
changed, the prior fingerprints and `settledThreads` from the reviewed set.
The backup also contains a prepared receipt with both generations. If the helper
exits before returning its receipt, use a fresh stopped inspection to determine
which generation committed. Treat the backup as private T3 data and share only
redacted counts or receipts.

Automatic settlement requires positive terminal linkage. Missing or contradictory
evidence and work linked to a current run, unresolved request or provider owner
still require review. Keep the existing install/recovery journal and selection
untouched throughout these operations.
