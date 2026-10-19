import "dotenv/config";
import app from "./app.js";
import { crawlQueue, redisConnection } from "./config/queue.js";
import { closeWorker } from "./worker.js";

const PORT = Number(process.env.PORT) || 4000;

console.log("[Render] Initializing unified API and BullMQ worker process...");

const server = app.listen(PORT, () => {
  console.log(`[Render] Unified server & worker running at http://localhost:${PORT}`);
});

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[Render] Received ${signal}. Gracefully shutting down unified service...`);

  server.close(async () => {
    try {
      await closeWorker();
      await crawlQueue.close();
      await redisConnection.quit();
      console.log("[Render] Unified shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("[Render] Shutdown error:", error.message);
      process.exit(1);
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
