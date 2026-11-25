// oxlint-disable t3code/no-untranslated-copy -- T3 Code LAN fleet messages ship English-only alongside fleet setup.
import { useAtomValue } from "@effect/atom-react";
import {
  ConnectionBlockedError,
  connectionRouteId,
  connectionRoutes,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { fleetPairingFailureDetail } from "./lanFleetPairingError";
import * as Option from "effect/Option";
import {
  LanFleetError,
  WS_METHODS,
  type EnvironmentId,
  type LanFleetResetInput,
  type LanFleetResetPreview,
  type LanFleetResetReceipt,
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
import { msg } from "gt-react";
import { m } from "../i18n/messages";
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
const isConnectionBlockedError = Schema.is(ConnectionBlockedError);

const resetFleet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:lan-fleet:reset",
  tag: WS_METHODS.serverResetLanFleetLinks,
  scheduler: createAtomCommandScheduler(),
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

function savedFleetConnections(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  fleetId: string,
) {
  return [...entries].flatMap(([environmentId, entry]) =>
    connectionRoutes(entry).flatMap((route) => {
      const profile = Option.getOrUndefined(route.profile);
      if (
        profile?._tag !== "BearerConnectionProfile" ||
        profile.learned === true ||
        profile.fleetTls === undefined
      )
        return [];
      const expectedFleet =
        profile.fleetId === fleetId
          ? { fleetId, fleetTls: profile.fleetTls }
          : profile.fleetId === undefined
            ? { fleetTls: profile.fleetTls }
            : undefined;
      return expectedFleet === undefined
        ? []
        : [
            {
              environmentId,
              routeId: connectionRouteId(route.target),
              expectedFleet: {
                ...expectedFleet,
                ...(profile.fleetReplacementDeliveryId === undefined
                  ? {}
                  : { fleetReplacementDeliveryId: profile.fleetReplacementDeliveryId }),
              },
              label: route.target.label,
              address: profile.httpBaseUrl,
            },
          ];
    }),
  );
}

export function useLanFleetReset(environmentId: EnvironmentId) {
  const allowed = useAtomValue(resetFleet.permissionAtom(environmentId));
  const run = useAtomCommand(resetFleet, { reportFailure: false });
  const remove = useAtomCommand(environmentCatalog.removeRoute, { reportFailure: false });
  const reset = async (
    input: LanFleetResetInput,
    routes: ReturnType<typeof savedFleetConnections> = [],
  ): Promise<
    | { error: string; preview?: never; receipt?: never }
    | {
        preview: LanFleetResetPreview;
        routes: ReturnType<typeof savedFleetConnections>;
        error?: never;
        receipt?: never;
      }
    | { receipt: LanFleetResetReceipt; error?: string; preview?: never }
  > => {
    if (input.mode === "apply") {
      if (appAtomRegistry.get(busyAtom)) return { error: "Fleet sync is in progress. Try again." };
      appAtomRegistry.set(busyAtom, true);
    }
    const work = async () => {
      const result = await run({ environmentId, input });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        return {
          error: isFleetError(failure)
            ? failure.refusal === "stale-review"
              ? "Fleet links changed. Review the current list before resetting."
              : failure.message
            : "Reset fleet links could not complete.",
        };
      }
      if ("digest" in result.value) {
        return {
          preview: result.value,
          routes: savedFleetConnections(
            appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
            result.value.fleetId,
          ),
        };
      }
      let removalError: string | undefined;
      for (const { environmentId, routeId, expectedFleet } of routes) {
        const removed = await remove({ environmentId, routeId, expectedFleet });
        if (removed._tag === "Success") continue;
        const failure = squashAtomCommandFailure(removed);
        removalError ??= isConnectionBlockedError(failure)
          ? failure.message
          : "Some saved fleet connections could not be removed.";
      }
      return {
        receipt: result.value,
        ...(removalError === undefined ? {} : { error: removalError }),
      };
    };
    return work().finally(() => {
      if (input.mode === "apply") appAtomRegistry.set(busyAtom, false);
    });
  };
  return { allowed, reset };
}

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
  // Promise#finally rather than a `finally` block: React Compiler skips any hook
  // that uses try/finally.
  const whileBusy = (work: () => Promise<boolean>) => {
    appAtomRegistry.set(busyAtom, true);
    return work().finally(() => appAtomRegistry.set(busyAtom, false));
  };
  const configure = async (input: LanFleetSetupInput) => {
    if (environmentId === null || !allowed || appAtomRegistry.get(busyAtom)) return false;
    return whileBusy(async () => {
      const result = await updateSetup({ environmentId, input });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        appAtomRegistry.set(
          errorAtom,
          // A refusal or a specific reason says what to fix; only a bare one gets the general hint.
          isFleetError(failure) &&
            (failure.refusal !== undefined || failure.reason !== "configuration")
            ? failure.message
            : appAtomRegistry.get(setupAtom)?.sharedFolderTrust === true
              ? "Fleet setup did not complete. Check Windows access to BuildShare, this machine's row in the fleet roster, and the local LAN address."
              : "Fleet setup was not confirmed. Check the verification code and shared storage; existing keys and trust were kept.",
        );
        return false;
      }
      appAtomRegistry.set(setupAtom, result.value);
      appAtomRegistry.set(errorAtom, null);
      appAtomRegistry.set(pausedAtom, false);
      return true;
    });
  };

  const run = async (
    mode: LanFleetSyncInput["mode"],
    sendMachineIds: ReadonlyArray<string> = [],
  ) => {
    if (environmentId === null || !allowed) return false;
    if (appAtomRegistry.get(busyAtom)) return true;
    if (mode === "manual") appAtomRegistry.set(pausedAtom, false);
    const synced = whileBusy(async () => {
      appAtomRegistry.set(errorAtom, null);
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
            pinnedFleetRoutes: [...current.entries].flatMap(([environmentId, entry]) => {
              const fleetIds = connectionRoutes(entry).flatMap(({ profile }) => {
                const saved = Option.getOrUndefined(profile);
                return saved?._tag === "BearerConnectionProfile" && saved.fleetTls !== undefined
                  ? (saved.fleetId ?? [])
                  : [];
              });
              return fleetIds.length === 0
                ? []
                : [{ environmentId, fleetIds: [...new Set(fleetIds)] }];
            }),
            completedReplacementDeliveryIds: [...current.entries.values()]
              .flatMap(connectionRoutes)
              .flatMap(({ profile }) => {
                const saved = Option.getOrNull(profile);
                return saved?._tag === "BearerConnectionProfile"
                  ? (saved.fleetReplacementDeliveryId ?? [])
                  : [];
              })
              .slice(0, 1000),
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
        const setup = appAtomRegistry.get(setupAtom);
        if (summary.enabled && (setup?.stage !== "active" || setup.tlsReady === false))
          await refreshSetup();
        if (incoming.length === 0) return true;
        for (const delivery of incoming) {
          const connected = await connect({
            host: delivery.host,
            pairingCode: delivery.pairingCode,
            ...(delivery.tls === undefined ? {} : { tls: delivery.tls }),
            ...(delivery.fleetId === undefined ? {} : { fleetId: delivery.fleetId }),
            expectedEnvironmentId: delivery.environmentId,
            // A replacement swaps the saved credential, such as after a fleet access change.
            skipExisting: delivery.replace !== true,
            ...(delivery.replace === true ? { replacementDeliveryId: delivery.deliveryId } : {}),
            ...(delivery.requireSavedConnection === true ? { requireSavedConnection: true } : {}),
            ...(delivery.preserveManualConnection === true
              ? { preserveManualConnection: true }
              : {}),
          });
          if (connected._tag !== "Success") {
            appAtomRegistry.set(
              errorAtom,
              fleetPairingFailureDetail(
                squashAtomCommandFailure(connected),
                delivery.pairingCode,
              ) ??
                (appAtomRegistry.get(setupAtom)?.sharedFolderTrust === true
                  ? "Pairing with the other machine stopped without a reason. Check that it is online and enabled in the fleet roster."
                  : "Pickup is unconfirmed. This delivery is paused for review; sync will not replace or retry its credential."),
            );
            return false;
          }
        }
      }
      return true;
    });
    // Polling slows after repeated failures but never stops; a success ends the slowdown.
    return synced.then((ok) => {
      if (ok) appAtomRegistry.set(pausedAtom, false);
      return ok;
    });
  };
  const pause = () => {
    appAtomRegistry.set(pausedAtom, true);
    appAtomRegistry.set(
      errorAtom,
      "Fleet sync failed three times in a row. It keeps checking every 30 minutes; Sync now checks at once.",
    );
  };
  return {
    environmentId,
    allowed,
    summary,
    setup,
    error:
      setup?.credentialUnavailable === true
        ? m(
            msg(
              "Windows could not read this machine's saved fleet credential. Restore the saved credential or ask the fleet owner to approve a replacement.",
            ),
          )
        : error,
    busy,
    paused,
    pause,
    run,
    refreshSetup,
    configure,
  };
}
