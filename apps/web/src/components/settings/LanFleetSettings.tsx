import { useEffect, useEffectEvent, useState } from "react";
import { useLanFleet } from "../../connection/lanFleet";
import { startFleetPolling } from "../../connection/lanFleetPolling";
import { Button } from "../ui/button";
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
  const enabled =
    !fleet.paused &&
    ((fleet.summary?.enabled === true && fleet.summary.autoPickup) ||
      (fleet.setup !== null &&
        fleet.setup.autoPickup &&
        (fleet.setup.stage === "pending" || fleet.setup.stage === "active")));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the fleet pickup polling timer while automatic pickup is enabled
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
              ? "Automatic pickup is paused. Sync now to check again."
              : fleet.summary.autoPickup
                ? "Assigned links are checked every 5 minutes while this desktop app is open."
                : "Automatic pickup is off. Sync now to collect assigned links."
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
