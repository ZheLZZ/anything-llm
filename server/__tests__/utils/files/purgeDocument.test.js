jest.mock("../../../utils/files", () => {
  const os = require("os");
  const path = require("path");
  const documentsPath = path.join(os.tmpdir(), "anythingllm-purge-tests");
  return {
    documentsPath,
    normalizePath: (value) => String(value).replace(/\\/g, "/"),
    isWithin: (outer, inner) => {
      const relative = path.relative(path.resolve(outer), path.resolve(inner));
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    },
    purgeVectorCache: jest.fn(),
    purgeSourceDocument: jest.fn(),
  };
});

jest.mock("../../../models/documents", () => ({
  Document: { removeDocuments: jest.fn() },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: { where: jest.fn() },
}));
jest.mock("../../../models/libraryDocuments", () => ({
  LibraryDocuments: {
    getByDocpath: jest.fn(),
    getByDocpaths: jest.fn(),
    deleteByDocpath: jest.fn(),
    deleteByDocpaths: jest.fn(),
    countReferencesToOriginalStorageKey: jest.fn(),
    referencedOriginalStorageKeys: jest.fn(),
  },
}));
jest.mock("../../../utils/files/originalDocumentStore", () => ({
  removeOriginalFile: jest.fn(),
}));

const fs = require("fs");
const path = require("path");
const {
  documentsPath,
  purgeVectorCache,
  purgeSourceDocument,
} = require("../../../utils/files");
const { Document } = require("../../../models/documents");
const { Workspace } = require("../../../models/workspace");
const { LibraryDocuments } = require("../../../models/libraryDocuments");
const {
  removeOriginalFile,
} = require("../../../utils/files/originalDocumentStore");
const {
  purgeDocument,
  purgeFolder,
} = require("../../../utils/files/purgeDocument");

describe("persistent original cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(documentsPath, { recursive: true, force: true });
    fs.mkdirSync(documentsPath, { recursive: true });
    Workspace.where.mockResolvedValue([{ id: 1, slug: "workspace" }]);
    Document.removeDocuments.mockResolvedValue(true);
    purgeVectorCache.mockResolvedValue(true);
    purgeSourceDocument.mockResolvedValue(true);
    removeOriginalFile.mockResolvedValue(true);
  });

  afterAll(() => {
    fs.rmSync(documentsPath, { recursive: true, force: true });
  });

  it("removes a single-output original after the last library record is purged", async () => {
    const record = {
      id: "library-1",
      originalStorageKey: "shared-original",
    };
    LibraryDocuments.getByDocpath.mockResolvedValue(record);
    LibraryDocuments.deleteByDocpath.mockResolvedValue(record);
    LibraryDocuments.countReferencesToOriginalStorageKey.mockResolvedValue(0);

    await purgeDocument("custom-documents/file.json");

    expect(Document.removeDocuments).toHaveBeenCalledWith(
      { id: 1, slug: "workspace" },
      ["custom-documents/file.json"]
    );
    expect(removeOriginalFile).toHaveBeenCalledWith("shared-original");
  });

  it("keeps a multi-output original while another library record references it", async () => {
    const record = {
      id: "library-child-1",
      originalStorageKey: "shared-original",
    };
    LibraryDocuments.getByDocpath.mockResolvedValue(record);
    LibraryDocuments.deleteByDocpath.mockResolvedValue(record);
    LibraryDocuments.countReferencesToOriginalStorageKey.mockResolvedValue(1);

    await purgeDocument("custom-documents/child-one.json");

    expect(removeOriginalFile).not.toHaveBeenCalled();
  });

  it("folder purge removes orphan originals but preserves keys referenced elsewhere", async () => {
    const folderPath = path.join(documentsPath, "batch");
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, "one.json"), "one");
    fs.writeFileSync(path.join(folderPath, "two.json"), "two");
    const records = [
      { id: "one", originalStorageKey: "orphan-original" },
      { id: "two", originalStorageKey: "still-referenced" },
    ];
    LibraryDocuments.getByDocpaths.mockResolvedValue(records);
    LibraryDocuments.deleteByDocpaths.mockResolvedValue(records);
    LibraryDocuments.referencedOriginalStorageKeys.mockResolvedValue(
      new Set(["still-referenced"])
    );

    await purgeFolder("batch");

    expect(fs.existsSync(folderPath)).toBe(false);
    expect(LibraryDocuments.deleteByDocpaths).toHaveBeenCalledWith([
      "batch/one.json",
      "batch/two.json",
    ]);
    expect(removeOriginalFile).toHaveBeenCalledTimes(1);
    expect(removeOriginalFile).toHaveBeenCalledWith("orphan-original");
  });
});
