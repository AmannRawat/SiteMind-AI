import rateLimit from "express-rate-limit";

function createRateLimiter({
  windowMs,
  limit,
  message,
  skipSuccessfulRequests = false,
}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests,

    // Render sits in front of the app. Keep the Express proxy
    // configuration in app.js aligned with your actual deployment.
    handler: (_req, res) => {
      res.status(429).json({
        error: message,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
    },
  });
}

// Applies to normal API traffic. Specific endpoint limiters below
// provide additional protection for expensive operations.
export const apiRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: "Too many requests. Please slow down and try again.",
});

export const crawlRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 3,
  message: "Too many crawl requests. Please try again in a few minutes.",
});

export const chatRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  message: "Too many chat requests. Please wait before asking again.",
});

export const crawlStatusRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: "Too many status checks. Please slow down.",
});