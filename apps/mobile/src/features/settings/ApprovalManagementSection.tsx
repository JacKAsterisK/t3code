import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationApproveScope,
  AuthSessionId,
  ThreadId,
  type ApprovalAdministrationMutation,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

function Choice({
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
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
      <Button
        tone="secondary"
        label={options.find((o) => o.value === value)?.label ?? "Select an exact identity"}
        disabled={disabled}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View className="gap-2">
          <Button
            tone="secondary"
            label="Clear selection"
            disabled={disabled}
            onPress={() => {
              onChange("");
              setOpen(false);
            }}
          />
          {options.map((option) => (
            <Button
              key={option.value}
              tone="secondary"
              label={option.label}
              disabled={disabled}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      className="p-2"
    >
      <Text className="text-sm text-foreground">
        {checked ? "☑" : "☐"} {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}
export function ApprovalManagementSection({
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
  const [previousSessionId, setPreviousSessionId] = useState("");
  const [nextSessionId, setNextSessionId] = useState("");
  const [fleetGrants, setFleetGrants] = useState<ReadonlyArray<string>>([]);
  const data = query.error ? null : query.data;
  const link = data?.links.find((l) => l.linkIdentityId === linkId && !l.revoked);
  const previousBinding = data?.bindings.find(
    (b) => b.sessionId === renewSessionId && b.linkIdentityId === linkId && b.active && !b.revoked,
  );
  const previousClient = data?.clients.find(
    (c) => c.sessionId === previousSessionId && c.kind === "local",
  );
  const newClient = data?.clients.find((c) => c.sessionId === nextSessionId && c.kind === "local");
  const peerCandidates =
    data?.clients.filter(
      (c) => c.kind === "peer" && !data.bindings.some((b) => b.sessionId === c.sessionId),
    ) ?? [];
  const peer = peerCandidates.find((c) => c.sessionId === sessionId);
  const busy = !allowed || pending || query.isPending || data === null;
  const act = async (input: ApprovalAdministrationMutation) => {
    if (busy || inFlight.current) return;
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
    } else
      setMessage(
        result.value.distributed === false
          ? "Policy saved here. Distribution is pending."
          : "Approval access updated.",
      );
  };
  const confirm = (title: string, detail: string, input: ApprovalAdministrationMutation) =>
    Dialog.alert(title, detail, [
      { text: "Cancel", style: "cancel" },
      { text: "Continue", style: "destructive", onPress: () => void act(input) },
    ]);
  return (
    <SettingsSection
      title="Linked approval access"
      footer="Read and Full access do not include approvals. Matching names never establish identity."
    >
      <View className="gap-4 p-4">
        <Button
          tone="secondary"
          label="Refresh approval access"
          disabled={pending || query.isPending}
          onPress={query.refresh}
        />
        {query.error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {query.error}
          </Text>
        ) : data === null ? (
          <Text className="text-sm text-foreground-muted">Loading approval access...</Text>
        ) : (
          <>
            <Text className="text-sm text-foreground-muted">
              Pair using an approval-capable code, then explicitly bind that new sign-in here. The
              old credential never gains approval permission.
            </Text>
            {data.links.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No incoming approval links.</Text>
            ) : (
              data.links.map((l) => (
                <View key={l.linkIdentityId} className="gap-1">
                  <Text selectable className="text-sm text-foreground">
                    {l.sourceEnvironmentId} · {l.linkIdentityId}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {l.revoked
                      ? "Revoked"
                      : l.effectiveEnabled
                        ? "Policy enabled"
                        : "Policy disabled"}{" "}
                    · link revision {l.revision} · policy revision {l.policyRevision}
                    {l.fleet
                      ? ` · Fleet ${l.fleet.callerMachineId}: ${l.fleet.valid ? (l.fleet.enabled ? "enabled" : "disabled") : "trust unavailable"}`
                      : " · Manual link"}
                  </Text>
                  {l.replacedByLinkIdentityId ? (
                    <Text selectable className="text-xs text-foreground-muted">
                      Replaced by {l.replacedByLinkIdentityId}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
            <Field
              label="Source environment ID"
              value={sourceEnvironmentId}
              onChange={setSourceEnvironmentId}
              disabled={busy}
            />
            <Button
              tone="secondary"
              label="Create approval link identity"
              disabled={busy || !sourceEnvironmentId.trim()}
              onPress={() =>
                void act({ type: "createLink", sourceEnvironmentId: sourceEnvironmentId.trim() })
              }
            />
            <Choice
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
              <View className="gap-2">
                <Button
                  tone="secondary"
                  label={link.policyEnabled ? "Disable approval policy" : "Enable approval policy"}
                  disabled={
                    busy ||
                    (!link.policyEnabled &&
                      link.fleet !== null &&
                      (!link.fleet.valid || !link.fleet.enabled))
                  }
                  onPress={() =>
                    void act({
                      type: "setLinkPolicy",
                      linkIdentityId: link.linkIdentityId,
                      expectedRevision: link.policyRevision,
                      enabled: !link.policyEnabled,
                    })
                  }
                />
                <Button
                  tone="danger"
                  label="Replace link identity"
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      "Replace approval link?",
                      `${link.linkIdentityId}: Existing delegations end. The new identity starts without approvals.`,
                      {
                        type: "replaceLink",
                        linkIdentityId: link.linkIdentityId,
                        expectedRevision: link.revision,
                      },
                    )
                  }
                />
                <Button
                  tone="danger"
                  label="Revoke approval link"
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      "Revoke approval link?",
                      `${link.linkIdentityId}: Its thread delegations end.`,
                      {
                        type: "revokeLink",
                        linkIdentityId: link.linkIdentityId,
                        expectedRevision: link.revision,
                      },
                    )
                  }
                />
              </View>
            ) : null}
            <Text className="font-t3-medium text-base text-foreground">
              Peer sign-ins and renewal
            </Text>
            {data.clients
              .filter((c) => c.kind === "peer")
              .map((c) => (
                <Text key={c.sessionId} selectable className="text-xs text-foreground-muted">
                  {c.label} · {c.sessionId} · {c.runtimeModeCeiling} · authorization revision{" "}
                  {c.revision}
                  {"\n"}Granted: {c.scopes.join(", ")}
                  {"\n"}Effective: {c.effectiveScopes.join(", ") || "None"}
                </Text>
              ))}
            {data.bindings.map((b) => (
              <View key={b.sessionId} className="gap-1">
                <Text selectable className="text-xs text-foreground-muted">
                  {b.sessionId} → {b.linkIdentityId} ·{" "}
                  {b.revoked
                    ? "Revoked"
                    : !b.active
                      ? "Expired or unavailable"
                      : b.effectiveEnabled
                        ? "Approval enabled"
                        : "Approval disabled"}{" "}
                  · {b.interactionModeCeiling} · binding revision {b.revision} · effective revision{" "}
                  {b.effectiveRevision}
                </Text>
                {!b.revoked ? (
                  <Button
                    tone="danger"
                    label="Revoke this binding"
                    disabled={busy}
                    onPress={() =>
                      void act({
                        type: "revokePeer",
                        sessionId: b.sessionId,
                        expectedRevision: b.revision,
                      })
                    }
                  />
                ) : null}
              </View>
            ))}
            <Choice
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
            <Choice
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
            <Toggle
              label="Allow this exact sign-in to answer permission requests through the selected link"
              checked={approvalConsent}
              onChange={setApprovalConsent}
              disabled={busy || !peer?.scopes.includes(AuthOrchestrationApproveScope)}
            />
            <Toggle
              label="Limit interaction to Plan mode"
              checked={planOnly}
              onChange={setPlanOnly}
              disabled={busy}
            />
            <Button
              tone="secondary"
              label={
                previousBinding ? "Renew binding; invalidate old sign-in" : "Bind selected sign-in"
              }
              disabled={
                busy ||
                !link ||
                !peer ||
                !approvalConsent ||
                (renewSessionId !== "" && !previousBinding)
              }
              onPress={() => {
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
            />
            <Text className="font-t3-medium text-base text-foreground">Thread delegation</Text>
            <Text className="text-sm text-foreground-muted">
              Choose the destination thread and exact source client. Existing threads need explicit
              delegation. Original history remains unchanged.
            </Text>
            <Choice
              label="Recent destination thread"
              value={threadId}
              onChange={setThreadId}
              disabled={busy}
              options={data.threads.map((t) => ({
                value: t.threadId,
                label: `${t.title} · ${t.threadId}`,
              }))}
            />
            <Field
              label="Exact destination thread ID"
              value={threadId}
              onChange={setThreadId}
              disabled={busy}
            />
            <Choice
              label="Previously observed source client on this link"
              value={clientId}
              onChange={setClientId}
              disabled={busy || !link}
              options={data.sourceClients
                .filter((c) => c.linkIdentityId === linkId)
                .map((c) => ({ value: c.initiatingClientId, label: c.initiatingClientId }))}
            />
            <Field
              label="Exact source client ID from that environment's agent sign-in"
              value={clientId}
              onChange={setClientId}
              disabled={busy}
            />
            <Button
              tone="secondary"
              label="Delegate this thread to this link and client"
              disabled={busy || !link?.effectiveEnabled || !threadId.trim() || !clientId.trim()}
              onPress={() => {
                if (link)
                  void act({
                    type: "grantDelegation",
                    threadId: ThreadId.make(threadId.trim()),
                    linkIdentityId: link.linkIdentityId,
                    initiatingClientId: clientId.trim(),
                    expectedPolicyRevision: link.policyRevision,
                  });
              }}
            />
            {data.delegations.map((d) => (
              <View key={d.delegationId} className="gap-1">
                <Text selectable className="text-xs text-foreground-muted">
                  {d.threadId} · {d.linkIdentityId} · {d.initiatingClientId}
                  {"\n"}
                  {d.revoked
                    ? "Revoked"
                    : d.effectiveEnabled
                      ? "Active delegation"
                      : "Inactive; current policy required"}{" "}
                  · policy revision {d.policyRevision}
                </Text>
                {!d.revoked ? (
                  <Button
                    tone="danger"
                    label="Revoke delegation"
                    disabled={busy}
                    onPress={() =>
                      void act({ type: "revokeDelegation", delegationId: d.delegationId })
                    }
                  />
                ) : null}
              </View>
            ))}
            <Text className="font-t3-medium text-base text-foreground">
              Continue a source client identity
            </Text>
            <Text className="text-sm text-foreground-muted">
              Fresh sign-ins have fresh IDs. Select both exact sign-ins to retain the old client ID
              and invalidate the old sign-in. Matching names are insufficient.
            </Text>
            {data.clients
              .filter((c) => c.kind === "local")
              .map((c) => (
                <Text key={c.sessionId} selectable className="text-xs text-foreground-muted">
                  {c.label} · {c.sessionId} · client {c.initiatingClientId} · revision {c.revision}{" "}
                  · {c.enabled ? "approval opted in" : "approval disabled"}
                </Text>
              ))}
            <Choice
              label="Previous source sign-in"
              value={previousSessionId}
              onChange={setPreviousSessionId}
              disabled={busy}
              options={data.clients
                .filter((c) => c.kind === "local")
                .map((c) => ({
                  value: c.sessionId,
                  label: `${c.label} · ${c.sessionId} · ${c.initiatingClientId}`,
                }))}
            />
            <Choice
              label="New source sign-in"
              value={nextSessionId}
              onChange={setNextSessionId}
              disabled={busy}
              options={data.clients
                .filter((c) => c.kind === "local" && c.sessionId !== previousSessionId)
                .map((c) => ({
                  value: c.sessionId,
                  label: `${c.label} · ${c.sessionId} · ${c.initiatingClientId}`,
                }))}
            />
            <Button
              tone="secondary"
              label="Continue selected client identity"
              disabled={busy || !previousClient || !newClient}
              onPress={() => {
                if (previousClient && newClient)
                  confirm(
                    "Continue client identity?",
                    `${previousClient.initiatingClientId}: ${previousClient.sessionId} → ${newClient.sessionId}. The previous sign-in stops working.`,
                    {
                      type: "continueClient",
                      sessionId: AuthSessionId.make(newClient.sessionId),
                      previousSessionId: previousClient.sessionId,
                      expectedRevision: previousClient.revision,
                    },
                  );
              }}
            />
            <Text className="font-t3-medium text-base text-foreground">Fleet approval policy</Text>
            <Text className="text-sm text-foreground-muted">
              {data.fleet.available
                ? `${data.fleet.destinationMachineId} · revision ${data.fleet.revision} · ${data.fleet.valid ? "Current trusted policy" : "No valid current policy"}`
                : "Current fleet trust is unavailable. Fleet approval grants are blocked."}
            </Text>
            {data.fleet.peers.map((p) => (
              <View key={p.callerMachineId} className="gap-1">
                <Toggle
                  label={`${p.callerMachineId} · ${p.environmentId} · currently ${p.enabled ? "enabled" : "disabled"}`}
                  checked={fleetGrants.includes(p.callerMachineId)}
                  disabled={busy || !data.fleet.available}
                  onChange={(checked) =>
                    setFleetGrants((values) =>
                      checked
                        ? [...values.filter((v) => v !== p.callerMachineId), p.callerMachineId]
                        : values.filter((v) => v !== p.callerMachineId),
                    )
                  }
                />
                {link && link.fleet === null && link.sourceEnvironmentId === p.environmentId ? (
                  <Button
                    tone="secondary"
                    label={`Use fleet policy for ${link.linkIdentityId}`}
                    disabled={busy || !data.fleet.available}
                    onPress={() =>
                      void act({
                        type: "bindFleetLink",
                        linkIdentityId: link.linkIdentityId,
                        callerMachineId: p.callerMachineId,
                      })
                    }
                  />
                ) : null}
              </View>
            ))}
            <Text className="text-sm text-foreground-muted">
              Publishing replaces this destination's policy. Only checked machines will be enabled.
            </Text>
            <Button
              tone="secondary"
              label="Publish selected fleet approval policy"
              disabled={busy || !data.fleet.available}
              onPress={() =>
                void act({
                  type: "publishFleetPolicy",
                  expectedRevision: data.fleet.revision,
                  grants: data.fleet.peers.map((p) => ({
                    callerMachineId: p.callerMachineId,
                    enabled: fleetGrants.includes(p.callerMachineId),
                  })),
                })
              }
            />
          </>
        )}
        {message ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground">
            {message}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
