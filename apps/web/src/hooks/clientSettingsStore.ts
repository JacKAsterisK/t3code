import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

// T3 Code LAN: the client settings snapshot lives apart from useSettings, so state modules
// (the shell's subagent switch) can read it without importing the environment state that
// useSettings needs. useSettings owns hydration and registers it here.

const listeners = new Set<() => void>();
let snapshot: ClientSettings = DEFAULT_CLIENT_SETTINGS;
let hydrate: (() => void) | null = null;

export function getClientSettingsSnapshot(): ClientSettings {
  return snapshot;
}

export function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  snapshot = settings;
  for (const listener of listeners) {
    listener();
  }
}

/** Replaces the snapshot without telling listeners; for test setup only. */
export function setClientSettingsSnapshotQuietly(settings: ClientSettings): void {
  snapshot = settings;
}

export function subscribeClientSettings(listener: () => void): () => void {
  listeners.add(listener);
  hydrate?.();
  return () => {
    listeners.delete(listener);
  };
}

/** A subscriber that arrived before useSettings loaded still starts hydration. */
export function setClientSettingsHydrator(next: () => void): void {
  hydrate = next;
  if (listeners.size > 0) next();
}

export function resetClientSettingsStoreForTests(): void {
  snapshot = DEFAULT_CLIENT_SETTINGS;
  listeners.clear();
}
