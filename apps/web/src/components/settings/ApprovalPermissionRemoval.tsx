import { AuthSessionId, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { authEnvironment } from "~/state/auth";
import { Button } from "../ui/button";

export function ApprovalPermissionRemoval({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const allowed = useAtomValue(
    authEnvironment.removeApprovalPermission.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(authEnvironment.removeApprovalPermission);
  const [pending, setPending] = useState(false);
  const act = async (family: boolean) => {
    setPending(true);
    await remove({ environmentId, input: { sessionId: AuthSessionId.make(sessionId), family } });
    setPending(false);
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={!allowed || pending}
        onClick={() => void act(false)}
      >
        Remove approval permission
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={!allowed || pending}
        onClick={() => void act(true)}
      >
        Remove for this application's sign-ins
      </Button>
    </div>
  );
}
