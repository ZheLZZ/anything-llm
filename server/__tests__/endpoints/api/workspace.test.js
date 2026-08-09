jest.mock("uuid", () => ({ v4: jest.fn(() => "response-id") }));
jest.mock("../../../models/documents", () => ({ Document: {} }));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../models/vectors", () => ({
  DocumentVectors: {
    forVectorIds: jest.fn(),
    contextByVectorId: jest.fn(),
  },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: { get: jest.fn() },
}));
jest.mock("../../../models/workspaceChats", () => ({ WorkspaceChats: {} }));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  resolveProviderConnector: jest.fn(),
}));
jest.mock("../../../utils/http", () => ({
  multiUserMode: jest.fn(),
  reqBody: (request) => request.body,
  safeJsonParse: (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
}));
jest.mock("../../../utils/middleware/validApiKey", () => ({
  validApiKey: jest.fn(),
}));
jest.mock("../../../utils/chats/stream", () => ({ VALID_CHAT_MODE: [] }));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  convertToChatHistory: jest.fn(),
  writeResponseChunk: jest.fn(),
}));
jest.mock("../../../utils/chats/apiChatHandler", () => ({
  ApiChatHandler: { streamChat: jest.fn() },
}));
jest.mock("../../../endpoints/utils", () => ({ getModelTag: jest.fn() }));
jest.mock(
  "../../../utils/middleware/workspaceDeletionProtection",
  () => ({ workspaceDeletionProtection: jest.fn() })
);

const { DocumentVectors } = require("../../../models/vectors");
const { Workspace } = require("../../../models/workspace");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../../../utils/helpers");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const {
  apiWorkspaceEndpoints,
  parseChunkContextSize,
} = require("../../../endpoints/api/workspace");

function registeredRoutes() {
  const routes = { get: {}, post: {}, delete: {} };
  const app = {};
  for (const method of Object.keys(routes)) {
    app[method] = (path, ...handlers) => {
      routes[method][path] = handlers.flat();
    };
  }
  apiWorkspaceEndpoints(app);
  return routes;
}

function responseMock() {
  return {
    locals: {},
    status: jest.fn(function () {
      return this;
    }),
    json: jest.fn(function () {
      return this;
    }),
    sendStatus: jest.fn(function () {
      return this;
    }),
    end: jest.fn(function () {
      return this;
    }),
  };
}

describe("workspace chunk APIs", () => {
  const workspace = {
    id: 10,
    name: "My Workspace",
    slug: "my-workspace",
    similarityThreshold: 0.25,
    topN: 4,
    vectorSearchMode: "default",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Workspace.get.mockResolvedValue(workspace);
  });

  it("registers both routes behind the API key middleware", () => {
    const routes = registeredRoutes();

    expect(
      routes.post["/v1/workspace/:slug/vector-search"][0]
    ).toBe(validApiKey);
    expect(
      routes.get["/v1/workspace/:slug/chunk/:vectorId/context"][0]
    ).toBe(validApiKey);
  });

  it("adds positions in one batch without changing existing search fields", async () => {
    const VectorDb = {
      hasNamespace: jest.fn().mockResolvedValue(true),
      namespaceCount: jest.fn().mockResolvedValue(2),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        sources: [
          {
            id: "vector-1",
            text: "first result",
            url: "file://first.txt",
            title: "first.txt",
            docAuthor: "Author",
            description: "Description",
            docSource: "doc-source",
            chunkSource: "chunk-source",
            published: "today",
            wordCount: 10,
            token_count_estimate: 12,
            _distance: 0.1,
            score: 0.9,
          },
          {
            id: "legacy-vector",
            text: "legacy result",
            title: "legacy.txt",
            _distance: 0.2,
            score: 0.8,
          },
        ],
      }),
    };
    getVectorDbClass.mockReturnValue(VectorDb);
    resolveProviderConnector.mockResolvedValue({ connector: {} });
    DocumentVectors.forVectorIds.mockResolvedValue([
      {
        docId: "doc-1",
        vectorId: "vector-1",
        chunkIndex: 4,
        chunkCount: 9,
        chunkText: "first result",
      },
      {
        docId: "legacy-doc",
        vectorId: "legacy-vector",
        chunkIndex: null,
        chunkCount: null,
        chunkText: null,
      },
    ]);
    const routes = registeredRoutes();
    const handler =
      routes.post["/v1/workspace/:slug/vector-search"].at(-1);
    const response = responseMock();

    await handler(
      {
        params: { slug: "my-workspace" },
        body: { query: "query", topN: 2, scoreThreshold: 0.25 },
      },
      response
    );

    expect(DocumentVectors.forVectorIds).toHaveBeenCalledTimes(1);
    expect(DocumentVectors.forVectorIds).toHaveBeenCalledWith([
      "vector-1",
      "legacy-vector",
    ]);
    expect(response.status).toHaveBeenCalledWith(200);
    const { results } = response.json.mock.calls[0][0];
    expect(results[0]).toEqual({
      id: "vector-1",
      text: "first result",
      metadata: {
        url: "file://first.txt",
        title: "first.txt",
        author: "Author",
        description: "Description",
        docSource: "doc-source",
        chunkSource: "chunk-source",
        published: "today",
        wordCount: 10,
        tokenCount: 12,
      },
      distance: 0.1,
      score: 0.9,
      position: {
        available: true,
        docId: "doc-1",
        chunkIndex: 4,
        chunkNumber: 5,
        chunkCount: 9,
      },
    });
    expect(results[1].position).toEqual({
      available: false,
      reindexRequired: true,
    });
  });

  it("returns ordered context with human-readable chunk numbers", async () => {
    DocumentVectors.contextByVectorId.mockResolvedValue({
      found: true,
      reindexRequired: false,
      document: {
        docId: "doc-1",
        filename: "fallback.txt",
        metadata: JSON.stringify({ title: "Document title" }),
      },
      hit: {
        vectorId: "vector-2",
        chunkIndex: 2,
        chunkCount: 5,
      },
      range: { fromIndex: 1, toIndex: 3 },
      chunks: [
        { vectorId: "vector-1", chunkIndex: 1, chunkText: "before" },
        { vectorId: "vector-2", chunkIndex: 2, chunkText: "hit" },
        { vectorId: "vector-3", chunkIndex: 3, chunkText: "after" },
      ],
    });
    const routes = registeredRoutes();
    const handler =
      routes.get["/v1/workspace/:slug/chunk/:vectorId/context"].at(-1);
    const response = responseMock();

    await handler(
      {
        params: { slug: "my-workspace", vectorId: "vector-2" },
        query: {},
      },
      response
    );

    expect(DocumentVectors.contextByVectorId).toHaveBeenCalledWith({
      vectorId: "vector-2",
      workspaceId: 10,
      before: 2,
      after: 2,
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      workspace: { name: "My Workspace", slug: "my-workspace" },
      document: { docId: "doc-1", title: "Document title" },
      hit: {
        vectorId: "vector-2",
        chunkIndex: 2,
        chunkNumber: 3,
        chunkCount: 5,
      },
      range: { fromIndex: 1, toIndex: 3 },
      chunks: [
        {
          vectorId: "vector-1",
          chunkIndex: 1,
          chunkNumber: 2,
          text: "before",
          matched: false,
        },
        {
          vectorId: "vector-2",
          chunkIndex: 2,
          chunkNumber: 3,
          text: "hit",
          matched: true,
        },
        {
          vectorId: "vector-3",
          chunkIndex: 3,
          chunkNumber: 4,
          text: "after",
          matched: false,
        },
      ],
    });
  });

  it("returns 404 for an invalid workspace", async () => {
    Workspace.get.mockResolvedValue(null);
    const handler = registeredRoutes().get[
      "/v1/workspace/:slug/chunk/:vectorId/context"
    ].at(-1);
    const response = responseMock();

    await handler(
      { params: { slug: "missing", vectorId: "vector-1" }, query: {} },
      response
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(DocumentVectors.contextByVectorId).not.toHaveBeenCalled();
  });

  it("returns the same 404 for missing and cross-workspace vectors", async () => {
    DocumentVectors.contextByVectorId.mockResolvedValue({ found: false });
    const handler = registeredRoutes().get[
      "/v1/workspace/:slug/chunk/:vectorId/context"
    ].at(-1);
    const response = responseMock();

    await handler(
      {
        params: { slug: "my-workspace", vectorId: "other-vector" },
        query: { before: "1", after: "1" },
      },
      response
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      code: "CHUNK_NOT_FOUND",
      message: "The vector chunk was not found in this workspace.",
    });
  });

  it.each(["-1", "1.5", "11", "not-a-number"])(
    "rejects invalid context size %s",
    async (before) => {
      const handler = registeredRoutes().get[
        "/v1/workspace/:slug/chunk/:vectorId/context"
      ].at(-1);
      const response = responseMock();

      await handler(
        {
          params: { slug: "my-workspace", vectorId: "vector-1" },
          query: { before, after: "2" },
        },
        response
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(DocumentVectors.contextByVectorId).not.toHaveBeenCalled();
    }
  );

  it("returns 409 when a legacy document must be re-indexed", async () => {
    DocumentVectors.contextByVectorId.mockResolvedValue({
      found: true,
      reindexRequired: true,
    });
    const handler = registeredRoutes().get[
      "/v1/workspace/:slug/chunk/:vectorId/context"
    ].at(-1);
    const response = responseMock();

    await handler(
      {
        params: { slug: "my-workspace", vectorId: "legacy-vector" },
        query: {},
      },
      response
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      code: "CHUNK_POSITION_UNAVAILABLE",
      message:
        "This document must be re-indexed before chunk context can be read.",
      reindexRequired: true,
    });
  });

  it("accepts only integer context sizes from zero through ten", () => {
    expect(parseChunkContextSize(undefined)).toBe(2);
    expect(parseChunkContextSize("0")).toBe(0);
    expect(parseChunkContextSize(10)).toBe(10);
    expect(parseChunkContextSize([])).toBeNull();
    expect(parseChunkContextSize(10.5)).toBeNull();
  });
});
