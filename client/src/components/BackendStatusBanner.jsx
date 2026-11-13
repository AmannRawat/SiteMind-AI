import React from "react";
import { LoaderCircle, RefreshCw, AlertTriangle, Clock } from "lucide-react";

/**
 * Recruiter-friendly, non-blocking notification banner indicating backend cold-start status.
 *
 * @param {Object} props
 * @param {'checking'|'waking'|'online'|'unavailable'} props.status - Current health state
 * @param {number} [props.retryCount] - Current retry attempt count
 * @param {() => void} [props.onRetry] - Callback invoked when clicking "Retry connection"
 */
export function BackendStatusBanner({ status, retryCount = 0, onRetry }) {
  if (status === "online" || status === "checking") {
    return null;
  }

  if (status === "unavailable") {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="mx-auto my-4 max-w-2xl rounded-xl border border-[#EF4444]/30 bg-[#141414] p-4 text-[#F5F5F5] shadow-lg sm:p-5"
      >
        <div className="flex items-start gap-3.5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#EF4444]/30 bg-[#EF4444]/10 text-[#EF4444]">
            <AlertTriangle size={18} aria-hidden="true" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[#F5F5F5]">
                Connection to demo server failed
              </h2>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EF4444]/30 bg-[#EF4444]/10 px-2.5 py-0.5 text-xs font-medium text-[#F87171]">
                Server offline
              </span>
            </div>

            <p className="mt-1 text-xs leading-relaxed text-[#A3A3A3] sm:text-sm">
              We&apos;re having trouble connecting to the demo server. Please try again in a moment.
            </p>

            <div className="mt-3.5 flex items-center gap-3">
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-2 rounded-lg border border-[#292929] bg-[#1C1C1C] px-3.5 py-2 text-xs font-semibold text-[#F5F5F5] transition-colors hover:border-[#3A3A3A] hover:bg-[#252525] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF2A2A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#090909] cursor-pointer"
              >
                <RefreshCw size={13} className="shrink-0" aria-hidden="true" />
                <span>Retry connection</span>
              </button>

              <span className="text-[11px] text-[#737373]">
                Free instances may require a fresh wake-up request
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // status === 'waking'
  return (
    <aside
      role="status"
      aria-live="polite"
      aria-label="Server status"
      className="mx-auto my-4 max-w-2xl rounded-xl border border-[#EAB308]/30 bg-[#141414] p-4 text-[#F5F5F5] shadow-lg sm:p-5"
    >
      <div className="flex items-start gap-3.5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#EAB308]/30 bg-[#EAB308]/10 text-[#FACC15]">
          <LoaderCircle
            size={18}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#F5F5F5]">
              Demo server is waking up
            </h2>

            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EAB308]/30 bg-[#EAB308]/10 px-2.5 py-0.5 text-xs font-medium text-[#FACC15]">
              <Clock size={12} className="shrink-0 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
              <span>Waking up server...</span>
            </span>
          </div>

          <p className="mt-1.5 text-xs leading-relaxed text-[#A3A3A3] sm:text-sm">
            Our free demo server may take a moment to start after a period of inactivity. We&apos;re establishing a connection. Thank you for your patience.
          </p>

          <div className="mt-3 flex items-center justify-between text-[11px] text-[#737373]">
            <span>Spinning up on Render Free instance (~50–60s)</span>
            {retryCount > 0 && (
              <span className="font-mono text-[10px] text-[#A3A3A3]">
                Check {retryCount} in progress
              </span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

