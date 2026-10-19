import "dotenv/config";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { processCrawlJob } from "./services/crawlJobProcessor.js";

const connection = new IORedis(
  process.env.VALKEY_URL || "redis://127.0.0.1:6380",
  {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 10_000,
  }
);

const worker = new Worker(
  "website-support-crawl",
  processCrawlJob,
  {
    connection,

    // Keep browser-heavy crawling sequential on the free instance.
    concurrency: 1,

    // Allow recovery from a crashed worker, but do not repeatedly
    // recycle the same stalled job forever.
    maxStalledCount: 1,

    // A crawl's total budget is currently 90 seconds by default.
    // Keep the lock longer than that budget plus cleanup overhead.
    lockDuration: 150_000,

    autorun: true,
  }
);

worker.on("ready", () => {
  console.log("[Worker] Connected to Valkey and ready for jobs.");
});

worker.on("active", (job) => {
  console.log(`[Worker] Started job ${job.id}.`);
});

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed.`);
});

worker.on("failed", (job, error) => {
  console.error(
    `[Worker] Job ${job?.id ?? "unknown"} failed:`,
    error?.message ?? "Unknown error"
  );
});

worker.on("stalled", (jobId) => {
  console.error(`[Worker] Job ${jobId} stalled.`);
});

worker.on("error", (error) => {
  console.error("[Worker] Error:", error.message);
});

let shuttingDown = false;

export async function closeWorker() {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await worker.close();
    await connection.quit();
  } catch (error) {
    console.error("[Worker] Error closing worker/connection:", error.message);
    throw error;
  }
}

export async function shutdown(signal) {
  console.log(`[Worker] Received ${signal}. Shutting down...`);

  try {
    // Gracefully stop accepting work and wait for the active job to finish.
    await closeWorker();
    console.log("[Worker] Shutdown complete.");
    process.exit(0);
  } catch (error) {
    console.error("[Worker] Shutdown error:", error.message);
    process.exit(1);
  }
}

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export { worker, connection };