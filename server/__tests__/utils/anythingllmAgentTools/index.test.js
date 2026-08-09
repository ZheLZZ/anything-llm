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
  it("exposes the three named tools", () => {
    const tools = createAnythingLLMAgentTools({
      apiKey: "test-key",
      fetchImpl: jest.fn(),
    });

    expect(tools.map(({ name }) => name)).toEqual([
      "anythingllm_list_notebooks",
      "anythingllm_search_notebook",
      "anythingllm_read_chunk_context",
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
