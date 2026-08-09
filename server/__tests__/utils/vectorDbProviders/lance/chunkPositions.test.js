const mockSplitText = jest.fn();

jest.mock("@lancedb/lancedb", () => ({ connect: jest.fn() }));
jest.mock("../../../../utils/helpers", () => ({
  toChunks: (items, size) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += size)
      chunks.push(items.slice(i, i + size));
    return chunks;
  },
  getEmbeddingEngineSelection: jest.fn(),
}));
jest.mock("../../../../utils/TextSplitter", () => ({
  TextSplitter: class TextSplitter {
    static determineMaxChunkSize(value) {
      return value;
    }

    static buildHeaderMeta() {
      return null;
    }

    splitText(...args) {
      return mockSplitText(...args);
    }
  },
}));
jest.mock("../../../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn().mockResolvedValue(1000),
  },
}));
jest.mock("../../../../utils/files", () => ({
  storeVectorResult: jest.fn(),
  cachedVectorInformation: jest.fn(),
}));
jest.mock("../../../../models/vectors", () => ({
  DocumentVectors: {
    bulkInsert: jest.fn(),
  },
}));
jest.mock("../../../../utils/chats", () => ({
  sourceIdentifier: jest.fn(),
}));
jest.mock("../../../../utils/EmbeddingRerankers/native", () => ({
  NativeEmbeddingReranker: class NativeEmbeddingReranker {},
}));

const {
  cachedVectorInformation,
  storeVectorResult,
} = require("../../../../utils/files");
const {
  getEmbeddingEngineSelection,
} = require("../../../../utils/helpers");
const { DocumentVectors } = require("../../../../models/vectors");
const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");

describe("LanceDb chunk position persistence", () => {
  let lance;
  let updateOrCreateCollection;

  beforeEach(() => {
    jest.clearAllMocks();
    lance = new LanceDb();
    jest.spyOn(lance, "connect").mockResolvedValue({ client: {} });
    updateOrCreateCollection = jest
      .spyOn(lance, "updateOrCreateCollection")
      .mockResolvedValue(true);
    DocumentVectors.bulkInsert.mockResolvedValue({ documentsInserted: 1 });
  });

  it("keeps cached chunk indexes continuous across cache batches", async () => {
    const allChunks = Array.from({ length: 502 }, (_, index) => ({
      values: [index],
      metadata: { id: `cached-${index}`, text: `chunk ${index}` },
    }));
    cachedVectorInformation.mockResolvedValue({
      exists: true,
      chunks: [allChunks.slice(0, 500), allChunks.slice(500)],
    });

    await expect(
      lance.addDocumentToNamespace(
        "workspace",
        { pageContent: "cached", docId: "doc-1" },
        "document.txt"
      )
    ).resolves.toEqual({ vectorized: true, error: null });

    const records = DocumentVectors.bulkInsert.mock.calls[0][0];
    const submissions = updateOrCreateCollection.mock.calls[0][1];
    expect(records).toHaveLength(502);
    expect(records[499]).toMatchObject({
      docId: "doc-1",
      chunkIndex: 499,
      chunkCount: 502,
      chunkText: "chunk 499",
    });
    expect(records[500]).toMatchObject({
      docId: "doc-1",
      chunkIndex: 500,
      chunkCount: 502,
      chunkText: "chunk 500",
    });
    expect(records[501]).toMatchObject({
      docId: "doc-1",
      chunkIndex: 501,
      chunkCount: 502,
      chunkText: "chunk 501",
    });
    expect(records.map(({ vectorId }) => vectorId)).toEqual(
      submissions.map(({ id }) => id)
    );
  });

  it("persists positions and the submitted IDs for newly embedded chunks", async () => {
    cachedVectorInformation.mockResolvedValue({ exists: false });
    mockSplitText.mockResolvedValue(["first", "second", "third"]);
    getEmbeddingEngineSelection.mockReturnValue({
      embeddingMaxChunkLength: 1000,
      embedChunks: jest
        .fn()
        .mockResolvedValue([[0.1], [0.2], [0.3]]),
    });

    await expect(
      lance.addDocumentToNamespace(
        "workspace",
        { pageContent: "new content", docId: "doc-2", title: "Title" },
        "new-document.txt"
      )
    ).resolves.toEqual({ vectorized: true, error: null });

    const records = DocumentVectors.bulkInsert.mock.calls[0][0];
    const submissions = updateOrCreateCollection.mock.calls[0][1];
    expect(records).toEqual([
      expect.objectContaining({
        docId: "doc-2",
        vectorId: submissions[0].id,
        chunkIndex: 0,
        chunkCount: 3,
        chunkText: "first",
      }),
      expect.objectContaining({
        docId: "doc-2",
        vectorId: submissions[1].id,
        chunkIndex: 1,
        chunkCount: 3,
        chunkText: "second",
      }),
      expect.objectContaining({
        docId: "doc-2",
        vectorId: submissions[2].id,
        chunkIndex: 2,
        chunkCount: 3,
        chunkText: "third",
      }),
    ]);
    expect(storeVectorResult).toHaveBeenCalledTimes(1);
  });
});
