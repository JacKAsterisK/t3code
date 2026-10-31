import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationApproveScope,
  AuthSessionId,
  ThreadId,
  type ApprovalAdministrationMutation,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

function IdentitySelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly disabled: boolean;
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span>{label}</span>
      <select
        aria-label={label}
        className="w-full min-w-0 rounded-md border border-input bg-background p-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">Select an exact identity</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ApprovalManagementSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const allowed = useAtomValue(authEnvironment.administration.mutate.permissionAtom(environmentId));
  return allowed ? <ApprovalManagement environmentId={environmentId} /> : null;
}

function ApprovalManagement({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    authEnvironment.administration.inspect({ environmentId, input: {} }),
  );
  const allowed = useAtomValue(authEnvironment.administration.mutate.permissionAtom(environmentId));
  const mutate = useAtomCommand(authEnvironment.administration.mutate);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [linkId, setLinkId] = useState("");
  const [sourceEnvironmentId, setSourceEnvironmentId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [renewSessionId, setRenewSessionId] = useState("");
  const [approvalConsent, setApprovalConsent] = useState(false);
  const [planOnly, setPlanOnly] = useState(false);
  const [threadId, setThreadId] = useState("");
  const [clientId, setClientId] = useState("");
  const [previousClientSession, setPreviousClientSession] = useState("");
  const [nextClientSession, setNextClientSession] = useState("");
  const [fleetGrants, setFleetGrants] = useState<ReadonlyArray<string>>([]);
  const data = query.error ? null : query.data;
  const link = data?.links.find((l) => l.linkIdentityId === linkId && !l.revoked);
  const previousBinding = data?.bindings.find(
    (b) => b.sessionId === renewSessionId && b.linkIdentityId === linkId && b.active && !b.revoked,
  );
  const previousClient = data?.clients.find(
    (c) => c.sessionId === previousClientSession && c.kind === "local",
  );
  const newClient = data?.clients.find(
    (c) => c.sessionId === nextClientSession && c.kind === "local",
  );
  const peerCandidates =
    data?.clients.filter(
      (c) => c.kind === "peer" && !data.bindings.some((b) => b.sessionId === c.sessionId),
    ) ?? [];
  const peer = peerCandidates.find((c) => c.sessionId === sessionId);
  const busy = !allowed || pending || query.isPending || data === null;
  const act = async (input: ApprovalAdministrationMutation, confirm?: string) => {
    if (busy || inFlight.current) return;
    if (confirm && !(await requestConfirmDialog(confirm, { variant: "destructive" }))) return;
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    const result = await mutate({ environmentId, input });
    inFlight.current = false;
    setPending(false);
    setApprovalConsent(false);
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      setMessage(error instanceof Error ? error.message : "Approval access could not be changed.");
    } else {
      setMessage(
        result.value.distributed === false
          ? "Policy saved here. Distribution is pending; refresh to check current access."
          : "Approval access updated.",
      );
    }
  };
  return (
    <section className="space-y-4 border-t border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Linked approval access</h3>
        <Button
          size="xs"
          variant="outline"
          onClick={query.refresh}
          disabled={pending || query.isPending}
        >
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Read and Full access do not include approvals. Pair with an approval-capable code first,
        then explicitly bind the new sign-in here. Names never establish identity.
      </p>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error}
        </p>
      ) : data === null ? (
        <p role="status" className="text-xs">
          Loading approval access...
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {data.links.length === 0 ? (
              <p className="text-xs text-muted-foreground">No incoming approval links.</p>
            ) : (
              data.links.map((entry) => (
                <div key={entry.linkIdentityId} className="break-all text-xs">
                  <p>
                    {entry.sourceEnvironmentId} · {entry.linkIdentityId}
                  </p>
                  <p className="text-muted-foreground">
                    {entry.revoked
                      ? "Revoked"
                      : entry.effectiveEnabled
                        ? "Policy enabled"
                        : "Policy disabled"}{" "}
                    · link revision {entry.revision} · policy revision {entry.policyRevision}
                    {entry.fleet
                      ? ` · Fleet ${entry.fleet.callerMachineId}: ${entry.fleet.valid ? (entry.fleet.enabled ? "enabled" : "disabled") : "trust unavailable"}`
                      : " · Manual link"}
                  </p>
                  {entry.replacedByLinkIdentityId ? (
                    <p>Replaced by {entry.replacedByLinkIdentityId}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-xs">
              <span>Source environment ID</span>
              <Input
                value={sourceEnvironmentId}
                onChange={(event) => setSourceEnvironmentId(event.target.value)}
                disabled={busy}
              />
            </label>
            <div className="self-end">
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !sourceEnvironmentId.trim()}
                onClick={() =>
                  void act({ type: "createLink", sourceEnvironmentId: sourceEnvironmentId.trim() })
                }
              >
                Create approval link identity
              </Button>
            </div>
          </div>
          <IdentitySelect
            label="Incoming approval link"
            value={linkId}
            onChange={(value) => {
              setLinkId(value);
              setRenewSessionId("");
              setApprovalConsent(false);
            }}
            disabled={busy}
            options={data.links
              .filter((l) => !l.revoked)
              .map((l) => ({
                value: l.linkIdentityId,
                label: `${l.sourceEnvironmentId} · ${l.linkIdentityId}`,
              }))}
          />
          {link ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={
                  busy ||
                  (!link.policyEnabled &&
                    link.fleet !== null &&
                    (!link.fleet.valid || !link.fleet.enabled))
                }
                onClick={() =>
                  void act({
                    type: "setLinkPolicy",
                    linkIdentityId: link.linkIdentityId,
                    expectedRevision: link.policyRevision,
                    enabled: !link.policyEnabled,
                  })
                }
              >
                {link.policyEnabled ? "Disable approval policy" : "Enable approval policy"}
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() =>
                  void act(
                    {
                      type: "replaceLink",
                      linkIdentityId: link.linkIdentityId,
                      expectedRevision: link.revision,
                    },
                    `Replace ${link.linkIdentityId}? Existing thread delegations end. The replacement starts without approval permission.`,
                  )
                }
              >
                Replace link identity
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() =>
                  void act(
                    {
                      type: "revokeLink",
                      linkIdentityId: link.linkIdentityId,
                      expectedRevision: link.revision,
                    },
                    `Revoke approval link ${link.linkIdentityId} and its thread delegations?`,
                  )
                }
              >
                Revoke link
              </Button>
            </div>
          ) : null}
          <div className="space-y-2">
            <h4 className="text-xs font-medium">Peer sign-ins and renewal</h4>
            {data.clients
              .filter((c) => c.kind === "peer")
              .map((c) => (
                <p key={c.sessionId} className="break-all text-xs text-muted-foreground">
                  {c.label} · {c.sessionId} · {c.runtimeModeCeiling} · authorization revision{" "}
                  {c.revision}
                  <br />
                  Granted: {c.scopes.join(", ")}
                  <br />
                  Effective: {c.effectiveScopes.join(", ") || "None"}
                </p>
              ))}
            {data.bindings.map((binding) => (
              <div key={binding.sessionId} className="space-y-1 break-all text-xs">
                <p>
                  {binding.sessionId} → {binding.linkIdentityId} ·{" "}
                  {binding.revoked
                    ? "Revoked"
                    : !binding.active
                      ? "Expired or unavailable"
                      : binding.effectiveEnabled
                        ? "Approval enabled"
                        : "Approval disabled"}{" "}
                  · {binding.interactionModeCeiling} · binding revision {binding.revision} ·
                  effective revision {binding.effectiveRevision}
                </p>
                {!binding.revoked ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() =>
                      void act({
                        type: "revokePeer",
                        sessionId: binding.sessionId,
                        expectedRevision: binding.revision,
                      })
                    }
                  >
                    Revoke this binding
                  </Button>
                ) : null}
              </div>
            ))}
            <IdentitySelect
              label="New peer sign-in"
              value={sessionId}
              onChange={(value) => {
                setSessionId(value);
                setApprovalConsent(false);
              }}
              disabled={busy}
              options={peerCandidates.map((c) => ({
                value: c.sessionId,
                label: `${c.label} · ${c.sessionId} · ${c.scopes.includes(AuthOrchestrationApproveScope) ? "approval-capable" : "no approval scope"}`,
              }))}
            />
            <IdentitySelect
              label="Previous binding to explicitly renew (optional)"
              value={renewSessionId}
              onChange={setRenewSessionId}
              disabled={busy || !link}
              options={data.bindings
                .filter((b) => b.linkIdentityId === linkId && b.active && !b.revoked)
                .map((b) => ({
                  value: b.sessionId,
                  label: `${b.sessionId} · revision ${b.revision}`,
                }))}
            />
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={approvalConsent}
                disabled={busy || !peer?.scopes.includes(AuthOrchestrationApproveScope)}
                onCheckedChange={(checked) => setApprovalConsent(checked === true)}
              />
              <span>
                Allow this exact new sign-in to answer permission requests through the selected
                link.
              </span>
            </label>
            <label className="flex gap-2 text-xs">
              <Checkbox
                checked={planOnly}
                disabled={busy}
                onCheckedChange={(checked) => setPlanOnly(checked === true)}
              />
              Limit interaction to Plan mode
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={
                busy ||
                !link ||
                !peer ||
                !approvalConsent ||
                (renewSessionId !== "" && !previousBinding)
              }
              onClick={() => {
                if (link && peer)
                  void act({
                    type: "bindPeer",
                    sessionId: peer.sessionId,
                    linkIdentityId: link.linkIdentityId,
                    approvals: approvalConsent,
                    interactionModeCeiling: planOnly ? "plan" : "default",
                    ...(previousBinding
                      ? {
                          renew: {
                            sessionId: previousBinding.sessionId,
                            revision: previousBinding.revision,
                          },
                        }
                      : {}),
                  });
              }}
            >
              {previousBinding
                ? "Renew selected binding; invalidate old sign-in"
                : "Bind selected sign-in"}
            </Button>
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-medium">Thread delegation</h4>
            <p className="text-xs text-muted-foreground">
              Choose the exact destination thread and source client. Existing threads need an
              explicit delegation. Original creation history remains unchanged.
            </p>
            <IdentitySelect
              label="Recent destination thread"
              value={threadId}
              onChange={setThreadId}
              disabled={busy}
              options={data.threads.map((t) => ({
                value: t.threadId,
                label: `${t.title} · ${t.threadId}`,
              }))}
            />
            <label className="grid gap-1 text-xs">
              <span>Exact destination thread ID</span>
              <Input
                value={threadId}
                onChange={(event) => setThreadId(event.target.value)}
                disabled={busy}
              />
            </label>
            <IdentitySelect
              label="Previously observed source client on this link"
              value={clientId}
              onChange={setClientId}
              disabled={busy || !link}
              options={data.sourceClients
                .filter((c) => c.linkIdentityId === linkId)
                .map((c) => ({ value: c.initiatingClientId, label: c.initiatingClientId }))}
            />
            <label className="grid gap-1 text-xs">
              <span>Exact source client ID (from that environment's agent sign-in)</span>
              <Input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                disabled={busy}
              />
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !link?.effectiveEnabled || !threadId.trim() || !clientId.trim()}
              onClick={() => {
                if (link)
                  void act({
                    type: "grantDelegation",
                    threadId: ThreadId.make(threadId.trim()),
                    linkIdentityId: link.linkIdentityId,
                    initiatingClientId: clientId.trim(),
                    expectedPolicyRevision: link.policyRevision,
                  });
              }}
            >
              Delegate this thread to this link and client
            </Button>
            {data.delegations.map((d) => (
              <div key={d.delegationId} className="space-y-1 break-all text-xs">
                <p>
                  {d.threadId} · {d.linkIdentityId} · {d.initiatingClientId}
                  <br />
                  {d.revoked
                    ? "Revoked"
                    : d.effectiveEnabled
                      ? "Active delegation"
                      : "Inactive; current policy required"}{" "}
                  · policy revision {d.policyRevision}
                </p>
                {!d.revoked ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() =>
                      void act({ type: "revokeDelegation", delegationId: d.delegationId })
                    }
                  >
                    Revoke delegation
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-medium">Continue a source client identity</h4>
            <p className="text-xs text-muted-foreground">
              Fresh sign-ins have fresh IDs. Select both exact sign-ins to retain the original
              client ID and invalidate the previous sign-in. Matching names are insufficient.
            </p>
            {data.clients
              .filter((c) => c.kind === "local")
              .map((c) => (
                <p key={c.sessionId} className="break-all text-xs text-muted-foreground">
                  {c.label} · {c.sessionId} · client {c.initiatingClientId} · revision {c.revision}{" "}
                  · {c.enabled ? "approval opted in" : "approval disabled"}
                </p>
              ))}
            <IdentitySelect
              label="Previous source sign-in"
              value={previousClientSession}
              onChange={setPreviousClientSession}
              disabled={busy}
              options={data.clients
                .filter((c) => c.kind === "local")
                .map((c) => ({
                  value: c.sessionId,
                  label: `${c.label} · ${c.sessionId} · ${c.initiatingClientId}`,
                }))}
            />
            <IdentitySelect
              label="New source sign-in"
              value={nextClientSession}
              onChange={setNextClientSession}
              disabled={busy}
              options={data.clients
                .filter((c) => c.kind === "local" && c.sessionId !== previousClientSession)
                .map((c) => ({
                  value: c.sessionId,
                  label: `${c.label} · ${c.sessionId} · ${c.initiatingClientId}`,
                }))}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !previousClient || !newClient}
              onClick={() => {
                if (previousClient && newClient)
                  void act(
                    {
                      type: "continueClient",
                      sessionId: AuthSessionId.make(newClient.sessionId),
                      previousSessionId: previousClient.sessionId,
                      expectedRevision: previousClient.revision,
                    },
                    `Continue client ${previousClient.initiatingClientId} from ${previousClient.sessionId} to ${newClient.sessionId}? The previous sign-in stops working.`,
                  );
              }}
            >
              Continue selected client identity
            </Button>
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-medium">Fleet approval policy</h4>
            <p className="text-xs text-muted-foreground">
              {data.fleet.available
                ? `${data.fleet.destinationMachineId} · revision ${data.fleet.revision} · ${data.fleet.valid ? "Current trusted policy" : "No valid current policy"}`
                : "Current fleet trust is unavailable. Fleet approval grants are blocked."}
            </p>
            {data.fleet.peers.map((p) => (
              <div key={p.callerMachineId} className="space-y-1 text-xs">
                <label className="flex gap-2">
                  <Checkbox
                    checked={fleetGrants.includes(p.callerMachineId)}
                    disabled={busy || !data.fleet.available}
                    onCheckedChange={(checked) =>
                      setFleetGrants((values) =>
                        checked === true
                          ? [...values.filter((v) => v !== p.callerMachineId), p.callerMachineId]
                          : values.filter((v) => v !== p.callerMachineId),
                      )
                    }
                  />
                  {p.callerMachineId} · {p.environmentId} · currently{" "}
                  {p.enabled ? "enabled" : "disabled"}
                </label>
                {link && link.fleet === null && link.sourceEnvironmentId === p.environmentId ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || !data.fleet.available}
                    onClick={() =>
                      void act({
                        type: "bindFleetLink",
                        linkIdentityId: link.linkIdentityId,
                        callerMachineId: p.callerMachineId,
                      })
                    }
                  >
                    Use fleet policy for {link.linkIdentityId}
                  </Button>
                ) : null}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Publishing replaces this destination's fleet approval policy. Only checked machines
              will be enabled.
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !data.fleet.available}
              onClick={() =>
                void act({
                  type: "publishFleetPolicy",
                  expectedRevision: data.fleet.revision,
                  grants: data.fleet.peers.map((p) => ({
                    callerMachineId: p.callerMachineId,
                    enabled: fleetGrants.includes(p.callerMachineId),
                  })),
                })
              }
            >
              Publish selected fleet approval policy
            </Button>
          </div>
        </>
      )}
      {message ? (
        <p role="status" className="text-xs">
          {message}
        </p>
      ) : null}
    </section>
  );
}
