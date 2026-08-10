const fs = require("fs");
const os = require("os");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

describe("library document rename against an isolated SQLite database", () => {
  let root;
  let prisma;
  let LibraryDocuments;
  let processedPath;
  let cachePath;
  let previousFetch;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "library-sqlite-test-"));
    const databasePath = path.join(root, "test.db").replace(/\\/g, "/");
    prisma = new PrismaClient({
      datasources: { db: { url: `file:${databasePath}` } },
    });
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../prisma/migrations/20260810120000_add_library_documents/migration.sql"
      ),
      "utf8"
    );
    for (const statement of migration
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await prisma.$executeRawUnsafe(statement);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "document_vectors" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "docId" TEXT NOT NULL,
        "vectorId" TEXT NOT NULL,
        "chunkIndex" INTEGER,
        "chunkCount" INTEGER,
        "chunkText" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    jest.doMock("../../utils/prisma", () => prisma);
    jest.doMock("../../utils/files/originalDocumentStore", () => ({
      originalExists: jest.fn().mockResolvedValue(false),
    }));
    ({ LibraryDocuments } = require("../../models/libraryDocuments"));
    previousFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterAll(async () => {
    global.fetch = previousFetch;
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.library_documents.deleteMany();
    await prisma.$executeRawUnsafe('DELETE FROM "document_vectors"');
    processedPath = path.join(root, "immutable-processed.json");
    cachePath = path.join(root, "immutable-vector-cache.json");
    fs.writeFileSync(
      processedPath,
      JSON.stringify({
        id: "processed-1",
        title: "Immutable processed title",
        text: "Immutable chunks",
      })
    );
    fs.writeFileSync(cachePath, JSON.stringify({ vectors: [1, 2, 3] }));
    await prisma.library_documents.create({
      data: {
        id: "library-1",
        processedDocumentId: "processed-1",
        docpath: "custom-documents/immutable-processed.json",
        displayName: "Old display name",
        sourceType: "upload",
        originalStorageKey: "opaque-original",
        originalFilename: "原始文件.pdf",
        originalMimeType: "application/pdf",
        originalSizeBytes: "123",
      },
    });
    await prisma.$executeRawUnsafe(`
      INSERT INTO "document_vectors"
        ("docId", "vectorId", "chunkIndex", "chunkCount", "chunkText")
      VALUES
        ('processed-1', 'vector-1', 0, 2, 'first chunk'),
        ('processed-1', 'vector-2', 1, 2, 'second chunk')
    `);
    global.fetch.mockClear();
  });

  it("changes only displayName and leaves processed data, cache, and vector rows byte-for-byte stable", async () => {
    const beforeRecord = await prisma.library_documents.findUnique({
      where: { id: "library-1" },
    });
    const beforeVectors = await prisma.$queryRawUnsafe(
      'SELECT * FROM "document_vectors" ORDER BY "id"'
    );
    const beforeProcessed = fs.readFileSync(processedPath);
    const beforeCache = fs.readFileSync(cachePath);
    const beforeProcessedMtime = fs.statSync(processedPath).mtimeMs;
    const beforeCacheMtime = fs.statSync(cachePath).mtimeMs;

    await LibraryDocuments.renameDisplayName(
      "library-1",
      "沐曦招股书（2026申报稿）"
    );

    const afterRecord = await prisma.library_documents.findUnique({
      where: { id: "library-1" },
    });
    const afterVectors = await prisma.$queryRawUnsafe(
      'SELECT * FROM "document_vectors" ORDER BY "id"'
    );
    expect(afterRecord).toMatchObject({
      ...beforeRecord,
      displayName: "沐曦招股书（2026申报稿）",
      lastUpdatedAt: expect.any(Date),
    });
    expect(afterRecord.docpath).toBe(beforeRecord.docpath);
    expect(afterRecord.processedDocumentId).toBe(
      beforeRecord.processedDocumentId
    );
    expect(afterRecord.originalStorageKey).toBe(
      beforeRecord.originalStorageKey
    );
    expect(afterVectors).toEqual(beforeVectors);
    expect(fs.readFileSync(processedPath)).toEqual(beforeProcessed);
    expect(fs.readFileSync(cachePath)).toEqual(beforeCache);
    expect(fs.statSync(processedPath).mtimeMs).toBe(beforeProcessedMtime);
    expect(fs.statSync(cachePath).mtimeMs).toBe(beforeCacheMtime);
    expect(global.fetch).not.toHaveBeenCalled();

    const [listed] = await LibraryDocuments.enrichPublicDocuments(
      [
        {
          id: "processed-1",
          location: "custom-documents/immutable-processed.json",
          title: "Immutable processed title",
        },
      ],
      { ensureLegacy: false }
    );
    expect(listed.displayName).toBe("沐曦招股书（2026申报稿）");
    expect(
      await LibraryDocuments.searchByDisplayName("2026申报稿")
    ).toHaveLength(1);
    const [source] = await LibraryDocuments.enrichSources([
      { id: "processed-1", title: "Immutable processed title" },
    ]);
    expect(source).toMatchObject({
      title: "Immutable processed title",
      effectiveTitle: "沐曦招股书（2026申报稿）",
    });
  });
});
