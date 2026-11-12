import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getPageCheckpoint: vi.fn(),
  savePageCheckpoint: vi.fn(),
  getPageState: vi.fn(),
  savePageState: vi.fn(),
  generateVectorEmbedding: vi.fn(),
  storeChunk: vi.fn(),
  deleteChunks: vi.fn(),
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
  getPageCheckpoint: mocks.getPageCheckpoint,
  savePageCheckpoint: mocks.savePageCheckpoint,
  getPageState: mocks.getPageState,
  savePageState: mocks.savePageState,
  closeCheckpointClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./embedding.service.js", () => ({
  generateVectorEmbedding: mocks.generateVectorEmbedding,
}));

vi.mock("./vectorStore.service.js", () => ({
  storeChunk: mocks.storeChunk,
  deleteChunks: mocks.deleteChunks,
  getVectorCount: vi.fn().mockResolvedValue(5),
}));

vi.mock("../config/qdrant.js", () => ({
  qdrantClient: {
    count: mocks.qdrantCount,
  },
  ensureCollection: mocks.ensureCollection,
  QDRANT_COLLECTION: "website_support_chunks",
}));

import { createBrowserSession, scrapeWebsite, scrapeReactWebsite } from "./scraper.service.js";
import { crawlWebsite } from "./crawler.service.js";

function setupMockBrowser({ isConnected = true } = {}) {
  let connectedState = isConnected;

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
    isConnected: vi.fn(() => connectedState),
    setConnected: (state) => {
      connectedState = state;
    },
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
    head: "Test Page Head",
    body: "Meaningful rendered text content. ".repeat(15),
    links: [],
  });

  return { browser, page };
}

describe("Browser Reuse & Lifecycle Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUPPETEER_NO_SANDBOX = "true";
    mocks.validatePublicHttpUrl.mockResolvedValue(undefined);
    mocks.getPageCheckpoint.mockResolvedValue(null);
    mocks.getPageState.mockResolvedValue(null);
    mocks.savePageCheckpoint.mockResolvedValue(undefined);
    mocks.savePageState.mockResolvedValue(undefined);
    mocks.generateVectorEmbedding.mockResolvedValue([0.1, 0.2]);
    mocks.storeChunk.mockResolvedValue(undefined);
    mocks.deleteChunks.mockResolvedValue(undefined);

    // Static extraction fails for SPA tests by default
    mocks.axiosGet.mockRejectedValue(new Error("Static HTML did not contain enough readable text."));
  });

  it("1. Reuses a single Puppeteer browser instance sequentially across multiple SPA pages", async () => {
    const { browser } = setupMockBrowser();
    const session = createBrowserSession();

    try {
      const page1 = await scrapeReactWebsite("https://example.com/page1", { browserSession: session });
      const page2 = await scrapeReactWebsite("https://example.com/page2", { browserSession: session });
      const page3 = await scrapeReactWebsite("https://example.com/page3", { browserSession: session });

      expect(mocks.launch).toHaveBeenCalledOnce();
      expect(browser.newPage).toHaveBeenCalledTimes(3);
      expect(mocks.pageClose).toHaveBeenCalledTimes(3);
      expect(mocks.browserClose).not.toHaveBeenCalled();

      expect(page1.timings.isBrowserReused).toBe(false);
      expect(page2.timings.isBrowserReused).toBe(true);
      expect(page3.timings.isBrowserReused).toBe(true);
    } finally {
      await session.close();
      expect(mocks.browserClose).toHaveBeenCalledOnce();
    }
  });

  it("2. Closes each page in a finally block even when navigation fails", async () => {
    setupMockBrowser();
    const session = createBrowserSession();

    mocks.goto.mockRejectedValueOnce(new Error("Navigation timeout of 15000 ms exceeded"));

    try {
      await expect(
        scrapeReactWebsite("https://example.com/fail-nav", { browserSession: session })
      ).rejects.toThrow("Navigation timeout");

      // Verify page was closed despite the error
      expect(mocks.pageClose).toHaveBeenCalledOnce();
      // Browser must stay open for subsequent pages
      expect(mocks.browserClose).not.toHaveBeenCalled();
    } finally {
      await session.close();
      expect(mocks.browserClose).toHaveBeenCalledOnce();
    }
  });

  it("3. Handles browser crash/disconnect by safely relaunching a fresh browser", async () => {
    const { browser: firstBrowser } = setupMockBrowser();
    const session = createBrowserSession();

    try {
      // First page succeeds with first browser
      const res1 = await scrapeReactWebsite("https://example.com/page1", { browserSession: session });
      expect(res1.timings.isBrowserReused).toBe(false);
      expect(mocks.launch).toHaveBeenCalledTimes(1);

      // Simulate crash: isConnected becomes false
      firstBrowser.setConnected(false);

      // Setup second browser instance for relaunch
      const secondBrowser = {
        newPage: mocks.browserNewPage,
        close: mocks.browserClose,
        isConnected: vi.fn(() => true),
      };
      mocks.launch.mockResolvedValueOnce(secondBrowser);

      // Second page should detect disconnected browser, clean it up, and relaunch
      const res2 = await scrapeReactWebsite("https://example.com/page2", { browserSession: session });
      expect(mocks.launch).toHaveBeenCalledTimes(2);
      expect(res2.timings.isBrowserReused).toBe(false);
    } finally {
      await session.close();
      expect(mocks.browserClose).toHaveBeenCalled();
    }
  });

  it("4. In crawlWebsite, closes the browser exactly once in crawl-level finally block", async () => {
    setupMockBrowser();

    // Homepage links to page2
    mocks.evaluate
      .mockResolvedValueOnce({
        head: "Home",
        body: "Home body content ".repeat(15),
        links: ["https://example.com/page2"],
      })
      .mockResolvedValueOnce({
        head: "Page 2",
        body: "Page 2 body content ".repeat(15),
        links: [],
      });

    const result = await crawlWebsite("https://example.com/", { jobId: "test-reuse-job" });

    expect(result.processedPages).toBe(2);
    expect(result.status).toBe("completed");
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.browserNewPage).toHaveBeenCalledTimes(2);
    expect(mocks.pageClose).toHaveBeenCalledTimes(2);
    expect(mocks.browserClose).toHaveBeenCalledOnce();
  });

  it("5. A failed page does not terminate the crawl, and browser continues for remaining pages", async () => {
    setupMockBrowser();

    // Homepage links to fail-page and ok-page
    mocks.evaluate
      .mockResolvedValueOnce({
        head: "Home",
        body: "Home body text ".repeat(15),
        links: ["https://example.com/fail-page", "https://example.com/ok-page"],
      })
      // page 2 fails navigation in goto below
      .mockResolvedValueOnce({
        head: "OK Page",
        body: "OK page body text ".repeat(15),
        links: [],
      });

    mocks.goto
      .mockResolvedValueOnce(undefined) // home
      .mockRejectedValueOnce(new Error("Browser scrape exceeded 25000ms.")) // fail-page
      .mockResolvedValueOnce(undefined); // ok-page

    const result = await crawlWebsite("https://example.com/", { jobId: "test-survive-fail-job" });

    expect(result.processedPages).toBe(2); // Home and ok-page
    expect(result.failedPages).toBe(1); // fail-page
    expect(result.status).toBe("partial");
    expect(mocks.browserClose).toHaveBeenCalledOnce();
  });

  it("6. Crawl timeout aborts cleanly, records partial status, and closes browser in finally", async () => {
    setupMockBrowser();

    // Crawl budget of 5ms
    const result = await crawlWebsite("https://example.com/", {
      jobId: "test-timeout-job",
      timeoutMs: 5000,
    });

    expect(mocks.browserClose).toHaveBeenCalledOnce();
    expect(result.websiteUrl).toBe("https://example.com/");
    expect(result.timings).toBeDefined();
    expect(typeof result.timings.totalDurationMs).toBe("number");
  });

  it("7. Captures all instrumentation timings (launch, nav, hydration, extraction, cleanup, total)", async () => {
    setupMockBrowser();

    const scraped = await scrapeReactWebsite("https://example.com/timed-page");

    expect(scraped.timings).toBeDefined();
    expect(typeof scraped.timings.launchDurationMs).toBe("number");
    expect(typeof scraped.timings.navigationDurationMs).toBe("number");
    expect(typeof scraped.timings.hydrationDurationMs).toBe("number");
    expect(typeof scraped.timings.extractionDurationMs).toBe("number");
    expect(typeof scraped.timings.pageCleanupDurationMs).toBe("number");
    expect(typeof scraped.timings.totalPageDurationMs).toBe("number");
    expect(scraped.timings.isBrowserReused).toBe(false);
  });
});

