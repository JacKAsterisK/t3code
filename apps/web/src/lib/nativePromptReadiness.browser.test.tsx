import { describe, expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
import {
  NativePromptFreezeRoot,
  NativePromptReadiness,
  nativePromptReadiness,
  useNativePromptDraft,
} from "./nativePromptReadiness";

function Prompt({ value }: { value: string }) {
  useNativePromptDraft(() => value.length > 0);
  return <textarea aria-label="Prompt" defaultValue={value} />;
}

const localReadiness = (environmentId: string, reservationId: string) =>
  (
    window as Window & {
      __t3NativeUpdateReady?: (environmentId: string, reservationId: string) => boolean;
    }
  ).__t3NativeUpdateReady?.(environmentId, reservationId);

function isolatedReservation() {
  return {
    [Symbol.asyncDispose]: async () => {
      await act(() => {
        nativePromptReadiness.setReservation("browser", null);
        document.body.inert = false;
      });
    },
  };
}

describe("native prompt freeze DOM", () => {
  it("blocks input immediately and acknowledges only after inert and child drafts commit", async () => {
    await using _cleanup = isolatedReservation();
    await using view = await render(
      <NativePromptFreezeRoot>
        <Prompt value="" />
      </NativePromptFreezeRoot>,
    );
    const prompt = document.querySelector("textarea")!;
    let prevented = false;
    await act(() => {
      nativePromptReadiness.setReservation("browser", "reservation");
      expect(nativePromptReadiness.report("browser")?.preparedReservationId).toBeNull();
      const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
      prompt.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    expect(prevented).toBe(true);
    expect(document.body.inert).toBe(true);
    expect(nativePromptReadiness.report("browser")?.preparedReservationId).toBe("reservation");
    expect(localReadiness("browser", "reservation")).toBe(true);
    expect(localReadiness("different-environment", "reservation")).toBe(false);
    expect(localReadiness("browser", "old-reservation")).toBe(false);
    await act(() => nativePromptReadiness.setReservation("browser", null));
    expect(document.body.inert).toBe(false);
    expect(localReadiness("browser", "reservation")).toBe(false);
    await view.unmount();
    expect(localReadiness("browser", "reservation")).toBeUndefined();
  });

  it("never acknowledges a child prompt containing whitespace", async () => {
    await using _cleanup = isolatedReservation();
    await using view = await render(
      <NativePromptFreezeRoot>
        <Prompt value=" " />
      </NativePromptFreezeRoot>,
    );
    await act(() => nativePromptReadiness.setReservation("browser", "draft"));
    expect(document.body.inert).toBe(true);
    expect(nativePromptReadiness.report("browser")?.hasUnsentPrompt).toBe(true);
    expect(localReadiness("browser", "draft")).toBe(false);
    expect(nativePromptReadiness.report("browser")?.preparedReservationId).toBeNull();
    await act(() => nativePromptReadiness.setReservation("browser", null));
    await view.unmount();
  });
  it("does not substitute a clean remote client for a disconnected local renderer", async () => {
    await using _cleanup = isolatedReservation();
    await using view = await render(
      <NativePromptFreezeRoot>
        <Prompt value="unsent local draft" />
      </NativePromptFreezeRoot>,
    );
    const remote = new NativePromptReadiness();
    remote.setRootReady(true);
    remote.setReservation("browser", "server-reservation");
    remote.commitFrozen(remote.snapshot());
    expect(remote.report("browser")?.preparedReservationId).toBe("server-reservation");
    expect(nativePromptReadiness.report("browser")?.hasUnsentPrompt).toBe(true);
    expect(localReadiness("browser", "server-reservation")).toBe(false);
    await view.unmount();
  });
});
