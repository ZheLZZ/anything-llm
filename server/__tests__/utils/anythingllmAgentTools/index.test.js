const {
  AnythingLLMApiClient,
  createAnythingLLMAgentTools,
} = require("../../../utils/anythingllmAgentTools");

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

describe("AnythingLLM local Agent tools", () => {
  it("exposes the four named tools", () => {
    const tools = createAnythingLLMAgentTools({
      apiKey: "test-key",
      fetchImpl: jest.fn(),
    });

    expect(tools.map(({ name }) => name)).toEqual([
      "anythingllm_list_notebooks",
      "anythingllm_search_notebook",
      "anythingllm_read_chunk_context",
      "anythingllm_query_notebook",
    ]);
  });

  it("lists workspaces with document counts", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.endsWith("/workspaces"))
        return jsonResponse(200, {
          workspaces: [
            { name: "One", slug: "one" },
            { name: "Two", slug: "two" },
          ],
        });
      if (url.endsWith("/workspace/one"))
        return jsonResponse(200, {
          workspace: [{ documents: [{}, {}] }],
        });
      if (url.endsWith("/workspace/two"))
        return jsonResponse(200, { workspace: [{ documents: [{}] }] });
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(client.listNotebooks()).resolves.toEqual([
      { name: "One", slug: "one", documentCount: 2 },
      { name: "Two", slug: "two", documentCount: 1 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("resolves a unique name and preserves vector-search positions", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workspaces: [{ name: "Notebook", slug: "notebook-slug" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            {
              id: "vector-1",
              text: "result",
              score: 0.9,
              position: {
                available: true,
                docId: "doc-1",
                chunkIndex: 1,
                chunkNumber: 2,
                chunkCount: 4,
              },
            },
          ],
        })
      );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await client.searchNotebook({
      notebook: "Notebook",
      query: " query ",
      topK: 3,
      scoreThreshold: 0.4,
    });

    expect(result.results[0].position.chunkNumber).toBe(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3001/api/v1/workspace/notebook-slug/vector-search",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "query",
          topN: 3,
          scoreThreshold: 0.4,
        }),
      }
    );
  });

  it("rejects duplicate workspace names instead of guessing", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        workspaces: [
          { name: "Duplicate", slug: "first" },
          { name: "Duplicate", slug: "second" },
        ],
      })
    );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(client.resolveNotebook("Duplicate")).rejects.toMatchObject({
      code: "AMBIGUOUS_NOTEBOOK",
      response: { slugs: ["first", "second"] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("creates a visible thread and returns only compact query data", async () => {
    const source = {
      id: "vector-1",
      title: "source.pdf",
      url: "file://source.pdf",
      text: "supporting text",
      description: "large source description",
      score: 0.9,
      position: {
        available: true,
        docId: "document-1",
        chunkIndex: 2,
        chunkNumber: 3,
        chunkCount: 5,
      },
    };
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workspaces: [{ name: "Notebook", slug: "notebook-slug" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          thread: {
            id: 7,
            name: "Codex \u00b7 question",
            slug: "thread-slug",
          },
          message: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "response-id",
          type: "textResponse",
          textResponse: "<think>private reasoning</think>\nGenerated answer",
          sources: [source],
          chatId: 42,
          metrics: { prompt_tokens: 100 },
          error: null,
        })
      );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await client.queryNotebook({
      notebook: "Notebook",
      question: " question ",
    });

    expect(result).toMatchObject({
      notebook: { name: "Notebook", slug: "notebook-slug" },
      thread: { name: "Codex \u00b7 question", slug: "thread-slug" },
      answer: "Generated answer",
      sources: [
        {
          id: "vector-1",
          title: "source.pdf",
          url: "file://source.pdf",
          score: 0.9,
          position: {
            available: true,
            docId: "document-1",
            chunkIndex: 2,
            chunkNumber: 3,
            chunkCount: 5,
          },
        },
      ],
      sourceCount: 1,
      hasSources: true,
      chatId: 42,
      metrics: { prompt_tokens: 100 },
    });
    expect(JSON.stringify(result)).not.toContain("supporting text");
    expect(JSON.stringify(result)).not.toContain("large source description");
    expect(JSON.stringify(result)).not.toContain("private reasoning");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3001/api/v1/workspace/notebook-slug/thread/new",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Codex \u00b7 question" }),
      }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:3001/api/v1/workspace/notebook-slug/thread/thread-slug/chat",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "question",
          mode: "query",
        }),
      }
    );
  });

  it("reuses an explicit visible thread and preserves a source-free response", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workspaces: [{ name: "Notebook", slug: "notebook-slug" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          type: "textResponse",
          textResponse: "No relevant information.",
          sources: [],
          error: null,
        })
      );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await client.queryNotebook({
      notebook: "notebook-slug",
      question: "Follow up",
      threadSlug: " existing-thread ",
    });

    expect(result).toMatchObject({
      thread: { name: null, slug: "existing-thread" },
      answer: "No relevant information.",
      sources: [],
      sourceCount: 0,
      hasSources: false,
      chatId: null,
      metrics: {},
    });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "http://127.0.0.1:3001/api/v1/workspace/notebook-slug/thread/existing-thread/chat"
    );
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      message: "Follow up",
      mode: "query",
    });
  });

  it("surfaces HTTP 200 failures while creating a visible thread", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workspaces: [{ name: "Notebook", slug: "notebook-slug" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          thread: null,
          message: "Could not create thread.",
        })
      );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      client.queryNotebook({ notebook: "Notebook", question: "Question" })
    ).rejects.toMatchObject({
      code: "ANYTHINGLLM_THREAD_CREATION_FAILED",
      message: "Could not create thread.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects empty, command-prefixed, and invalid-thread queries locally", async () => {
    const fetchImpl = jest.fn();
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      client.queryNotebook({ notebook: "Notebook", question: " " })
    ).rejects.toThrow("question must be a non-empty string");
    await expect(
      client.queryNotebook({ notebook: "Notebook", question: "@agent search" })
    ).rejects.toMatchObject({ code: "QUERY_MODE_PREFIX_NOT_ALLOWED" });
    await expect(
      client.queryNotebook({ notebook: "Notebook", question: "/reset" })
    ).rejects.toMatchObject({ code: "QUERY_MODE_PREFIX_NOT_ALLOWED" });
    await expect(
      client.queryNotebook({
        notebook: "Notebook",
        question: "Question",
        threadSlug: " ",
      })
    ).rejects.toThrow("threadSlug must be a non-empty string");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces HTTP 200 abort responses from notebook query", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workspaces: [{ name: "Notebook", slug: "notebook-slug" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          type: "abort",
          textResponse: null,
          sources: [],
          error: "Vector search failed.",
        })
      );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      client.queryNotebook({
        notebook: "Notebook",
        question: "Question",
        threadSlug: "existing-thread",
      })
    ).rejects.toMatchObject({
      code: "ANYTHINGLLM_QUERY_ABORTED",
      message: "Vector search failed.",
    });
  });

  it("calls the bounded context endpoint and surfaces reindex errors", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workspaces: [{ name: "Notebook", slug: "notebook-slug" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          code: "CHUNK_POSITION_UNAVAILABLE",
          message: "This document must be re-indexed.",
          reindexRequired: true,
        })
      );
    const client = new AnythingLLMApiClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      client.readChunkContext({
        notebook: "notebook-slug",
        vectorId: "vector/1",
        before: 1,
        after: 3,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "CHUNK_POSITION_UNAVAILABLE",
      response: { reindexRequired: true },
    });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "http://127.0.0.1:3001/api/v1/workspace/notebook-slug/chunk/vector%2F1/context?before=1&after=3"
    );
  });

  it("never calls the API without an injected or environment API key", async () => {
    const previousApiKey = process.env.ANYTHINGLLM_API_KEY;
    delete process.env.ANYTHINGLLM_API_KEY;
    const fetchImpl = jest.fn();
    const client = new AnythingLLMApiClient({ fetchImpl });

    try {
      await expect(client.workspaces()).rejects.toThrow(
        "ANYTHINGLLM_API_KEY is required"
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANYTHINGLLM_API_KEY;
      else process.env.ANYTHINGLLM_API_KEY = previousApiKey;
    }
  });
});
