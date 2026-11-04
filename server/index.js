import "dotenv/config";
import readlineSync from "readline-sync";
import { crawlWebsite } from "./src/services/crawler.service.js";
import { answerQuestion } from "./src/services/answer.service.js";

const START_URL = "https://anupbh77.github.io/";

async function main() {
    console.log("🚀 Starting ingestion...\n");

    const result = await crawlWebsite(START_URL, {
        jobId: "cli-local-ingestion",
    });

    console.log("\n📊 Indexing summary");
    console.log("-------------------");
    console.log(`Pages discovered: ${result.discoveredPages}`);
    console.log(`Pages processed:  ${result.processedPages}`);
    console.log(`Pages failed:     ${result.failedPages}`);
    console.log(`Chunks indexed:   ${result.indexedChunks}`);
    console.log(`Total vectors:    ${result.vectorCount}`);
    console.log(`Status:           ${result.status}`);

    if (result.processedPages === 0) {
        throw new Error(
            "No pages were indexed successfully. Check the crawl errors above."
        );
    }

    while (true) {
        const question = readlineSync.question("\n> You: ");

        if (question.trim().toLowerCase() === "exit") {
            console.log("\n👋 Goodbye!");
            break;
        }

        if (!question.trim()) {
            continue;
        }

        try {
            const response = await answerQuestion(question);

            console.log("\n" + "═".repeat(60));
            console.log("🤖  AI SUPPORT AGENT");
            console.log("═".repeat(60));
            console.log(`\n${response.answer}`);

            if (response.sources.length > 0) {
                console.log("\n🔗 Sources:");

                for (const source of response.sources) {
                    console.log(`- ${source.title || source.url}`);
                    console.log(`  ${source.url}`);
                }
            }

            console.log("═".repeat(60));
        } catch (error) {
            console.error("\n❌ Failed to answer:", error.message);
        }
    }
}

// Only execute the CLI when this file is run directly.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
    main().catch((error) => {
        console.error("\n❌ Application failed:", error.message);
        process.exitCode = 1;
    });
}