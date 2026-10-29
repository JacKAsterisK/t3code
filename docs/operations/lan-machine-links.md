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
its writer's fleet key and chained to the previous revision. A revision counts
only if its writer had standard access under the previous one, or if it only
makes its writer read-only. The last standard machine cannot restrict itself.
Each machine keeps the revisions it accepted, so deleting or rewriting share files
cannot undo a change; a later write republishes lost revisions. Being the fleet
owner grants nothing here.

The receiving side enforces it. Every machine issues each peer's credential at
that peer's access. In shared-folder fleets each sync also revokes credentials it
issued that no longer match and delivers a replacement, which the peer's desktop
swaps in for its saved connection. Lost access ends at the issuer's next sync;
gained access waits until the peer is online. A read-only machine's own server
also refuses to forward LAN task changes. Until a list is saved, each machine
keeps the access chosen at setup.

The same replacement renews fleet links. A credential becomes a session with the
default 30-day lifetime, and in shared-folder fleets the issuer delivers a
replacement once less than seven days remain, whether or not a list was saved.
The old session keeps working until the peer connects with the new one, which
then retires it. A peer that is offline is renewed when its signed summary is
fresh again, including after its session expired. Only credentials this machine
delivered are renewed; a connection the peer made another way is left alone.

Limits: in owner-approval fleets a change applies only to links issued after it,
so relink existing ones there. Outside-agent task grants are approved on the
destination and are not tied to a machine; revoke them in **Sharing & access**. A
read-only machine's credentials cannot approve new ones.

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
task or starts a provider. Pickup stops when the desktop app closes.

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
