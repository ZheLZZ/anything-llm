jest.mock("../../utils/prisma", () => ({
  library_documents: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
}));
jest.mock("../../utils/files/originalDocumentStore", () => ({
  originalExists: jest.fn(),
}));

const prisma = require("../../utils/prisma");
const {
  originalExists,
} = require("../../utils/files/originalDocumentStore");
const { LibraryDocuments } = require("../../models/libraryDocuments");

describe("LibraryDocuments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("validates a display alias without applying filesystem filename rules", () => {
    expect(
      LibraryDocuments.validateDisplayName(" 沐曦招股书（2026申报稿）.pdf ")
    ).toBe("沐曦招股书（2026申报稿）.pdf");
    expect(() => LibraryDocuments.validateDisplayName(" \n ")).toThrow(
      /empty/
    );
    expect(() => LibraryDocuments.validateDisplayName("bad\u0000name")).toThrow(
      /control/
    );
    expect(() => LibraryDocuments.validateDisplayName("bad\u0085name")).toThrow(
      /control/
    );
  });

  it.each([
    "../../etc/passwd",
    "folder/..",
    "folder//file.json",
    "folder/file.json:alternate-stream",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\file.json",
  ])("rejects unsafe canonical document path %s", (docpath) => {
    expect(LibraryDocuments.canonicalDocpath(docpath)).toBeNull();
  });

  it("renames by updating only the library record", async () => {
    prisma.library_documents.update.mockResolvedValue({
      id: "library-1",
      displayName: "新名称",
    });

    await LibraryDocuments.renameDisplayName("library-1", "新名称");

    expect(prisma.library_documents.update).toHaveBeenCalledTimes(1);
    const update = prisma.library_documents.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "library-1" });
    expect(update.data.displayName).toBe("新名称");
    expect(update.data.lastUpdatedAt).toBeInstanceOf(Date);
    expect(Object.keys(update.data).sort()).toEqual([
      "displayName",
      "lastUpdatedAt",
    ]);
  });

  it("registers multi-output documents with one shared original key", async () => {
    prisma.library_documents.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.library_documents.upsert.mockResolvedValue({});
    prisma.$transaction.mockResolvedValue([]);
    const original = {
      originalStorageKey: "7aec429a-162f-4780-8b9d-c700c266a9ca",
      originalFilename: "archive.mbox",
      originalRelativePath: null,
      originalMimeType: "application/mbox",
      originalSizeBytes: "1234",
      originalUploadedAt: new Date(),
    };

    await LibraryDocuments.registerParsedDocuments(
      [
        {
          id: "processed-1",
          location: "mail/one.json",
          title: "One",
        },
        {
          id: "processed-2",
          location: "mail/two.json",
          title: "Two",
        },
      ],
      { sourceType: "upload", original }
    );

    expect(prisma.library_documents.upsert).toHaveBeenCalledTimes(2);
    for (const [call] of prisma.library_documents.upsert.mock.calls) {
      expect(call.create.originalStorageKey).toBe(
        original.originalStorageKey
      );
      expect(call.create.sourceType).toBe("upload");
    }
  });

  it("enriches sources only through the stable processed document id", async () => {
    prisma.library_documents.findMany.mockResolvedValue([
      {
        processedDocumentId: "processed-1",
        displayName: "新的显示名称",
      },
    ]);
    const sources = [
      {
        id: "processed-1",
        title: "Original title",
        text: "A",
        url: "FILE:///app/collector/hotdir/report.pdf",
      },
      { id: "processed-2", title: "新的显示名称", text: "B" },
    ];

    const enriched = await LibraryDocuments.enrichSources(sources);

    expect(enriched[0]).toMatchObject({
      title: "Original title",
      url: "file://report.pdf",
      displayName: "新的显示名称",
      effectiveTitle: "新的显示名称",
    });
    expect(enriched[1]).toEqual(sources[1]);
  });

  it("returns only public-safe original metadata", async () => {
    originalExists.mockResolvedValue(true);
    const fields = await LibraryDocuments.toPublicFields({
      id: "library-1",
      displayName: "Report",
      sourceType: "upload",
      originalStorageKey: "internal-secret-key",
      originalFilename: "报告.pdf",
      originalRelativePath: null,
      originalMimeType: "application/pdf",
      originalSizeBytes: "42",
    });

    expect(fields.originalFileAvailable).toBe(true);
    expect(fields.originalFilename).toBe("报告.pdf");
    expect(fields).not.toHaveProperty("originalStorageKey");
    expect(fields).not.toHaveProperty("path");
  });

  it("does not rewrite an already backfilled legacy record", async () => {
    const existing = {
      id: "library-1",
      processedDocumentId: "processed-1",
      docpath: "custom-documents/legacy.json",
      displayName: "User alias",
      sourceType: "legacy",
    };
    prisma.library_documents.findMany
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing]);

    await LibraryDocuments.ensureLegacyDocuments([
      {
        id: "processed-1",
        location: "custom-documents/legacy.json",
        title: "Immutable processed title",
      },
    ]);

    expect(prisma.library_documents.update).not.toHaveBeenCalled();
    expect(prisma.library_documents.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("lazily backfills a historical document without inventing an original", async () => {
    const record = {
      id: "library-legacy",
      processedDocumentId: "processed-legacy",
      docpath: "custom-documents/legacy.json",
      displayName: "Historical title",
      sourceType: "legacy",
      originalStorageKey: null,
    };
    prisma.library_documents.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce([record]);
    prisma.library_documents.upsert.mockResolvedValue(record);
    prisma.$transaction.mockResolvedValue([]);

    const [document] = await LibraryDocuments.enrichPublicDocuments([
      {
        id: "processed-legacy",
        location: "custom-documents/legacy.json",
        title: "Historical title",
      },
    ]);

    expect(prisma.library_documents.upsert).toHaveBeenCalledTimes(1);
    expect(document).toMatchObject({
      libraryDocumentId: "library-legacy",
      displayName: "Historical title",
      originalFileAvailable: false,
    });
  });

  it("searches aliases without reading or modifying processed content", async () => {
    prisma.library_documents.findMany.mockResolvedValue([]);
    await LibraryDocuments.searchByDisplayName("沐曦招股书", 25);
    expect(prisma.library_documents.findMany).toHaveBeenCalledWith({
      where: { displayName: { contains: "沐曦招股书" } },
      take: 25,
      orderBy: { lastUpdatedAt: "desc" },
    });
  });

  it("moves a record by changing only docpath metadata", async () => {
    prisma.library_documents.findUnique.mockResolvedValue({
      id: "library-1",
      docpath: "custom-documents/file.json",
      displayName: "Persistent alias",
      originalStorageKey: "opaque-key",
    });
    prisma.library_documents.update.mockResolvedValue({});

    await LibraryDocuments.updateDocpath(
      "custom-documents/file.json",
      "archive/file.json"
    );

    const update = prisma.library_documents.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "library-1" });
    expect(update.data.docpath).toBe("archive/file.json");
    expect(update.data.lastUpdatedAt).toBeInstanceOf(Date);
    expect(update.data).not.toHaveProperty("displayName");
    expect(update.data).not.toHaveProperty("originalStorageKey");
  });
});
