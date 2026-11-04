import { randomUUID } from "node:crypto";
import { crawlQueue } from "../config/queue.js";

const MAX_WAITING_CRAWLS = 10;

const ACTIVE_STATES = new Set([
  "waiting",
  "active",
  "delayed",
  "waiting-children",
]);

function normalizeCrawlUrl(value) {
  const url = new URL(value);

  url.hash = "";

  // Normalize only the URL representation, not query parameters,
  // because query parameters can change the actual page content.
  return url.href;
}

export async function enqueueCrawl(inputUrl) {
  const url = normalizeCrawlUrl(inputUrl);

  console.log(`[Diagnostic] Enqueue request - Submitted: "${inputUrl}", Normalized: "${url}"`);

  // First avoid enqueuing the same URL repeatedly while an existing
  // crawl is waiting, running, or delayed for a retry.
  const existingJobs = await crawlQueue.getJobs(
    ["waiting", "active", "delayed", "waiting-children"],
    0,
    100,
    true
  );

  for (const existingJob of existingJobs) {
    if (existingJob.data?.url !== url) continue;

    const state = await existingJob.getState();

    if (ACTIVE_STATES.has(state)) {
      console.log(
        `[Diagnostic] Deduplication HIT - existingJobId: ${existingJob.id}, state: ${state}, url: "${url}"`
      );
      const isDelayed = state === "delayed";
      return {
        jobId: existingJob.id,
        status: isDelayed ? "delayed" : state === "active" ? "active" : "queued",
        state,
        url,
        deduplicated: true,
        isExistingJob: true,
        isDelayed,
      };
    }
  }

  // Global admission control: count all waiting jobs, not just jobs
  // submitted by the current IP. Active jobs are limited by the worker.
  const counts = await crawlQueue.getJobCounts(
    "waiting",
    "delayed",
    "waiting-children"
  );

  const waitingCount =
    (counts.waiting ?? 0) +
    (counts.delayed ?? 0) +
    (counts["waiting-children"] ?? 0);

  if (waitingCount >= MAX_WAITING_CRAWLS) {
    const error = new Error(
      "The crawl queue is currently full. Please try again later."
    );
    error.statusCode = 429;
    error.code = "CRAWL_QUEUE_FULL";
    throw error;
  }

  const job = await crawlQueue.add(
    "crawl-website",
    { url },
    {
      // Random IDs make casual job enumeration harder. They do not
      // replace authentication or server-side ownership checks.
      jobId: randomUUID(),
    }
  );

  console.log(
    `[Diagnostic] New job created - jobId: ${job.id}, state: queued, url: "${url}", deduplicated: false`
  );

  return {
    jobId: job.id,
    status: "queued",
    state: "waiting",
    url,
    deduplicated: false,
    isExistingJob: false,
    isDelayed: false,
  };
}

export async function getCrawlJob(jobId) {
  if (typeof jobId !== "string" || jobId.length > 100) {
    return null;
  }

  const job = await crawlQueue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await job.getState();
  const result = job.returnvalue ?? null;
  const processedPages = Number(result?.processedPages ?? 0);
  const indexedChunks = Number(result?.indexedChunks ?? 0);
  const isCrawlResultFailed = result?.status === "failed";

  // Return only sanitized, safe user-facing failure messages;
  // never leak internal error details or stack traces through a public endpoint.
  let failedReason = null;
  if (
    state === "failed" ||
    isCrawlResultFailed ||
    (state === "completed" && processedPages === 0 && indexedChunks === 0)
  ) {
    if (
      typeof job.failedReason === "string" &&
      job.failedReason.startsWith("Crawl failed:")
    ) {
      failedReason = job.failedReason;
    } else if (state === "completed" && processedPages === 0) {
      failedReason = "Crawl failed: no pages were processed or indexed.";
    } else {
      failedReason =
        "The crawl failed. Please check worker logs or verify the URL is reachable.";
    }
  }

  const isSuccess =
    state === "completed" &&
    !isCrawlResultFailed &&
    (processedPages > 0 || indexedChunks > 0);

  console.log(
    `[Diagnostic] Job poll - jobId: ${job.id}, state: ${state}, progress: ${job.progress}, isSuccess: ${isSuccess}, status: ${result?.status ?? "none"}`
  );

  return {
    jobId: job.id,
    url: job.data?.url ?? null,
    state,
    progress: job.progress,
    failedReason,
    result,
    isSuccess,
    isDelayed: state === "delayed",
  };
}