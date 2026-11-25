// oxlint-disable t3code/no-untranslated-copy -- T3 Code LAN fleet settings ship English-only alongside fleet setup.
import type { EnvironmentId, LanFleetResetReceipt } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { useLanFleet, useLanFleetReset } from "../../connection/lanFleet";
import { startFleetPolling } from "../../connection/lanFleetPolling";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";
import { LanFleetSetup } from "./LanFleetSetup";

export function LanFleetCoordinator() {
  const fleet = useLanFleet();
  const initialize = useEffectEvent(() => {
    void fleet.refreshSetup().then(() => fleet.run("status"));
  });
  const poll = useEffectEvent(async () => (await fleet.refreshSetup()) && fleet.run("automatic"));
  const pause = useEffectEvent(() => fleet.pause());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads fleet setup and status from the server when this machine's environment becomes eligible
  useEffect(() => {
    if (fleet.environmentId !== null && fleet.allowed) initialize();
  }, [fleet.environmentId, fleet.allowed]);
  // Polls even with automatic pickup off: renewals of accepted links need no decision, and only
  // new links wait for Sync now.
  const enabled =
    fleet.summary?.enabled === true ||
    (fleet.setup !== null && (fleet.setup.stage === "pending" || fleet.setup.stage === "active"));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the fleet pickup polling timer while this machine is in a fleet
  useEffect(() => {
    if (!enabled || !fleet.allowed || fleet.environmentId === null) return;
    return startFleetPolling(poll, pause);
  }, [enabled, fleet.environmentId, fleet.allowed]);
  return null;
}

const labels = {
  self: "This machine",
  untrusted: "Approval needed",
  ready: "Ready",
  pending: "Waiting for pickup",
  connected: "Already connected",
  expired: "Expired · review needed",
  uncertain: "Interrupted · review needed",
};

function ResetFleetLinks({
  environmentId,
  syncing,
}: {
  environmentId: EnvironmentId;
  syncing: boolean;
}) {
  const { allowed, reset } = useLanFleetReset(environmentId);
  type Preview = Extract<Awaited<ReturnType<typeof reset>>, { preview: unknown }>;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Preview>();
  const [receipt, setReceipt] = useState<LanFleetResetReceipt>();
  const [error, setError] = useState<string>();
  const [includeConnections, setIncludeConnections] = useState(false);

  const preview = async () => {
    setOpen(true);
    setBusy(true);
    setReview(undefined);
    setReceipt(undefined);
    setError(undefined);
    setIncludeConnections(false);
    const result = await reset({ mode: "preview" });
    if (result.preview !== undefined) setReview(result);
    setError(result.error);
    setBusy(false);
  };
  const apply = async () => {
    if (review === undefined) return;
    const { fleetId, digest } = review.preview;
    setBusy(true);
    setError(undefined);
    const result = await reset(
      { mode: "apply", fleetId, previewDigest: digest },
      includeConnections ? review.routes : [],
    );
    setReview(undefined);
    setReceipt(result.receipt);
    setError(result.error);
    setBusy(false);
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!allowed || syncing}
        onClick={() => void preview()}
      >
        Reset fleet links
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Reset fleet links</DialogTitle>
            <DialogDescription>
              Review the fleet links and credentials that will be retired on this machine.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {busy ? (
              <p role="status">
                {review === undefined ? "Loading preview…" : "Resetting fleet links…"}
              </p>
            ) : null}
            {error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {review === undefined ? null : (
              <div className="space-y-3 text-sm wrap-anywhere">
                <p>Fleet {review.preview.fleetId}</p>
                <p>
                  {review.preview.items.state.linking} outgoing and{" "}
                  {review.preview.items.state.serving} serving state entries
                </p>
                <ul className="list-disc ps-5">
                  {review.preview.items.links.map((link) => (
                    <li key={link.environmentId}>
                      Agent link to {link.label} ({link.environmentId}, {link.machineId})
                    </li>
                  ))}
                  {review.preview.items.sessions.map((session) => (
                    <li key={session.sessionId}>
                      Served session {session.sessionId} ({session.subject})
                    </li>
                  ))}
                  {review.preview.items.codes.map((code) => (
                    <li key={code.id}>
                      Pending code {code.id} ({code.subject})
                    </li>
                  ))}
                </ul>
                {review.routes.length === 0 ? null : (
                  <>
                    <p>
                      These saved connections came from a fleet. They stay saved unless you include
                      them.
                    </p>
                    <ul className="list-disc ps-5">
                      {review.routes.map((route) => (
                        <li key={route.routeId}>
                          {route.label} ({route.address})
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={includeConnections}
                        disabled={busy}
                        onCheckedChange={setIncludeConnections}
                      />
                      Also remove these saved fleet connections
                    </label>
                  </>
                )}
              </div>
            )}
            {receipt === undefined ? null : (
              <div role="status" className="space-y-1 text-sm">
                <p>Fleet reset complete</p>
                <p>
                  {receipt.unlinked} agent links removed, {receipt.revokedSessions} sessions
                  revoked, {receipt.revokedCodes} codes revoked.
                </p>
                <p>
                  Fleet {receipt.fleetId} · {receipt.completedUtc}
                </p>
                <p className="wrap-anywhere">
                  Review digest <code>{receipt.previewDigest}</code>
                </p>
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {receipt === undefined ? "Cancel" : "Done"}
            </Button>
            {review !== undefined ? (
              <Button
                variant="destructive"
                disabled={!allowed || busy || syncing}
                onClick={() => void apply()}
              >
                Confirm reset
              </Button>
            ) : error !== undefined && receipt === undefined ? (
              <Button disabled={!allowed || busy} onClick={() => void preview()}>
                Review again
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function LanFleetSettings() {
  const fleet = useLanFleet();
  const [selection, setSelection] = useState("fleet:all");
  if (fleet.environmentId === null) return null;
  const ready = fleet.summary?.machines.filter((machine) => machine.status === "ready") ?? [];
  const candidates =
    fleet.setup?.owner && fleet.setup.stage === "active"
      ? fleet.setup.peers.filter(
          (peer) => peer.status === "approved" && peer.environmentId !== fleet.setup?.environmentId,
        )
      : ready;
  const selected =
    selection === "fleet:all"
      ? candidates.map((machine) => machine.machineId)
      : candidates
          .filter((machine) => machine.machineId === selection)
          .map((machine) => machine.machineId);
  return (
    <SettingsSection title="LAN machine links">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <LanFleetSetup />
        <p className="text-xs text-muted-foreground">
          {fleet.summary?.enabled
            ? fleet.paused
              ? "Sync keeps failing, so it now checks every 30 minutes. Sync now checks at once."
              : fleet.summary.autoPickup
                ? "Assigned links are checked every 5 minutes while this desktop app is open."
                : "Automatic pickup is off: Sync now collects new links. Renewals of existing links are still collected every 5 minutes while this desktop app is open."
            : fleet.setup?.sharedFolderTrust
              ? "Connect this machine through BuildShare to enable LAN links."
              : "Complete fleet setup to approve this machine before connecting."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={[
              { value: "fleet:all", label: "All ready machines" },
              ...candidates.map((machine) => ({ value: machine.machineId, label: machine.label })),
            ]}
            value={selection}
            onValueChange={(value) => {
              if (value !== null) setSelection(value);
            }}
            disabled={fleet.busy || candidates.length === 0}
          >
            <SelectTrigger aria-label="LAN link recipients">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="fleet:all">All ready machines</SelectItem>
              {candidates.map((machine) => (
                <SelectItem key={machine.machineId} value={machine.machineId}>
                  {machine.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            disabled={!fleet.allowed || fleet.busy || selected.length === 0}
            onClick={() => {
              if (fleet.setup?.owner)
                void fleet
                  .configure({ operation: "link", confirmed: true, machineIds: selected })
                  .then((ok) => {
                    if (ok) void fleet.run("manual");
                  });
              else void fleet.run("manual", selected);
            }}
          >
            {fleet.setup?.owner ? "Link both ways" : "Share this machine"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!fleet.allowed || fleet.busy}
            onClick={() => void fleet.run("manual")}
          >
            {fleet.busy ? "Syncing…" : "Sync now"}
          </Button>
          {fleet.setup?.stage === "active" || fleet.summary?.enabled === true ? (
            <ResetFleetLinks environmentId={fleet.environmentId} syncing={fleet.busy} />
          ) : null}
        </div>
        {fleet.summary?.machines.map((machine) => (
          <div key={machine.machineId} className="flex items-center justify-between gap-3 text-xs">
            <span>{machine.label}</span>
            <span className="text-muted-foreground">
              {fleet.setup?.sharedFolderTrust && machine.status === "untrusted"
                ? "Not connected"
                : fleet.setup?.sharedFolderTrust &&
                    (machine.status === "expired" || machine.status === "uncertain")
                  ? "Connection unavailable"
                  : labels[machine.status]}
            </span>
          </div>
        ))}
        {fleet.error ? (
          <p role="status" className="text-xs text-muted-foreground">
            {fleet.error}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
