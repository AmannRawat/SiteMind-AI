import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobs: vi.fn(),
  getJobCounts: vi.fn(),
  add: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("../config/queue.js", () => ({
  crawlQueue: {
    getJobs: mocks.getJobs,
    getJobCounts: mocks.getJobCounts,
    add: mocks.add,
    getJob: mocks.getJob,
  },
}));

import { enqueueCrawl, getCrawlJob } from "./crawlQueue.service.js";

describe("crawlQueue.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("enqueueCrawl", () => {
    it("creates a new job when no active or delayed job exists for the URL", async () => {
      mocks.getJobs.mockResolvedValue([]);
      mocks.getJobCounts.mockResolvedValue({ waiting: 0, delayed: 0, "waiting-children": 0 });
      mocks.add.mockResolvedValue({ id: "new-job-1" });

      const result = await enqueueCrawl("https://example.com/page");

      expect(result).toEqual({
        jobId: "new-job-1",
        status: "queued",
        state: "waiting",
        url: "https://example.com/page",
        deduplicated: false,
        isExistingJob: false,
        isDelayed: false,
      });
      expect(mocks.add).toHaveBeenCalledWith(
        "crawl-website",
        { url: "https://example.com/page" },
        expect.objectContaining({ jobId: expect.any(String) })
      );
    });

    it("deduplicates when an existing job is in active state", async () => {
      const existingJob = {
        id: "active-job-42",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("active"),
      };
      mocks.getJobs.mockResolvedValue([existingJob]);

      const result = await enqueueCrawl("https://example.com/");

      expect(result).toEqual({
        jobId: "active-job-42",
        status: "active",
        state: "active",
        url: "https://example.com/",
        deduplicated: true,
        isExistingJob: true,
        isDelayed: false,
      });
      expect(mocks.add).not.toHaveBeenCalled();
    });

    it("explicitly handles delayed jobs and reports delayed status", async () => {
      const existingJob = {
        id: "delayed-job-99",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("delayed"),
      };
      mocks.getJobs.mockResolvedValue([existingJob]);

      const result = await enqueueCrawl("https://example.com/");

      expect(result).toEqual({
        jobId: "delayed-job-99",
        status: "delayed",
        state: "delayed",
        url: "https://example.com/",
        deduplicated: true,
        isExistingJob: true,
        isDelayed: true,
      });
      expect(mocks.add).not.toHaveBeenCalled();
    });

    it("does not deduplicate against different URLs", async () => {
      const existingJob = {
        id: "other-job",
        data: { url: "https://other.com/" },
        getState: vi.fn().mockResolvedValue("active"),
      };
      mocks.getJobs.mockResolvedValue([existingJob]);
      mocks.getJobCounts.mockResolvedValue({ waiting: 0, delayed: 0, "waiting-children": 0 });
      mocks.add.mockResolvedValue({ id: "fresh-job" });

      const result = await enqueueCrawl("https://example.com/");

      expect(result.jobId).toBe("fresh-job");
      expect(result.deduplicated).toBe(false);
      expect(mocks.add).toHaveBeenCalledTimes(1);
    });

    it("throws 429 when queue capacity is reached", async () => {
      mocks.getJobs.mockResolvedValue([]);
      mocks.getJobCounts.mockResolvedValue({ waiting: 10, delayed: 0, "waiting-children": 0 });

      await expect(enqueueCrawl("https://example.com/")).rejects.toMatchObject({
        statusCode: 429,
        code: "CRAWL_QUEUE_FULL",
      });
      expect(mocks.add).not.toHaveBeenCalled();
    });
  });

  describe("getCrawlJob", () => {
    it("returns null for non-existent or invalid jobId", async () => {
      expect(await getCrawlJob(12345)).toBeNull();
      expect(await getCrawlJob("")).toBeNull();

      mocks.getJob.mockResolvedValue(null);
      expect(await getCrawlJob("non-existent-id")).toBeNull();
    });

    it("returns active job details without false success", async () => {
      mocks.getJob.mockResolvedValue({
        id: "running-job-1",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("active"),
        progress: 45,
        returnvalue: null,
      });

      const result = await getCrawlJob("running-job-1");

      expect(result).toEqual({
        jobId: "running-job-1",
        url: "https://example.com/",
        state: "active",
        progress: 45,
        failedReason: null,
        result: null,
        isSuccess: false,
        isDelayed: false,
      });
    });

    it("flags delayed state explicitly", async () => {
      mocks.getJob.mockResolvedValue({
        id: "delayed-job-1",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("delayed"),
        progress: 10,
        returnvalue: null,
      });

      const result = await getCrawlJob("delayed-job-1");

      expect(result.state).toBe("delayed");
      expect(result.isDelayed).toBe(true);
      expect(result.isSuccess).toBe(false);
    });

    it("does not report success when a completed job has 0 processed pages and 0 indexed chunks", async () => {
      mocks.getJob.mockResolvedValue({
        id: "stale-job-0-pages",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("completed"),
        progress: 100,
        returnvalue: {
          status: "failed",
          processedPages: 0,
          failedPages: 1,
          indexedChunks: 0,
        },
      });

      const result = await getCrawlJob("stale-job-0-pages");

      expect(result.state).toBe("completed");
      expect(result.isSuccess).toBe(false);
      expect(result.failedReason).toBe("Crawl failed: no pages were processed or indexed.");
    });

    it("reports genuine success when a job completed with indexed pages", async () => {
      mocks.getJob.mockResolvedValue({
        id: "successful-job",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("completed"),
        progress: 100,
        returnvalue: {
          status: "completed",
          processedPages: 3,
          failedPages: 0,
          indexedChunks: 12,
        },
      });

      const result = await getCrawlJob("successful-job");

      expect(result.state).toBe("completed");
      expect(result.isSuccess).toBe(true);
      expect(result.failedReason).toBeNull();
      expect(result.result.processedPages).toBe(3);
    });

    it("preserves sanitized error reasons for failed jobs", async () => {
      mocks.getJob.mockResolvedValue({
        id: "failed-job",
        data: { url: "https://example.com/" },
        getState: vi.fn().mockResolvedValue("failed"),
        progress: 5,
        failedReason: "Crawl failed: no pages were processed successfully for https://example.com/",
        returnvalue: null,
      });

      const result = await getCrawlJob("failed-job");

      expect(result.state).toBe("failed");
      expect(result.isSuccess).toBe(false);
      expect(result.failedReason).toBe(
        "Crawl failed: no pages were processed successfully for https://example.com/"
      );
    });
  });
});
