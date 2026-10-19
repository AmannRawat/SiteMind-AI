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
      return {
        jobId: existingJob.id,
        status: state === "active" ? "active" : "queued",
        url,
        deduplicated: true,
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

  return {
    jobId: job.id,
    status: "queued",
    url,
    deduplicated: false,
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

  // Do not return failedReason, stack traces, or internal error details
  // through a public endpoint.
  return {
    jobId: job.id,
    url: job.data?.url ?? null,
    state,
    progress: job.progress,
    result: job.returnvalue ?? null,
  };
}