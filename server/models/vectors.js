const prisma = require("../utils/prisma");
const { Document } = require("./documents");

const DocumentVectors = {
  bulkInsert: async function (vectorRecords = []) {
    if (vectorRecords.length === 0) return;

    try {
      const inserts = [];
      vectorRecords.forEach((record) => {
        inserts.push(
          prisma.document_vectors.create({
            data: {
              docId: record.docId,
              vectorId: record.vectorId,
              chunkIndex: record.chunkIndex ?? null,
              chunkCount: record.chunkCount ?? null,
              chunkText: record.chunkText ?? null,
            },
          })
        );
      });
      await prisma.$transaction(inserts);
      return { documentsInserted: inserts.length };
    } catch (error) {
      console.error("Bulk insert failed", error);
      return { documentsInserted: 0 };
    }
  },

  where: async function (clause = {}, limit) {
    try {
      const results = await prisma.document_vectors.findMany({
        where: clause,
        take: limit || undefined,
      });
      return results;
    } catch (error) {
      console.error("Where query failed", error);
      return [];
    }
  },

  forVectorIds: async function (vectorIds = []) {
    const uniqueVectorIds = [
      ...new Set(
        vectorIds.filter(
          (vectorId) =>
            typeof vectorId === "string" && vectorId.trim().length > 0
        )
      ),
    ];
    if (uniqueVectorIds.length === 0) return [];

    try {
      return await prisma.document_vectors.findMany({
        where: { vectorId: { in: uniqueVectorIds } },
      });
    } catch (error) {
      console.error("Vector ID query failed", error);
      throw error;
    }
  },

  contextByVectorId: async function ({
    vectorId,
    workspaceId,
    before = 2,
    after = 2,
  }) {
    try {
      const candidates = await prisma.document_vectors.findMany({
        where: { vectorId },
      });
      if (candidates.length === 0) return { found: false };

      const document = await prisma.workspace_documents.findFirst({
        where: {
          workspaceId,
          docId: { in: [...new Set(candidates.map(({ docId }) => docId))] },
        },
      });
      if (!document) return { found: false };

      const hit = candidates.find(({ docId }) => docId === document.docId);
      if (!hit) return { found: false };

      const hasChunkPosition =
        Number.isInteger(hit.chunkIndex) &&
        Number.isInteger(hit.chunkCount) &&
        hit.chunkIndex >= 0 &&
        hit.chunkCount > 0 &&
        hit.chunkIndex < hit.chunkCount &&
        typeof hit.chunkText === "string";

      if (!hasChunkPosition)
        return {
          found: true,
          reindexRequired: true,
          document,
          docId: hit.docId,
          vectorId: hit.vectorId,
        };

      const fromIndex = Math.max(0, hit.chunkIndex - before);
      const toIndex = Math.min(hit.chunkCount - 1, hit.chunkIndex + after);
      const chunks = await prisma.document_vectors.findMany({
        where: {
          docId: hit.docId,
          chunkIndex: { gte: fromIndex, lte: toIndex },
        },
        orderBy: { chunkIndex: "asc" },
      });

      const expectedChunkCount = toIndex - fromIndex + 1;
      const hasCompleteRange =
        chunks.length === expectedChunkCount &&
        chunks.every(
          (chunk, index) =>
            chunk.chunkIndex === fromIndex + index &&
            chunk.chunkCount === hit.chunkCount &&
            typeof chunk.chunkText === "string"
        );

      if (!hasCompleteRange)
        return {
          found: true,
          reindexRequired: true,
          document,
          docId: hit.docId,
          vectorId: hit.vectorId,
        };

      return {
        found: true,
        reindexRequired: false,
        document,
        hit,
        range: { fromIndex, toIndex },
        chunks,
      };
    } catch (error) {
      console.error("Chunk context query failed", error);
      throw error;
    }
  },

  deleteForWorkspace: async function (workspaceId) {
    const documents = await Document.forWorkspace(workspaceId);
    const docIds = [...new Set(documents.map((doc) => doc.docId))];

    try {
      await prisma.document_vectors.deleteMany({
        where: { docId: { in: docIds } },
      });
      return true;
    } catch (error) {
      console.error("Delete for workspace failed", error);
      return false;
    }
  },

  deleteIds: async function (ids = []) {
    try {
      await prisma.document_vectors.deleteMany({
        where: { id: { in: ids } },
      });
      return true;
    } catch (error) {
      console.error("Delete IDs failed", error);
      return false;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.document_vectors.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error("Delete failed", error);
      return false;
    }
  },
};

module.exports = { DocumentVectors };
