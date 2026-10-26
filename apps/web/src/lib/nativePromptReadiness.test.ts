import { describe, expect, it } from "vite-plus/test";
import { NativePromptReadiness } from "./nativePromptReadiness";

describe("native prompt update readiness", () => {
  it("keeps startup unknown and counts whitespace and all mounted environments", () => {
    const state = new NativePromptReadiness();
    expect(state.report("local")).toBeUndefined();
    let text = " ";
    const release = state.register(() => text.length > 0);
    state.setRootReady(true);
    expect(state.report("local")?.hasUnsentPrompt).toBe(true);
    expect(state.report("remote")?.hasUnsentPrompt).toBe(true);
    text = "";
    expect(state.report("local")?.hasUnsentPrompt).toBe(false);
    release();
    state.setRootReady(false);
    expect(state.report("local")).toBeUndefined();
  });

  it("acknowledges only the current inert DOM commit with no draft", () => {
    const state = new NativePromptReadiness();
    let dirty = false;
    state.register(() => dirty);
    state.setRootReady(true);
    const before = state.snapshot();
    state.setReservation("local", "first");
    expect(state.isFrozen()).toBe(true);
    expect(state.report("local")?.preparedReservationId).toBeNull();
    state.commitFrozen(before);
    expect(state.report("local")?.preparedReservationId).toBeNull();
    state.commitFrozen(state.snapshot());
    expect(state.report("local")?.preparedReservationId).toBe("first");
    dirty = true;
    expect(state.report("local")?.preparedReservationId).toBeNull();
    dirty = false;
    state.setReservation("local", "second");
    expect(state.report("local")?.preparedReservationId).toBeNull();
    state.commitFrozen(state.snapshot());
    expect(state.report("local")?.preparedReservationId).toBe("second");
    state.setReservation("remote", "other");
    state.setReservation("local", null);
    expect(state.isFrozen()).toBe(true);
    state.setReservation("remote", null);
    expect(state.isFrozen()).toBe(false);
  });

  it("retains pending imports across unmount and treats unreadable drafts as unsafe", () => {
    const state = new NativePromptReadiness();
    state.setRootReady(true);
    let pending = true;
    const release = state.register(
      () => false,
      () => pending,
    );
    release();
    expect(state.report("local")?.hasUnsentPrompt).toBe(true);
    pending = false;
    expect(state.report("local")?.hasUnsentPrompt).toBe(false);
    state.register(() => {
      throw new Error("not committed");
    });
    expect(state.report("local")?.hasUnsentPrompt).toBe(true);
  });
});
