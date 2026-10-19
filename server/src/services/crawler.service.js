
import { createHash } from "node:crypto";
import { scrapeWebsite } from "./scraper.service.js";
import { chunkText } from "./chunking.service.js";
import { generateVectorEmbedding } from "./embedding.service.js";
import {
    storeChunk,
    getVectorCount,
    deleteChunks,
} from "./vectorStore.service.js";
import { validatePublicHttpUrl } from "../security/urlSafety.js";
import {
    getPageCheckpoint,
    savePageCheckpoint,
    getPageState,
    savePageState,
} from "./crawlCheckpoint.service.js";

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_CRAWL_TIMEOUT_MS = 90_000;
const MAX_ALLOWED_PAGES = 50;
const MAX_ALLOWED_DEPTH = 4;
const MIN_CRAWL_TIMEOUT_MS = 5_000;
const MAX_CRAWL_TIMEOUT_MS = 120_000;

class CrawlDeadlineError extends Error {
    constructor() {
        super("Crawl exceeded its total time budget.");
        this.name = "CrawlDeadlineError";
    }
}

function boundedInteger(value, fallback, min, max) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeUrl(value) {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    if (url.username || url.password) {
        throw new Error("URLs containing credentials are not allowed.");
    }

    url.hash = "";

    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
    }

    return url.href;
}

function hashPageContent(head, body) {
    return createHash("sha256")
        .update(head)
        .update("\0")
        .update(body)
        .digest("hex");
}

export async function crawlWebsite(startUrl, options = {}) {
    const maxPages = boundedInteger(
        options.maxPages,
        DEFAULT_MAX_PAGES,
        1,
        MAX_ALLOWED_PAGES
    );

    const maxDepth = boundedInteger(
        options.maxDepth,
        DEFAULT_MAX_DEPTH,
        0,
        MAX_ALLOWED_DEPTH
    );

    const timeoutMs = boundedInteger(
        options.timeoutMs,
        DEFAULT_CRAWL_TIMEOUT_MS,
        MIN_CRAWL_TIMEOUT_MS,
        MAX_CRAWL_TIMEOUT_MS
    );

    const jobId = options.jobId;
    const onProgress = options.onProgress;

    if (!jobId) {
        throw new Error(
            "crawlWebsite requires a BullMQ jobId for checkpointing."
        );
    }

    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;

    function checkDeadline() {
        if (Date.now() >= deadlineAt) {
            throw new CrawlDeadlineError();
        }
    }
    const start = normalizeUrl(startUrl);
    checkDeadline();
    const allowedOrigin = new URL(start).origin;
    const visited = new Set();

    let processedPages = 0;
    let indexedChunks = 0;
    let failedPages = 0;
    let timedOut = false;

    async function reportProgress() {
        if (!onProgress) return;

        checkDeadline();

        await onProgress({
            processedPages,
            discoveredPages: visited.size,
            failedPages,
            maxPages,
        });

        checkDeadline();
    }

    async function visitPage(pageUrl, depth) {
        checkDeadline();

        let normalizedUrl;

        try {
            normalizedUrl = normalizeUrl(pageUrl);
        } catch (error) {
            failedPages++;
            console.warn(
                `[Crawler] Invalid URL skipped: ${error.message}`
            );
            return;
        }

        if (
            visited.has(normalizedUrl) ||
            visited.size >= maxPages ||
            depth > maxDepth
        ) {
            return;
        }

        // Never crawl outside the starting origin.
        if (new URL(normalizedUrl).origin !== allowedOrigin) {
            return;
        }

        try {
            await validatePublicHttpUrl(normalizedUrl);
            checkDeadline();
        } catch (error) {
            if (error instanceof CrawlDeadlineError) {
                throw error;
            }

            if (depth === 0) {
                throw new Error(
                    `Starting URL failed security validation: ${error.message}`
                );
            }

            failedPages++;

            console.warn(
                `[Crawler] Unsafe or unreachable URL skipped: ${normalizedUrl}`
            );

            return;
        }

        // Add before processing to prevent duplicate traversal.
        visited.add(normalizedUrl);

        let checkpoint;

        try {
            checkpoint = await getPageCheckpoint(jobId, normalizedUrl);
            checkDeadline();
        } catch (error) {
            if (error instanceof CrawlDeadlineError) {
                throw error;
            }

            failedPages++;

            console.error(
                `[Crawler] Checkpoint lookup failed for ${normalizedUrl}: ${error.message}`
            );

            return;
        }

        // Resume previously completed pages without repeating embeddings.
        if (
            checkpoint &&
            Array.isArray(checkpoint.internalLinks) &&
            Number.isInteger(checkpoint.indexedChunks)
        ) {
            console.log(
                `[Crawler] Resuming job ${jobId}: skipping ${normalizedUrl}`
            );

            processedPages++;
            indexedChunks += checkpoint.indexedChunks;

            await reportProgress();

            for (const link of checkpoint.internalLinks) {
                checkDeadline();

                if (visited.size >= maxPages) break;

                let nextUrl;

                try {
                    nextUrl = normalizeUrl(
                        new URL(link, normalizedUrl).href
                    );
                } catch {
                    continue;
                }

                if (new URL(nextUrl).origin === allowedOrigin) {
                    await visitPage(nextUrl, depth + 1);
                }
            }

            return;
        }

        console.log(`[Crawler] Crawling: ${normalizedUrl}`);

        let scraped;

        try {
            // Axios + Cheerio first; Puppeteer fallback is handled
            // inside scrapeWebsite().
            scraped = await scrapeWebsite(normalizedUrl);
            checkDeadline();
        } catch (error) {
            if (error instanceof CrawlDeadlineError) {
                throw error;
            }

            failedPages++;

            console.error(
                `[Crawler] Failed to scrape ${normalizedUrl}: ${error.message}`
            );

            return;
        }

        const head =
            typeof scraped.head === "string" ? scraped.head : "";

        const body =
            typeof scraped.body === "string" ? scraped.body : "";

        const internalLinks = Array.isArray(scraped.internalLinks)
            ? scraped.internalLinks
            : [];

        // Do not embed pages that contain no useful text.
        if (!head.trim() && !body.trim()) {
            failedPages++;

            console.warn(
                `[Crawler] No readable content extracted: ${normalizedUrl}`
            );

            return;
        }

        const contentHash = hashPageContent(head, body);

        let previousState;

        try {
            previousState = await getPageState(normalizedUrl);
            checkDeadline();
        } catch (error) {
            if (error instanceof CrawlDeadlineError) {
                throw error;
            }

            failedPages++;

            console.error(
                `[Crawler] Page-state lookup failed for ${normalizedUrl}: ${error.message}`
            );

            return;
        }

        let pageIndexedChunks = 0;

        if (
            previousState?.contentHash === contentHash &&
            Array.isArray(previousState.chunkIds) &&
            Number.isInteger(previousState.indexedChunks)
        ) {
            console.log(
                `[Crawler] Unchanged page; skipping embeddings: ${normalizedUrl}`
            );

            pageIndexedChunks = previousState.indexedChunks;
            indexedChunks += pageIndexedChunks;
        } else {
            const newChunkIds = [];

            try {
                // Index the heading separately when present.
                if (head.trim()) {
                    checkDeadline();

                    const id = `${normalizedUrl}::${contentHash}::head`;
                    const embedding = await generateVectorEmbedding(head);

                    checkDeadline();

                    await storeChunk({
                        id,
                        embedding,
                        url: normalizedUrl,
                        websiteUrl: allowedOrigin,
                        text: head,
                        title: "",
                    });

                    checkDeadline();
                    newChunkIds.push(id);
                }

                const chunks = chunkText(body);

                for (const [index, chunk] of chunks.entries()) {
                    checkDeadline();

                    if (!chunk.trim()) continue;

                    const id =
                        `${normalizedUrl}::${contentHash}::chunk-${index}`;

                    const embedding = await generateVectorEmbedding(chunk);

                    checkDeadline();

                    await storeChunk({
                        id,
                        embedding,
                        url: normalizedUrl,
                        websiteUrl: allowedOrigin,
                        text: chunk,
                        title: "",
                    });

                    checkDeadline();

                    newChunkIds.push(id);
                    indexedChunks++;
                    pageIndexedChunks++;
                }

                // Delete stale chunks only after the new chunks have
                // been written successfully.
                checkDeadline();

                const oldChunkIds = Array.isArray(previousState?.chunkIds)
                    ? previousState.chunkIds
                    : [];

                const newChunkIdSet = new Set(newChunkIds);

                const staleChunkIds = oldChunkIds.filter(
                    (id) => !newChunkIdSet.has(id)
                );

                await deleteChunks(staleChunkIds);
                checkDeadline();

                await savePageState(normalizedUrl, {
                    contentHash,
                    chunkIds: newChunkIds,
                    indexedChunks: pageIndexedChunks,
                });

                checkDeadline();
            } catch (error) {
                // Infrastructure failures must reach BullMQ so the job can be retried.
                // Do not save the page state or checkpoint for a failed indexing attempt.
                console.error(
                    `[Crawler] Failed to index ${normalizedUrl}: ${error.message}`
                );
                throw error;
            }
        }

        // Save the checkpoint after successful indexing.
        try {
            checkDeadline();

            await savePageCheckpoint(jobId, normalizedUrl, {
                indexedChunks: pageIndexedChunks,
                internalLinks,
            });

            checkDeadline();
        } catch (error) {
            if (error instanceof CrawlDeadlineError) {
                throw error;
            }

            failedPages++;

            console.error(
                `[Crawler] Failed to save checkpoint for ${normalizedUrl}: ${error.message}`
            );

            return;
        }

        processedPages++;
        await reportProgress();

        for (const link of internalLinks) {
            checkDeadline();

            if (visited.size >= maxPages) break;

            let nextUrl;

            try {
                nextUrl = normalizeUrl(
                    new URL(link, normalizedUrl).href
                );
            } catch {
                continue;
            }

            if (new URL(nextUrl).origin === allowedOrigin) {
                await visitPage(nextUrl, depth + 1);
            }
        }
    }

    try {
        await visitPage(start, 0);
    } catch (error) {
        if (!(error instanceof CrawlDeadlineError)) {
            throw error;
        }

        timedOut = true;

        console.warn(
            `[Crawler] Job ${jobId} reached its ${timeoutMs}ms crawl budget.`
        );
    }

    const vectorCount = await getVectorCount();

    const status = timedOut
        ? processedPages > 0
            ? "partial"
            : "failed"
        : failedPages === 0
            ? "completed"
            : processedPages > 0
                ? "partial"
                : "failed";

    return {
        websiteUrl: start,
        jobId,
        discoveredPages: visited.size,
        processedPages,
        failedPages,
        indexedChunks,
        vectorCount,
        status,
        timedOut,
        durationMs: Date.now() - startedAt,
    };
}