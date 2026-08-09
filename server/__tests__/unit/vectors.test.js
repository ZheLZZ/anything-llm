const prisma = require("../../utils/prisma");
const { DocumentVectors } = require("../../models/vectors");

jest.mock("../../utils/prisma", () => ({
  document_vectors: {
    create: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  workspace_documents: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(),
}));

describe("DocumentVectors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("bulkInsert", () => {
    it("persists chunk position and text metadata", async () => {
      prisma.document_vectors.create.mockResolvedValue({});
      prisma.$transaction.mockResolvedValue([]);

      await DocumentVectors.bulkInsert([
        {
          docId: "doc-1",
          vectorId: "vector-1",
          chunkIndex: 0,
          chunkCount: 2,
          chunkText: "first chunk",
        },
        {
          docId: "doc-1",
          vectorId: "vector-2",
          chunkIndex: 1,
          chunkCount: 2,
          chunkText: "",
        },
      ]);

      expect(prisma.document_vectors.create).toHaveBeenNthCalledWith(1, {
        data: {
          docId: "doc-1",
          vectorId: "vector-1",
          chunkIndex: 0,
          chunkCount: 2,
          chunkText: "first chunk",
        },
      });
      expect(prisma.document_vectors.create).toHaveBeenNthCalledWith(2, {
        data: {
          docId: "doc-1",
          vectorId: "vector-2",
          chunkIndex: 1,
          chunkCount: 2,
          chunkText: "",
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("forVectorIds", () => {
    it("queries all unique vector IDs in one batch", async () => {
      const rows = [{ vectorId: "vector-1" }, { vectorId: "vector-2" }];
      prisma.document_vectors.findMany.mockResolvedValue(rows);

      await expect(
        DocumentVectors.forVectorIds([
          "vector-1",
          "vector-2",
          "vector-1",
          "",
          null,
        ])
      ).resolves.toEqual(rows);

      expect(prisma.document_vectors.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.document_vectors.findMany).toHaveBeenCalledWith({
        where: { vectorId: { in: ["vector-1", "vector-2"] } },
      });
    });
  });

  describe("contextByVectorId", () => {
    const document = {
      docId: "doc-1",
      workspaceId: 10,
      filename: "document.txt",
      metadata: JSON.stringify({ title: "Document title" }),
    };

    const chunk = (chunkIndex, chunkCount = 5) => ({
      id: chunkIndex + 1,
      docId: "doc-1",
      vectorId: `vector-${chunkIndex}`,
      chunkIndex,
      chunkCount,
      chunkText: `chunk ${chunkIndex}`,
    });

    it.each([
      {
        label: "the beginning",
        hitIndex: 0,
        before: 2,
        after: 2,
        fromIndex: 0,
        toIndex: 2,
      },
      {
        label: "the middle",
        hitIndex: 2,
        before: 1,
        after: 1,
        fromIndex: 1,
        toIndex: 3,
      },
      {
        label: "the end",
        hitIndex: 4,
        before: 10,
        after: 10,
        fromIndex: 0,
        toIndex: 4,
      },
    ])(
      "returns an ordered, bounded range at $label",
      async ({ hitIndex, before, after, fromIndex, toIndex }) => {
        const hit = chunk(hitIndex);
        const contextChunks = Array.from(
          { length: toIndex - fromIndex + 1 },
          (_, offset) => chunk(fromIndex + offset)
        );
        prisma.document_vectors.findMany
          .mockResolvedValueOnce([hit])
          .mockResolvedValueOnce(contextChunks);
        prisma.workspace_documents.findFirst.mockResolvedValue(document);

        const result = await DocumentVectors.contextByVectorId({
          vectorId: hit.vectorId,
          workspaceId: 10,
          before,
          after,
        });

        expect(result).toEqual({
          found: true,
          reindexRequired: false,
          document,
          hit,
          range: { fromIndex, toIndex },
          chunks: contextChunks,
        });
        expect(prisma.document_vectors.findMany).toHaveBeenNthCalledWith(2, {
          where: {
            docId: "doc-1",
            chunkIndex: { gte: fromIndex, lte: toIndex },
          },
          orderBy: { chunkIndex: "asc" },
        });
      }
    );

    it("returns reindexRequired for a legacy vector record", async () => {
      prisma.document_vectors.findMany.mockResolvedValue([
        {
          docId: "doc-1",
          vectorId: "legacy-vector",
          chunkIndex: null,
          chunkCount: null,
          chunkText: null,
        },
      ]);
      prisma.workspace_documents.findFirst.mockResolvedValue(document);

      await expect(
        DocumentVectors.contextByVectorId({
          vectorId: "legacy-vector",
          workspaceId: 10,
        })
      ).resolves.toMatchObject({
        found: true,
        reindexRequired: true,
        docId: "doc-1",
        vectorId: "legacy-vector",
      });
      expect(prisma.document_vectors.findMany).toHaveBeenCalledTimes(1);
    });

    it("does not read a vector through a different workspace", async () => {
      prisma.document_vectors.findMany.mockResolvedValue([chunk(2)]);
      prisma.workspace_documents.findFirst.mockResolvedValue(null);

      await expect(
        DocumentVectors.contextByVectorId({
          vectorId: "vector-2",
          workspaceId: 99,
        })
      ).resolves.toEqual({ found: false });
      expect(prisma.workspace_documents.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: 99,
          docId: { in: ["doc-1"] },
        },
      });
      expect(prisma.document_vectors.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
