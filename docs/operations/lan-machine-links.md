# LAN machine links

Launch the native desktop through a Hub configured with the shared roster location.
Open **Settings → Connections → LAN machine links**. No machine IDs, private keys,
or trust JSON need to be entered by the user. Installing a release does not enroll
or authorize a machine.

## Set up the fleet

On the intended owner computer, choose **Create fleet**. Confirm its reachable
HTTPS address, the access other approved members may have to this environment,
and automatic or manual sync. The final confirmation generates this machine's
X25519 encryption and Ed25519 signing keys plus a separate Ed25519 fleet-owner key.
Private keys stay in the per-user OS credential store. The app shares public
metadata and displays the owner verification code.

On another computer, choose **Join fleet**. Enter the owner code displayed in the
owner's T3 app, review this machine's address and sharing scope, and confirm the
request. The app generates its two device keys only after this confirmation.
This machine remains pending and cannot link until approved.

On the owner computer, refresh setup and review the pending member. Compare the
12-character code displayed on the joining computer's own T3 app and enter it in
**Verify and approve**. Approval binds the exact environment identity, canonical
address, and public keys. A matching name or hostname alone is never trusted.
The owner signs the membership record; each member pins the owner key and the
highest authority revision it has observed. Changed keys require deliberate
revocation and verification rather than automatic replacement.

The running server's existing environment ID determines assignment. An existing
roster row for that ID is preserved; otherwise setup creates a stable machine ID
from the environment identity. It never guesses or enrolls other devices. Adding
another machine uses the same join/approve flow without a new build.

Read-only access permits thread, file, and diagnostic reads. Standard access also
permits agents, shell commands, file changes, provider configuration, settings,
and client-access management. The owner approves membership; it cannot turn on a
member's automatic sync.

## Machine access

Access is one fleet-wide list, **Machine access**, kept as signed revisions in
`fleet-access` beside the roster. Each revision is a full snapshot, signed with
its writer's fleet key and chained to the revision it follows. A revision counts
only if its writer had standard access under what it follows, or if it only
makes its writer read-only. A revision that leaves no machine the fleet knows at
standard access does not count, and the last standard machine cannot restrict
itself. Being the fleet owner grants nothing here.

The list fails closed:

- Competing revisions, such as two first lists or two machines saving at once,
  all apply, each machine at the most restrictive access any of them gives it.
  The next save follows all of them. A machine cannot lift its own restriction
  by writing a rival revision, whatever its contents or timestamp.
- Each machine keeps the revisions it accepted, so deleting or rewriting share
  files cannot undo a change; a later write republishes lost revisions. A machine
  with no saved copy reads the same result from the share.
- A revision whose writer has since left or changed keys still restricts but
  cannot lift anything for a machine that never verified it. A standard machine
  that did verify it re-signs it on its next read, so every machine agrees again.
- A machine never starts a second first revision while the share holds any
  history, even history it cannot follow.
- If the share's list cannot be read, including more than 1,000 revision files,
  a machine keeps capping each use at the list it accepted and reports it
  unreadable, but revokes and replaces nothing for access until a read
  succeeds, so a share blip never costs a credential. A machine that never
  accepted a list behaves as before one was saved. Changes are refused until it
  can read the list.
- A change holds `fleet-access.lock` for a moment. A lock older than two minutes
  was left by a crash, and the next change clears it.

A fleet with no list yet can start from `fleet-access-seed.json` beside the
roster, which names the machines that start read-only:
`{"version":1,"fleetId":"<fleetId from fleet-authority.json>","defaultAccess":"standard","readOnly":["<machineId>"]}`.
A machine on LAN 1.0.26 or later that reads it, with no revision on the share or
in its own copy, signs it in as revision 1 through the ordinary change path, but
only once no machine still on LAN 1.0.25 could cut a read-only machine off:

- LAN 1.0.25 revokes a downgraded machine's fleet session at once and sends a
  replacement. LAN 1.0.24 cannot take a replacement for a connection it already
  has, so a 1.0.24 machine the list makes read-only would lose its connection to
  every running 1.0.25 machine, reads included, until it updates. 1.0.24 never
  revokes for access, and 1.0.26 keeps a downgraded machine's session (below).
- So every enabled machine says, when it sees the list on 1.0.26 or later, that
  it runs it: it signs `fleet-access-ready/<machineId>.json` beside the roster.
  Once every enabled machine has one, the list is adopted at once.
- 24 hours after a machine first saw the list, it stops waiting for machines
  without a marker that have published no signed connection summary for 24
  hours: they are off. It keeps waiting for any that published one, since that
  is the only sign a machine runs, and 1.0.25 and 1.0.24 publish the same summary
  (1.0.25 every five minutes from its server, 1.0.24 every five minutes while its
  desktop is open with automatic pickup). A busy 1.0.24 machine therefore delays
  the list until it updates. That delays the restriction, never anyone's access.
- Each machine records when it first saw the list in
  `userdata\lan-fleet-access-seed.json`, so a restart does not restart the wait.
- While it waits, Machine access names each machine it waits for, as running an
  older version or offline, and when offline ones stop being waited for; the
  server logs the same. Placing the file early is safe: older builds never read
  it, and newer ones wait like this.

Machines it doesn't name, and **Machines added later**, get its `defaultAccess`,
so the result doesn't depend on which machine adopts it; the command writes
`standard`. Once the share holds revision 1 and gives it back, the machine that
adopted it deletes the file, so a later loss of the share's list cannot bring it
back in; if that fails, it stays. Once any list exists, here or on the share, the
file is ignored for good, so later changes go through Settings. A file that
doesn't parse, names another fleet or an unknown machine, repeats a machine or
leaves no machine standard is refused: Machine access shows it, the server logs
it, and nothing links until it is fixed or removed or a list is saved. A file the
share cannot give, such as while it is unreachable, only waits; it is never
reported as refused. Machines adopting it at once serialize on the lock, and any
competing first revisions merge as above. Write it with the checker, which reads
the roster and authority, refuses once a list exists, and writes only with
`--write`:

```powershell
node apps/server/scripts/lan-fleet-access-seed.ts \\fileserver\private-share\fleet-roster.json <machineId> <machineId> --write
```

The receiving side enforces it. Every machine issues each peer's credential at
that peer's access. Every credential a fleet machine holds here is attributed to
that machine by subjects this server sets: its fleet credential, its peer-link
sessions, pairing codes its sessions mint and the sessions redeemed from them,
and MCP sessions and `t3_lan_*` task grants approved with any of those. Each use
of such a credential, over HTTP, WebSocket RPC or MCP, gets at most that
machine's current access. A read-only machine's still-open connections and task
grants lose launch, send, interrupt, respond, settings and fleet changes at once.
A machine the fleet disabled, or whose roster entry now names another identity,
can use nothing. One a successful trust check only misses, such as when the
enrollment folder briefly reads as absent, keeps its access until it has stayed
missing for 15 minutes over at least three checks; a read error never counts.
Each machine records this in `lan-fleet-members.json` and `lan-fleet-trusted.json`
in its userdata, so a restart does not reset it.

Revocation follows on the issuer at startup, every ten minutes and whenever the
list or the fleet's machines change. It revokes unused pairing codes attributed
to a downgraded machine above its access, and everything attributed to a departed
or untrusted one. A downgraded machine's sessions and task grants are only
capped, so they keep reading and refreshing without a new approval. In
shared-folder fleets each sync also sends a peer whose access changed a
replacement fleet credential at its access; the peer's desktop swaps it in for
its saved connection. From LAN 1.0.26 the issuer keeps the peer's old fleet
session, capped, until the peer uses a session at its new access, and only then
retires it. So a peer that cannot take the replacement yet (LAN 1.0.24) keeps
reading until it updates, then converges with no manual step. LAN 1.0.25 issuers
instead revoke the old session at once. Gained access waits until the peer is
online. A read-only machine's own server also refuses to forward LAN task
changes. Until a list is saved, each machine keeps the access chosen at setup.

The same replacement renews fleet links. A credential becomes a session with the
default 30-day lifetime, and in shared-folder fleets the issuer delivers a
replacement once less than seven days remain, whether or not a list was saved.
The old session keeps working until the peer connects with the new one, which
then retires every session issued before it. A replacement counts as done only
once the peer uses it: one redeemed but unused an hour later, such as when saving
it failed, is replaced again while the old session still works. A peer that is
offline is renewed when its signed summary is fresh again, including after its
session expired. Only credentials this machine delivered are renewed; a
connection the peer made another way is left alone.

The receiving desktop collects a renewal or replacement of a connection it
already accepted every five minutes while it is open, whether or not automatic
pickup is on: it is no new trust decision. Automatic pickup only governs new
links. Failing syncs slow it to every 30 minutes but never stop it. The saved
connection lives in the desktop app, so the server cannot collect for it; while
the app is closed nothing uses the connection, and on opening it collects the
pending renewal straight away, since the issuer keeps one available until the
new session is in use.

The server runs this issuing side itself every five minutes, so renewal, access
changes and revocation do not wait for an open window; an open desktop's sync
only makes them sooner, and the sync lock keeps one at a time. It starts only
after this machine's desktop has synced once: it republishes the connections
that desktop last published. A sync lock left by a server that stopped mid-sync
is cleared once its owner process is gone, or after ten minutes; a background
sync that keeps finding the lock held logs a warning.

Limits:

- In owner-approval fleets a change applies only to links issued after it, so
  relink existing ones there.
- A task grant approved on the destination by its own user, or with a pairing
  code created there, is that user's decision and is not tied to a machine;
  revoke it in **Sharing & access**.
- Task grants approved before grants recorded their approver are attributed at
  their next refresh, within an hour, to the fleet machine whose server holds
  them: it signs a claim for that one grant with its own fleet key, so a machine
  can only ever claim its own grants, at its own access. Until then, and for a
  holder that is not a fleet server, they only read while the list restricts
  any machine.
- Sessions redeemed from pairing codes a fleet session minted before codes
  recorded their minter are not attributed. They keep the access they were
  issued with until they expire, at most 30 days after this version is
  installed. Revoke them in **Sharing & access** to end them sooner.

Shared-folder trust is the boundary. Anything that can write the fleet share can
already join the fleet: it can file enrollment requests, edit roster entries or
swap keys. These controls stop a restricted machine, its agents and its
credentials through the app, `t3_lan_*` tools, task grants, peer links and direct
calls. They do not stop software on that machine that deliberately forges fleet
files on the share. Keep write access to the share to the fleet's machines and
their administrators.

### Rolling out 1.0.26 with a starting list

Hub updates one machine at a time when T3 is idle, so versions mix for hours or
days. With `fleet-access-seed.json` placed when 1.0.26 publishes:

- **1.0.24** ignores the starting list and any list, issues at its setup access
  and never revokes for access. It cannot take a replacement for a connection it
  already has.
- **1.0.25** ignores the starting list. With no list it changes nothing. Once a
  list exists it revokes a downgraded peer's fleet session at once and sends a
  replacement. That is why adoption waits for it.
- **1.0.26** signs its marker on first sight and shows, in Machine access, whom
  it waits for. Nothing links and no access changes until the list is adopted.
  After that it caps each downgraded peer's existing sessions on every use,
  sends a replacement at the new access and retires the old session once the
  replacement is in use. Links form within two adapter passes.

What the user sees:

1. **Every machine updates within a day.** The first machine on 1.0.26 shows the
   other four as waited for; the list shrinks as each updates. When the last one
   signs, the next sync on any 1.0.26 machine (within five minutes) adopts it and
   removes the starting list. From then on AnvilToad and SPDevMachine can read but
   not launch, send, stop or approve on the others. Their open desktops collect
   read-only replacements within five minutes, or as they open, with no prompt.
   Linked environments turn on, locked, on all five, and links form at the
   list's access within about 20 minutes.
2. **AnvilToad stays busy on 1.0.24 for days.** With its desktop open and
   automatic pickup on, it publishes a summary every five minutes, so the others
   show it as running an older version and keep waiting past the day. Nothing
   changes anywhere: it keeps standard access, and nothing links. Once it
   updates and signs, the list is adopted as in 1. With automatic pickup off it
   publishes nothing, so after the day it counts as offline and the list is
   adopted without it. 1.0.26 issuers then keep its sessions, now read-only on
   every use, and offer read-only replacements it ignores; it keeps reading.
   When it updates, it collects them and its old sessions are retired.
3. **SPDevMachine is off the whole time.** The others show it as offline. A day
   after the first 1.0.26 machine saw the starting list, once every other machine
   has signed (or been silent for a day), the list is adopted without it. When
   it starts again on 1.0.26 it collects its read-only replacements. If it starts
   on 1.0.24 first, it keeps reading everywhere and converges once updated.

## Link approved machines

On the owner computer, select one approved member or all approved members and
choose **Link both ways**. This signs a 24-hour request for connections among the
selected members, including the owner. With automatic sync approved locally,
each open desktop checks every five minutes, publishes its signed connection
summary, and exchanges only missing links. Under normal reachable conditions,
allow roughly ten minutes for detection and pickup; **Sync now** checks immediately.
Members using manual sync must choose **Sync now** themselves.

A non-owner may use **Share this machine** to send its environment to approved
recipients. Browser and mobile clients retain manual pairing; they cannot safely
identify a native computer or read its shared folder. Nothing installs a scheduled
task or starts a provider. Pickup stops when the desktop app closes; issuing,
renewal and revocation continue from the server.

Repeated requests preserve saved connections, including disabled entries. A fresh,
signed recipient summary is checked before managed enrollment issues a credential.
Deliveries are recipient-encrypted with X25519/HKDF/AES-256-GCM and sender-signed
with Ed25519. Pairing credentials never appear as plaintext on the share. The
normal importer verifies the destination environment before exchanging its code.
Each delivery is claimed once; uncertain exchanges pause for review instead of
rotating credentials or replaying enrollment.

Deliveries and owner link requests expire after 24 hours; signed connection
summaries last ten minutes. Polling stops after three consecutive failures and
shows a paused state. **Sync now** permits a manual check. Interrupted publishing,
a lost journal, a stale operation lock, or an unconfirmed pickup needs review.
Preserve local state and shared delivery files when investigating; deleting them
is not a retry mechanism.

**Pause fleet** stops new local fleet activity while retaining keys and saved
connections. The owner can revoke a member to stop new links/deliveries. Existing
sessions are deliberately preserved; withdraw existing access separately through
Authorized clients. Restoring a lost owner/device key is an administrator recovery
operation, not an automatic key rotation.

## Agents on other machines

From LAN 1.0.26 each server links itself to every trusted fleet peer as an
upstream linked environment, so in-app agents use `t3_environment_links` and
`environmentId` on the native tools. In-app threads no longer see the `t3_lan_*`
tools, which have refused every in-app thread since they were added; only outside
task clients can use them. Each link carries the access the destination's Machine
access list gives this machine: standard is `full-access`, read-only is
`read-only`.

Links form only once the fleet has a Machine access list, adopted from a starting
list or saved in Settings. Until then no machine asks for or offers a link, since
a link would carry each machine's setup access, normally standard. That includes a
machine with no saved list that finds no `fleet-access` folder on the share.

The linking machine also holds itself to its own list: it never links above the
access its accepted list gives it, whatever the destination offers, and drops at
once a link above it when its list narrows, then relinks at its access. It
ignores offers that carry no list revision, which is every offer from LAN 1.0.25
(whose adapter, turned on by hand, offers its setup access even before a list
exists). The destination's cap on every call stays authoritative.

Linked environments count as on only while the fleet links this machine: as of
its last fleet read its own enrollment checks out, its roster row is enabled,
and a list exists. Labs then shows the switch on and locked. A machine whose
roster row is disabled stops counting as linked, while the list it accepted keeps
governing credentials. Anywhere else, such as a development or unenrolled
install, the Labs switch decides as upstream. A machine opts out with
`"fleetLinkedEnvironmentsEnabled": false` in its `userdata\settings.json`; on its
next pass it forgets the links it made and revokes those it issued. Design, share
files and the live proof: [native link adapter](../maintenance/native-link-adapter.md).

## Hub bootstrap contract

`T3CODE_LAN_FLEET_ROSTER_PATH` is the absolute roster JSON filename, including the
filename, not a directory. T3 has no machine-specific default. Hub preserves any
explicit value verbatim and supplies its private default only when the variable
is absent, scoped to the normal T3 child process. It must not inject this setting
into maintenance/repair or change persistent user/machine environment settings.

An explicitly empty value disables fleet bootstrap and ignores any legacy local
fallback. Other invalid values fail closed. Changing the launch variable requires
a relaunch; roster, membership, and link-request contents reload during sync
without restarting or rebuilding. The native backend inherits the launch variable.
The variable alone creates no keys, approves no members, and enables no enrollment.

Storage beside the roster contains `fleet-authority.json` (signed public membership
and link requests), `fleet-enrollment` (public join requests), and `fleet-deliveries`
(encrypted deliveries and signed status/receipts). No private key or plaintext
bearer credential belongs there. The feature changes no share or network ACLs.
Keep real names, paths, addresses and IDs in private untracked runtime storage.

## Roster metadata

The roster is separate from trust grants. Its schema is version 1 with a `machines`
array; each row has `machineId`, existing `environmentId`, `label`, canonical
`origin`, and `enabled`. HTTPS is required outside loopback, matching the routing
origin policy. At most 100 machines are accepted. Duplicate machine/environment IDs,
duplicate JSON members, unknown fields and files over one MiB are rejected.

Setup edits the roster under a shared operation lock and replaces complete files
atomically. Advanced operators can also validate and atomically replace a private
candidate file, using one editor at a time:

```powershell
node apps/server/scripts/lan-fleet-roster.ts C:\PrivateFleet\candidate.json \\fileserver\private-share\fleet-roster.json
```

Editing metadata never installs keys or grants trust. Legacy local administrator
configuration is preserved; explicit new enrollment does not silently rewrite it.
No build, publication or development test authorizes actual fleet activation.
