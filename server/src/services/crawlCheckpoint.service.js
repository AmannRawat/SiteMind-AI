
import "dotenv/config";
import IORedis from "ioredis";
import { createHash } from "node:crypto";

const redis = new IORedis(
  process.env.VALKEY_URL || "redis://127.0.0.1:6380",
  {
    maxRetriesPerRequest: null,
  }
);

const CHECKPOINT_TTL_SECONDS = 7 * 24 * 60 * 60;

const PAGE_STATE_TTL_SECONDS = 30 * 24 * 60 * 60;

function getPageStateKey(pageUrl) {
  const pageHash = createHash("sha256")
    .update(pageUrl)
    .digest("hex");

  return `website-page-state:${pageHash}`;
}

export async function getPageState(pageUrl) {
  const key = getPageStateKey(pageUrl);
  const value = await redis.get(key);

  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    await redis.del(key);
    return null;
  }
}

export async function savePageState(pageUrl, data) {
  const key = getPageStateKey(pageUrl);

  await redis.set(
    key,
    JSON.stringify({
      version: 1,
      pageUrl,
      updatedAt: new Date().toISOString(),
      ...data,
    }),
    "EX",
    PAGE_STATE_TTL_SECONDS
  );
}

function getCheckpointKey(jobId, pageUrl) {
  const pageHash = createHash("sha256")
    .update(pageUrl)
    .digest("hex");

  return `website-crawl:${jobId}:page:${pageHash}`;
}

export async function getPageCheckpoint(jobId, pageUrl) {
  const key = getCheckpointKey(jobId, pageUrl);
  const value = await redis.get(key);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    await redis.del(key);
    return null;
  }
}

export async function savePageCheckpoint(jobId, pageUrl, data) {
  const key = getCheckpointKey(jobId, pageUrl);

  await redis.set(
    key,
    JSON.stringify({
      version: 1,
      pageUrl,
      completedAt: new Date().toISOString(),
      ...data,
    }),
    "EX",
    CHECKPOINT_TTL_SECONDS
  );
}

export async function closeCheckpointClient() {
  try {
    await redis.quit();
  } catch (error) {
    console.error("[Checkpoint] Error closing Redis client:", error.message);
  }
}
