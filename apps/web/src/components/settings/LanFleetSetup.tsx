import { useState } from "react";
import type { LanFleetSetupState } from "@t3tools/contracts";
import { useLanFleet } from "../../connection/lanFleet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const accessItems = [
  { value: "read-only", label: "Read only" },
  { value: "standard", label: "Full T3 access" },
];
const pickupItems = [
  { value: "automatic", label: "Automatic, every 5 minutes" },
  { value: "manual", label: "Only when I sync" },
];
type Peer = LanFleetSetupState["peers"][number];

function EnrollmentDialog({ onClose }: { onClose: () => void }) {
  const fleet = useLanFleet();
  const setup = fleet.setup;
  const [origin, setOrigin] = useState(setup?.origin ?? "");
  const [managedTls, setManagedTls] = useState(setup?.managedTls === true);
  const [code, setCode] = useState("");
  const [access, setAccess] = useState<"read-only" | "standard">(setup?.access ?? "standard");
  const [automatic, setAutomatic] = useState(setup?.deviceCode == null ? true : setup.autoPickup);
  const joining = setup?.stage === "join";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !fleet.busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{joining ? "Join this fleet" : "Create a fleet"}</DialogTitle>
          <DialogDescription>
            {joining
              ? "Compare the owner code with the code displayed in the owner's T3 app. The owner will then verify this machine before it can link."
              : "This machine will approve new fleet members. Keep its owner verification code available when joining your other machines."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              This machine: {setup?.label}. Its existing environment identity is detected
              automatically. Private keys stay in the OS credential store; only public enrollment
              data is shared.
            </p>
            <Select
              items={[
                { value: "managed", label: "Automatic LAN encryption" },
                { value: "existing", label: "Existing HTTPS endpoint" },
              ]}
              value={managedTls ? "managed" : "existing"}
              onValueChange={(value) => {
                setManagedTls(value === "managed");
                setOrigin(
                  value === "managed" && setup?.suggestedTlsOrigins?.length === 1
                    ? setup.suggestedTlsOrigins[0]!
                    : "",
                );
              }}
            >
              <SelectTrigger aria-label="Fleet transport">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="managed">Automatic LAN encryption</SelectItem>
                <SelectItem value="existing">Existing HTTPS endpoint</SelectItem>
              </SelectPopup>
            </Select>
            {managedTls && (setup?.suggestedTlsOrigins?.length ?? 0) > 1 ? (
              <Select
                items={setup!.suggestedTlsOrigins!.map((address) => ({
                  value: address,
                  label: address,
                }))}
                value={origin || null}
                onValueChange={(value) => {
                  if (value !== null) setOrigin(value);
                }}
              >
                <SelectTrigger aria-label="Local LAN address">
                  <SelectValue placeholder="Choose this machine's LAN address" />
                </SelectTrigger>
                <SelectPopup>
                  {setup!.suggestedTlsOrigins!.map((address) => (
                    <SelectItem key={address} value={address}>
                      {address}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span>
                {managedTls ? "Encrypted LAN address and port" : "Reachable HTTPS address"}
              </span>
              <Input
                value={origin}
                onChange={(event) => setOrigin(event.currentTarget.value)}
                autoComplete="off"
                placeholder="https://machine.example.test"
              />
            </label>
            {managedTls ? (
              <p className="text-xs text-muted-foreground">
                Confirming creates a local encryption key in the OS credential store and opens the
                shown additional port automatically whenever T3 starts, until you stop encrypted
                access. Your access choice is saved once. The port must be available and reachable
                on your LAN. No firewall rules or system certificate trust will be changed. Existing
                HTTP connections are preserved.
              </p>
            ) : null}
            {joining ? (
              <label className="block space-y-1 text-sm">
                <span>Owner verification code</span>
                <Input
                  value={code}
                  onChange={(event) =>
                    setCode(
                      event.currentTarget.value
                        .replace(/[^a-f0-9]/giu, "")
                        .toLowerCase()
                        .slice(0, 12),
                    )
                  }
                  autoComplete="off"
                  placeholder="12 characters from the owner's app"
                />
              </label>
            ) : null}
            <div className="space-y-1">
              <p className="text-sm">Allow owner-approved machines to access this environment</p>
              <Select
                items={accessItems}
                value={access}
                onValueChange={(value) => {
                  if (value === "read-only" || value === "standard") setAccess(value);
                }}
              >
                <SelectTrigger aria-label="Fleet access scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {accessItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                {access === "standard"
                  ? "Full access includes running agents and shell commands, reading and changing files, provider setup, settings, and client access."
                  : "Read only allows reading threads, files, and diagnostics. It does not grant command execution or editing."}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm">Collect and share approved links</p>
              <Select
                items={pickupItems}
                value={automatic ? "automatic" : "manual"}
                onValueChange={(value) => setAutomatic(value === "automatic")}
              >
                <SelectTrigger aria-label="Fleet pickup schedule">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {pickupItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                The fleet owner can request links between approved members. Each machine grants its
                own selected access. Automatic checks run only while this desktop app is open.
              </p>
            </div>
            {fleet.error ? (
              <p role="status" className="text-xs text-muted-foreground">
                {fleet.error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={fleet.busy} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={fleet.busy || !origin || (joining && code.length !== 12)}
            onClick={() => {
              void fleet
                .configure(
                  joining
                    ? {
                        operation: "join",
                        confirmed: true,
                        origin,
                        ownerCode: code,
                        autoPickup: automatic,
                        access,
                        managedTls,
                      }
                    : {
                        operation: "start",
                        confirmed: true,
                        origin,
                        autoPickup: automatic,
                        access,
                        managedTls,
                      },
                )
                .then((ok) => {
                  if (ok) {
                    onClose();
                    void fleet.run("manual");
                  }
                });
            }}
          >
            {fleet.busy
              ? "Setting up…"
              : joining
                ? managedTls
                  ? "Enable encryption and request to join"
                  : "Generate keys and request to join"
                : managedTls
                  ? "Enable encryption and create fleet"
                  : "Generate keys and create fleet"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReviewPeerDialog({ peer, onClose }: { peer: Peer; onClose: () => void }) {
  const fleet = useLanFleet();
  const [code, setCode] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !fleet.busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Verify {peer.label}</DialogTitle>
          <DialogDescription>
            Enter the code shown on that machine's own T3 app. A matching name or address alone is
            not proof of identity.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <p className="break-all text-xs text-muted-foreground">
              Environment: {peer.environmentId}
              <br />
              Address: {peer.origin}
            </p>
            <Input
              aria-label="Machine verification code"
              autoComplete="off"
              placeholder="12 characters from the other machine"
              value={code}
              onChange={(event) =>
                setCode(
                  event.currentTarget.value
                    .replace(/[^a-f0-9]/giu, "")
                    .toLowerCase()
                    .slice(0, 12),
                )
              }
            />
            <p className="text-xs text-muted-foreground">
              Approving binds this exact environment, address and public keys to the fleet. Members
              can then link using the access each machine has explicitly allowed.
            </p>
            {fleet.error ? (
              <p role="status" className="text-xs text-muted-foreground">
                {fleet.error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={fleet.busy} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={fleet.busy || code.length !== 12}
            onClick={() =>
              void fleet
                .configure({
                  operation: "approve",
                  confirmed: true,
                  machineId: peer.machineId,
                  verificationCode: code,
                })
                .then((ok) => {
                  if (ok) onClose();
                })
            }
          >
            Verify and approve
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function LanFleetSetup() {
  const fleet = useLanFleet();
  const setup = fleet.setup;
  const [enrolling, setEnrolling] = useState(false);
  const [review, setReview] = useState<Peer | null>(null);
  const [revoke, setRevoke] = useState<Peer | null>(null);
  const [scopeChange, setScopeChange] = useState<"read-only" | "standard" | null>(null);
  const [transportChange, setTransportChange] = useState<boolean | null>(null);
  if (setup === null)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={!fleet.allowed || fleet.busy}
        onClick={() => void fleet.refreshSetup()}
      >
        Check fleet setup
      </Button>
    );
  if (!setup.available)
    return (
      <p className="text-xs text-muted-foreground">
        Fleet setup is off. Launch T3 through a Hub configured with a roster location. An explicitly
        empty launch setting keeps it disabled.
      </p>
    );
  return (
    <div className="space-y-3">
      {setup.managedTls && setup.tlsEnabled && setup.tlsReady === false ? (
        <p role="status" className="text-xs text-muted-foreground">
          Automatic encrypted LAN startup could not complete. Check the selected local address, port
          availability and OS-stored key, then retry. Saved keys, connections and access choices are
          preserved.
        </p>
      ) : null}
      {setup.stage === "unconfigured" || setup.stage === "join" ? (
        <Button
          size="sm"
          disabled={!fleet.allowed || fleet.busy}
          onClick={() => setEnrolling(true)}
        >
          {setup.stage === "join" ? "Join fleet" : "Create fleet"}
        </Button>
      ) : (
        <>
          {setup.owner ? (
            <p className="text-sm">
              Owner verification code: <code>{setup.ownerCode}</code>
            </p>
          ) : null}
          <p className="text-sm">
            This machine's code: <code>{setup.deviceCode}</code>
          </p>
          <Select
            items={accessItems}
            value={setup.access}
            disabled={fleet.busy || !fleet.allowed}
            onValueChange={(value) => {
              if ((value === "read-only" || value === "standard") && value !== setup.access)
                setScopeChange(value);
            }}
          >
            <SelectTrigger aria-label="Access granted by this machine">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {accessItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {setup.stage === "pending" ? (
            <p className="text-xs text-muted-foreground">
              Waiting for the fleet owner to compare this code and approve this machine. No
              connection access is granted while waiting.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={fleet.busy || !fleet.allowed}
              onClick={() => {
                void fleet.refreshSetup();
                void fleet.run("manual");
              }}
            >
              Refresh setup
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={fleet.busy || !fleet.allowed}
              onClick={() =>
                void fleet.configure({
                  operation: "settings",
                  confirmed: true,
                  enabled: setup.stage === "paused",
                  autoPickup: setup.autoPickup,
                  access: setup.access,
                })
              }
            >
              {setup.stage === "paused" ? "Resume fleet" : "Pause fleet"}
            </Button>
            {setup.managedTls ? (
              <Button
                size="sm"
                variant="outline"
                disabled={fleet.busy || !fleet.allowed}
                onClick={() => setTransportChange(!setup.tlsEnabled)}
              >
                {setup.tlsEnabled ? "Stop encrypted endpoint" : "Enable automatic encrypted access"}
              </Button>
            ) : null}
            {setup.managedTls && setup.tlsEnabled && !setup.tlsReady ? (
              <Button
                size="sm"
                variant="outline"
                disabled={fleet.busy || !fleet.allowed}
                onClick={() => setTransportChange(true)}
              >
                Retry encrypted endpoint
              </Button>
            ) : null}
            {setup.stage === "active" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={fleet.busy || !fleet.allowed}
                onClick={() =>
                  void fleet.configure({
                    operation: "settings",
                    confirmed: true,
                    enabled: true,
                    autoPickup: !setup.autoPickup,
                    access: setup.access,
                  })
                }
              >
                {setup.autoPickup ? "Use manual sync" : "Enable automatic sync"}
              </Button>
            ) : null}
          </div>
          {setup.owner
            ? setup.peers
                .filter((peer) => peer.environmentId !== setup.environmentId)
                .map((peer) => (
                  <div
                    key={`${peer.machineId}:${peer.verificationCode}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span>
                      {peer.label} ·{" "}
                      {peer.status === "pending"
                        ? "Needs verification"
                        : peer.status === "revoked"
                          ? "Revoked"
                          : "Approved"}
                    </span>
                    {peer.status === "pending" || peer.status === "revoked" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={fleet.busy || !fleet.allowed || setup.stage !== "active"}
                        onClick={() => setReview(peer)}
                      >
                        Review
                      </Button>
                    ) : peer.status === "approved" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={fleet.busy || !fleet.allowed}
                        onClick={() => setRevoke(peer)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                ))
            : null}
        </>
      )}
      {enrolling ? <EnrollmentDialog onClose={() => setEnrolling(false)} /> : null}
      {review ? <ReviewPeerDialog peer={review} onClose={() => setReview(null)} /> : null}
      {scopeChange ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !fleet.busy) setScopeChange(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Change access for new fleet links?</DialogTitle>
              <DialogDescription>
                {scopeChange === "standard"
                  ? "Owner-approved machines may receive full access to this environment, including agents, shells, files, provider setup, settings and client access."
                  : "New links will allow reading threads, files and diagnostics without command execution or editing."}{" "}
                Existing sessions and saved connections are not replaced or reset; manage existing
                access separately in Authorized clients.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={fleet.busy} />}>
                Cancel
              </DialogClose>
              <Button
                disabled={fleet.busy}
                onClick={() =>
                  void fleet
                    .configure({
                      operation: "settings",
                      confirmed: true,
                      enabled: setup.stage !== "paused",
                      autoPickup: setup.autoPickup,
                      access: scopeChange,
                    })
                    .then((ok) => {
                      if (ok) setScopeChange(null);
                    })
                }
              >
                Confirm new-link access
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
      {transportChange !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !fleet.busy) setTransportChange(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                {transportChange
                  ? "Enable automatic encrypted LAN access?"
                  : "Stop encrypted LAN access?"}
              </DialogTitle>
              <DialogDescription>
                {transportChange
                  ? `This opens ${setup.origin} now and automatically whenever T3 starts, using its existing OS-stored key. You can stop it here at any time. It does not change firewall rules, rotate keys or create access grants.`
                  : "This closes the encrypted port and keeps it off after T3 restarts until you enable it again. Saved connections, keys and access grants are preserved. Existing HTTP connections are unchanged."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={fleet.busy} />}>
                Cancel
              </DialogClose>
              <Button
                disabled={fleet.busy}
                onClick={() => {
                  void fleet
                    .configure({
                      operation: "transport",
                      confirmed: true,
                      enabled: transportChange,
                    })
                    .then((ok) => {
                      if (ok) setTransportChange(null);
                    });
                }}
              >
                {transportChange ? "Enable and start automatically" : "Stop encrypted endpoint"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
      {revoke ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !fleet.busy) setRevoke(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Revoke {revoke.label} from the fleet?</DialogTitle>
              <DialogDescription>
                This stops new fleet links and deliveries for this member. Existing saved
                connections and sessions are preserved; revoke existing access separately in
                Authorized clients.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={fleet.busy} />}>
                Cancel
              </DialogClose>
              <Button
                disabled={fleet.busy}
                onClick={() =>
                  void fleet
                    .configure({
                      operation: "revoke",
                      confirmed: true,
                      machineId: revoke.machineId,
                    })
                    .then((ok) => {
                      if (ok) setRevoke(null);
                    })
                }
              >
                Revoke fleet approval
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
