import { useEffect, useState } from "react";
import {
  Globe,
  Search,
  LoaderCircle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  MessageCircle,
  Send,
  Bot,
  User,
  RefreshCw,
  Layers,
  Sparkles,
} from "lucide-react";

import { Analytics } from '@vercel/analytics/react';
import posthog from "./posthog.js";
import { MarkdownContent } from "./components/MarkdownContent.jsx";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function App() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [apiStatus, setApiStatus] = useState("checking");

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);

  const state = job?.state || job?.status;
  const isDelayed = state === "delayed" || Boolean(job?.isDelayed);
  const isDeduplicated = Boolean(job?.deduplicated || job?.isExistingJob);
  const crawlResult = job?.result;
  const crawlResultStatus = crawlResult?.status;
  const processedPages = Number(crawlResult?.processedPages ?? 0);
  const indexedChunks = Number(crawlResult?.indexedChunks ?? 0);

  // A crawl is genuinely failed if:
  // 1) BullMQ reports failed state, OR
  // 2) The crawler explicitly marked status as "failed", OR
  // 3) The state is reported "completed" but 0 pages and 0 chunks were indexed.
  const failed =
    state === "failed" ||
    crawlResultStatus === "failed" ||
    (state === "completed" && processedPages === 0 && indexedChunks === 0);

  // A crawl is completed only when it reached completion and indexed actual content.
  const completed =
    state === "completed" &&
    !failed &&
    (job?.isSuccess !== undefined
      ? Boolean(job.isSuccess)
      : processedPages > 0 || indexedChunks > 0);

  const partiallyCompleted = completed && crawlResultStatus === "partial";
  const active = Boolean(job && !completed && !failed);
  const websiteUrl = job?.url || job?.result?.websiteUrl || "";

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const response = await fetch(`${API_URL}/health`);

        if (!response.ok) {
          throw new Error("Health check failed");
        }

        if (!cancelled) {
          setApiStatus("online");
        }
      } catch {
        if (!cancelled) {
          // A failed fetch may be caused by an extension(UBLOCK ORIGIN) or network issue.
          // It does not prove the entire API is offline.
          setApiStatus("unknown");
        }
      }
    }

    checkHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!job?.jobId || completed || failed) return;

    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(
          `${API_URL}/api/crawls/${encodeURIComponent(job.jobId)}`
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Could not fetch job status.");
        }

        if (!cancelled) {
          setError("");

          setJob((current) =>
            current?.jobId === data.jobId ? { ...current, ...data } : current
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not fetch job status.");
        }
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.jobId, completed, failed]);

  async function handleSubmit(event) {
    event.preventDefault();

    setError("");
    let targetUrl = url.trim();

    if (!targetUrl) {
      setError("Please enter a website URL to begin crawling.");
      return;
    }

    // Auto-normalize if user omitted protocol (e.g., example.com -> https://example.com)
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
      setUrl(targetUrl);
    }

    setJob(null);
    setMessages([]);
    setQuestion("");
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/crawls`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not start the crawl.");
      }

      setJob({
        ...data,
        state: data.status || "waiting",
        progress: 0,
      });
      posthog.capture("crawl_started");
      posthog.logger.info("crawl request accepted", { source: "web" });
    } catch (err) {
      posthog.capture("crawl_start_failed");
      setError(
        err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError")
          ? `Could not reach the SiteMind API at ${API_URL}. Please ensure the backend server is running.`
          : err.message || "Could not connect to the API."
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleAsk(event) {
    event.preventDefault();

    const userQuestion = question.trim();

    if (!userQuestion || !websiteUrl || chatLoading) return;

    posthog.capture("chat_question_submitted");
    setError("");
    setChatLoading(true);
    setQuestion("");

    setMessages((current) => [
      ...current,
      {
        role: "user",
        text: userQuestion,
      },
    ]);

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          websiteUrl,
          question: userQuestion,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to answer this question.");
      }

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: data.answer || "The assistant returned an empty answer.",
          sources: data.sources || [],
        },
      ]);
      posthog.capture("chat_answer_received");
      posthog.logger.info("chat answer displayed", { source: "web" });
    } catch (err) {
      setError(err.message || "Could not reach the chat API.");
    } finally {
      setChatLoading(false);
    }
  }

  function resetChat() {
    posthog.capture("chat_cleared");
    setMessages([]);
    setError("");
  }

  function handleSuggestedQuestion(suggestedText) {
    setQuestion(suggestedText);
    const textarea = document.getElementById("chat-question-input");
    if (textarea) {
      textarea.focus();
    }
  }

  return (
    <main className="min-h-screen bg-[#090909] text-[#F5F5F5]">
      {/* Top Navigation / Brand Header */}
      <header className="sticky top-0 z-30 border-b border-[#292929] bg-[#090909]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            {/* SiteMind AI Brand Favicon Logo */}
            <img
              src="/favicon.svg"
              alt="SiteMind AI Logo"
              className="h-9 w-9 rounded-lg shrink-0"
              width="36"
              height="36"
            />

            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight text-[#F5F5F5]">
                  SiteMind AI
                </span>
                <span className="rounded border border-[#292929] bg-[#1C1C1C] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#A3A3A3]">
                  RAG
                </span>
              </div>
              <p className="text-xs text-[#A3A3A3] hidden sm:block">
                Website crawling &amp; RAG assistant
              </p>
            </div>
          </div>

          <div
            className="flex items-center gap-2 rounded-full border border-[#292929] bg-[#141414] px-3 py-1.5 text-xs text-[#A3A3A3]"
            title={
              apiStatus === "online"
                ? "Health endpoint responded successfully"
                : apiStatus === "checking"
                  ? "Checking API health"
                  : "Health check unavailable; the API may still be working"
            }
          >
            <span
              className={`h-2 w-2 rounded-full ${apiStatus === "online"
                ? "bg-[#22C55E] ring-2 ring-[#22C55E]/30"
                : apiStatus === "checking"
                  ? "bg-[#EAB308] ring-2 ring-[#EAB308]/30"
                  : "bg-[#737373] ring-2 ring-[#737373]/30"
                }`}
              aria-hidden="true"
            />
            <span>
              {apiStatus === "online"
                ? "API connected"
                : apiStatus === "checking"
                  ? "Checking API"
                  : "API status unknown"}
            </span>
          </div>
        </div>
      </header>

      {/* Hero & Form Section */}
      <section className="mx-auto max-w-4xl px-4 pb-16 pt-10 sm:px-6 sm:pt-14">
        {/* Hero Copy */}
        <div className="mx-auto max-w-2xl text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#292929] bg-[#141414] px-3.5 py-1 text-xs font-medium text-[#A3A3A3]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#FF2A2A]" aria-hidden="true" />
            <span>Grounded Website Intelligence &amp; Indexing</span>
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-[#F5F5F5] sm:text-5xl sm:leading-tight">
            Understand any{" "}
            <span className="text-[#FF2A2A]">website, deeply.</span>
          </h1>

          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-[#A3A3A3] sm:text-base">
            Crawl web domains, extract and index page content into vector embeddings,
            and query an assistant grounded strictly in verified site data.
          </p>
        </div>

        {/* Crawl URL Submission Form */}
        <form
          onSubmit={handleSubmit}
          className="mx-auto mt-8 max-w-2xl rounded-xl border border-[#292929] bg-[#141414] p-3.5 sm:p-4 shadow-sm"
        >
          <label
            htmlFor="website-url"
            className="mb-2 block text-xs font-medium uppercase tracking-wider text-[#A3A3A3]"
          >
            Target Website URL
          </label>

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-[#292929] bg-[#1C1C1C] px-3.5 py-2.5 transition-colors focus-within:border-[#FF2A2A] focus-within:ring-1 focus-within:ring-[#FF2A2A]">
              <Globe size={18} className="shrink-0 text-[#737373]" aria-hidden="true" />

              <input
                id="website-url"
                type="text"
                inputMode="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com or example.com"
                disabled={loading}
                className="w-full bg-transparent text-sm text-[#F5F5F5] placeholder-[#737373] outline-none disabled:opacity-50"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#FF2A2A] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#FF5C5C] active:bg-[#D32F2F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF2A2A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#090909] disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <LoaderCircle className="animate-spin" size={17} aria-hidden="true" />
              ) : (
                <Search size={17} aria-hidden="true" />
              )}
              <span>{loading ? "Starting..." : "Start crawl"}</span>
            </button>
          </div>

          <p className="mt-2 text-xs text-[#737373]">
            Enter any public HTTP or HTTPS web address to begin extraction and indexing.
          </p>
        </form>

        {/* Global Error Banner */}
        {error && (
          <div
            role="alert"
            className="mx-auto mt-4 flex max-w-2xl items-start gap-3 rounded-lg border border-[#EF4444]/30 bg-[#EF4444]/10 p-3.5 text-sm text-[#FCA5A5]"
          >
            <CircleAlert size={18} className="mt-0.5 shrink-0 text-[#EF4444]" aria-hidden="true" />
            <p className="flex-1 leading-5 break-words">{error}</p>
          </div>
        )}

        {/* Crawl Progress Card */}
        {job && (
          <section
            aria-labelledby="crawl-status-heading"
            className="mx-auto mt-6 max-w-2xl rounded-xl border border-[#292929] bg-[#141414] p-4 sm:p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="crawl-status-heading" className="text-sm font-semibold text-[#F5F5F5]">
                    Crawl job
                  </h2>
                  {isDeduplicated && (
                    <span className="rounded border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#60A5FA]">
                      Existing active job
                    </span>
                  )}
                </div>
                <p className="mt-0.5 break-all font-mono text-xs text-[#737373]">
                  ID: {job.jobId}
                </p>
              </div>

              {failed ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EF4444]/30 bg-[#EF4444]/10 px-2.5 py-1 text-xs font-medium text-[#F87171]">
                  <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
                  Failed
                </span>
              ) : partiallyCompleted ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EAB308]/30 bg-[#EAB308]/10 px-2.5 py-1 text-xs font-medium text-[#FACC15]">
                  <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
                  Partial
                </span>
              ) : completed ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#22C55E]/30 bg-[#22C55E]/10 px-2.5 py-1 text-xs font-medium text-[#4ADE80]">
                  <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" />
                  Completed
                </span>
              ) : isDelayed ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EAB308]/30 bg-[#EAB308]/10 px-2.5 py-1 text-xs font-medium text-[#FACC15]">
                  <Clock3 size={14} className="shrink-0 animate-pulse" aria-hidden="true" />
                  Retrying
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FF2A2A]/30 bg-[#FF2A2A]/10 px-2.5 py-1 text-xs font-medium text-[#FF2A2A]">
                  <LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" />
                  {active ? "Crawling" : "Queued"}
                </span>
              )}
            </div>

            {/* Status description */}
            <div className="mt-3 flex items-center justify-between text-xs text-[#A3A3A3]">
              <div className="flex items-center gap-1.5">
                <Clock3 size={14} className="text-[#737373]" aria-hidden="true" />
                <span className="capitalize">
                  {partiallyCompleted
                    ? "Partially completed"
                    : isDelayed
                      ? "Waiting to retry (delayed)"
                      : state || "waiting"}
                </span>
              </div>
              <span className="font-mono text-xs text-[#737373]">
                {Math.max(0, Math.min(100, Number(job.progress) || 0))}%
              </span>
            </div>

            {/* Progress bar */}
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full border border-[#292929] bg-[#1C1C1C]"
              role="progressbar"
              aria-valuenow={Math.max(0, Math.min(100, Number(job.progress) || 0))}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full rounded-full transition-all duration-300 ease-out ${failed
                  ? "bg-[#EF4444]"
                  : partiallyCompleted || isDelayed
                    ? "bg-[#EAB308]"
                    : completed
                      ? "bg-[#22C55E]"
                      : "bg-[#FF2A2A]"
                  }`}
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100, Number(job.progress) || 0)
                  )}%`,
                }}
              />
            </div>

            {/* Informative banner for deduplicated/existing job */}
            {isDeduplicated && active && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#3B82F6]/20 bg-[#3B82F6]/10 p-2.5 text-xs text-[#93C5FD]">
                <Clock3 size={14} className="shrink-0" aria-hidden="true" />
                <span>
                  Attached to an existing in-progress crawl for this URL. Monitoring live status.
                </span>
              </div>
            )}

            {/* Error detail */}
            {failed && (
              <p className="mt-3 rounded-lg border border-[#EF4444]/20 bg-[#EF4444]/10 p-3 text-xs leading-relaxed text-[#FCA5A5] break-words">
                {job.failedReason ||
                  (processedPages === 0 && indexedChunks === 0
                    ? "Crawl failed: no readable content was found or indexed for this website."
                    : "The crawl failed. Please check worker logs or verify the URL is reachable.")}
              </p>
            )}

            {/* Completion banners */}
            {completed && (
              <div
                className={`mt-3 flex items-center gap-2 rounded-lg border p-3 text-xs leading-relaxed ${partiallyCompleted
                  ? "border-[#EAB308]/20 bg-[#EAB308]/10 text-[#FACC15]"
                  : "border-[#22C55E]/20 bg-[#22C55E]/10 text-[#4ADE80]"
                  }`}
              >
                {partiallyCompleted ? (
                  <CircleAlert size={16} className="shrink-0" aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={16} className="shrink-0" aria-hidden="true" />
                )}
                <span>
                  {partiallyCompleted
                    ? "Crawl finished with some page timeouts or skips. All available content was indexed."
                    : "Website crawl completed successfully. Content is indexed and ready for chat."}
                </span>
              </div>
            )}

            {/* Link to target website */}
            {job.url && (
              <div className="mt-3.5 pt-3 border-t border-[#292929] flex items-center justify-between text-xs">
                <span className="text-[#737373]">Crawled domain:</span>
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-[#FF2A2A] hover:text-[#FF5C5C] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF2A2A] rounded"
                >
                  <span className="truncate max-w-[240px] sm:max-w-md">{job.url}</span>
                  <ExternalLink size={13} className="shrink-0" aria-hidden="true" />
                </a>
              </div>
            )}
          </section>
        )}

        {/* Chat / RAG Section */}
        {completed && (
          <section
            aria-labelledby="rag-chat-heading"
            className="mx-auto mt-6 max-w-2xl overflow-hidden rounded-xl border border-[#292929] bg-[#141414] shadow-sm"
          >
            {/* Chat Header */}
            <div className="flex flex-col gap-3 border-b border-[#292929] bg-[#141414] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#292929] bg-[#1C1C1C] text-[#FF2A2A]">
                  <MessageCircle size={17} aria-hidden="true" />
                </div>

                <div className="min-w-0">
                  <h2 id="rag-chat-heading" className="text-sm font-semibold text-[#F5F5F5]">
                    Chat with this website
                  </h2>
                  <p className="truncate font-mono text-xs text-[#A3A3A3] max-w-xs sm:max-w-md">
                    {websiteUrl}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={resetChat}
                disabled={chatLoading || messages.length === 0}
                className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#292929] bg-[#1C1C1C] px-2.5 py-1.5 text-xs font-medium text-[#A3A3A3] transition-colors hover:border-[#3A3A3A] hover:text-[#F5F5F5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF2A2A] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw size={13} aria-hidden="true" />
                <span>Clear chat</span>
              </button>
            </div>

            {/* Chat Messages Log */}
            <div className="flex min-h-[260px] max-h-[500px] flex-col gap-4 overflow-y-auto p-4 sm:p-5">
              {messages.length === 0 && (
                <div className="m-auto max-w-md py-6 text-center">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-[#292929] bg-[#1C1C1C] text-[#FF2A2A]">
                    <Bot size={22} aria-hidden="true" />
                  </div>
                  <h3 className="text-sm font-medium text-[#F5F5F5]">
                    Ask anything about this website
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-[#A3A3A3]">
                    Answers are synthesized from retrieved content chunks indexed from the crawled site.
                  </p>

                  {/* Suggestion Chips */}
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {[
                      "What is this website about?",
                      "Summarize key features and services",
                      "How can I contact or get started?",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => handleSuggestedQuestion(suggestion)}
                        className="rounded-full border border-[#292929] bg-[#1C1C1C] px-3 py-1 text-xs text-[#A3A3A3] transition-colors hover:border-[#FF2A2A]/50 hover:text-[#F5F5F5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF2A2A]"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message, index) => (
                <div
                  key={`${index}-${message.role}`}
                  className={`flex gap-2.5 ${message.role === "user" ? "justify-end" : "justify-start"
                    }`}
                >
                  {message.role === "assistant" && (
                    <div
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#292929] bg-[#1C1C1C] text-[#FF2A2A]"
                      aria-hidden="true"
                    >
                      <Bot size={15} />
                    </div>
                  )}

                  <div
                    className={`min-w-0 max-w-[88%] rounded-xl px-4 py-2.5 text-sm ${message.role === "user"
                      ? "bg-[#FF2A2A] font-medium text-white"
                      : "border border-[#292929] bg-[#1C1C1C] text-[#F5F5F5]"
                      }`}
                  >
                    {message.role === "assistant" ? (
                      <MarkdownContent content={message.text} />
                    ) : (
                      <div className="whitespace-pre-wrap break-words leading-relaxed text-sm">
                        {message.text}
                      </div>
                    )}

                    {message.role === "assistant" && message.sources?.length > 0 && (
                      <div className="mt-3 border-t border-[#292929] pt-2.5">
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                          Cited Sources
                        </p>

                        <div className="flex flex-col gap-1.5">
                          {message.sources.map((source, srcIdx) => (
                            <a
                              key={`${source.url}-${srcIdx}`}
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-start gap-1.5 break-all text-xs text-[#FF2A2A] transition-colors hover:text-[#FF5C5C] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF2A2A] rounded"
                            >
                              <ExternalLink
                                size={13}
                                className="mt-0.5 shrink-0 text-[#FF2A2A]"
                                aria-hidden="true"
                              />
                              <span className="leading-tight">{source.title || source.url}</span>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {message.role === "user" && (
                    <div
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#292929] bg-[#1C1C1C] text-[#A3A3A3]"
                      aria-hidden="true"
                    >
                      <User size={15} />
                    </div>
                  )}
                </div>
              ))}

              {chatLoading && (
                <div className="flex items-center gap-2.5 rounded-lg border border-[#292929] bg-[#1C1C1C] px-3.5 py-2.5 text-xs text-[#A3A3A3] w-fit">
                  <LoaderCircle
                    size={15}
                    className="animate-spin text-[#FF2A2A]"
                    aria-hidden="true"
                  />
                  <span>Retrieving indexed content and generating response...</span>
                </div>
              )}
            </div>

            {/* Chat Input Form */}
            <form onSubmit={handleAsk} className="border-t border-[#292929] bg-[#141414] p-3">
              <div className="flex items-end gap-2 rounded-lg border border-[#292929] bg-[#1C1C1C] p-2 transition-colors focus-within:border-[#FF2A2A] focus-within:ring-1 focus-within:ring-[#FF2A2A]">
                <textarea
                  id="chat-question-input"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Ask a question about this website..."
                  rows={2}
                  disabled={chatLoading}
                  aria-label="Ask a question about this website"
                  className="max-h-28 min-h-[44px] flex-1 resize-y bg-transparent p-1.5 text-sm leading-5 text-[#F5F5F5] placeholder-[#737373] outline-none disabled:opacity-50"
                />

                <button
                  type="submit"
                  disabled={chatLoading || !question.trim()}
                  aria-label="Send question"
                  className="mb-1 rounded-md bg-[#FF2A2A] p-2 text-white transition-colors hover:bg-[#FF5C5C] active:bg-[#D32F2F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF2A2A] disabled:cursor-not-allowed disabled:opacity-40 shrink-0 cursor-pointer"
                >
                  {chatLoading ? (
                    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Send size={16} aria-hidden="true" />
                  )}
                </button>
              </div>

              <p className="mt-1.5 px-1 text-[11px] text-[#737373]">
                Press <kbd className="rounded border border-[#292929] bg-[#1C1C1C] px-1 py-0.5 text-[10px] text-[#A3A3A3]">Enter</kbd> to send · <kbd className="rounded border border-[#292929] bg-[#1C1C1C] px-1 py-0.5 text-[10px] text-[#A3A3A3]">Shift + Enter</kbd> for new line
              </p>
            </form>
          </section>
        )}

        {/* Feature / Workflow Step Cards */}
        <div className="mx-auto mt-12 grid max-w-2xl gap-3.5 sm:grid-cols-3">
          {[
            {
              number: "01",
              title: "Crawl",
              description: "Automated traversal and text extraction of domain pages.",
              icon: Globe,
            },
            {
              number: "02",
              title: "Index",
              description: "Recursive chunking with high-density vector embeddings.",
              icon: Layers,
            },
            {
              number: "03",
              title: "Ask",
              description: "Grounded semantic retrieval with verifiable source links.",
              icon: Sparkles,
            },
          ].map(({ number, title, description, icon: StepIcon }) => (
            <div
              key={number}
              className="group rounded-xl border border-[#292929] bg-[#141414] p-4 transition-colors hover:border-[#3A3A3A]"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-[#FF2A2A]">
                  {number}
                </span>
                <StepIcon
                  size={15}
                  className="text-[#737373] transition-colors group-hover:text-[#A3A3A3]"
                  aria-hidden="true"
                />
              </div>
              <h2 className="mt-2.5 text-sm font-semibold text-[#F5F5F5]">{title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-[#A3A3A3]">{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#292929] py-6 text-center text-xs text-[#737373]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>SiteMind AI — High-performance Website Crawler &amp; RAG Assistant</span>
          <span className="font-mono text-[11px] text-[#737373]">Production v1.0</span>
        </div>
      </footer>
      <Analytics />
    </main>
  );
}