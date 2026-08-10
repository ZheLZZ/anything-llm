jest.mock("../../../utils/files", () => {
  const os = require("os");
  const path = require("path");
  const documentsPath = path.join(os.tmpdir(), "anythingllm-move-tests");
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
  };
});

jest.mock("../../../models/libraryDocuments", () => ({
  LibraryDocuments: {
    canonicalDocpath: (docpath) => docpath.replace(/\\/g, "/"),
    getByDocpath: jest.fn(),
    updateDocpath: jest.fn(),
  },
}));

const fs = require("fs");
const path = require("path");
const { documentsPath } = require("../../../utils/files");
const { LibraryDocuments } = require("../../../models/libraryDocuments");
const {
  moveLibraryDocument,
} = require("../../../utils/files/moveLibraryDocument");

describe("moveLibraryDocument", () => {
  const from = "custom-documents/file.json";
  const to = "archive/file.json";
  const sourcePath = path.join(documentsPath, from);
  const destinationPath = path.join(documentsPath, to);

  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(documentsPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(sourcePath, "processed-json");
  });

  afterAll(() => {
    fs.rmSync(documentsPath, { recursive: true, force: true });
  });

  it("moves the file and updates only the library docpath linkage", async () => {
    LibraryDocuments.getByDocpath.mockResolvedValue({
      id: "library-1",
      displayName: "Persistent alias",
      originalStorageKey: "opaque-original",
    });
    LibraryDocuments.updateDocpath.mockResolvedValue({});

    await expect(moveLibraryDocument(from, to)).resolves.toBe(true);

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("processed-json");
    expect(LibraryDocuments.updateDocpath).toHaveBeenCalledWith(from, to);
  });

  it("rolls the filesystem back when the metadata update fails", async () => {
    LibraryDocuments.getByDocpath.mockResolvedValue({ id: "library-1" });
    LibraryDocuments.updateDocpath.mockRejectedValue(
      new Error("database unavailable")
    );

    await expect(moveLibraryDocument(from, to)).rejects.toThrow(
      "database unavailable"
    );

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("processed-json");
    expect(fs.existsSync(destinationPath)).toBe(false);
  });
});
