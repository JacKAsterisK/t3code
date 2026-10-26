import {
  createElement,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface NativePromptReport {
  readonly protocolVersion: 1;
  readonly hasUnsentPrompt: boolean;
  readonly preparedReservationId: string | null;
}

type DraftReader = { read: () => boolean; pending?: () => boolean; detached?: boolean };

/** Includes every mounted prompt in this window, even prompts for another environment. */
export class NativePromptReadiness {
  private readonly drafts = new Map<symbol, DraftReader>();
  private readonly reservations = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly prepared = new Map<string, string>();
  private ready = false;
  private version = 0;
  private freezeState = { version: 0, frozen: false };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = (): Readonly<{ version: number; frozen: boolean }> => this.freezeState;
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  changed(): void {
    this.notify();
  }
  register(read: () => boolean, pending?: () => boolean): () => void {
    const key = Symbol();
    const entry: DraftReader = { read, ...(pending ? { pending } : {}) };
    this.drafts.set(key, entry);
    this.notify();
    return () => {
      // An asynchronous attachment/import can outlive its composer. Keep that claim until it settles.
      if (entry.pending?.()) {
        entry.read = entry.pending;
        entry.detached = true;
      } else this.drafts.delete(key);
      this.notify();
    };
  }
  setRootReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.prepared.clear();
    this.version++;
    this.freezeState = { version: this.version, frozen: this.isFrozen() };
    this.notify();
  }
  setReservation(environmentId: string, reservationId: string | null): void {
    if ((this.reservations.get(environmentId) ?? null) === reservationId) return;
    if (reservationId === null) this.reservations.delete(environmentId);
    else this.reservations.set(environmentId, reservationId);
    this.prepared.delete(environmentId);
    this.version++;
    this.freezeState = { version: this.version, frozen: this.isFrozen() };
    this.notify();
  }
  isFrozen(): boolean {
    return this.reservations.size > 0;
  }
  commitFrozen(state: Readonly<{ version: number; frozen: boolean }>): void {
    if (!this.ready || !state.frozen || state.version !== this.version || !this.isFrozen()) return;
    let changed = false;
    for (const [environmentId, reservationId] of this.reservations) {
      if (this.prepared.get(environmentId) !== reservationId) {
        this.prepared.set(environmentId, reservationId);
        changed = true;
      }
    }
    if (changed) this.notify();
  }
  report(environmentId: string): NativePromptReport | undefined {
    if (!this.ready) return undefined;
    let hasUnsentPrompt = false;
    for (const [key, draft] of this.drafts) {
      try {
        const dirty = draft.read() || draft.pending?.() === true;
        hasUnsentPrompt ||= dirty;
        if (draft.detached && !dirty) this.drafts.delete(key);
      } catch {
        hasUnsentPrompt = true;
      }
    }
    const reservationId = this.reservations.get(environmentId);
    return {
      protocolVersion: 1,
      hasUnsentPrompt,
      preparedReservationId:
        !hasUnsentPrompt &&
        reservationId !== undefined &&
        this.prepared.get(environmentId) === reservationId
          ? reservationId
          : null,
    };
  }
}

export const nativePromptReadiness = new NativePromptReadiness();

export function useNativePromptDraft(read: () => boolean, pending?: () => boolean): void {
  const current = useRef({ read, pending });
  const previousDirty = useRef<boolean | undefined>(undefined);
  // Child layout effects commit before the root acknowledges that its inert DOM is committed.
  // oxlint-disable-next-line t3code/react-effect-budget -- Publish committed child draft evidence before the parent layout effect can acknowledge its freeze.
  useLayoutEffect(() => {
    current.current = { read, pending };
    let dirty = true;
    try {
      dirty = read() || pending?.() === true;
    } catch {}
    if (previousDirty.current !== dirty) {
      previousDirty.current = dirty;
      nativePromptReadiness.changed();
    }
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Mounted prompt registration must be removed on unmount while retaining unfinished import claims.
  useLayoutEffect(
    () =>
      nativePromptReadiness.register(
        () => current.current.read(),
        () => current.current.pending?.() ?? false,
      ),
    [],
  );
}

export function beginNativePromptWork(): () => void {
  let pending = true;
  const release = nativePromptReadiness.register(
    () => pending,
    () => pending,
  );
  return () => {
    pending = false;
    release();
  };
}

const BLOCKED_EVENTS = [
  "beforeinput",
  "input",
  "keydown",
  "paste",
  "drop",
  "click",
  "pointerdown",
  "submit",
  "compositionstart",
] as const;

const openFilePickers = new WeakSet<HTMLInputElement>();
function guardNativePromptInput(event: Event): void {
  if (!nativePromptReadiness.isFrozen()) {
    const input = event.target;
    if (
      event.type === "click" &&
      input instanceof HTMLInputElement &&
      input.type === "file" &&
      !openFilePickers.has(input)
    ) {
      openFilePickers.add(input);
      const release = beginNativePromptWork();
      const settled = () => {
        input.removeEventListener("change", settled, true);
        input.removeEventListener("cancel", settled, true);
        openFilePickers.delete(input);
        release();
      };
      input.addEventListener("change", settled, true);
      input.addEventListener("cancel", settled, true);
    }
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Body inert also covers portals, while capture blocks input immediately before React commits. */
export function NativePromptFreezeRoot({ children }: { readonly children: ReactNode }) {
  const state = useSyncExternalStore(
    nativePromptReadiness.subscribe,
    nativePromptReadiness.snapshot,
    nativePromptReadiness.snapshot,
  );
  const frozen = state.frozen;
  // oxlint-disable-next-line t3code/react-effect-budget -- Root lifetime owns native window capture listeners and marks readiness only after child layout effects commit.
  useLayoutEffect(() => {
    for (const event of BLOCKED_EVENTS)
      window.addEventListener(event, guardNativePromptInput, { capture: true, passive: false });
    const nativeWindow = window as Window & {
      __t3NativeUpdateReady?: (environmentId: string, reservationId: string) => boolean;
    };
    // Electron checks its own renderer after consume, even if this window lost its WebSocket.
    const localReady = (environmentId: string, reservationId: string) => {
      if (
        typeof environmentId !== "string" ||
        !environmentId ||
        typeof reservationId !== "string" ||
        !reservationId ||
        !document.body.inert
      )
        return false;
      const report = nativePromptReadiness.report(environmentId);
      return report?.hasUnsentPrompt === false && report.preparedReservationId === reservationId;
    };
    nativeWindow.__t3NativeUpdateReady = localReady;
    nativePromptReadiness.setRootReady(true);
    return () => {
      if (nativeWindow.__t3NativeUpdateReady === localReady)
        delete nativeWindow.__t3NativeUpdateReady;
      nativePromptReadiness.setRootReady(false);
      for (const event of BLOCKED_EVENTS)
        window.removeEventListener(event, guardNativePromptInput, true);
    };
  }, []);
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize portal-inclusive inert DOM before acknowledging the current server reservation.
  useLayoutEffect(() => {
    document.body.inert = frozen;
    nativePromptReadiness.commitFrozen(state);
  }, [frozen, state]);
  return createElement("div", { inert: frozen, style: { display: "contents" } }, children);
}
