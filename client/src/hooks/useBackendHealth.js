import { useState, useEffect, useCallback, useRef } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

// Retry delays in milliseconds covering ~60s of Render free tier cold-start:
// 3s + 5s + 7s + 9s + 11s + 13s + 15s = 63s
export const RETRY_DELAYS = [3000, 5000, 7000, 9000, 11000, 13000, 15000];
export const PROBE_TIMEOUT_MS = 8000;
export const WAKING_NOTICE_DELAY_MS = 2000;

/**
 * Hook to manage backend health checking with cold-start awareness.
 *
 * States:
 * - 'checking': Initial probe in-flight (< 2s).
 * - 'waking': Backend appears sleeping / cold-starting; backoff polling active.
 * - 'online': Health endpoint returned HTTP 200 OK. Polling is stopped.
 * - 'unavailable': Max retries exhausted without a 200 response. Polling is stopped.
 */
export function useBackendHealth(options = {}) {
  const apiUrl = options.apiUrl || API_URL;
  const retryDelays = options.retryDelays || RETRY_DELAYS;
  const probeTimeout = options.probeTimeout ?? PROBE_TIMEOUT_MS;
  const wakingNoticeDelay = options.wakingNoticeDelay ?? WAKING_NOTICE_DELAY_MS;

  const retryDelaysRef = useRef(retryDelays);
  const probeTimeoutRef = useRef(probeTimeout);
  const wakingNoticeDelayRef = useRef(wakingNoticeDelay);
  const apiUrlRef = useRef(apiUrl);

  useEffect(() => {
    retryDelaysRef.current = retryDelays;
    probeTimeoutRef.current = probeTimeout;
    wakingNoticeDelayRef.current = wakingNoticeDelay;
    apiUrlRef.current = apiUrl;
  }, [retryDelays, probeTimeout, wakingNoticeDelay, apiUrl]);

  const [status, setStatus] = useState("checking");
  const [retryCount, setRetryCount] = useState(0);

  const retryTimeoutRef = useRef(null);
  const abortControllerRef = useRef(null);
  const wakingTimerRef = useRef(null);
  const isMountedRef = useRef(true);
  const statusRef = useRef("checking");

  // Keep ref synchronized with state to avoid stale closures in callbacks
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const clearTimers = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (wakingTimerRef.current) {
      clearTimeout(wakingTimerRef.current);
      wakingTimerRef.current = null;
    }
  }, []);

  const performProbe = useCallback(
    async function probe(currentRetryIndex = 0) {
      if (!isMountedRef.current) return;

      clearTimers();

      // If probe takes longer than wakingNoticeDelay, indicate waking state early
      if (statusRef.current === "checking") {
        wakingTimerRef.current = setTimeout(() => {
          if (isMountedRef.current && statusRef.current === "checking") {
            setStatus("waking");
          }
        }, wakingNoticeDelayRef.current);
      }

      // Abort any previous pending probe request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const timeoutId = setTimeout(() => {
        controller.abort();
      }, probeTimeoutRef.current);

      try {
        const response = await fetch(`${apiUrlRef.current}/health`, {
          signal: controller.signal,
          cache: "no-store",
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Health check returned status ${response.status}`);
        }

        if (!isMountedRef.current) return;

        // Health check succeeded
        clearTimers();
        setStatus("online");
        setRetryCount(0);
      } catch {
        clearTimeout(timeoutId);

        // Ignore aborts triggered by unmounting
        if (!isMountedRef.current) return;

        const delays = retryDelaysRef.current;
        if (currentRetryIndex < delays.length) {
          setStatus("waking");
          setRetryCount(currentRetryIndex + 1);

          const delay = delays[currentRetryIndex];
          retryTimeoutRef.current = setTimeout(() => {
            probe(currentRetryIndex + 1);
          }, delay);
        } else {
          // Exhausted all retries in the schedule
          setStatus("unavailable");
        }
      }
    },
    [clearTimers]
  );

  const manualRetry = useCallback(() => {
    clearTimers();
    setRetryCount(0);
    setStatus("waking");
    performProbe(0);
  }, [clearTimers, performProbe]);

  const reportNetworkError = useCallback(() => {
    // If an active user action encountered a network failure
    clearTimers();
    setStatus("waking");
    setRetryCount(0);
    performProbe(0);
  }, [clearTimers, performProbe]);

  useEffect(() => {
    isMountedRef.current = true;
    performProbe(0);

    return () => {
      isMountedRef.current = false;
      clearTimers();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [apiUrl, performProbe, clearTimers]);

  return {
    status,
    isOnline: status === "online",
    isWaking: status === "waking",
    isChecking: status === "checking",
    isUnavailable: status === "unavailable",
    retryCount,
    manualRetry,
    reportNetworkError,
  };
}
