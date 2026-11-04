import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnrecoverableError } from "bullmq";

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  validatePublicHttpUrl: vi.fn(),
  launch: vi.fn(),
  browserNewPage: vi.fn(),
  browserClose: vi.fn(),
  pageClose: vi.fn(),
  setRequestInterception: vi.fn(),
  setDefaultNavigationTimeout: vi.fn(),
  setDefaultTimeout: vi.fn(),
  setUserAgent: vi.fn(),
  goto: vi.fn(),
  waitForFunction: vi.fn(),
  evaluate: vi.fn(),
  setRequestHandler: vi.fn(),
  qdrantCount: vi.fn(),
  ensureCollection: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    get: mocks.axiosGet,
  },
}));

vi.mock("puppeteer", () => ({
  default: {
    launch: mocks.launch,
  },
}));

vi.mock("../security/urlSafety.js", () => ({
  validatePublicHttpUrl: mocks.validatePublicHttpUrl,
}));

vi.mock("./crawlCheckpoint.service.js", () => ({
  getPageCheckpoint: vi.fn().mockResolvedValue(null),
  savePageCheckpoint: vi.fn().mockResolvedValue(undefined),
  getPageState: vi.fn().mockResolvedValue(null),
  savePageState: vi.fn().mockResolvedValue(undefined),
  closeCheckpointClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/qdrant.js", () => ({
  qdrantClient: {
    count: mocks.qdrantCount,
  },
  ensureCollection: mocks.ensureCollection,
  QDRANT_COLLECTION: "website_support_chunks",
}));

import { scrapeWebsite } from "./scraper.service.js";
import { processCrawlJob } from "./crawlJobProcessor.js";
import { getVectorCount } from "./vectorStore.service.js";

function mockBrowserInstance({
  head = "PrepAI - Master Your Next Technical Interview",
  body = "Welcome to PrepAI. ".repeat(25),
  links = ["https://prepai-app.vercel.app/features"],
} = {}) {
  const page = {
    setDefaultNavigationTimeout: mocks.setDefaultNavigationTimeout,
    setDefaultTimeout: mocks.setDefaultTimeout,
    setRequestInterception: mocks.setRequestInterception,
    setUserAgent: mocks.setUserAgent,
    on: mocks.setRequestHandler,
    goto: mocks.goto,
    waitForFunction: mocks.waitForFunction,
    evaluate: mocks.evaluate,
    close: mocks.pageClose,
  };

  const browser = {
    newPage: mocks.browserNewPage,
    close: mocks.browserClose,
  };

  mocks.launch.mockResolvedValue(browser);
  mocks.browserNewPage.mockResolvedValue(page);
  mocks.pageClose.mockResolvedValue(undefined);
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.setRequestInterception.mockResolvedValue(undefined);
  mocks.setUserAgent.mockResolvedValue(undefined);
  mocks.goto.mockResolvedValue(undefined);
  mocks.waitForFunction.mockResolvedValue(undefined);
  mocks.evaluate.mockResolvedValue({
    head,
    body,
    links,
  });

  return { browser, page };
}

describe("Pipeline Regression & Reliability Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUPPETEER_NO_SANDBOX = "true";
    mocks.validatePublicHttpUrl.mockResolvedValue(undefined);
    mocks.ensureCollection.mockResolvedValue("website_support_chunks");
    mocks.qdrantCount.mockResolvedValue({ count: 0 });
  });

  describe("Regression: CSR / React App Scrape", () => {
    it("successfully falls back to browser and waits for hydration when static HTML is an empty SPA shell", async () => {
      const spaUrl = "https://prepai-app.vercel.app/";

      // Simulate Vite/React static shell: empty #root container (< 200 chars)
      mocks.axiosGet.mockResolvedValue({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        data: `<!doctype html><html><head><title>PrepAI</title></head><body><div id="root"></div></body></html>`,
      });

      mockBrowserInstance({
        head: "PrepAI - Interview Prep",
        body: "Comprehensive technical interview practice and behavioral preparation. ".repeat(10),
      });

      const result = await scrapeWebsite(spaUrl);

      expect(result.body.length).toBeGreaterThanOrEqual(200);
      expect(result.head).toBe("PrepAI - Interview Prep");
      expect(mocks.launch).toHaveBeenCalledOnce();
      expect(mocks.setUserAgent).toHaveBeenCalledOnce();
      expect(mocks.waitForFunction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ timeout: 5000 }),
        200
      );
    });
  });

  describe("Regression: Non-Retryable Error Classification", () => {
    it("marks empty/unscrapeable websites as UnrecoverableError so BullMQ does not loop retries", async () => {
      const job = {
        id: "job-permanent-fail-1",
        data: { url: "https://empty-app.example.com/" },
        updateProgress: vi.fn().mockResolvedValue(undefined),
      };

      // Both static and browser return unextractable text
      mocks.axiosGet.mockResolvedValue({
        status: 200,
        headers: { "content-type": "text/html" },
        data: "<html><body>Short</body></html>",
      });

      mockBrowserInstance({
        body: "Still too short",
      });

      await expect(processCrawlJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe("Regression: Vector Count Site Scoping", () => {
    it("filters count by websiteUrl payload field to avoid showing global cluster count", async () => {
      mocks.qdrantCount.mockResolvedValue({ count: 42 });

      const count = await getVectorCount("https://prepai-app.vercel.app");

      expect(count).toBe(42);
      expect(mocks.qdrantCount).toHaveBeenCalledWith(
        "website_support_chunks",
        expect.objectContaining({
          exact: true,
          filter: {
            must: [
              {
                key: "websiteUrl",
                match: { value: "https://prepai-app.vercel.app" },
              },
            ],
          },
        })
      );
    });
  });
});
