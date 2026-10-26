import { useAtomValue } from "@effect/atom-react";
import {
  LanFleetError,
  WS_METHODS,
  type LanFleetSyncInput,
  type LanFleetSyncResult,
  type LanFleetSetupInput,
  type LanFleetSetupState,
} from "@t3tools/contracts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { environmentCatalog } from "./catalog";
import { resolveFleetEnvironmentId, resolveNativeWindowsPrimary } from "./lanFleetEnvironment";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { connectPairing } from "./onboarding";
import { connectionAtomRuntime } from "./runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";

const syncFleet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:lan-fleet:sync",
  tag: WS_METHODS.serverSyncLanFleet,
  scheduler: createAtomCommandScheduler(),
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});
const summaryAtom = Atom.make<Omit<LanFleetSyncResult, "incoming"> | null>(null);
const setupAtom = Atom.make<LanFleetSetupState | null>(null);
const fetchSetup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:lan-fleet:setup",
  tag: WS_METHODS.serverGetLanFleetSetup,
});
const configureFleet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:lan-fleet:configure",
  tag: WS_METHODS.serverConfigureLanFleet,
  scheduler: createAtomCommandScheduler(),
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});
const errorAtom = Atom.make<string | null>(null);
const busyAtom = Atom.make(false);
const pausedAtom = Atom.make(false);
const deniedAtom = Atom.make(false);
const isFleetError = Schema.is(LanFleetError);

export function useLanFleet() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  // Only the desktop-managed primary is a local Windows host; web and configured remotes are not.
  let nativePrimary: ReturnType<typeof resolveNativeWindowsPrimary> = null;
  let isWindows = false;
  try {
    isWindows = window.desktopBridge?.getClientPlatform?.() === "win32";
    nativePrimary = resolveNativeWindowsPrimary(
      window.desktopBridge,
      readPrimaryEnvironmentTarget(),
    );
  } catch {
    // An incomplete desktop bootstrap is not evidence that the primary is local.
    isWindows = false;
  }
  const environmentId = resolveFleetEnvironmentId(
    [...catalog.entries.values()].map((entry) => entry.target),
    nativePrimary,
    isWindows,
  );
  const allowed = useAtomValue(
    environmentId === null ? deniedAtom : syncFleet.permissionAtom(environmentId),
  );
  const summary = useAtomValue(summaryAtom);
  const setup = useAtomValue(setupAtom);
  const error = useAtomValue(errorAtom);
  const busy = useAtomValue(busyAtom);
  const paused = useAtomValue(pausedAtom);
  const sync = useAtomCommand(syncFleet, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const inspect = useAtomCommand(fetchSetup, { reportFailure: false });
  const updateSetup = useAtomCommand(configureFleet, { reportFailure: false });
  const refreshSetup = async () => {
    if (environmentId === null || !allowed) return false;
    const result = await inspect({ environmentId, input: {} });
    if (result._tag === "Success") {
      appAtomRegistry.set(setupAtom, result.value);
      return true;
    }
    appAtomRegistry.set(
      errorAtom,
      "Fleet setup could not be read. Check the Hub roster location and shared storage.",
    );
    return false;
  };
  const configure = async (input: LanFleetSetupInput) => {
    if (environmentId === null || !allowed || appAtomRegistry.get(busyAtom)) return false;
    appAtomRegistry.set(busyAtom, true);
    try {
      const result = await updateSetup({ environmentId, input });
      if (result._tag !== "Success") {
        appAtomRegistry.set(
          errorAtom,
          "Fleet setup was not confirmed. Check the verification code and shared storage; existing keys and trust were kept.",
        );
        return false;
      }
      appAtomRegistry.set(setupAtom, result.value);
      appAtomRegistry.set(errorAtom, null);
      appAtomRegistry.set(pausedAtom, false);
      return true;
    } finally {
      appAtomRegistry.set(busyAtom, false);
    }
  };

  const run = async (
    mode: LanFleetSyncInput["mode"],
    sendMachineIds: ReadonlyArray<string> = [],
  ) => {
    if (environmentId === null || !allowed) return false;
    if (appAtomRegistry.get(busyAtom)) return true;
    if (mode === "manual") appAtomRegistry.set(pausedAtom, false);
    appAtomRegistry.set(busyAtom, true);
    appAtomRegistry.set(errorAtom, null);
    try {
      // One server claim at a time, drained immediately so a fleet does not take one poll per peer.
      for (let remaining = 100; remaining > 0; remaining--) {
        const current = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
        if (!current.isReady) return false;
        const result = await sync({
          environmentId,
          input: {
            mode,
            sendMachineIds: remaining === 100 ? sendMachineIds : [],
            connectedEnvironmentIds: [...current.entries.keys()],
          },
        });
        if (result._tag !== "Success") {
          const failure = squashAtomCommandFailure(result);
          appAtomRegistry.set(
            errorAtom,
            isFleetError(failure)
              ? failure.message
              : "LAN link sync failed. Check local trust and shared storage; existing connections were kept.",
          );
          return false;
        }
        const { incoming, ...summary } = result.value;
        appAtomRegistry.set(summaryAtom, summary);
        if (incoming.length === 0) return true;
        for (const delivery of incoming) {
          const connected = await connect({
            host: delivery.host,
            pairingCode: delivery.pairingCode,
            ...(delivery.tls === undefined ? {} : { tls: delivery.tls }),
            expectedEnvironmentId: delivery.environmentId,
            skipExisting: true,
          });
          if (connected._tag !== "Success") {
            appAtomRegistry.set(
              errorAtom,
              "Pickup is unconfirmed. This delivery is paused for review; sync will not replace or retry its credential.",
            );
            return false;
          }
        }
      }
      return true;
    } finally {
      appAtomRegistry.set(busyAtom, false);
    }
  };
  const pause = () => {
    appAtomRegistry.set(pausedAtom, true);
    appAtomRegistry.set(
      errorAtom,
      "Automatic pickup paused after three failed syncs. Use Sync now to check again.",
    );
  };
  return {
    environmentId,
    allowed,
    summary,
    setup,
    error,
    busy,
    paused,
    pause,
    run,
    refreshSetup,
    configure,
  };
}
