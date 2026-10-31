import { ApprovalManagementSection } from "./ApprovalManagementSection";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessReadScope,
  AuthOrchestrationApproveScope,
  type AuthClientSession,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function ApprovalPermissionsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  return (
    <>
      <ApprovalManagementSection environmentId={environmentId} />
      {canRead ? <ApprovalClients environmentId={environmentId} /> : null}
    </>
  );
}

function ApprovalClients({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(authEnvironment.accessChanges({ environmentId, input: null }));
  const snapshot = AsyncResult.getOrElse(result, () => null);
  const sessions =
    snapshot?.type === "snapshot"
      ? snapshot.payload.clientSessions.filter((session) =>
          (session.permissions ?? session.scopes).includes(AuthOrchestrationApproveScope),
        )
      : [];
  return (
    <SettingsSection
      title="Agent approval permission"
      footer="Outside-agent sign-in asks separately whether the agent may answer permission requests. Full access does not include it."
    >
      {AsyncResult.isFailure(result) ? (
        <Text className="p-4 text-sm text-danger-foreground">
          Approval permissions could not be loaded.
        </Text>
      ) : snapshot === null ? (
        <Text className="p-4 text-sm text-foreground-muted">Loading approval permissions...</Text>
      ) : sessions.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          No agent sign-ins have approval permission.
        </Text>
      ) : (
        sessions.map((session) => (
          <ApprovalClient key={session.sessionId} session={session} environmentId={environmentId} />
        ))
      )}
    </SettingsSection>
  );
}

function ApprovalClient({
  session,
  environmentId,
}: {
  readonly session: AuthClientSession;
  readonly environmentId: EnvironmentId;
}) {
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- AuthClientSession.client is display metadata; removal uses the guarded authEnvironment command.
  const clientLabel = session.client.label ?? "Agent sign-in";
  const allowed = useAtomValue(
    authEnvironment.removeApprovalPermission.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(authEnvironment.removeApprovalPermission);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (family: boolean) => {
    if (pending || !allowed) return;
    setPending(true);
    setError(null);
    const result = await remove({ environmentId, input: { sessionId: session.sessionId, family } });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "Approval permission could not be removed.",
      );
    }
  };
  return (
    <View className="gap-2 p-4">
      <Text className="font-t3-medium text-base text-foreground">{clientLabel}</Text>
      <Text className="text-sm text-foreground-muted">
        Each accepted request still needs consent for its full permission and duration.
      </Text>
      <Button
        label="Remove approval permission"
        tone="danger"
        disabled={!allowed || pending}
        onPress={() => void act(false)}
      />
      <Button
        label="Remove for this application's sign-ins"
        tone="secondary"
        disabled={!allowed || pending}
        onPress={() => void act(true)}
      />
      {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
    </View>
  );
}
