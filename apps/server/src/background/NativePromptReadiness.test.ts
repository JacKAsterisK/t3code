import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { ClientActivityReportInput } from "@t3tools/contracts";
import { makeNativePromptReadiness } from "./NativePromptReadiness.ts";

const report = (
  hasUnsentPrompt = false,
  preparedReservationId: string | null = null,
): ClientActivityReportInput => ({
  clientId: "renderer",
  clientKind: "desktop-renderer",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  scopes: [],
  observedAt: DateTime.makeUnsafe(0),
  nativeUpdate: { protocolVersion: 1, hasUnsentPrompt, preparedReservationId },
});

describe("native prompt admission", () => {
  it("requires a fresh report from every connected client, without an inactivity timer", () => {
    const state = makeNativePromptReadiness();
    expect(state.snapshot(0).draftStateKnown).toBe(false);
    state.register("a", 1);
    expect(state.snapshot(0).draftStateKnown).toBe(false);
    state.report("a", 1, report(), 10);
    expect(state.snapshot(10)).toMatchObject({ draftStateKnown: true, hasUnsentPrompt: false });
    state.register("b", 2);
    expect(state.snapshot(11).draftStateKnown).toBe(false);
    state.report("b", 2, report(true), 11);
    expect(state.snapshot(11).hasUnsentPrompt).toBe(true);
    state.remove("b", 2);
    expect(state.snapshot(12).hasUnsentPrompt).toBe(false);
    expect(state.snapshot(30_011).draftStateKnown).toBe(false);
  });
  it("keeps legacy and expired clients unknown rather than forgetting them", () => {
    const state = makeNativePromptReadiness();
    const { nativeUpdate: _nativeUpdate, ...legacy } = report();
    state.report("a", 1, legacy, 0);
    state.report("b", 2, report(), 100_000);
    expect(state.snapshot(100_000).draftStateKnown).toBe(false);
    state.remove("a", 1);
    expect(state.snapshot(100_000).draftStateKnown).toBe(true);
  });
  it("requires a new empty acknowledgement after freeze and includes clients that connect later", () => {
    const state = makeNativePromptReadiness();
    state.report("a", 1, report(false, "reservation"), 0);
    expect(state.freeze("reservation", 10)).toBe(true);
    expect(state.snapshot(10).prepared).toBe(false);
    state.report("a", 1, report(false, "reservation"), 11);
    expect(state.snapshot(11).prepared).toBe(true);
    state.register("b", 2);
    expect(state.snapshot(11).prepared).toBe(false);
    state.report("b", 2, report(false, "reservation"), 12);
    expect(state.snapshot(12).prepared).toBe(true);
    state.report("a", 1, report(true, "reservation"), 13);
    expect(state.snapshot(13).prepared).toBe(false);
    expect(state.freeze("foreign", 13)).toBe(false);
    state.thaw("foreign");
    expect(state.snapshot(13).reservationId).toBe("reservation");
    state.thaw("reservation");
    expect(state.snapshot(13).prepared).toBe(false);
  });
  it("does not discard an unresponsive logical client on the same connection", () => {
    const state = makeNativePromptReadiness();
    state.report("a", 1, { ...report(), clientId: "old" }, 0);
    state.report("a", 1, report(), 40_000);
    expect(state.snapshot(40_000).draftStateKnown).toBe(false);
    state.remove("a", 1);
    state.report("a", 1, report(), 40_001);
    expect(state.snapshot(40_001).draftStateKnown).toBe(true);
  });
});
