# LAN fleet routes at a shared address

Candidate 1.0.54 keeps the 1.0.53 sender and credential lookup behavior. Fleet IDs and TLS pins can prove which routes to retire after a fleet switch. A delivery that collides with a retained route stops before replacing that route. If the collision appears during code exchange, the catalog write refuses the change.

## Findings from candidate B

- Same-address coexistence needs a stable connection ID for each credential. The implementation must handle manual-first and fleet-first pairing, a fleet route receiving its first pin, repeated renewal, and a manual route saved during exchange. Candidate B also needed route selection and a desktop gateway probe to reach the intended pinned route.
- Fleet-only connected reports lost the renewal signal for unpinned routes created by 1.0.53. Keeping the existing environment report preserves renewal for those installations. That report alone cannot prove an offer was redeemed. A delivery-specific acknowledgment would need to follow verified pairing and the atomic catalog write, with migration for old journals and clients.
- Dropping borrowed-credential aliases broke existing manual LAN-to-Tailscale access. Retaining aliases also requires care when a credential learns its first pin. An existing alias must not become a way to use the newly pinned credential against an unpinned endpoint.
- Owner **Link both ways** re-arm needs to reconcile older connected reports, spent and unspent grants, and receipts for previous offers. A fresh signed catalog can still predate the receipt and trigger a redundant grant. Revoking an unspent grant must identify the exact grant even for an older journal.

## Open questions

- What stable route IDs and preference rules make adding either route first predictable? How should a failed pin probe fall back to manual access without sending the fleet credential?
- How should upgrades preserve legitimate borrowed aliases and isolate credentials as a route gains a pin? How long should the desktop keep an alternate loopback gateway?
- How can a signed report prove it follows the relevant acknowledgment? How should a mixed-version fleet renew legacy unpinned sessions and report a new pickup accurately?
- What should owner re-arm do when the prior session has already been redeemed, or the journal lacks the exact unspent grant ID?
