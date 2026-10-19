
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  scrapeWebsite: vi.fn(),
  chunkText: vi.fn(),
  generateVectorEmbedding: vi.fn(),
  storeChunk: vi.fn(),
  getVectorCount: vi.fn(),
  deleteChunks: vi.fn(),
  validatePublicHttpUrl: vi.fn(),
  getPageCheckpoint: vi.fn(),
  savePageCheckpoint: vi.fn(),
  getPageState: vi.fn(),
  savePageState: vi.fn(),
}));

vi.mock("./scraper.service.js", () => ({
  scrapeWebsite: mocks.scrapeWebsite,
}));

vi.mock("./chunking.service.js", () => ({
  chunkText: mocks.chunkText,
}));

vi.mock("./embedding.service.js", () => ({
  generateVectorEmbedding: mocks.generateVectorEmbedding,
}));

vi.mock("./vectorStore.service.js", () => ({
  storeChunk: mocks.storeChunk,
  getVectorCount: mocks.getVectorCount,
  deleteChunks: mocks.deleteChunks,
}));

vi.mock("../security/urlSafety.js", () => ({
  validatePublicHttpUrl: mocks.validatePublicHttpUrl,
}));

vi.mock("./crawlCheckpoint.service.js", () => ({
  getPageCheckpoint: mocks.getPageCheckpoint,
  savePageCheckpoint: mocks.savePageCheckpoint,
  getPageState: mocks.getPageState,
  savePageState: mocks.savePageState,
}));

import { crawlWebsite } from "./crawler.service.js";

describe("crawlWebsite", () => {
  const url = "https://example.com/";
  const jobId = "job-123";

  const defaultHead = "Example website title";
  const defaultBody = "Example website body";

  function hashContent(head, body) {
    return createHash("sha256")
      .update(head)
      .update("\0")
      .update(body)
      .digest("hex");
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.validatePublicHttpUrl.mockResolvedValue(undefined);
    mocks.getPageCheckpoint.mockResolvedValue(null);
    mocks.getPageState.mockResolvedValue(null);

    mocks.scrapeWebsite.mockResolvedValue({
      head: defaultHead,
      body: defaultBody,
      internalLinks: [],
    });

    mocks.chunkText.mockReturnValue(["First chunk", "Second chunk"]);
    mocks.generateVectorEmbedding.mockResolvedValue([0.1, 0.2]);
    mocks.storeChunk.mockResolvedValue(undefined);
    mocks.deleteChunks.mockResolvedValue(undefined);
    mocks.savePageCheckpoint.mockResolvedValue(undefined);
    mocks.savePageState.mockResolvedValue(undefined);
    mocks.getVectorCount.mockResolvedValue(3);
  });

  it("reports progress after a page is indexed and checkpointed", async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);

    const result = await crawlWebsite(url, {
      jobId,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({
      processedPages: 1,
      discoveredPages: 1,
      failedPages: 0,
      maxPages: 20,
    });

    expect(mocks.savePageCheckpoint).toHaveBeenCalled();
    expect(result.processedPages).toBe(1);
  });

  it("indexes page content and saves page state and checkpoint", async () => {
    const contentHash = hashContent(defaultHead, defaultBody);

    const result = await crawlWebsite(url, { jobId });

    expect(mocks.scrapeWebsite).toHaveBeenCalledWith(url);
    expect(mocks.generateVectorEmbedding).toHaveBeenCalledTimes(3);
    expect(mocks.storeChunk).toHaveBeenCalledTimes(3);

    expect(mocks.savePageState).toHaveBeenCalledWith(
      url,
      {
        contentHash,
        chunkIds: [
          `${url}::${contentHash}::head`,
          `${url}::${contentHash}::chunk-0`,
          `${url}::${contentHash}::chunk-1`,
        ],
        indexedChunks: 2,
      }
    );

    expect(mocks.savePageCheckpoint).toHaveBeenCalledWith(
      jobId,
      url,
      {
        indexedChunks: 2,
        internalLinks: [],
      }
    );

    expect(result).toMatchObject({
      processedPages: 1,
      failedPages: 0,
      indexedChunks: 2,
      status: "completed",
    });

    expect(mocks.deleteChunks).toHaveBeenCalledWith([]);
  });

  it("skips embedding and vector writes when content is unchanged", async () => {
    const contentHash = hashContent(defaultHead, defaultBody);

    mocks.getPageState.mockResolvedValue({
      contentHash,
      chunkIds: [
        `${url}::${contentHash}::head`,
        `${url}::${contentHash}::chunk-0`,
        `${url}::${contentHash}::chunk-1`,
      ],
      indexedChunks: 2,
    });

    const result = await crawlWebsite(url, { jobId });

    expect(mocks.scrapeWebsite).toHaveBeenCalledOnce();
    expect(mocks.generateVectorEmbedding).not.toHaveBeenCalled();
    expect(mocks.storeChunk).not.toHaveBeenCalled();
    expect(mocks.deleteChunks).not.toHaveBeenCalled();
    expect(mocks.savePageState).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      processedPages: 1,
      indexedChunks: 2,
      status: "completed",
    });

    expect(mocks.savePageCheckpoint).toHaveBeenCalledWith(
      jobId,
      url,
      {
        indexedChunks: 2,
        internalLinks: [],
      }
    );
  });

  it("re-indexes changed content and deletes stale chunks", async () => {
    const oldHash = "old-content-hash";

    mocks.getPageState.mockResolvedValue({
      contentHash: oldHash,
      chunkIds: [
        `${url}::${oldHash}::head`,
        `${url}::${oldHash}::chunk-0`,
        `${url}::${oldHash}::chunk-1`,
        `${url}::${oldHash}::chunk-2`,
      ],
      indexedChunks: 3,
    });

    mocks.chunkText.mockReturnValue(["Updated chunk"]);

    const newHash = hashContent(defaultHead, defaultBody);

    await crawlWebsite(url, { jobId });

    expect(mocks.generateVectorEmbedding).toHaveBeenCalledTimes(2);
    expect(mocks.storeChunk).toHaveBeenCalledTimes(2);

    expect(mocks.deleteChunks).toHaveBeenCalledWith([
      `${url}::${oldHash}::head`,
      `${url}::${oldHash}::chunk-0`,
      `${url}::${oldHash}::chunk-1`,
      `${url}::${oldHash}::chunk-2`,
    ]);

    expect(mocks.savePageState).toHaveBeenCalledWith(
      url,
      {
        contentHash: newHash,
        chunkIds: [
          `${url}::${newHash}::head`,
          `${url}::${newHash}::chunk-0`,
        ],
        indexedChunks: 1,
      }
    );
  });

  it("does not save new page state when embedding fails", async () => {
    mocks.generateVectorEmbedding.mockRejectedValue(
      new Error("Gemini unavailable")
    );

    await expect(
      crawlWebsite(url, { jobId })
    ).rejects.toThrow("Gemini unavailable");

    expect(mocks.savePageState).not.toHaveBeenCalled();
    expect(mocks.savePageCheckpoint).not.toHaveBeenCalled();
  });

  it("skips a page that already has a valid job checkpoint", async () => {
    mocks.getPageCheckpoint.mockResolvedValue({
      indexedChunks: 4,
      internalLinks: [],
    });

    const result = await crawlWebsite(url, { jobId });

    expect(mocks.scrapeWebsite).not.toHaveBeenCalled();
    expect(mocks.storeChunk).not.toHaveBeenCalled();
    expect(mocks.getPageState).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      processedPages: 1,
      indexedChunks: 4,
      status: "completed",
    });
  });

  it("crawls same-origin links but rejects external links", async () => {
    mocks.scrapeWebsite
      .mockResolvedValueOnce({
        head: defaultHead,
        body: defaultBody,
        internalLinks: [
          "https://example.com/about",
          "https://another-site.com/private",
        ],
      })
      .mockResolvedValueOnce({
        head: "About page",
        body: "About page body",
        internalLinks: [],
      });

    await crawlWebsite(url, { jobId });

    expect(mocks.scrapeWebsite).toHaveBeenCalledTimes(2);
    expect(mocks.scrapeWebsite).toHaveBeenCalledWith(
      "https://example.com/"
    );
    expect(mocks.scrapeWebsite).toHaveBeenCalledWith(
      "https://example.com/about"
    );

    expect(mocks.scrapeWebsite).not.toHaveBeenCalledWith(
      "https://another-site.com/private"
    );
  });

  it("rejects a starting URL that fails security validation", async () => {
    mocks.validatePublicHttpUrl.mockRejectedValue(
      new Error("Blocked private network address")
    );

    await expect(
      crawlWebsite(url, { jobId })
    ).rejects.toThrow("Starting URL failed security validation");

    expect(mocks.scrapeWebsite).not.toHaveBeenCalled();
  });

  it("requires a BullMQ job ID for checkpointing", async () => {
    await expect(crawlWebsite(url)).rejects.toThrow(
      "crawlWebsite requires a BullMQ jobId for checkpointing."
    );
  });
});