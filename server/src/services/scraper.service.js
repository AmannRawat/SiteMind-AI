
import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import { validatePublicHttpUrl } from "../security/urlSafety.js";

// HTTP extraction limits
const STATIC_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// Browser limits
const BROWSER_TIMEOUT_MS = 15_000;
const BROWSER_OPERATION_TIMEOUT_MS = 18_000;
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;

// Resource limits
const MIN_USEFUL_TEXT_LENGTH = 200;
const MAX_CONCURRENT_BROWSER_SCRAPES = 1;
const MAX_QUEUED_BROWSER_SCRAPES = 3;
const BROWSER_QUEUE_WAIT_MS = 10_000;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

// Process-local browser queue
let activeBrowserScrapes = 0;
const browserScrapeQueue = [];

// Prevent duplicate close attempts for the same browser.
const browserClosePromises = new WeakMap();

// --------------------------------------------------
// URL helpers
// --------------------------------------------------

function normalizeUrl(value) {
    let url;

    try {
        url = new URL(value);
    } catch {
        throw new Error("A valid absolute URL is required.");
    }

    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    if (url.username || url.password) {
        throw new Error("URLs containing credentials are not allowed.");
    }

    url.hash = "";
    return url.href;
}

async function validateUrl(value) {
    const normalizedUrl = normalizeUrl(value);

    await validatePublicHttpUrl(normalizedUrl);

    return normalizedUrl;
}

// --------------------------------------------------
// Browser concurrency limiter
// --------------------------------------------------

function createRelease() {
    let released = false;

    return () => {
        if (released) return;
        released = true;

        while (browserScrapeQueue.length > 0) {
            const next = browserScrapeQueue.shift();

            if (!next || next.cancelled) continue;

            clearTimeout(next.timer);
            next.resolve(createRelease());
            return;
        }

        activeBrowserScrapes = Math.max(
            0,
            activeBrowserScrapes - 1,
        );
    };
}

function acquireBrowserSlot() {
    if (activeBrowserScrapes < MAX_CONCURRENT_BROWSER_SCRAPES) {
        activeBrowserScrapes++;
        return Promise.resolve(createRelease());
    }

    if (browserScrapeQueue.length >= MAX_QUEUED_BROWSER_SCRAPES) {
        return Promise.reject(
            new Error("Browser capacity is full. Please retry shortly."),
        );
    }

    return new Promise((resolve, reject) => {
        const entry = {
            resolve,
            reject,
            timer: null,
            cancelled: false,
        };

        entry.timer = setTimeout(() => {
            const index = browserScrapeQueue.indexOf(entry);

            if (index !== -1) {
                browserScrapeQueue.splice(index, 1);
                entry.cancelled = true;

                reject(
                    new Error("Timed out waiting for browser capacity."),
                );
            }
        }, BROWSER_QUEUE_WAIT_MS);

        browserScrapeQueue.push(entry);
    });
}

// --------------------------------------------------
// HTML and link extraction
// --------------------------------------------------

function extractLinks($, baseUrl) {
    const internalLinks = new Set();
    const externalLinks = new Set();
    const baseOrigin = new URL(baseUrl).origin;

    $("a[href]").each((_, element) => {
        const href = $(element).attr("href")?.trim();

        if (
            !href ||
            href.startsWith("#") ||
            /^(mailto:|tel:|javascript:|data:|blob:)/i.test(href)
        ) {
            return;
        }

        try {
            const parsed = new URL(href, baseUrl);

            if (!["http:", "https:"].includes(parsed.protocol)) return;
            if (parsed.username || parsed.password) return;

            parsed.hash = "";

            if (parsed.origin === baseOrigin) {
                internalLinks.add(parsed.href);
            } else {
                externalLinks.add(parsed.href);
            }
        } catch {
            // Ignore malformed links.
        }
    });

    return {
        internalLinks: [...internalLinks],
        externalLinks: [...externalLinks],
    };
}

function extractHtmlContent(html, baseUrl) {
    const $ = cheerio.load(html);

    $("script, style, noscript, iframe, svg").remove();

    const head = $("head").text().replace(/\s+/g, " ").trim();
    const body = $("body").text().replace(/\s+/g, " ").trim();

    return {
        head,
        body,
        ...extractLinks($, baseUrl),
    };
}

function hasUsefulContent(result) {
    return (
        typeof result?.body === "string" &&
        result.body.trim().length >= MIN_USEFUL_TEXT_LENGTH
    );
}

function isHtmlResponse(contentType = "") {
    return /text\/html|application\/xhtml\+xml/i.test(contentType);
}

// --------------------------------------------------
// Static HTTP scraper with validated redirects
// --------------------------------------------------

export async function scrapeStaticWebsite(inputUrl) {
    let currentUrl = await validateUrl(inputUrl);

    for (let redirectCount = 0; ; redirectCount++) {
        const response = await axios.get(currentUrl, {
            timeout: STATIC_TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: MAX_HTML_BYTES,
            responseType: "text",

            headers: {
                "User-Agent": "SiteMindAI/1.0 (+website content extraction)",
                Accept: "text/html,application/xhtml+xml",
            },

            validateStatus: (status) =>
                (status >= 200 && status < 300) ||
                [301, 302, 303, 307, 308].includes(status),
        });

        const { status } = response;

        if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;

            if (!location) {
                throw new Error(
                    "Redirect response did not include a location.",
                );
            }

            if (redirectCount >= MAX_REDIRECTS) {
                throw new Error("The page exceeded the redirect limit.");
            }

            currentUrl = await validateUrl(
                new URL(location, currentUrl).href,
            );

            continue;
        }

        if (!isHtmlResponse(response.headers["content-type"])) {
            throw new Error("The URL did not return an HTML page.");
        }

        const result = extractHtmlContent(response.data, currentUrl);

        if (!hasUsefulContent(result)) {
            throw new Error(
                "Static HTML did not contain enough readable text.",
            );
        }

        return result;
    }
}

// --------------------------------------------------
// Browser cleanup and timeout helpers
// --------------------------------------------------

function closeBrowserSafely(browser) {
    if (!browser) return Promise.resolve();

    const existingClose = browserClosePromises.get(browser);
    if (existingClose) return existingClose;

    const closePromise = (async () => {
        let timer;

        try {
            await Promise.race([
                browser.close(),

                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error("Browser close timed out."));
                    }, BROWSER_CLOSE_TIMEOUT_MS);
                }),
            ]);
        } catch (error) {
            console.error(
                `[Scraper] Browser close failed: ${error.message}`,
            );

            // Best-effort termination of the Chromium process tree.
            try {
                const child = browser.process();

                if (child && child.pid && child.exitCode === null) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    } catch {
                        child.kill("SIGKILL");
                    }
                }
            } catch {
                // The process may already have exited.
            }
        } finally {
            clearTimeout(timer);
        }
    })();

    browserClosePromises.set(browser, closePromise);

    return closePromise;
}

function withTimeout(promise, timeoutMs, message, onTimeout) {
    let timer;

    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            // Start cleanup immediately when the timeout fires.
            try {
                void Promise.resolve(onTimeout?.()).catch(() => {});
            } catch {
                // Preserve the timeout error even if cleanup fails.
            }

            reject(new Error(message));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
    });
}

// --------------------------------------------------
// Browser scraper
// --------------------------------------------------

export async function scrapeReactWebsite(inputUrl) {
    const releaseBrowserSlot = await acquireBrowserSlot();

    let browser;
    let launchTimedOut = false;

    try {
        const url = await validateUrl(inputUrl);

        const launchPromise = puppeteer.launch({
            headless: true,
            args: [
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--disable-extensions",
                "--disable-sync",
                "--disable-gpu",
                "--no-zygote",
                "--mute-audio",
                "--no-first-run",
                "--disable-speech-api",
                ...(process.env.PUPPETEER_NO_SANDBOX === "true"
                    ? ["--no-sandbox", "--disable-setuid-sandbox"]
                    : []),
            ],
        }).then((launchedBrowser) => {
            // If launch finishes after its timeout, clean up the late browser.
            if (launchTimedOut) {
                void closeBrowserSafely(launchedBrowser);
            }

            return launchedBrowser;
        });

        browser = await withTimeout(
            launchPromise,
            BROWSER_TIMEOUT_MS,
            "Browser launch timed out.",
            () => {
                launchTimedOut = true;
            },
        );

        const scrapeOperation = async () => {
            const page = await browser.newPage();

            try {
                page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);
                page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

                await page.setRequestInterception(true);

                page.on("request", (request) => {
                    void (async () => {
                        try {
                            if (request.isInterceptResolutionHandled()) return;

                            const requestUrl = request.url();
                            const protocol = new URL(requestUrl).protocol;

                            if (["data:", "blob:", "about:"].includes(protocol)) {
                                await request.continue();
                                return;
                            }

                            if (!["http:", "https:"].includes(protocol)) {
                                await request.abort("blockedbyclient");
                                return;
                            }

                            if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
                                await request.abort("blockedbyclient");
                                return;
                            }

                            // Validate HTTP(S) destinations before allowing
                            // navigation and subresource requests.
                            await validateUrl(requestUrl);

                            if (!request.isInterceptResolutionHandled()) {
                                await request.continue();
                            }
                        } catch {
                            try {
                                if (!request.isInterceptResolutionHandled()) {
                                    await request.abort("blockedbyclient");
                                }
                            } catch {
                                // The request may already be resolved.
                            }
                        }
                    })();
                });

                await page.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: BROWSER_TIMEOUT_MS,
                });

                const result = await page.evaluate(() => ({
                    head: document.head?.innerText || "",
                    body: document.body?.innerText || "",
                    links: Array.from(
                        document.querySelectorAll("a[href]"),
                    ).map((anchor) => anchor.href),
                }));

                const internalLinks = new Set();
                const externalLinks = new Set();
                const pageOrigin = new URL(url).origin;

                for (const href of result.links) {
                    try {
                        const parsed = new URL(href);

                        if (!["http:", "https:"].includes(parsed.protocol)) {
                            continue;
                        }

                        if (parsed.username || parsed.password) continue;

                        parsed.hash = "";

                        if (parsed.origin === pageOrigin) {
                            internalLinks.add(parsed.href);
                        } else {
                            externalLinks.add(parsed.href);
                        }
                    } catch {
                        // Ignore malformed links.
                    }
                }

                const scraped = {
                    head: result.head.replace(/\s+/g, " ").trim(),
                    body: result.body.replace(/\s+/g, " ").trim(),
                    internalLinks: [...internalLinks],
                    externalLinks: [...externalLinks],
                };

                if (!hasUsefulContent(scraped)) {
                    throw new Error(
                        "Browser rendering did not produce enough readable text.",
                    );
                }

                return scraped;
            } finally {
                // Browser shutdown also closes its open pages.
                // This page cleanup is best-effort and does not delay
                // the overall browser timeout indefinitely.
                try {
                    await withTimeout(
                        page.close(),
                        BROWSER_CLOSE_TIMEOUT_MS,
                        "Page close timed out.",
                    );
                } catch {
                    // Browser-level cleanup runs in the outer finally.
                }
            }
        };

        return await withTimeout(
            scrapeOperation(),
            BROWSER_OPERATION_TIMEOUT_MS,
            `Browser scrape exceeded ${BROWSER_OPERATION_TIMEOUT_MS}ms.`,
            () => closeBrowserSafely(browser),
        );
    } finally {
        await closeBrowserSafely(browser);
        releaseBrowserSlot();
    }
}

// --------------------------------------------------
// Adaptive scraper: static first, browser fallback
// --------------------------------------------------

export async function scrapeWebsite(url) {
    let staticError;

    try {
        const result = await scrapeStaticWebsite(url);

        console.log(`[Scraper] Static extraction succeeded: ${url}`);

        return result;
    } catch (error) {
        staticError = error;

        // Security failures should not be bypassed by trying another method.
        if (
            /private network|not allowed|credentials|Only HTTP and HTTPS|valid absolute URL/i
                .test(error.message)
        ) {
            throw error;
        }

        console.log(
            `[Scraper] Static extraction unavailable; trying browser: ${url}`,
        );
    }

    if (
        process.env.ENABLE_PUPPETEER === "false" ||
        process.env.DISABLE_PUPPETEER === "true"
    ) {
        throw new Error(
            `Static extraction failed (${staticError.message}) and browser rendering is disabled.`
        );
    }

    try {
        const result = await scrapeReactWebsite(url);

        console.log(`[Scraper] Browser extraction succeeded: ${url}`);

        return result;
    } catch (browserError) {
        throw new Error(
            `Unable to extract page content. ` +
            `Static: ${staticError.message}. ` +
            `Browser: ${browserError.message}.`,
        );
    }
}