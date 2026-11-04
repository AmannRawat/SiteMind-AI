
import { createHash } from "node:crypto";
import {
  ensureCollection,
  qdrantClient,
  QDRANT_COLLECTION,
} from "../config/qdrant.js";

function toPointId(id) {
  // Qdrant point IDs must be unsigned integers or UUIDs.
  // Convert arbitrary existing chunk IDs into stable UUIDs.
  const hex = createHash("sha256")
    .update(String(id))
    .digest("hex")
    .slice(0, 32)
    .split("");

  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  const value = hex.join("");

  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join("-");
}

export async function storeChunk({
  id,
  embedding,
  url,
  websiteUrl,
  text,
  title = "",
}) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("A non-empty embedding is required.");
  }

  if (embedding.length !== Number(process.env.QDRANT_VECTOR_SIZE || 3072)) {
    throw new Error(
      `Embedding has ${embedding.length} dimensions, but QDRANT_VECTOR_SIZE ` +
      `is ${process.env.QDRANT_VECTOR_SIZE || 3072}.`
    );
  }

  await ensureCollection();

  await qdrantClient.upsert(QDRANT_COLLECTION, {
    wait: true,
    points: [
      {
        id: toPointId(id),
        vector: embedding,
        payload: {
          url,
          websiteUrl,
          title,
          text,
        },
      },
    ],
  });
}

function isErrorChunk(text) {
  if (!text || typeof text !== "string") return true;
  return (
    /404\s*:\s*not_found|404\s+not_found|this page doesn’t exist/i.test(text) ||
    /<title>404:\s*not_found<\/title>/i.test(text)
  );
}

export async function getHomepageChunk(websiteUrl) {
  if (!websiteUrl) return null;
  await ensureCollection();

  const origin = new URL(websiteUrl).origin;
  const candidates = [origin, `${origin}/`];

  for (const urlCandidate of candidates) {
    try {
      const scrollResult = await qdrantClient.scroll(QDRANT_COLLECTION, {
        filter: {
          must: [
            { key: "websiteUrl", match: { value: origin } },
            { key: "url", match: { value: urlCandidate } },
          ],
        },
        limit: 10,
        with_payload: true,
      });

      const validPoints = (scrollResult.points || []).filter(
        (p) =>
          typeof p.payload?.text === "string" &&
          p.payload.text.trim().length >= 100 &&
          !isErrorChunk(p.payload.text)
      );

      if (validPoints.length > 0) {
        // Sort by text length to pick the main content body chunk rather than title
        validPoints.sort(
          (a, b) => (b.payload?.text?.length || 0) - (a.payload?.text?.length || 0)
        );

        return {
          text: validPoints[0].payload.text,
          url: validPoints[0].payload.url || urlCandidate,
          title: validPoints[0].payload.title || "",
        };
      }
    } catch {
      // Fallback if payload index is still building or scroll fails
    }
  }

  return null;
}

export async function retrieveChunks(
  questionEmbedding,
  websiteUrl,
  limit = 6
) {
  await ensureCollection();

  const normalizedOrigin = new URL(websiteUrl).origin;

  // Over-fetch to ensure filtering out empty/error chunks does not deplete the limit
  const fetchLimit = Math.max(limit * 2, 10);

  const result = await qdrantClient.query(QDRANT_COLLECTION, {
    query: questionEmbedding,
    limit: fetchLimit,
    filter: {
      must: [
        {
          key: "websiteUrl",
          match: { value: normalizedOrigin },
        },
      ],
    },
    with_payload: true,
    with_vector: false,
  });

  // Preserve the response shape expected by answer.service.js,
  // filtering out any error or 404 pages.
  const points = (result.points || [])
    .filter((point) => !isErrorChunk(point.payload?.text))
    .slice(0, limit);

  return {
    documents: [
      points.map((point) => point.payload?.text || ""),
    ],
    metadatas: [
      points.map((point) => ({
        url: point.payload?.url || "",
        websiteUrl: point.payload?.websiteUrl || "",
        title: point.payload?.title || "",
        score: point.score,
      })),
    ],
  };
}

export async function getVectorCount(websiteUrl) {
  await ensureCollection();

  const countOptions = { exact: true };
  if (websiteUrl) {
    countOptions.filter = {
      must: [
        {
          key: "websiteUrl",
          match: { value: websiteUrl },
        },
      ],
    };
  }

  const result = await qdrantClient.count(QDRANT_COLLECTION, countOptions);

  return result.count;
}

export async function deleteChunks(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;

  await ensureCollection();

  const pointIds = ids.map(toPointId);

  await qdrantClient.delete(QDRANT_COLLECTION, {
    wait: true,
    points: pointIds,
  });
}

export async function deleteChunksByUrl(url, keepChunkIds = []) {
  if (!url) return;
  await ensureCollection();

  const keepSet = new Set(keepChunkIds.map(toPointId));

  try {
    const scrollResult = await qdrantClient.scroll(QDRANT_COLLECTION, {
      filter: {
        must: [
          {
            key: "url",
            match: { value: url },
          },
        ],
      },
      limit: 100,
      with_payload: false,
    });

    const stalePointIds = (scrollResult.points || [])
      .map((p) => p.id)
      .filter((id) => !keepSet.has(id));

    if (stalePointIds.length > 0) {
      await qdrantClient.delete(QDRANT_COLLECTION, {
        wait: true,
        points: stalePointIds,
      });
    }
  } catch (error) {
    console.warn(`[VectorStore] Failed to purge stale chunks for ${url}:`, error.message);
  }
}