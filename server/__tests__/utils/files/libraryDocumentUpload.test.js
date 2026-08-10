jest.mock("../../../utils/files/originalDocumentStore", () => ({
  preserveUploadedFile: jest.fn(),
  cleanupStagedOriginal: jest.fn(),
}));

jest.mock("../../../utils/files", () => {
  const os = require("os");
  const path = require("path");
  const hotdirPath = path.join(os.tmpdir(), "anythingllm-library-upload-tests");
  return {
    hotdirPath,
    isWithin: (outer, inner) => {
      const relative = path.relative(path.resolve(outer), path.resolve(inner));
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    },
    purgeSourceDocument: jest.fn(),
    moveProcessedDocsToFolder: jest.fn((documents, folderName) => {
      for (const document of documents)
        document.location = `${folderName}\\${path.basename(
          document.location
        )}`;
    }),
  };
});

jest.mock("../../../models/libraryDocuments", () => ({
  LibraryDocuments: {
    canonicalDocpath: (docpath) => docpath.replace(/\\/g, "/"),
    registerParsedDocuments: jest.fn(),
    enrichPublicDocuments: jest.fn(),
    deleteByDocpaths: jest.fn(),
  },
}));

const fs = require("fs");
const path = require("path");
const {
  hotdirPath,
  purgeSourceDocument,
  moveProcessedDocsToFolder,
} = require("../../../utils/files");
const {
  preserveUploadedFile,
  cleanupStagedOriginal,
} = require("../../../utils/files/originalDocumentStore");
const { LibraryDocuments } = require("../../../models/libraryDocuments");
const {
  processUploadedLibraryDocument,
} = require("../../../utils/files/libraryDocumentUpload");

describe("processUploadedLibraryDocument", () => {
  const original = {
    originalStorageKey: "8494ea40-d44d-466e-b27f-a2edcbdf5b70",
    originalFilename: "沐曦股份招股说明书.pdf",
    originalRelativePath: null,
    originalMimeType: "application/pdf",
    originalSizeBytes: "12",
    originalUploadedAt: new Date("2026-08-10T00:00:00Z"),
  };
  let file;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync(hotdirPath, { recursive: true });
    file = {
      path: path.join(hotdirPath, "flattened-upload"),
      originalname: "沐曦股份招股说明书.pdf",
      mimetype: "application/pdf",
      size: 12,
    };
    fs.writeFileSync(file.path, "original PDF");
    preserveUploadedFile.mockResolvedValue(original);
    cleanupStagedOriginal.mockResolvedValue(true);
    purgeSourceDocument.mockResolvedValue(true);
    LibraryDocuments.registerParsedDocuments.mockImplementation(
      async (documents) =>
        documents.map((document, index) => ({
          id: `library-${index}`,
          docpath: document.location,
        }))
    );
    LibraryDocuments.deleteByDocpaths.mockResolvedValue([]);
    LibraryDocuments.enrichPublicDocuments.mockImplementation(
      async (documents) => documents
    );
  });

  afterEach(() => {
    fs.rmSync(hotdirPath, { recursive: true, force: true });
  });

  it("cleans the staged original and current processed output on parse failure", async () => {
    const documents = [
      {
        id: "processed-current",
        location: "custom-documents/current.json",
      },
    ];
    const collector = {
      processDocument: jest.fn(async () => {
        fs.unlinkSync(file.path);
        return { success: false, reason: "invalid PDF", documents };
      }),
    };

    const result = await processUploadedLibraryDocument({ collector, file });

    expect(result).toEqual({
      success: false,
      reason: "invalid PDF",
      documents: [],
    });
    expect(cleanupStagedOriginal).toHaveBeenCalledWith(
      original.originalStorageKey
    );
    expect(purgeSourceDocument).toHaveBeenCalledWith(
      "custom-documents/current.json"
    );
    expect(LibraryDocuments.registerParsedDocuments).not.toHaveBeenCalled();
    expect(LibraryDocuments.deleteByDocpaths).toHaveBeenCalledWith([
      "custom-documents/current.json",
    ]);
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it("does not orphan an original when the collector returns no documents", async () => {
    const collector = {
      processDocument: jest.fn(async () => {
        fs.unlinkSync(file.path);
        return { success: true, documents: [] };
      }),
    };

    const result = await processUploadedLibraryDocument({ collector, file });

    expect(result).toEqual({
      success: false,
      reason: "Document processing produced no documents.",
      documents: [],
    });
    expect(cleanupStagedOriginal).toHaveBeenCalledWith(
      original.originalStorageKey
    );
    expect(LibraryDocuments.registerParsedDocuments).not.toHaveBeenCalled();
  });

  it("rolls back parsed outputs when database registration fails", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const documents = [
      {
        id: "processed-current",
        location: "custom-documents/current.json",
      },
    ];
    const collector = {
      processDocument: jest.fn(async () => {
        fs.unlinkSync(file.path);
        return { success: true, documents };
      }),
    };
    LibraryDocuments.registerParsedDocuments.mockRejectedValue(
      Object.assign(new Error("database offline"), { code: "DB_FAILURE" })
    );

    const result = await processUploadedLibraryDocument({ collector, file });

    expect(result.success).toBe(false);
    expect(cleanupStagedOriginal).toHaveBeenCalledWith(
      original.originalStorageKey
    );
    expect(purgeSourceDocument).toHaveBeenCalledWith(
      "custom-documents/current.json"
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Persistent upload registration failed (DB_FAILURE)."
    );
    consoleError.mockRestore();
  });

  it("registers every collector output against one original after its final move", async () => {
    const documents = [
      { id: "processed-1", location: "custom-documents/one.json" },
      { id: "processed-2", location: "custom-documents/two.json" },
    ];
    const collector = {
      processDocument: jest.fn(async () => {
        fs.unlinkSync(file.path);
        return { success: true, documents };
      }),
    };

    const result = await processUploadedLibraryDocument({
      collector,
      file,
      folderName: "mail-archive",
    });

    expect(result.success).toBe(true);
    expect(preserveUploadedFile).toHaveBeenCalledWith({
      sourcePath: file.path,
      originalFilename: "沐曦股份招股说明书.pdf",
      originalRelativePath: "mail-archive/沐曦股份招股说明书.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
    });
    expect(moveProcessedDocsToFolder).toHaveBeenCalledWith(
      documents,
      "mail-archive"
    );
    expect(documents.map((document) => document.location)).toEqual([
      "mail-archive/one.json",
      "mail-archive/two.json",
    ]);
    expect(LibraryDocuments.registerParsedDocuments).toHaveBeenCalledWith(
      documents,
      { sourceType: "upload", original }
    );
    expect(cleanupStagedOriginal).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it("deletes committed library rows if public readback fails", async () => {
    const documents = [
      {
        id: "processed-current",
        location: "custom-documents/current.json",
      },
    ];
    const collector = {
      processDocument: jest.fn(async () => {
        fs.unlinkSync(file.path);
        return { success: true, documents };
      }),
    };
    LibraryDocuments.enrichPublicDocuments.mockRejectedValue(
      Object.assign(new Error("readback failed"), {
        code: "READBACK_FAILED",
      })
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await processUploadedLibraryDocument({ collector, file });

    expect(result.success).toBe(false);
    expect(LibraryDocuments.deleteByDocpaths).toHaveBeenCalledWith([
      "custom-documents/current.json",
    ]);
    expect(cleanupStagedOriginal).toHaveBeenCalledWith(
      original.originalStorageKey
    );
    expect(purgeSourceDocument).toHaveBeenCalledWith(
      "custom-documents/current.json"
    );
    consoleError.mockRestore();
  });
});
