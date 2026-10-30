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
  The list waits until every enabled machine has a marker signed with its own
  fleet key, however long that takes, then is adopted at once. Nothing else
  tells a 1.0.25 machine from one that is off, so a machine that is off delays
  the list until it is turned on and updated, or is disabled in the roster. That
  delays the restriction, never anyone's access. Hub never downgrades, so once
  every enabled machine has run 1.0.26, no 1.0.25 issuer is left among them.
- The machine that adopts it reads every marker again under the change lock,
  right before it writes revision 1.
- While it waits, Machine access names the machines not yet on 1.0.26, and the
  server logs the same. Placing the file early is safe: older builds never read
  it, and newer ones wait like this.
- A machine disabled in the roster is not waited for. If it is enabled again
  after the list is adopted while still on 1.0.25, it revokes a downgraded
  machine's session at once, as 1.0.25 does. A downgraded machine on 1.0.26
  collects the replacement within five minutes while its desktop is open, or
  as it opens; one still on 1.0.24 cannot, and loses reads on that machine until
  one of them updates. Let a disabled machine update before enabling it again.

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
its saved connection. From LAN 1.0.26 the issuer treats the session the peer
used last, at any access, as the one it saved: it retires only sessions issued
before that one, and when that one is not at the peer's current access it keeps
it, capped, sends a replacement and waits until the peer uses it. So a peer that
cannot take the replacement yet (LAN 1.0.24) keeps reading until it updates,
then converges with no manual step, and a peer whose access changes back before
the issuer's next pass keeps the session it just saved. LAN 1.0.25 issuers
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

### Exceptions

An exception gives a read-only machine standard access on the machines it
names, while it stays read-only on every other one. In **Machine access**, a
read-only machine's row shows **Standard on:** and **Choose**: tick the machines
and **Save**. Only a machine with standard access can save. Each direction is
its own exception, so for AnvilToad and SPDevMachine to have standard access on
each other, choose SPDevMachine for AnvilToad and AnvilToad for SPDevMachine.
A standard machine's own exceptions change nothing until it is made read-only
again.

An exception only applies on a machine that is itself read-only, so
**Choose** offers only read-only machines. Standard access on a machine
includes its reach: its agents and shell, and through them that machine's own
credentials, its peer links to other machines, and its owner access to its own
server, including `t3` on that host, which needs no sign-in and can configure
the fleet as that machine. An exception onto a standard machine would reach
every machine that one can change, and could administer the fleet through it.
That would break both "not on the other machines" and the rule that a
read-only machine cannot lift its own restriction.

While it applies, an exception gives the caller full control of the receiver.
Standard access includes the receiver's shell, so the caller can do there
anything that machine's own user can. That is inherent to standard access, and
no rule here can take it back afterwards:

- Removing the exception, or making the receiver standard, stops every further
  use of the fleet credentials and peer links the caller holds there. It does
  not undo what the caller did there while the exception applied. A pairing
  credential made in its shell with `t3 auth pairing create`, a scheduled task,
  an SSH key or anything else it left behind stays. Such a credential is not
  tied to the caller's fleet credential, so nothing narrows it.
- Making the receiver standard extends the fleet's trust to whatever was done
  on it, including credentials like that one, which then pass as that machine's
  own. When a save would make a machine standard while exceptions onto it are
  stored, **Machine access** names the machines that had full control of it and
  asks before saving. Check that machine first, or reinstall it if a caller
  could not be trusted.
- The same goes for threads the caller starts there. A full-access thread on the
  receiver can read its database, use its shell and list its scheduled tasks
  with their webhook URLs, and anything it hands back to the caller outlives the
  exception. The webhook rule below only stops the caller's own connection from
  seeing those URLs.

- A save that adds an exception onto a machine that is standard in the saved
  list is refused, with a message saying why. So is one that does not name two
  machines the fleet has; Settings offers only those.
- When a machine named by an exception is made standard, the exception stays
  saved but stops applying: that pair narrows as a downgrade does, writes stop
  and reads are kept. Its row shows it as **Inactive on** that machine, **which
  is standard**. Make the machine read-only again and the exception applies
  again, with nothing to approve; or open **Choose** and untick it to remove
  it.
- The receiving machine decides, per pair: a caller has standard access there
  if it is standard, or if the list names that caller and that receiver and the
  receiver is itself read-only. Otherwise it has its listed level. This applies
  everywhere access applies: the cap on each use, revocation, the credentials
  and peer links each machine issues and replaces, the caller's own ceiling on
  the links it keeps, its refusal to forward task changes, routing, and what
  `t3_environment_links` reports.
- An exception is for working on that machine: threads, agents, the shell,
  files and that machine's own settings. It never makes the caller a fleet
  administrator there. Changing the list or its exceptions, fleet setup,
  enrollment and approval, and fleet sync on that machine's behalf all need the
  caller's own standard access, whatever exceptions it has. So a read-only
  machine cannot lift its restriction or grant an exception through a standard
  machine's Settings either.
- The same holds for handing access to someone outside the fleet, which would
  outlive the exception: creating guest shares, seeing scheduled tasks' webhook
  URLs (in Settings and from MCP clients), and linking the machine to a T3
  Connect account. Every other credential a fleet machine can mint or approve
  there stays tied to its own fleet credential and narrows with it: pairing
  credentials, MCP client sign-ins and task grants it approves, and peer links.
- The list's rules apply unchanged, and which revisions count is decided
  exactly as LAN 1.0.26 decides it, over every entry as signed. A revision that
  adds or removes an exception counts only if its writer had standard access
  under what it follows. A read-only machine can grant no exception and remove
  none, its own included: it may only restrict itself, every other entry left
  as it was, or 1.0.26 would not count the revision, nor any after it, and the
  two versions would stop on different lists. Exceptions change only what a
  counted revision grants. Competing revisions keep an exception only if every
  one of them grants it. A revision whose writer left or changed keys keeps only
  the exceptions the revisions it follows grant. A stored exception naming a
  machine the fleet does not know, such as one that left, is kept, hidden, and
  applies once that machine is back, if it is read-only.
- An entry whose ID has the form of an exception or a writer's mark is always
  read as one. The reading depends on the list alone, never on which machines
  the fleet has, so it is the same on every machine: at startup, before any
  fleet read; with a machine disabled in the roster; and in a save.
- This version never admits, trusts or gives access to a machine whose ID
  starts with `pair-access-`, and refuses every credential such a machine
  holds. No real machine has one, because every ID T3 Code generates is
  `machine-<hex>`. Only forged roster, enrollment or authority files on the
  share could bring one in, and whatever can write the share can already join
  the fleet. That is the shared-folder trust boundary described above.
  Which revisions count still treats such a machine's key exactly as 1.0.26
  does, so the two versions never follow different chains.
- Adding one needs nothing more: within a few minutes the receiver replaces the
  read-only fleet credential and peer link it gave the caller with standard
  ones. No approval, pickup or relink.
- Removing one narrows that pair as a downgrade does, and nothing loses reads:
  each replacement is made before the old credential is retired. Once the
  receiver reads the change, writes stop at once on each use of every fleet
  connection, task grant and peer link the caller holds there, which keep
  reading, capped. The receiver offers read-only replacements unasked and
  retires each old session only once its replacement is in use.
- A caller that reads the change first enforces it on itself at once. Its peer
  link keeps reading, but the caller refuses every write over it: in
  `environmentId` tools, `delegate_task` and forwarded task calls alike. It
  reads its list again right before each write is sent, a retry or a new
  session included, so a list that narrows mid-call stops the write. That
  re-check and the send are not one step: a list that narrows in the instant
  between them lets that one write go, as if it had been sent a moment earlier.
  It then asks for a read-only link. A link that finishes signing in after the caller's
  list narrowed is kept for its reads, first link or not: the caller refuses
  its writes, confirms it to the receiver as usual and asks for a read-only one.
  Dropping it would leave a 1.0.26 receiver holding the spent code, ignoring
  new requests until it expires an hour later.
- Accepted propagation delay: the desktop app's own fleet connections to other
  machines, and the codes fleet sync collects, are capped by the receiver, not
  by the caller. After a narrowing they keep their old access until the
  receiver reads the change, within its sync delay. Agents reach other machines
  through peer links, on which the caller already refuses writes itself, so the
  remaining window is only the receiver's sync delay.
- A code being minted as the list narrows carries only what the live list says
  right before minting, including the first list a fleet adopts mid-sync. The
  list is read again once the code is published, for fleet credentials and peer
  links alike: if it narrowed meanwhile, the code is revoked and its offer taken
  back, and the next pass offers one at the narrower access.

With versions mixed, exceptions take effect pair by pair as both machines
update: the receiver must run a release with exceptions to grant one, and the
caller to lift its own link ceiling. An exception is stored inside the signed
list as an entry LAN 1.0.26 reads as a machine it does not know, so 1.0.26
still verifies and applies every revision and ignores the exception:

- A 1.0.26 machine keeps AnvilToad read-only toward itself whatever the list's
  exceptions say, and a 1.0.26 AnvilToad links read-only to an updated
  SPDevMachine. No machine loses reads, or the links and writes the list
  without exceptions gives it.
- A 1.0.26 machine still handles a narrowed peer link as 1.0.26 does: as the
  receiver it revokes the link's session, and as the caller it unlinks. That
  link stops reading until it relinks by itself at the narrower access. 1.0.26
  never grants an exception, so only ordinary downgrades reach it, and this ends
  once every machine is updated.
- A save from a 1.0.26 machine keeps the exceptions, because its Settings
  signs every entry it was shown. It can never add one: a revision without its
  writer's own mark keeps only the exceptions the revisions it follows grant.
- Nothing waits for machines to update. Revision files never gain a field:
  1.0.26 skips such a file and every revision after it, which would leave it on
  an old list.

### Rolling out 1.0.26 with a starting list

Hub updates one machine at a time when T3 is idle, so versions mix for hours or
days. With `fleet-access-seed.json` placed when 1.0.26 publishes:

- **1.0.24** ignores the starting list and any list, issues at its setup access
  and never revokes for access. It cannot take a replacement for a connection it
  already has.
- **1.0.25** ignores the starting list. With no list it changes nothing. Once a
  list exists it revokes a downgraded peer's fleet session at once and sends a
  replacement. That is why adoption waits for it.
- **1.0.26** signs its marker on its first fleet read and shows, in Machine
  access, which machines are not yet on 1.0.26. Nothing links and no access
  changes until the list is adopted. After that it caps each downgraded peer's
  existing sessions on every use, sends a replacement at the new access and
  retires the old session once the replacement is in use. Links form within two
  adapter passes.

The list waits until every enabled machine is on 1.0.26. There is no timeout: a
machine that is off delays the restriction until it is turned on and updated,
or is disabled in the roster. Until then every machine keeps the access it has
today and nothing links.

What the user sees:

1. **SPDevMachine updates soon.** The first machine on 1.0.26 lists the other
   four as not yet on 1.0.26; the list shrinks as each updates and starts. When
   the last one signs, the next sync on any 1.0.26 machine (within five minutes)
   adopts it and removes the starting list, and the others read it within five
   minutes. From then on AnvilToad and SPDevMachine can read but not launch,
   send, stop or approve on the other three: their existing connections lose
   writes at once and keep reading. Their open desktops collect read-only
   replacements within five minutes, or as they open, with no prompt, and the
   old sessions are retired once the replacements are in use. Linked
   environments turn on, locked, on all five, and links form at the list's
   access within about 20 minutes. A machine that stays busy on an older
   version delays all of this the same way until Hub updates it.
2. **SPDevMachine stays off.** Every 1.0.26 machine lists SPDevMachine as not yet
   on 1.0.26, and nothing changes anywhere: AnvilToad keeps standard access, and
   nothing links. When SPDevMachine is turned on, Hub updates it once it is
   idle; on 1.0.26 it signs, and the list is adopted as in 1. If it comes up
   on 1.0.24 or 1.0.25 first, it changes nothing until then. To apply the
   restriction sooner, disable SPDevMachine in the roster: the list is then
   adopted without it, and it starts read-only. Let it update before enabling it
   again (see [Machine access](#machine-access)).

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
access its accepted list gives it, whatever the destination offers, reading its
list again right before each sign-in. When its list narrows it keeps the link it
has, so it never stops reading, and asks for one at its access; the new link
replaces the old one, and only then does the destination retire the old session.
The destination caps each call on the old link at what its own list says as soon
as it reads the change, and offers the narrower code unasked. It mints each code
at what its list says at that moment, and withdraws one the list narrowed before
it was offered.
Another machine applies a later change in Settings only once it reads it, within
about five minutes; until then it may still offer the access the change took
away, just as it still serves its fleet connections at the old access. It
ignores offers that carry no list revision, which is every offer from LAN 1.0.25
(whose adapter, turned on by hand, offers its setup access even before a list
exists). The destination's cap on every call stays authoritative.

Linked environments count as on only while the fleet links this machine: as of
its last fleet read its own enrollment checks out, its roster row is enabled,
and a list exists. Labs then shows the switch on and locked. A machine whose
roster row is disabled, whose enrollment record is gone or whose fleet bootstrap
is turned off stops counting as linked, while the list it accepted keeps
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
