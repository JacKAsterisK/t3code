import { describe, expect, it, vi } from "vite-plus/test";
import { startFleetPolling } from "./lanFleetPolling";

function fakeTimers() {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

describe("desktop fleet polling", () => {
  it("checks immediately and every five minutes, then stops after three failures", async () => {
    using _timers = fakeTimers();
    const sync = vi.fn().mockResolvedValue(false);
    const pause = vi.fn();
    const stop = startFleetPolling(sync, pause);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(sync).toHaveBeenCalledTimes(3);
    stop();
  });

  it("resets the failure budget after successful storage access", async () => {
    using _timers = fakeTimers();
    const sync = vi
      .fn()
      .mockResolvedValue(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const pause = vi.fn();
    const stop = startFleetPolling(sync, pause);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(sync).toHaveBeenCalledTimes(4);
    expect(pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(pause).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not restart polling when an in-flight sync completes after the app stops it", async () => {
    using _timers = fakeTimers();
    let finish: (value: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const sync = vi.fn(() => pending);
    const pause = vi.fn();
    const stop = startFleetPolling(sync, pause);
    stop();
    finish(true);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });
});
