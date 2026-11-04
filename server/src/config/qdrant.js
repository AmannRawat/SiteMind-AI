
import { QdrantClient } from "@qdrant/js-client-rest";

const url = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const apiKey = process.env.QDRANT_API_KEY;

export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION || "website_support_chunks";

export const VECTOR_SIZE = Number(
  process.env.QDRANT_VECTOR_SIZE || 3072
);

export const qdrantClient = new QdrantClient({
  url,
  ...(apiKey ? { apiKey } : {}),
});

let collectionPromise;

export async function ensureCollection() {
  if (!Number.isInteger(VECTOR_SIZE) || VECTOR_SIZE <= 0) {
    throw new Error("QDRANT_VECTOR_SIZE must be a positive integer.");
  }

  if (!collectionPromise) {
    collectionPromise = (async () => {
      const { collections } = await qdrantClient.getCollections();

      const exists = collections.some(
        (collection) => collection.name === QDRANT_COLLECTION
      );

      if (!exists) {
        await qdrantClient.createCollection(QDRANT_COLLECTION, {
          vectors: {
            size: VECTOR_SIZE,
            distance: "Cosine",
          },
        });
      } else {
        const collection = await qdrantClient.getCollection(
          QDRANT_COLLECTION
        );

        const configuredVectors = collection.config.params.vectors;

        // Validate the dimension for collections using unnamed vectors.
        const existingSize =
          typeof configuredVectors.size === "number"
            ? configuredVectors.size
            : null;

        if (existingSize !== null && existingSize !== VECTOR_SIZE) {
          throw new Error(
            `Qdrant collection dimension is ${existingSize}, but ` +
              `QDRANT_VECTOR_SIZE is ${VECTOR_SIZE}. Use a matching ` +
              `dimension or a new collection name.`
          );
        }
      }

      // Ensure website filtering works for both new and existing collections.
      // Recreating an existing payload index is safe when its schema matches.
      await qdrantClient.createPayloadIndex(
        QDRANT_COLLECTION,
        {
          field_name: "websiteUrl",
          field_schema: "keyword",
        },
        { wait: true }
      );

      await qdrantClient.createPayloadIndex(
        QDRANT_COLLECTION,
        {
          field_name: "url",
          field_schema: "keyword",
        },
        { wait: true }
      );

      return QDRANT_COLLECTION;
    })().catch((error) => {
      collectionPromise = undefined;
      throw error;
    });
  }

  return collectionPromise;
}