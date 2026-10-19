
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
    answerQuestion: vi.fn(),
    enqueueCrawl: vi.fn(),
    getCrawlJob: vi.fn(),
    validatePublicHttpUrl: vi.fn(),
}));

vi.mock("./services/answer.service.js", () => ({
    answerQuestion: mocks.answerQuestion,
}));

vi.mock("./services/crawlQueue.service.js", () => ({
    enqueueCrawl: mocks.enqueueCrawl,
    getCrawlJob: mocks.getCrawlJob,
}));

vi.mock("./security/urlSafety.js", () => ({
    validatePublicHttpUrl: mocks.validatePublicHttpUrl,
}));

import app from "./app.js";

let nextTestIp = 1;

function apiRequest(method, path) {
    const testIp = `198.51.100.${nextTestIp++}`;

    return request(app)[method](path).set("X-Forwarded-For", testIp);
}

describe("Website Support API", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Keep tests independent of external DNS and network services.
        mocks.validatePublicHttpUrl.mockImplementation(
            async (value) => new URL(value)
        );
    });

    describe("GET /health", () => {
        it("returns API health status", async () => {
            const response = await apiRequest("get", "/health");

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                status: "ok",
                service: "website-support-api",
            });
        });
    });

    describe("POST /api/crawls", () => {
        it("rejects a missing URL", async () => {
            const response = await apiRequest("post", "/api/crawls")
                .send({});

            expect(response.status).toBe(400);
            expect(mocks.enqueueCrawl).not.toHaveBeenCalled();
        });

        it("rejects a non-string URL", async () => {
            const response = await apiRequest("post", "/api/crawls")
                .send({ url: 123 });

            expect(response.status).toBe(400);
            expect(mocks.enqueueCrawl).not.toHaveBeenCalled();
        });

        it("rejects an excessively long URL", async () => {
            const response = await apiRequest("post", "/api/crawls")
                .send({ url: `https://example.com/${"a".repeat(2100)}` });

            expect(response.status).toBe(400);
            expect(mocks.enqueueCrawl).not.toHaveBeenCalled();
        });

        it("rejects a URL that fails public URL validation", async () => {
            mocks.validatePublicHttpUrl.mockRejectedValue(
                new Error("Private or invalid URL")
            );

            const response = await apiRequest("post", "/api/crawls")
                .send({ url: "http://127.0.0.1" });

            expect(response.status).toBe(400);
            expect(mocks.enqueueCrawl).not.toHaveBeenCalled();
        });

        it("queues a valid website crawl", async () => {
            mocks.enqueueCrawl.mockResolvedValue({
                jobId: "test-job-123",
                status: "queued",
                url: "https://example.com/",
                deduplicated: false,
            });

            const response = await apiRequest("post", "/api/crawls")
                .send({ url: "https://example.com" });

            expect(response.status).toBe(202);
            expect(response.body.jobId).toBe("test-job-123");
            expect(response.body.status).toBe("queued");

            expect(mocks.validatePublicHttpUrl).toHaveBeenCalledWith(
                "https://example.com"
            );

            expect(mocks.enqueueCrawl).toHaveBeenCalledWith(
                "https://example.com/"
            );
        });

        it("returns 429 when the queue is full", async () => {
            const error = new Error("Queue full");
            error.statusCode = 429;
            error.code = "CRAWL_QUEUE_FULL";

            mocks.enqueueCrawl.mockRejectedValue(error);

            const response = await apiRequest("post", "/api/crawls")
                .send({ url: "https://example.com" });

            expect(response.status).toBe(429);
            expect(response.body.error).toBe(
                "The crawl queue is full. Please try again later."
            );
        });

        it("returns 503 when queue infrastructure fails", async () => {
            mocks.enqueueCrawl.mockRejectedValue(
                new Error("Valkey connection failed")
            );

            const response = await apiRequest("post", "/api/crawls")
                .send({ url: "https://example.com" });

            expect(response.status).toBe(503);
            expect(response.body.error).toBe(
                "Unable to queue the crawl right now. Please try again later."
            );
        });
    });

    describe("GET /api/crawls/:jobId", () => {
        it("returns a crawl job when it exists", async () => {
            mocks.getCrawlJob.mockResolvedValue({
                jobId: "test-job-123",
                url: "https://example.com/",
                state: "completed",
                progress: 100,
                result: { status: "completed" },
            });

            const response = await request(app).get(
                "/api/crawls/test-job-123"
            );

            expect(response.status).toBe(200);
            expect(response.body.jobId).toBe("test-job-123");
            expect(response.body.state).toBe("completed");
        });

        it("returns 404 when a job does not exist", async () => {
            mocks.getCrawlJob.mockResolvedValue(null);

            const response = await request(app).get(
                "/api/crawls/missing-job"
            );

            expect(response.status).toBe(404);
            expect(response.body.error).toBe("Crawl job not found.");
        });

        it("returns 503 when queue status lookup fails", async () => {
            mocks.getCrawlJob.mockRejectedValue(
                new Error("Queue unavailable")
            );

            const response = await request(app).get(
                "/api/crawls/test-job-123"
            );

            expect(response.status).toBe(503);
            expect(response.body.error).toBe(
                "Unable to retrieve crawl status right now."
            );
        });
    });

    describe("POST /api/chat", () => {
        it("rejects missing chat fields", async () => {
            const response = await request(app)
                .post("/api/chat")
                .send({ question: "What does this website do?" });

            expect(response.status).toBe(400);
            expect(mocks.answerQuestion).not.toHaveBeenCalled();
        });

        it("rejects a question that is too long", async () => {
            const response = await request(app)
                .post("/api/chat")
                .send({
                    question: "a".repeat(2001),
                    websiteUrl: "https://example.com",
                });

            expect(response.status).toBe(400);
            expect(mocks.answerQuestion).not.toHaveBeenCalled();
        });

        it("rejects an invalid website URL", async () => {
            mocks.validatePublicHttpUrl.mockRejectedValue(
                new Error("Invalid URL")
            );

            const response = await request(app)
                .post("/api/chat")
                .send({
                    question: "What does this website do?",
                    websiteUrl: "http://127.0.0.1",
                });

            expect(response.status).toBe(400);
            expect(mocks.answerQuestion).not.toHaveBeenCalled();
        });

        it("returns an AI answer and sources", async () => {
            mocks.answerQuestion.mockResolvedValue({
                answer: "Example is a demonstration website.",
                sources: [
                    {
                        url: "https://example.com/",
                        title: "Example Domain",
                    },
                ],
            });

            const response = await request(app)
                .post("/api/chat")
                .send({
                    question: "What does this website do?",
                    websiteUrl: "https://example.com",
                });

            expect(response.status).toBe(200);
            expect(response.body.answer).toBe(
                "Example is a demonstration website."
            );
            expect(response.body.sources).toHaveLength(1);

            expect(mocks.answerQuestion).toHaveBeenCalledWith(
                "What does this website do?",
                "https://example.com/"
            );
        });

        it("returns 502 when the AI service fails", async () => {
            mocks.answerQuestion.mockRejectedValue(
                new Error("AI service unavailable")
            );

            const response = await request(app)
                .post("/api/chat")
                .send({
                    question: "What does this website do?",
                    websiteUrl: "https://example.com",
                });

            expect(response.status).toBe(502);
            expect(response.body.error).toBe(
                "Unable to answer the question right now. Please try again."
            );
        });

        it("returns 429 when the AI provider is rate-limiting", async () => {
            const error = new Error("Provider rate limit");
            error.status = 429;

            mocks.answerQuestion.mockRejectedValue(error);

            const response = await request(app)
                .post("/api/chat")
                .send({
                    question: "What does this website do?",
                    websiteUrl: "https://example.com",
                });

            expect(response.status).toBe(429);
            expect(response.body.error).toContain("AI service is busy");
        });
    });

    describe("Request validation", () => {
        it("rejects malformed JSON", async () => {
            const response = await request(app)
                .post("/api/chat")
                .set("Content-Type", "application/json")
                .send('{"question":');

            expect(response.status).toBe(400);
            expect(response.body.error).toBe(
                "Request body must contain valid JSON."
            );
        });

        it("rejects requests from a disallowed browser origin", async () => {
            const response = await request(app)
                .post("/api/chat")
                .set("Origin", "https://untrusted.example")
                .send({
                    question: "Hello",
                    websiteUrl: "https://example.com",
                });

            expect(response.status).toBe(403);
            expect(mocks.answerQuestion).not.toHaveBeenCalled();
        });
    });
});