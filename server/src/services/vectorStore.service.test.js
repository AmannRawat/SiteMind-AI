
import { describe, it, expect, vi, beforeEach } from "vitest";

const { qdrantClient, ensureCollection } = vi.hoisted(() => ({
  qdrantClient: {
    upsert: vi.fn(),
    query: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  ensureCollection: vi.fn(),
}));

vi.mock("../config/qdrant.js", () => ({
  qdrantClient,
  ensureCollection,
  QDRANT_COLLECTION: "website_support_chunks",
}));

import {
  storeChunk,
  retrieveChunks,
  getVectorCount,
  deleteChunks,
} from "./vectorStore.service.js";

describe("vectorStore.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    ensureCollection.mockResolvedValue("website_support_chunks");
    qdrantClient.upsert.mockResolvedValue({});
    qdrantClient.delete.mockResolvedValue({});

    qdrantClient.query.mockResolvedValue({
      points: [
        {
          id: "00000000-0000-5000-8000-000000000001",
          payload: {
            text: "Relevant website content",
            url: "https://example.com/about",
            websiteUrl: "https://example.com",
            title: "About",
          },
        },
      ],
    });

    qdrantClient.count.mockResolvedValue({ count: 5 });
  });

  it("stores a chunk with its embedding and metadata", async () => {
    const embedding = Array(3072).fill(0.1);

    await storeChunk({
      id: "chunk-1",
      embedding,
      url: "https://example.com/about",
      websiteUrl: "https://example.com",
      text: "Relevant website content",
      title: "About",
    });

    expect(ensureCollection).toHaveBeenCalledOnce();
    expect(qdrantClient.upsert).toHaveBeenCalledOnce();

    const [collection, request] = qdrantClient.upsert.mock.calls[0];

    expect(collection).toBe("website_support_chunks");
    expect(request.wait).toBe(true);
    expect(request.points).toHaveLength(1);
    expect(request.points[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(request.points[0].vector).toEqual(embedding);
    expect(request.points[0].payload).toEqual({
      url: "https://example.com/about",
      websiteUrl: "https://example.com",
      title: "About",
      text: "Relevant website content",
    });
  });

  it("rejects an embedding with the wrong dimension", async () => {
    await expect(
      storeChunk({
        id: "chunk-1",
        embedding: [0.1, 0.2, 0.3],
        url: "https://example.com/",
        websiteUrl: "https://example.com",
        text: "Home page",
      })
    ).rejects.toThrow("Embedding has 3 dimensions");

    expect(qdrantClient.upsert).not.toHaveBeenCalled();
  });

  it("retrieves chunks filtered by website and maps the result", async () => {
    const embedding = Array(3072).fill(0.1);

    const result = await retrieveChunks(
      embedding,
      "https://example.com",
      3
    );

    expect(qdrantClient.query).toHaveBeenCalledWith(
      "website_support_chunks",
      expect.objectContaining({
        query: embedding,
        limit: 10,
        filter: {
          must: [
            {
              key: "websiteUrl",
              match: { value: "https://example.com" },
            },
          ],
        },
        with_payload: true,
        with_vector: false,
      })
    );

    expect(result.documents[0]).toEqual([
      "Relevant website content",
    ]);

    expect(result.metadatas[0][0]).toEqual({
      url: "https://example.com/about",
      websiteUrl: "https://example.com",
      title: "About",
    });
  });

  it("filters out error chunks and respects the requested limit", async () => {
    qdrantClient.query.mockResolvedValue({
      points: [
        {
          id: "00000000-0000-5000-8000-000000000001",
          payload: {
            text: "404: NOT_FOUND This page could not be found.",
            url: "https://example.com/broken",
            websiteUrl: "https://example.com",
            title: "404",
          },
        },
        {
          id: "00000000-0000-5000-8000-000000000002",
          payload: {
            text: "Valid content chunk 1",
            url: "https://example.com/feature1",
            websiteUrl: "https://example.com",
            title: "Feature 1",
          },
        },
        {
          id: "00000000-0000-5000-8000-000000000003",
          payload: {
            text: "Valid content chunk 2",
            url: "https://example.com/feature2",
            websiteUrl: "https://example.com",
            title: "Feature 2",
          },
        },
      ],
    });

    const result = await retrieveChunks(
      Array(3072).fill(0.1),
      "https://example.com",
      1
    );

    expect(result.documents[0]).toEqual(["Valid content chunk 1"]);
    expect(result.metadatas[0][0].url).toBe("https://example.com/feature1");
  });

  it("returns empty arrays when no chunks match", async () => {
    qdrantClient.query.mockResolvedValue({ points: [] });

    const result = await retrieveChunks(
      Array(3072).fill(0.1),
      "https://unknown.example"
    );

    expect(result).toEqual({
      documents: [[]],
      metadatas: [[]],
    });
  });

  it("deletes chunks using their deterministic Qdrant IDs", async () => {
    await deleteChunks([
      "https://example.com/::chunk-1",
      "https://example.com/::chunk-2",
    ]);

    expect(ensureCollection).toHaveBeenCalledOnce();
    expect(qdrantClient.delete).toHaveBeenCalledOnce();

    const [collection, request] = qdrantClient.delete.mock.calls[0];

    expect(collection).toBe("website_support_chunks");
    expect(request.wait).toBe(true);
    expect(request.points).toHaveLength(2);

    for (const id of request.points) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
  });

  it("does not call Qdrant when deleting an empty list", async () => {
    await deleteChunks([]);

    expect(ensureCollection).not.toHaveBeenCalled();
    expect(qdrantClient.delete).not.toHaveBeenCalled();
  });

  it("propagates database errors", async () => {
    qdrantClient.query.mockRejectedValue(
      new Error("Qdrant unavailable")
    );

    await expect(
      retrieveChunks(
        Array(3072).fill(0.1),
        "https://example.com"
      )
    ).rejects.toThrow("Qdrant unavailable");
  });

  it("returns the vector count", async () => {
    await expect(getVectorCount()).resolves.toBe(5);

    expect(qdrantClient.count).toHaveBeenCalledWith(
      "website_support_chunks",
      { exact: true }
    );
  });
});