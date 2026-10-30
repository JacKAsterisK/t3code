import { useState } from "react";
import type { FleetAccess, LanFleetSetupState } from "@t3tools/contracts";
import { useLanFleet } from "../../connection/lanFleet";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  const sharedFolderTrust = setup?.sharedFolderTrust === true;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !fleet.busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {sharedFolderTrust
              ? "Connect this machine"
              : joining
                ? "Join this fleet"
                : "Create a fleet"}
          </DialogTitle>
          <DialogDescription>
            {sharedFolderTrust
              ? "Windows access to BuildShare connects machines automatically."
              : joining
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
            {!sharedFolderTrust ? (
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
            ) : null}
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
            {managedTls && !sharedFolderTrust ? (
              <p className="text-xs text-muted-foreground">
                Confirming creates a local encryption key in the OS credential store and opens the
                shown additional port automatically whenever T3 starts, until you stop encrypted
                access. Your access choice is saved once. The port must be available and reachable
                on your LAN. No firewall rules or system certificate trust will be changed. Existing
                HTTP connections are preserved.
              </p>
            ) : null}
            {joining && !sharedFolderTrust ? (
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
            {!sharedFolderTrust ? (
              <>
                <div className="space-y-1">
                  <p className="text-sm">
                    Allow owner-approved machines to access this environment
                  </p>
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
                    The fleet owner can request links between approved members. Each machine grants
                    its own selected access. Automatic checks run only while this desktop app is
                    open.
                  </p>
                </div>
              </>
            ) : null}
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
            disabled={
              fleet.busy || !origin || (joining && !sharedFolderTrust && code.length !== 12)
            }
            onClick={() => {
              void fleet
                .configure(
                  joining
                    ? {
                        operation: "join",
                        confirmed: true,
                        origin,
                        ...(sharedFolderTrust ? {} : { ownerCode: code }),
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
              : sharedFolderTrust
                ? "Connect this machine"
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

const machineAccessItems = [
  { value: "read-only", label: "Read only" },
  { value: "standard", label: "Standard" },
];
type MachineAccessChange = {
  readonly machineId: string | null;
  readonly label: string;
  readonly access: FleetAccess;
};
type ExceptionChange = {
  readonly machineId: string;
  readonly label: string;
  readonly standardOn: ReadonlyArray<string>;
};

/** One fleet-wide list, synced through shared storage; each machine applies it to its peers. */
function FleetMachineAccess({ setup }: { setup: LanFleetSetupState }) {
  const fleet = useLanFleet();
  const [change, setChange] = useState<MachineAccessChange | null>(null);
  const [exceptionChange, setExceptionChange] = useState<ExceptionChange | null>(null);
  const policy = setup.accessPolicy;
  if (policy === undefined) return null;
  const machines = setup.peers.filter((peer) => peer.status === "approved");
  const accessOf = (machineId: string) =>
    policy.machines.find((machine) => machine.machineId === machineId)?.access ??
    policy.defaultAccess;
  const standardOn = (machineId: string) =>
    policy.exceptions?.find((exception) => exception.machineId === machineId)?.standardOn ?? [];
  const labelOf = (machineId: string) =>
    setup.peers.find((peer) => peer.machineId === machineId)?.label ?? machineId;
  const self = machines.find((peer) => peer.environmentId === setup.environmentId);
  const selfExceptions = self === undefined ? [] : standardOn(self.machineId);
  const disabled = fleet.busy || !fleet.allowed || !policy.canChange;
  const select = (label: string, value: FleetAccess, machineId: string | null) => (
    <div className="w-36 shrink-0">
      <Select
        items={machineAccessItems}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if ((next === "read-only" || next === "standard") && next !== value)
            setChange({ machineId, label, access: next });
        }}
      >
        <SelectTrigger aria-label={`Access for ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {machineAccessItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Machine access</p>
      <p className="text-xs text-muted-foreground">
        {policy.canChange
          ? "One setting for the whole fleet. A read-only machine can view threads and tasks on the other machines but cannot start, send to, stop or approve them."
          : `This machine has read-only access to the other machines${
              selfExceptions.length === 0
                ? ""
                : `, except standard access on ${selfExceptions.map(labelOf).join(", ")}`
            }. Only a machine with standard access can change this.`}
      </p>
      {policy.seed === "waiting" && policy.seedPending !== undefined ? (
        <p className="text-xs text-muted-foreground">
          This fleet's starting access list applies once every enabled machine runs T3 Code LAN
          1.0.26 or later, so no machine loses its connections on the way. Not yet on 1.0.26:{" "}
          {policy.seedPending.machineIds
            .map(
              (machineId) =>
                setup.peers.find((peer) => peer.machineId === machineId)?.label ?? machineId,
            )
            .join(", ")}
          . A machine that is off delays it until it is turned on and updated, or disabled in the
          roster. Machines link to each other once it is in place.
        </p>
      ) : policy.seed === "waiting" ? (
        <p className="text-xs text-muted-foreground">
          Applying this fleet's starting access list. Machines link to each other once it is in
          place.
        </p>
      ) : policy.revision === 0 && policy.seed === undefined ? (
        <p className="text-xs text-muted-foreground">
          Machines link to each other once this fleet has an access list. Changing access here saves
          one.
        </p>
      ) : policy.seed === "invalid" ? (
        <p className="text-xs text-destructive">
          The starting access list on the shared folder can't be used, so machines don't link to
          each other yet. Fix or remove fleet-access-seed.json, or change access here.
        </p>
      ) : null}
      {machines.map((peer) => (
        <div key={peer.machineId} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span>
              {peer.label}
              {peer.environmentId === setup.environmentId ? " · This machine" : ""}
            </span>
            {select(peer.label, accessOf(peer.machineId), peer.machineId)}
          </div>
          {accessOf(peer.machineId) === "read-only" && machines.length > 1 ? (
            <div className="flex items-center justify-between gap-3 pl-3 text-xs text-muted-foreground">
              <span>
                Standard on:{" "}
                {standardOn(peer.machineId).length === 0
                  ? "no machines"
                  : standardOn(peer.machineId).map(labelOf).join(", ")}
              </span>
              <Button
                size="compact"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`Choose where ${peer.label} has standard access`}
                onClick={() =>
                  setExceptionChange({
                    machineId: peer.machineId,
                    label: peer.label,
                    standardOn: standardOn(peer.machineId),
                  })
                }
              >
                Choose
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>Machines added later</span>
        {select("machines added later", policy.defaultAccess, null)}
      </div>
      {change ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !fleet.busy) setChange(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                {change.access === "read-only"
                  ? `Make ${change.label} read only?`
                  : `Give ${change.label} standard access?`}
              </DialogTitle>
              <DialogDescription>
                {change.access === "read-only"
                  ? "It will be able to read threads and tasks on the other machines, but not start, send to, stop or approve them."
                  : "It will be able to start and run agents, shells and commands on the other machines, and change their files and settings."}{" "}
                Every machine applies this automatically and replaces the credentials it gave this
                one within a few minutes. Nothing needs approving on any machine.
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
                      operation: "access",
                      confirmed: true,
                      revision: policy.revision,
                      defaultAccess:
                        change.machineId === null ? change.access : policy.defaultAccess,
                      machines:
                        change.machineId === null
                          ? policy.machines
                          : [
                              ...policy.machines.filter(
                                (machine) => machine.machineId !== change.machineId,
                              ),
                              { machineId: change.machineId, access: change.access },
                            ],
                    })
                    .then((ok) => {
                      if (ok) setChange(null);
                    })
                }
              >
                Change access
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
      {exceptionChange ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !fleet.busy) setExceptionChange(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Where may {exceptionChange.label} make changes?</DialogTitle>
              <DialogDescription>
                {exceptionChange.label} gets standard access on the machines you pick and stays read
                only on the rest. Every machine applies this automatically and replaces the
                credentials it gave this one within a few minutes. Nothing needs approving on any
                machine.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {machines
                  .filter((peer) => peer.machineId !== exceptionChange.machineId)
                  .map((peer) => (
                    <label
                      key={peer.machineId}
                      className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-xs transition-colors hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={exceptionChange.standardOn.includes(peer.machineId)}
                        disabled={fleet.busy}
                        onCheckedChange={(checked) =>
                          setExceptionChange({
                            ...exceptionChange,
                            standardOn:
                              checked === true
                                ? [...exceptionChange.standardOn, peer.machineId]
                                : exceptionChange.standardOn.filter(
                                    (machineId) => machineId !== peer.machineId,
                                  ),
                          })
                        }
                      />
                      {peer.label}
                    </label>
                  ))}
              </div>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={fleet.busy} />}>
                Cancel
              </DialogClose>
              <Button
                disabled={fleet.busy || !policy.canChange}
                onClick={() =>
                  void fleet
                    .configure({
                      operation: "access",
                      confirmed: true,
                      revision: policy.revision,
                      defaultAccess: policy.defaultAccess,
                      machines: policy.machines,
                      exceptions: [
                        {
                          machineId: exceptionChange.machineId,
                          standardOn: [...new Set(exceptionChange.standardOn)],
                        },
                      ],
                    })
                    .then((ok) => {
                      if (ok) setExceptionChange(null);
                    })
                }
              >
                Save
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}

export function LanFleetSetup() {
  const fleet = useLanFleet();
  const setup = fleet.setup;
  const [enrolling, setEnrolling] = useState(false);
  const [review, setReview] = useState<Peer | null>(null);
  const [revoke, setRevoke] = useState<Peer | null>(null);
  const [transportChange, setTransportChange] = useState<boolean | null>(null);
  const sharedFolderTrust = setup?.sharedFolderTrust === true;
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
        <>
          {sharedFolderTrust ? (
            <p className="text-sm">Windows access to BuildShare connects machines automatically.</p>
          ) : null}
          <Button
            size="sm"
            disabled={!fleet.allowed || fleet.busy}
            onClick={() => {
              const origin =
                setup.origin ||
                (setup.suggestedTlsOrigins?.length === 1 ? setup.suggestedTlsOrigins[0] : "");
              if (!sharedFolderTrust || !origin) {
                setEnrolling(true);
                return;
              }
              void fleet
                .configure({
                  operation: setup.stage === "join" ? "join" : "start",
                  confirmed: true,
                  origin,
                  managedTls: setup.managedTls === true,
                  autoPickup: setup.deviceCode == null ? true : setup.autoPickup,
                  access: setup.access,
                })
                .then((ok) => {
                  if (ok) void fleet.run("manual");
                });
            }}
          >
            {sharedFolderTrust
              ? "Connect this machine"
              : setup.stage === "join"
                ? "Join fleet"
                : "Create fleet"}
          </Button>
        </>
      ) : (
        <>
          {sharedFolderTrust ? (
            <p className="text-sm">Windows access to BuildShare connects machines automatically.</p>
          ) : setup.owner ? (
            <p className="text-sm">
              Owner verification code: <code>{setup.ownerCode}</code>
            </p>
          ) : null}
          {!sharedFolderTrust ? (
            <p className="text-sm">
              This machine's code: <code>{setup.deviceCode}</code>
            </p>
          ) : null}
          {setup.stage === "active" ? <FleetMachineAccess setup={setup} /> : null}
          {setup.stage === "pending" ? (
            <p className="text-xs text-muted-foreground">
              {sharedFolderTrust
                ? "Connecting this machine through shared storage."
                : "Waiting for the fleet owner to compare this code and approve this machine. No connection access is granted while waiting."}
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
                        ? sharedFolderTrust
                          ? "Connecting"
                          : "Needs verification"
                        : peer.status === "revoked"
                          ? "Revoked"
                          : "Approved"}
                    </span>
                    {!sharedFolderTrust &&
                    (peer.status === "pending" || peer.status === "revoked") ? (
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
