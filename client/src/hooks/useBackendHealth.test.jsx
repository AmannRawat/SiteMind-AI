// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBackendHealth } from "./useBackendHealth.js";

describe("useBackendHealth hook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transitions to online immediately when /health responds with 200 OK", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", service: "website-support-api" }),
    });

    const { result } = renderHook(() =>
      useBackendHealth({
        apiUrl: "http://localhost:4000",
        retryDelays: [1000, 2000],
        wakingNoticeDelay: 500,
      })
    );

    expect(result.current.status).toBe("checking");

    await act(async () => {
      // allow promise microtasks to settle
      await Promise.resolve();
    });

    expect(result.current.status).toBe("online");
    expect(result.current.isOnline).toBe(true);
    expect(result.current.retryCount).toBe(0);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4000/health",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("transitions to waking if the initial probe takes longer than wakingNoticeDelay", async () => {
    // Hang the fetch promise to simulate slow/cold connection
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useBackendHealth({
        apiUrl: "http://localhost:4000",
        retryDelays: [1000, 2000],
        wakingNoticeDelay: 500,
      })
    );

    expect(result.current.status).toBe("checking");

    act(() => {
      vi.advanceTimersByTime(501);
    });

    expect(result.current.status).toBe("waking");
    expect(result.current.isWaking).toBe(true);
  });

  it("schedules retries with backoff and transitions to online once a probe succeeds", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error("Failed to fetch"));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      });
    });

    const { result } = renderHook(() =>
      useBackendHealth({
        apiUrl: "http://localhost:4000",
        retryDelays: [1000, 2000, 3000],
        wakingNoticeDelay: 200,
      })
    );

    // Initial probe failure
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe("waking");
    expect(result.current.retryCount).toBe(1);

    // Advance by first delay (1000ms) to trigger 2nd probe
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(result.current.status).toBe("waking");
    expect(result.current.retryCount).toBe(2);

    // Advance by second delay (2000ms) to trigger 3rd probe which succeeds
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(result.current.status).toBe("online");
    expect(result.current.isOnline).toBe(true);
    expect(result.current.retryCount).toBe(0);
  });

  it("transitions to unavailable when all retries are exhausted", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network connection refused"));

    const { result } = renderHook(() =>
      useBackendHealth({
        apiUrl: "http://localhost:4000",
        retryDelays: [500, 1000], // 2 retries
        wakingNoticeDelay: 200,
      })
    );

    // Probe 1 fails -> retryCount 1, schedules delay 500ms
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("waking");
    expect(result.current.retryCount).toBe(1);

    // Probe 2 fails -> retryCount 2, schedules delay 1000ms
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("waking");
    expect(result.current.retryCount).toBe(2);

    // Probe 3 fails -> index 2 >= length(2) -> unavailable
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(result.current.status).toBe("unavailable");
    expect(result.current.isUnavailable).toBe(true);
  });

  it("manualRetry restarts probing immediately and resets retry count", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Down"));

    const { result } = renderHook(() =>
      useBackendHealth({
        apiUrl: "http://localhost:4000",
        retryDelays: [500],
        wakingNoticeDelay: 100,
      })
    );

    // Let it exhaust retries
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("unavailable");

    // Next fetch will succeed
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });

    act(() => {
      result.current.manualRetry();
    });

    expect(result.current.status).toBe("waking");
    expect(result.current.retryCount).toBe(0);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe("online");
  });

  it("reportNetworkError triggers health probe when previously online", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });

    const { result } = renderHook(() =>
      useBackendHealth({
        apiUrl: "http://localhost:4000",
        retryDelays: [1000],
      })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("online");

    // Server went to sleep, so next probe fails
    global.fetch.mockRejectedValueOnce(new Error("Failed to fetch"));

    act(() => {
      result.current.reportNetworkError();
    });

    expect(result.current.status).toBe("waking");

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe("waking");
    expect(result.current.retryCount).toBe(1);
  });
});

