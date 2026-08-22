// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePolling } from "../../../src/renderer/client/lib/usePolling";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePolling", () => {
  it("polls immediately, then on the interval; success renders authoritative data", async () => {
    const onData = vi.fn();
    const fn = vi.fn().mockResolvedValue("state-1");

    const { result } = renderHook(() =>
      usePolling({ fn, enabled: true, intervalMs: 1000, onData }),
    );

    await act(async () => {});
    expect(result.current).toBe("live");
    expect(onData).toHaveBeenCalledWith("state-1");
    expect(fn).toHaveBeenCalledTimes(1);

    fn.mockResolvedValueOnce("state-2");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onData).toHaveBeenLastCalledWith("state-2");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a failed poll flips to reconnecting but NEVER stops the loop or cancels work", async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    // First poll succeeds; the SECOND rejects (Once-impls are consumed first).
    const fn = vi.fn().mockResolvedValue("ok");

    const { result } = renderHook(() =>
      usePolling({ fn, enabled: true, intervalMs: 1000, onData, onError }),
    );
    await act(async () => {});
    expect(result.current).toBe("live");

    await act(async () => {
      fn.mockRejectedValueOnce(new Error("boom"));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe("reconnecting");
    expect(onError).toHaveBeenCalledTimes(1);

    // Next success renders authoritative current state again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe("live");
    expect(onData).toHaveBeenLastCalledWith("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("cleans up timers on unmount (bounded lifecycle)", async () => {
    const fn = vi.fn().mockResolvedValue(1);
    const { unmount } = renderHook(() =>
      usePolling({ fn, enabled: true, intervalMs: 1000, onData: vi.fn() }),
    );
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores in-flight results after unmount", async () => {
    const onData = vi.fn();
    let resolveLater!: (v: number) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<number>((r) => (resolveLater = r)),
    );

    const { unmount } = renderHook(() =>
      usePolling({ fn, enabled: true, intervalMs: 1000, onData }),
    );
    unmount();
    await act(async () => {
      resolveLater(99);
    });
    expect(onData).not.toHaveBeenCalled();
  });

  it("stays idle and never polls when disabled", async () => {
    const fn = vi.fn().mockResolvedValue(1);
    const { result } = renderHook(() =>
      usePolling({ fn, enabled: false, intervalMs: 1000, onData: vi.fn() }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toBe("idle");
    expect(fn).not.toHaveBeenCalled();
  });
});
