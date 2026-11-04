import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  generateVectorEmbedding: vi.fn(),
  retrieveChunks: vi.fn(),
  getHomepageChunk: vi.fn(),
  generateContent: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("./embedding.service.js", () => ({
  generateVectorEmbedding: mocks.generateVectorEmbedding,
}));

vi.mock("./vectorStore.service.js", () => ({
  retrieveChunks: mocks.retrieveChunks,
  getHomepageChunk: mocks.getHomepageChunk,
}));

vi.mock("../config/gemini.js", () => ({
  ai: {
    chats: {
      create: () => ({
        sendMessage: mocks.sendMessage,
      }),
    },
  },
  monitoredAi: {
    models: {
      generateContent: mocks.generateContent,
    },
  },
}));

import { answerQuestion, isOverviewQuestion } from "./answer.service.js";

describe("answer.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isOverviewQuestion", () => {
    it("identifies broad overview questions", () => {
      expect(isOverviewQuestion("What is this website about?")).toBe(true);
      expect(isOverviewQuestion("what is the website about?")).toBe(true);
      expect(isOverviewQuestion("What does this website do?")).toBe(true);
      expect(isOverviewQuestion("Tell me about this website")).toBe(true);
      expect(isOverviewQuestion("Overview of this website")).toBe(true);
      expect(isOverviewQuestion("What features does PrepAI offer?")).toBe(true);
    });

    it("identifies specific questions as non-overview", () => {
      expect(isOverviewQuestion("What is Resume Reviewer?")).toBe(false);
      expect(isOverviewQuestion("What is DSA Arena?")).toBe(false);
      expect(isOverviewQuestion("How much does it cost?")).toBe(false);
      expect(isOverviewQuestion("How do I contact support?")).toBe(false);
    });
  });

  describe("answerQuestion", () => {
    it("prioritizes homepage chunk as primary source for broad overview questions", async () => {
      mocks.generateVectorEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

      mocks.retrieveChunks.mockResolvedValue({
        documents: [
          [
            "DSA Arena: Practice coding problems with AI.",
            "Resume Reviewer: Get ATS-friendly resume feedback.",
          ],
        ],
        metadatas: [
          [
            { url: "https://prepai-app.vercel.app/dsa-arena", title: "DSA Arena" },
            { url: "https://prepai-app.vercel.app/resume-reviewer", title: "Resume Reviewer" },
          ],
        ],
      });

      mocks.getHomepageChunk.mockResolvedValue({
        text: "PrepAI is an AI-powered interview and career preparation platform.",
        url: "https://prepai-app.vercel.app/",
        title: "PrepAI",
      });

      mocks.generateContent.mockResolvedValue({
        text: "# PrepAI Overview\n\nPrepAI is an interview prep platform featuring DSA Arena and Resume Reviewer.",
      });

      const result = await answerQuestion(
        "What is this website about?",
        "https://prepai-app.vercel.app"
      );

      expect(mocks.getHomepageChunk).toHaveBeenCalledWith(
        "https://prepai-app.vercel.app"
      );

      // Verify that the prompt sent to Gemini has Homepage as Source 1
      expect(mocks.generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: expect.stringContaining("Source 1 (https://prepai-app.vercel.app/):\nPrepAI is an AI-powered interview"),
        })
      );

      expect(result.sources[0].url).toBe("https://prepai-app.vercel.app/");
      expect(result.answer).toContain("PrepAI Overview");
    });

    it("handles specific questions directly without forcing homepage to Source 1", async () => {
      mocks.generateVectorEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

      mocks.retrieveChunks.mockResolvedValue({
        documents: [
          [
            "Resume Reviewer: Upload your resume PDF and paste job description to get ATS analysis.",
          ],
        ],
        metadatas: [
          [
            { url: "https://prepai-app.vercel.app/resume-reviewer", title: "Resume Reviewer" },
          ],
        ],
      });

      mocks.generateContent.mockResolvedValue({
        text: "**Resume Reviewer** analyzes resumes against job descriptions.",
      });

      const result = await answerQuestion(
        "What is Resume Reviewer?",
        "https://prepai-app.vercel.app"
      );

      expect(mocks.getHomepageChunk).not.toHaveBeenCalled();
      expect(result.sources[0].url).toBe("https://prepai-app.vercel.app/resume-reviewer");
      expect(result.answer).toContain("Resume Reviewer");
    });

    it("returns helpful message when no relevant chunks are found", async () => {
      mocks.generateVectorEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      mocks.retrieveChunks.mockResolvedValue({
        documents: [[]],
        metadatas: [[]],
      });

      const result = await answerQuestion(
        "Unknown query",
        "https://prepai-app.vercel.app"
      );

      expect(result.answer).toContain("I couldn't find enough relevant information");
      expect(result.sources).toEqual([]);
    });
  });
});
