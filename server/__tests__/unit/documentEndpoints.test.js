delete process.env.JWT_SECRET;
process.env.SIG_KEY = "library-document-download-signing-key";
process.env.SIG_SALT = "library-document-download-signing-salt";

jest.mock("../../models/documents", () => ({
  Document: { where: jest.fn() },
}));
jest.mock("../../utils/files", () => ({
  normalizePath: (value) => value,
  documentsPath: __dirname,
  isWithin: () => true,
}));
jest.mock("../../utils/http", () => {
  return {
    reqBody: (request) => request.body,
  };
});
jest.mock("../../utils/middleware/multiUserProtected", () => {
  const ROLES = { admin: "admin", manager: "manager", default: "default" };
  return {
    ROLES,
    flexUserRoleValid: (allowedRoles) => (_request, response, next) => {
      if (!response.locals?.multiUserMode) return next();
      if (allowedRoles.includes(response.locals?.user?.role)) return next();
      return response.sendStatus(401);
    },
  };
});
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next(),
}));
jest.mock("../../utils/files/moveLibraryDocument", () => ({
  moveLibraryDocument: jest.fn(),
}));
jest.mock("../../models/libraryDocuments", () => ({
  LibraryDocuments: {
    canonicalDocpath: (value) =>
      typeof value === "string" ? value.replace(/\\/g, "/") : null,
    getById: jest.fn(),
    renameDisplayName: jest.fn(),
    toPublicFields: jest.fn(),
  },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../utils/files/originalDocumentStore", () => ({
  ...jest.requireActual("../../utils/files/originalDocumentStore"),
  streamOriginalFile: jest.fn(),
}));

const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const { LibraryDocuments } = require("../../models/libraryDocuments");
const { EventLogs } = require("../../models/eventLogs");
const {
  moveLibraryDocument,
} = require("../../utils/files/moveLibraryDocument");
const { Document } = require("../../models/documents");
const {
  streamOriginalFile,
} = require("../../utils/files/originalDocumentStore");
const {
  documentEndpoints,
  sendOriginalDocument,
} = require("../../endpoints/document");

function makeOriginalDocumentToken(payload, expiresIn = "60s") {
  const secret = crypto
    .createHmac("sha256", process.env.SIG_KEY)
    .update(
      "anythingllm:original-document-download:v1:" + process.env.SIG_SALT
    )
    .digest();
  return JWT.sign(payload, secret, { expiresIn });
}

function createApp() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "patch"]) {
    app[method] = (route, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${route}`, handlers.flat());
    };
  }
  documentEndpoints(app);
  return routes;
}

function responseMock(overrides = {}) {
  const response = {
    locals: {},
    headersSent: false,
    status: jest.fn(),
    json: jest.fn(),
    sendStatus: jest.fn(),
    ...overrides,
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  response.sendStatus.mockReturnValue(response);
  return response;
}

describe("library document UI endpoints", () => {
  const routes = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses download-token creation for an unauthorized multi-user role", () => {
    const handlers = routes.get(
      "POST /document/:libraryDocumentId/original-download-token"
    );
    const roleMiddleware = handlers[1];
    const response = responseMock({
      locals: { multiUserMode: true, user: { role: "default" } },
    });
    const next = jest.fn();

    roleMiddleware({}, response, next);

    expect(response.sendStatus).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("binds a short-lived UI token to one purpose and document id", async () => {
    const handler = routes.get(
      "POST /document/:libraryDocumentId/original-download-token"
    ).at(-1);
    LibraryDocuments.getById.mockResolvedValue({
      id: "library-1",
      originalStorageKey: "internal-key",
    });
    const response = responseMock();

    await handler({ params: { libraryDocumentId: "library-1" } }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ success: true, expiresIn: 60 });

    streamOriginalFile.mockResolvedValue(true);
    const downloadHandler = routes.get(
      "GET /document/:libraryDocumentId/original"
    ).at(-1);
    await downloadHandler(
      {
        params: { libraryDocumentId: "library-1" },
        query: { token: body.token },
      },
      responseMock()
    );
    expect(streamOriginalFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another document", { purpose: "original-document-download", libraryDocumentId: "library-2" }],
    ["wrong purpose", { purpose: "session", libraryDocumentId: "library-1" }],
  ])("rejects a token bound to %s", async (_label, payload) => {
    const handler = routes.get(
      "GET /document/:libraryDocumentId/original"
    ).at(-1);
    const response = responseMock();

    await handler(
      {
        params: { libraryDocumentId: "library-1" },
        query: { token: makeOriginalDocumentToken(payload) },
      },
      response
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INVALID_DOWNLOAD_TOKEN" })
    );
    expect(LibraryDocuments.getById).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const handler = routes.get(
      "GET /document/:libraryDocumentId/original"
    ).at(-1);
    const response = responseMock();

    await handler(
      {
        params: { libraryDocumentId: "library-1" },
        query: {
          token: makeOriginalDocumentToken(
            {
              purpose: "original-document-download",
              libraryDocumentId: "library-1",
            },
            "-1s"
          ),
        },
      },
      response
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(LibraryDocuments.getById).not.toHaveBeenCalled();
  });

  it.each([
    [
      { id: "legacy", originalStorageKey: null },
      "ORIGINAL_NOT_AVAILABLE",
    ],
    [
      { id: "missing", originalStorageKey: "internal-key" },
      "ORIGINAL_FILE_MISSING",
    ],
  ])("returns a precise 404 when the original cannot be sent", async (record, code) => {
    streamOriginalFile.mockResolvedValue(false);
    const response = responseMock();

    await sendOriginalDocument(response, record);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code })
    );
  });

  it("renames only library metadata and reports that no reindex occurred", async () => {
    const handler = routes.get(
      "PATCH /document/:libraryDocumentId/display-name"
    ).at(-1);
    LibraryDocuments.getById.mockResolvedValue({
      id: "library-1",
      displayName: "Old name",
    });
    LibraryDocuments.renameDisplayName.mockResolvedValue({
      id: "library-1",
      displayName: "New name",
    });
    LibraryDocuments.toPublicFields.mockResolvedValue({
      libraryDocumentId: "library-1",
      displayName: "New name",
    });
    EventLogs.logEvent.mockResolvedValue(true);
    const response = responseMock();

    await handler(
      {
        params: { libraryDocumentId: "library-1" },
        body: { displayName: "New name" },
      },
      response
    );

    expect(LibraryDocuments.renameDisplayName).toHaveBeenCalledWith(
      "library-1",
      "New name"
    );
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      document: {
        libraryDocumentId: "library-1",
        displayName: "New name",
      },
      reindexed: false,
    });
  });

  it("normalizes Windows paths before enforcing the embedded-document move guard", async () => {
    const handler = routes.get("POST /document/move-files").at(-1);
    Document.where.mockResolvedValue([
      { docpath: "custom-documents/embedded.json" },
    ]);
    const response = responseMock();

    await handler(
      {
        body: {
          files: [
            {
              from: "custom-documents\\embedded.json",
              to: "archive\\embedded.json",
            },
          ],
        },
      },
      response
    );

    expect(Document.where).toHaveBeenCalledWith({
      docpath: {
        in: [
          "custom-documents/embedded.json",
          "custom-documents\\embedded.json",
        ],
      },
    });
    expect(moveLibraryDocument).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      message:
        "1/1 files not moved. Unembed them from all workspaces.",
    });
  });
});
