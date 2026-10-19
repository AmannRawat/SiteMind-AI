import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisUrl =
  process.env.VALKEY_URL || "redis://127.0.0.1:6380";

export const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 10_000,
});

export const crawlQueue = new Queue("website-support-crawl", {
  connection: redisConnection,

  defaultJobOptions: {
    attempts: 3,

    backoff: {
      type: "exponential",
      delay: 2_000,
    },

    // Keep bounded history for debugging without unlimited Redis growth.
    removeOnComplete: {
      count: 100,
    },

    removeOnFail: {
      count: 200,
    },
  },
});