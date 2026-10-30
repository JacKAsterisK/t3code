import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { FleetUsersDirectory, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, primaryServerConfigAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveSelfOwnerId } from "../taskOwners";
import { useClientSettings } from "./useSettings";

/** The primary machine's fleet users, else any connected machine's: every machine shares them. */
const fleetUsersDirectoryAtom = Atom.make((get): FleetUsersDirectory | null => {
  const primary = get(primaryServerConfigAtom)?.fleetUsers;
  if (primary) return primary;
  for (const config of get(environmentServerConfigsAtom).values()) {
    if (config.fleetUsers) return config.fleetUsers;
  }
  return null;
}).pipe(Atom.withLabel("web-fleet-users-directory"));

export function useFleetUsersDirectory(): FleetUsersDirectory | null {
  return useAtomValue(fleetUsersDirectoryAtom);
}

export function readFleetUsersDirectory(): FleetUsersDirectory | null {
  return appAtomRegistry.get(fleetUsersDirectoryAtom);
}

/** Who this device is: its own choice, else the primary machine's default owner. */
export function useSelfOwnerId(): string | null {
  const directory = useFleetUsersDirectory();
  const taskOwnerSelf = useClientSettings((settings) => settings.taskOwnerSelf);
  return resolveSelfOwnerId(taskOwnerSelf, directory);
}

/**
 * Not operate-gated: an owner is a label, and the server lets read-only sessions set it, so
 * read-only machines can still hand their threads around.
 */
export function useSetThreadOwner() {
  const setOwner = useAtomCommand(threadEnvironment.setOwner, { reportFailure: false });
  return async (threadRef: ScopedThreadRef, ownerId: string) => {
    const result = await setOwner({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ownerId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to assign thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
}
