
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnrecoverableError } from "bullmq";

const { crawlWebsite } = vi.hoisted(() => ({
  crawlWebsite: vi.fn(),
}));

vi.mock("./crawler.service.js", () => ({
  crawlWebsite,
}));

import { processCrawlJob } from "./crawlJobProcessor.js";

describe("processCrawlJob", () => {
  let job;

  beforeEach(() => {
    vi.clearAllMocks();

    job = {
      id: "job-123",
      data: {
        url: "https://example.com/",
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("reports page progress and returns a successful crawl result", async () => {
    const result = {
      status: "completed",
      processedPages: 5,
      failedPages: 0,
      indexedChunks: 20,
    };

    crawlWebsite.mockImplementation(async (url, options) => {
      expect(url).toBe("https://example.com/");
      expect(options.jobId).toBe("job-123");
      expect(options.onProgress).toEqual(expect.any(Function));

      await options.onProgress({
        processedPages: 5,
        discoveredPages: 5,
        failedPages: 0,
        maxPages: 20,
      });

      return result;
    });

    const returnedResult = await processCrawlJob(job);

    expect(crawlWebsite).toHaveBeenCalledTimes(1);
    expect(job.updateProgress).toHaveBeenNthCalledWith(1, 5);
    expect(job.updateProgress).toHaveBeenNthCalledWith(2, 24);
    expect(job.updateProgress).toHaveBeenNthCalledWith(3, 100);
    expect(returnedResult).toEqual(result);
  });

  it("returns partial results without throwing", async () => {
    const result = {
      status: "partial",
      processedPages: 3,
      failedPages: 2,
      indexedChunks: 12,
    };

    crawlWebsite.mockResolvedValue(result);

    await expect(processCrawlJob(job)).resolves.toEqual(result);

    expect(job.updateProgress).toHaveBeenNthCalledWith(1, 5);
    expect(job.updateProgress).toHaveBeenNthCalledWith(2, 100);
  });

  it("throws UnrecoverableError when the crawl result is failed", async () => {
    crawlWebsite.mockResolvedValue({
      status: "failed",
      processedPages: 0,
      failedPages: 5,
      indexedChunks: 0,
    });

    await expect(processCrawlJob(job)).rejects.toThrow(
      "Crawl failed: no pages were processed successfully for https://example.com/"
    );
    await expect(processCrawlJob(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(job.updateProgress).toHaveBeenCalledTimes(2);
    expect(job.updateProgress).toHaveBeenCalledWith(5);
  });

  it("throws UnrecoverableError when the starting URL fails security validation", async () => {
    crawlWebsite.mockRejectedValue(
      new Error("Starting URL failed security validation: Private network not allowed")
    );

    await expect(processCrawlJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("propagates infrastructure errors as retryable errors", async () => {
    const error = new Error("Qdrant unavailable");
    crawlWebsite.mockRejectedValue(error);

    await expect(processCrawlJob(job)).rejects.toThrow("Qdrant unavailable");
    await expect(processCrawlJob(job)).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("propagates progress callback errors", async () => {
    crawlWebsite.mockImplementation(async (url, options) => {
      await options.onProgress({
        processedPages: 1,
        discoveredPages: 1,
        failedPages: 0,
        maxPages: 20,
      });

      return {
        status: "completed",
        processedPages: 1,
        failedPages: 0,
        indexedChunks: 2,
      };
    });

    job.updateProgress
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Progress update failed"));

    await expect(processCrawlJob(job)).rejects.toThrow(
      "Progress update failed"
    );
  });
});