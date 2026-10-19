import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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
    goto: vi.fn(),
    evaluate: vi.fn(),
    setRequestHandler: vi.fn(),
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

import {
    scrapeStaticWebsite,
    scrapeReactWebsite,
    scrapeWebsite,
} from "./scraper.service.js";

const URL = "https://example.com/";

function htmlWithText(text = "A".repeat(300), links = "") {
    return `
        <!doctype html>
        <html>
            <head><title>Example</title></head>
            <body>
                <main>${text}</main>
                ${links}
            </body>
        </html>
    `;
}

function mockBrowser({
    body = "Rendered website content ".repeat(20),
    links = [],
} = {}) {
    const page = {
        setDefaultNavigationTimeout: mocks.setDefaultNavigationTimeout,
        setDefaultTimeout: mocks.setDefaultTimeout,
        setRequestInterception: mocks.setRequestInterception,
        on: mocks.setRequestHandler,
        goto: mocks.goto,
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
    mocks.goto.mockResolvedValue(undefined);
    mocks.evaluate.mockResolvedValue({
        head: "Example website",
        body,
        links,
    });

    return { browser, page };
}

beforeEach(() => {
    vi.clearAllMocks();

    process.env.PUPPETEER_NO_SANDBOX = "true";

    mocks.validatePublicHttpUrl.mockResolvedValue(undefined);

    mocks.axiosGet.mockResolvedValue({
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
        },
        data: htmlWithText(),
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("scrapeStaticWebsite", () => {
    it("extracts readable HTML without launching a browser", async () => {
        const result = await scrapeStaticWebsite(URL);

        expect(result.body.length).toBeGreaterThanOrEqual(200);
        expect(mocks.validatePublicHttpUrl).toHaveBeenCalledWith(URL);
        expect(mocks.axiosGet).toHaveBeenCalledWith(
            URL,
            expect.objectContaining({
                timeout: expect.any(Number),
                maxRedirects: 0,
            }),
        );
        expect(mocks.launch).not.toHaveBeenCalled();
    });

    it("classifies relative and absolute same-origin links as internal", async () => {
        mocks.axiosGet.mockResolvedValue({
            status: 200,
            headers: { "content-type": "text/html" },
            data: htmlWithText(
                "A".repeat(300),
                `
                    <a href="/about">About</a>
                    <a href="https://example.com/pricing">Pricing</a>
                    <a href="https://other.example.org/">Other</a>
                `,
            ),
        });

        const result = await scrapeStaticWebsite(URL);

        expect(result.internalLinks).toContain("https://example.com/about");
        expect(result.internalLinks).toContain("https://example.com/pricing");
        expect(result.externalLinks).toContain("https://other.example.org/");
    });

    it("rejects non-HTML responses", async () => {
        mocks.axiosGet.mockResolvedValue({
            status: 200,
            headers: { "content-type": "application/pdf" },
            data: "not html",
        });

        await expect(scrapeStaticWebsite(URL)).rejects.toThrow(
            "The URL did not return an HTML page.",
        );
    });

    it("rejects pages with insufficient readable text", async () => {
        mocks.axiosGet.mockResolvedValue({
            status: 200,
            headers: { "content-type": "text/html" },
            data: htmlWithText("Too short"),
        });

        await expect(scrapeStaticWebsite(URL)).rejects.toThrow(
            "Static HTML did not contain enough readable text.",
        );
    });
});

describe("scrapeReactWebsite", () => {
    it("extracts rendered content and closes the page and browser", async () => {
        mockBrowser({
            links: [
                "https://example.com/about",
                "https://external.example.org/docs",
                "https://example.com/about#team",
            ],
        });

        const result = await scrapeReactWebsite(URL);

        expect(result.body).toContain("Rendered website content");
        expect(result.internalLinks).toEqual([
            "https://example.com/about",
        ]);
        expect(result.externalLinks).toEqual([
            "https://external.example.org/docs",
        ]);

        expect(mocks.launch).toHaveBeenCalledOnce();
        expect(mocks.goto).toHaveBeenCalledWith(
            URL,
            expect.objectContaining({
                waitUntil: "domcontentloaded",
                timeout: expect.any(Number),
            }),
        );

        expect(mocks.pageClose).toHaveBeenCalledOnce();
        expect(mocks.browserClose).toHaveBeenCalledOnce();
    });

    it("closes the page and browser when navigation fails", async () => {
        mockBrowser();
        mocks.goto.mockRejectedValue(
            new Error("Navigation timeout of 15000 ms exceeded"),
        );

        await expect(scrapeReactWebsite(URL)).rejects.toThrow(
            "Navigation timeout",
        );

        expect(mocks.pageClose).toHaveBeenCalledOnce();
        expect(mocks.browserClose).toHaveBeenCalledOnce();
    });

    it("rejects rendered pages with insufficient readable text", async () => {
        mockBrowser({ body: "Too short" });

        await expect(scrapeReactWebsite(URL)).rejects.toThrow(
            "Browser rendering did not produce enough readable text.",
        );

        expect(mocks.pageClose).toHaveBeenCalledOnce();
        expect(mocks.browserClose).toHaveBeenCalledOnce();
    });

    it("attempts browser cleanup when creating a page fails", async () => {
        const browser = {
            newPage: mocks.browserNewPage,
            close: mocks.browserClose,
        };

        mocks.launch.mockResolvedValue(browser);
        mocks.browserNewPage.mockRejectedValue(
            new Error("Could not create browser page"),
        );
        mocks.browserClose.mockResolvedValue(undefined);

        await expect(scrapeReactWebsite(URL)).rejects.toThrow(
            "Could not create browser page",
        );

        expect(mocks.browserClose).toHaveBeenCalledOnce();
    });
    it("limits concurrent browser scrapes to one active browser", async () => {
        let activeBrowsers = 0;
        let maxActiveBrowsers = 0;

        let releaseFirstNavigation;

        const firstNavigation = new Promise((resolve) => {
            releaseFirstNavigation = resolve;
        });

        mocks.goto
            .mockImplementationOnce(async () => {
                activeBrowsers++;
                maxActiveBrowsers = Math.max(
                    maxActiveBrowsers,
                    activeBrowsers,
                );

                await firstNavigation;

                activeBrowsers--;
            })
            .mockImplementationOnce(async () => {
                activeBrowsers++;
                maxActiveBrowsers = Math.max(
                    maxActiveBrowsers,
                    activeBrowsers,
                );

                activeBrowsers--;
            });

        mockBrowser();

        const firstScrape = scrapeReactWebsite(URL);

        // Allow the first scrape to begin before starting the second.
        await vi.waitFor(() => {
            expect(mocks.goto).toHaveBeenCalledTimes(1);
        });

        const secondScrape = scrapeReactWebsite(
            "https://example.com/second",
        );

        releaseFirstNavigation();

        await Promise.all([firstScrape, secondScrape]);

        expect(maxActiveBrowsers).toBe(1);
    });
    it("validates redirect destinations before requesting them", async () => {
        mocks.axiosGet
            .mockResolvedValueOnce({
                status: 302,
                headers: {
                    location: "https://example.com/redirected",
                },
                data: "",
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {
                    "content-type": "text/html",
                },
                data: htmlWithText(),
            });

        await scrapeStaticWebsite(URL);

        expect(mocks.validatePublicHttpUrl).toHaveBeenCalledWith(
            "https://example.com/redirected",
        );

        expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
    });

    it("does not request a redirect destination rejected by URL validation", async () => {
        mocks.axiosGet.mockResolvedValueOnce({
            status: 302,
            headers: {
                location: "http://127.0.0.1/admin",
            },
            data: "",
        });

        mocks.validatePublicHttpUrl.mockImplementation(async (url) => {
            if (url.includes("127.0.0.1")) {
                throw new Error("Blocked private address");
            }
        });

        await expect(scrapeStaticWebsite(URL)).rejects.toThrow(
            "Blocked private address",
        );

        expect(mocks.axiosGet).toHaveBeenCalledOnce();
    });
});

describe("scrapeWebsite", () => {
    it("falls back to browser scraping when static extraction fails", async () => {
        mocks.axiosGet.mockRejectedValue(new Error("Static request failed"));
        mockBrowser();

        const result = await scrapeWebsite(URL);

        expect(result.body).toContain("Rendered website content");
        expect(mocks.launch).toHaveBeenCalledOnce();
    });

    it("reports both failures when static and browser extraction fail", async () => {
        mocks.axiosGet.mockRejectedValue(new Error("Static request failed"));
        mockBrowser();

        mocks.goto.mockRejectedValue(new Error("Browser navigation failed"));

        await expect(scrapeWebsite(URL)).rejects.toThrow(
            /Static: Static request failed.*Browser: Browser navigation failed/,
        );

        expect(mocks.pageClose).toHaveBeenCalledOnce();
        expect(mocks.browserClose).toHaveBeenCalledOnce();
    });
});
