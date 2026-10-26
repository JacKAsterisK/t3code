import type { ClientActivityReportInput } from "@t3tools/contracts";

const MAX_CLIENTS_PER_CONNECTION = 16;
const MAX_DRAFT_AGE_MS = 30_000;

interface ClientState {
  readonly reports: Map<
    string,
    {
      readonly input: ClientActivityReportInput["nativeUpdate"];
      readonly observedAt: number;
      readonly expiresAt: number;
    }
  >;
  overflow: boolean;
}

/** Draft contents never leave the renderer. Missing/stale clients remain unknown until disconnect. */
export function makeNativePromptReadiness() {
  const clients = new Map<string, ClientState>();
  let reservation: { readonly id: string; readonly startedAt: number } | null = null;
  const key = (sessionId: string, rpcClientId: number) => JSON.stringify([sessionId, rpcClientId]);
  const register = (sessionId: string, rpcClientId: number) => {
    const clientKey = key(sessionId, rpcClientId);
    let state = clients.get(clientKey);
    if (state === undefined) {
      state = { reports: new Map(), overflow: false };
      clients.set(clientKey, state);
    }
    return state;
  };
  const snapshot = (now: number) => {
    let known = clients.size > 0;
    let hasUnsentPrompt = false;
    let prepared = reservation !== null;
    for (const state of clients.values()) {
      if (state.overflow || state.reports.size === 0) known = false;
      for (const report of state.reports.values()) {
        const fresh =
          now >= report.observedAt &&
          now < report.expiresAt &&
          now - report.observedAt <= MAX_DRAFT_AGE_MS;
        if (!fresh || report.input === undefined) known = false;
        if (report.input?.hasUnsentPrompt === true) hasUnsentPrompt = true;
        if (
          !fresh ||
          report.input === undefined ||
          report.input.hasUnsentPrompt ||
          report.input.preparedReservationId !== reservation?.id ||
          report.observedAt < (reservation?.startedAt ?? Infinity)
        )
          prepared = false;
      }
    }
    return {
      draftStateKnown: known,
      hasUnsentPrompt: known || hasUnsentPrompt ? hasUnsentPrompt : null,
      prepared: known && !hasUnsentPrompt && prepared,
      reservationId: reservation?.id ?? null,
    };
  };
  return {
    register,
    report(sessionId: string, rpcClientId: number, input: ClientActivityReportInput, now: number) {
      const state = register(sessionId, rpcClientId);
      if (!state.reports.has(input.clientId) && state.reports.size >= MAX_CLIENTS_PER_CONNECTION) {
        state.overflow = true;
        return;
      }
      const ttl = Math.min(Math.max(input.ttlMs ?? 45_000, 1_000), 120_000);
      state.reports.set(input.clientId, {
        input: input.nativeUpdate,
        observedAt: now,
        expiresAt: now + ttl,
      });
    },
    remove(sessionId: string, rpcClientId: number) {
      clients.delete(key(sessionId, rpcClientId));
    },
    freeze(id: string, now: number) {
      if (reservation !== null && reservation.id !== id) return false;
      reservation ??= { id, startedAt: now };
      return true;
    },
    thaw(id: string) {
      if (reservation?.id === id) reservation = null;
    },
    snapshot,
  };
}
