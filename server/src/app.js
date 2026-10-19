import express from "express";
import cors from "cors";

import { answerQuestion } from "./services/answer.service.js";
import {
  enqueueCrawl,
  getCrawlJob,
} from "./services/crawlQueue.service.js";
import {
  apiRateLimit,
  crawlRateLimit,
  chatRateLimit,
  crawlStatusRateLimit,
} from "./middleware/rateLimiters.js";
import { validatePublicHttpUrl } from "./security/urlSafety.js";

const app = express();

// Set this to the number of trusted proxy hops in your deployment.
// Render commonly uses one proxy hop, but verify your actual setup.
// Never blindly trust arbitrary X-Forwarded-For values.
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);

if (
  !Number.isInteger(trustedProxyHops) ||
  trustedProxyHops < 0 ||
  trustedProxyHops > 3
) {
  throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 3.");
}

app.set("trust proxy", trustedProxyHops);

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  process.env.FRONTEND_URL,
]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/$/, ""));

app.disable("x-powered-by");

app.use(
  cors({
    origin(origin, callback) {
      // Requests without Origin can come from CLI clients. CORS is not
      // authentication, so API protections still apply to these requests.
      if (!origin) return callback(null, true);

      const normalizedOrigin = origin.replace(/\/$/, "");

      const isLocalDevelopment =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
          normalizedOrigin
        );

      if (
        allowedOrigins.includes(normalizedOrigin) ||
        isLocalDevelopment
      ) {
        return callback(null, true);
      }

      const error = new Error("Origin not allowed by CORS");
      error.statusCode = 403;
      return callback(error);
    },
  })
);

// Reject oversized JSON before route handlers run.
app.use(express.json({ limit: "10kb", strict: true }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "website-support-api",
  });
});

// General API limiter plus a stricter per-endpoint limiter.
app.use("/api", apiRateLimit);

app.post("/api/crawls", crawlRateLimit, async (req, res) => {
  try {
    const { url } = req.body ?? {};

    if (
      typeof url !== "string" ||
      !url.trim() ||
      url.length > 2048
    ) {
      return res.status(400).json({
        error: "A valid website URL is required (maximum 2048 characters).",
      });
    }

    let parsedUrl;

    try {
      parsedUrl = await validatePublicHttpUrl(url.trim());
    } catch {
      return res.status(400).json({
        error: "The website URL is invalid or not publicly accessible.",
      });
    }

    const job = await enqueueCrawl(parsedUrl.href);

    return res.status(202).json(job);
  } catch (error) {
    if (
      error?.statusCode === 429 ||
      error?.code === "CRAWL_QUEUE_FULL"
    ) {
      return res.status(429).json({
        error: "The crawl queue is full. Please try again later.",
        retryAfterSeconds: 60,
      });
    }

    console.error("[API] Failed to enqueue crawl:", error.message);

    return res.status(503).json({
      error: "Unable to queue the crawl right now. Please try again later.",
    });
  }
});

app.get(
  "/api/crawls/:jobId",
  crawlStatusRateLimit,
  async (req, res) => {
    try {
      const job = await getCrawlJob(req.params.jobId);

      if (!job) {
        return res.status(404).json({
          error: "Crawl job not found.",
        });
      }

      return res.json(job);
    } catch (error) {
      console.error(
        "[API] Failed to retrieve crawl job:",
        error.message
      );

      return res.status(503).json({
        error: "Unable to retrieve crawl status right now.",
      });
    }
  }
);

app.post("/api/chat", chatRateLimit, async (req, res) => {
  try {
    const { question, websiteUrl } = req.body ?? {};

    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 2000 ||
      typeof websiteUrl !== "string" ||
      !websiteUrl.trim() ||
      websiteUrl.length > 2048
    ) {
      return res.status(400).json({
        error:
          "Provide a question (maximum 2000 characters) and a valid website URL.",
      });
    }

    let parsedUrl;

    try {
      parsedUrl = await validatePublicHttpUrl(websiteUrl.trim());
    } catch {
      return res.status(400).json({
        error: "The website URL is invalid or not publicly accessible.",
      });
    }

    const result = await answerQuestion(
      question.trim(),
      parsedUrl.href
    );

    return res.json(result);
  } catch (error) {
    // Log only a short error message, never secrets or request bodies.
    console.error("[API] Chat failed:", error?.message ?? "Unknown error");

    const upstreamStatus = Number(error?.status ?? error?.statusCode);

    if (upstreamStatus === 429) {
      return res.status(429).json({
        error:
          "The AI service is busy. Please wait before asking another question.",
      });
    }

    if (
      upstreamStatus === 503 ||
      error?.code === "UNAVAILABLE"
    ) {
      return res.status(503).json({
        error:
          "The AI service is temporarily unavailable. Please try again shortly.",
      });
    }

    return res.status(502).json({
      error: "Unable to answer the question right now. Please try again.",
    });
  }
});

// Central error handler must come after all routes.
app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      error: "Request body must contain valid JSON.",
    });
  }

  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request body is too large.",
    });
  }

  if (error?.statusCode === 403 && error.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      error: "This origin is not allowed.",
    });
  }

  console.error("[API] Unexpected error:", error?.message ?? "Unknown error");

  return res.status(500).json({
    error: "Internal server error.",
  });
});

export default app;