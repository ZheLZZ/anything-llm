jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
}));
jest.mock("../../utils/prisma", () => ({
  workspace_documents: {
    findFirst: jest.fn(),
    delete: jest.fn(),
  },
  document_vectors: {
    deleteMany: jest.fn(),
  },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../utils/http", () => ({ safeJsonParse: jest.fn() }));
jest.mock("../../endpoints/utils", () => ({ getModelTag: jest.fn() }));

const { getVectorDbClass } = require("../../utils/helpers");
const prisma = require("../../utils/prisma");
const { Document } = require("../../models/documents");

describe("Document.removeDocuments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("removes every persisted chunk-position row for the document", async () => {
    const vectorDb = { deleteDocumentFromNamespace: jest.fn() };
    getVectorDbClass.mockReturnValue(vectorDb);
    prisma.workspace_documents.findFirst.mockResolvedValue({
      id: 7,
      docId: "doc-1",
      docpath: "folder/document.txt",
      workspaceId: 10,
    });
    prisma.workspace_documents.delete.mockResolvedValue({});
    prisma.document_vectors.deleteMany.mockResolvedValue({ count: 3 });

    await Document.removeDocuments(
      { id: 10, slug: "workspace", name: "Workspace" },
      ["folder/document.txt"]
    );

    expect(vectorDb.deleteDocumentFromNamespace).toHaveBeenCalledWith(
      "workspace",
      "doc-1"
    );
    expect(prisma.workspace_documents.delete).toHaveBeenCalledWith({
      where: { id: 7, workspaceId: 10 },
    });
    expect(prisma.document_vectors.deleteMany).toHaveBeenCalledWith({
      where: { docId: "doc-1" },
    });
  });
});
