import { describe, it, expect, vi } from "vitest";
import http from "node:http";

vi.mock("../security/urlSafety.js", () => ({
  validatePublicHttpUrl: vi.fn().mockResolvedValue(undefined),
}));

import { createBrowserSession, scrapeReactWebsite } from "./scraper.service.js";

describe("Live Local Benchmark: Cold Launch vs Browser Reuse", () => {
  it("benchmarks 4 pages with real Puppeteer headless browser", async () => {
    // Spin up real local HTTP server
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!doctype html>
        <html>
          <head><title>Page ${req.url}</title></head>
          <body>
            <div id="root">Loading...</div>
            <script>
              setTimeout(() => {
                document.getElementById('root').innerHTML =
                  '<h1>Page ${req.url}</h1>' +
                  '<p>' + 'Meaningful client-side hydrated content for testing browser reuse performance. '.repeat(10) + '</p>' +
                  '<a href="/page1">P1</a> <a href="/page2">P2</a> <a href="/page3">P3</a> <a href="/page4">P4</a>';
              }, 100);
            </script>
          </body>
        </html>
      `);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const urls = [
      `${baseUrl}/page1`,
      `${baseUrl}/page2`,
      `${baseUrl}/page3`,
      `${baseUrl}/page4`,
    ];

    try {
      // Phase A: Baseline (Cold launch & close per page)
      console.log("\n=======================================================");
      console.log("--> BENCHMARK PHASE A: Baseline (Cold launch per page)");
      const baselineStart = Date.now();
      const baselineTimings = [];

      for (let i = 0; i < urls.length; i++) {
        const pageStart = Date.now();
        const scraped = await scrapeReactWebsite(urls[i]);
        const duration = Date.now() - pageStart;
        baselineTimings.push({ duration, ...scraped.timings });
        console.log(`[Baseline] Page ${i + 1}: ${duration}ms (launch: ${scraped.timings.launchDurationMs}ms, nav: ${scraped.timings.navigationDurationMs}ms, hydration: ${scraped.timings.hydrationDurationMs}ms)`);
      }
      const baselineTotal = Date.now() - baselineStart;

      // Phase B: Browser Reuse (Single browser session across 4 pages)
      console.log("\n--> BENCHMARK PHASE B: With Browser Reuse (Single session)");
      const reuseStart = Date.now();
      const reuseTimings = [];
      const session = createBrowserSession();

      try {
        for (let i = 0; i < urls.length; i++) {
          const pageStart = Date.now();
          const scraped = await scrapeReactWebsite(urls[i], { browserSession: session });
          const duration = Date.now() - pageStart;
          reuseTimings.push({ duration, ...scraped.timings });
          console.log(`[Reused]   Page ${i + 1}: ${duration}ms (reused: ${scraped.timings.isBrowserReused}, launch: ${scraped.timings.launchDurationMs}ms, nav: ${scraped.timings.navigationDurationMs}ms, hydration: ${scraped.timings.hydrationDurationMs}ms)`);
        }
      } finally {
        await session.close();
      }
      const reuseTotal = Date.now() - reuseStart;

      console.log("\n=======================================================");
      console.log("LOCAL BENCHMARK MEASURED RESULTS (4 Pages):");
      console.log(`- Baseline (Cold Launch): ${baselineTotal}ms total (avg ${Math.round(baselineTotal / 4)}ms/page)`);
      console.log(`- Browser Reuse:          ${reuseTotal}ms total (avg ${Math.round(reuseTotal / 4)}ms/page)`);
      console.log(`- Absolute time saved:    ${baselineTotal - reuseTotal}ms`);
      console.log(`- Speedup:                ${((baselineTotal - reuseTotal) / baselineTotal * 100).toFixed(1)}% faster (${(baselineTotal / reuseTotal).toFixed(2)}x)`);
      console.log("=======================================================\n");

      expect(reuseTotal).toBeLessThan(baselineTotal);
      expect(reuseTimings[1].isBrowserReused).toBe(true);
      expect(reuseTimings[2].isBrowserReused).toBe(true);
      expect(reuseTimings[3].isBrowserReused).toBe(true);
      expect(reuseTimings[1].launchDurationMs).toBe(0);
      expect(reuseTimings[2].launchDurationMs).toBe(0);
      expect(reuseTimings[3].launchDurationMs).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60000);
});

