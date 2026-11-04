import { UnrecoverableError } from "bullmq";
import { crawlWebsite } from "./crawler.service.js";

export async function processCrawlJob(job) {
  const { url } = job.data;

  console.log(`\n[Worker] Starting crawl job ${job.id}`);
  console.log(`[Worker] Website: ${url}`);

  await job.updateProgress(5);

  let result;
  try {
    result = await crawlWebsite(url, {
      jobId: String(job.id),
      onProgress: async ({ processedPages, maxPages }) => {
        const progress = Math.min(
          95,
          Math.max(10, Math.round((processedPages / maxPages) * 95))
        );

        await job.updateProgress(progress);

        console.log(
          `[Worker] Progress: ${processedPages} pages processed; ${progress}%`
        );
      },
    });
  } catch (error) {
    if (
      /security validation|Only HTTP and HTTPS|Invalid website|not allowed/i.test(
        error.message
      )
    ) {
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }

  console.log(`[Worker] Job ${job.id} result:`, result);

  if (result.status === "failed") {
    throw new UnrecoverableError(
      `Crawl failed: no pages were processed successfully for ${url}`
    );
  }

  await job.updateProgress(100);

  return result;
}