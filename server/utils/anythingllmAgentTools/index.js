class AnythingLLMApiError extends Error {
  constructor(message, { status = null, code = null, response = null } = {}) {
    super(message);
    this.name = "AnythingLLMApiError";
    this.status = status;
    this.code = code;
    this.response = response;
  }
}

class AnythingLLMApiClient {
  constructor({
    baseUrl = process.env.ANYTHINGLLM_API_BASE_URL ||
      "http://127.0.0.1:3001/api/v1",
    apiKey = process.env.ANYTHINGLLM_API_KEY,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function")
      throw new Error("A Fetch API implementation is required.");

    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    if (!this.apiKey)
      throw new AnythingLLMApiError(
        "ANYTHINGLLM_API_KEY is required to call AnythingLLM."
      );

    const response = await this.fetch(
      `${this.baseUrl}/${String(path).replace(/^\/+/, "")}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );

    const responseText = await response.text();
    let data = null;
    if (responseText.length > 0) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { message: responseText };
      }
    }

    if (!response.ok)
      throw new AnythingLLMApiError(
        data?.message ||
          `AnythingLLM request failed with HTTP ${response.status}.`,
        {
          status: response.status,
          code: data?.code || null,
          response: data,
        }
      );
    return data;
  }

  async workspaces() {
    const data = await this.request("workspaces");
    return Array.isArray(data?.workspaces) ? data.workspaces : [];
  }

  async resolveNotebook(notebook) {
    const requested = String(notebook || "").trim();
    if (!requested)
      throw new AnythingLLMApiError(
        "notebook must be a workspace name or slug."
      );

    const workspaces = await this.workspaces();
    const slugMatch = workspaces.find(({ slug }) => slug === requested);
    if (slugMatch) return slugMatch;

    let nameMatches = workspaces.filter(({ name }) => name === requested);
    if (nameMatches.length === 0) {
      const normalized = requested.toLocaleLowerCase();
      nameMatches = workspaces.filter(
        ({ name }) => String(name).toLocaleLowerCase() === normalized
      );
    }

    if (nameMatches.length === 0)
      throw new AnythingLLMApiError(
        `No AnythingLLM workspace matches notebook "${requested}".`,
        { code: "NOTEBOOK_NOT_FOUND" }
      );
    if (nameMatches.length > 1)
      throw new AnythingLLMApiError(
        `Multiple AnythingLLM workspaces are named "${requested}"; use a slug instead.`,
        {
          code: "AMBIGUOUS_NOTEBOOK",
          response: { slugs: nameMatches.map(({ slug }) => slug) },
        }
      );
    return nameMatches[0];
  }

  async listNotebooks() {
    const workspaces = await this.workspaces();
    return await Promise.all(
      workspaces.map(async (workspace) => {
        const details = await this.request(
          `workspace/${encodeURIComponent(workspace.slug)}`
        );
        const detailedWorkspace = Array.isArray(details?.workspace)
          ? details.workspace[0]
          : details?.workspace;
        return {
          name: workspace.name,
          slug: workspace.slug,
          documentCount: Array.isArray(detailedWorkspace?.documents)
            ? detailedWorkspace.documents.length
            : 0,
        };
      })
    );
  }

  async searchNotebook({ notebook, query, topK = 8, scoreThreshold = 0.25 }) {
    const workspace = await this.resolveNotebook(notebook);
    if (typeof query !== "string" || query.trim().length === 0)
      throw new AnythingLLMApiError("query must be a non-empty string.");
    if (!Number.isSafeInteger(topK) || topK < 1)
      throw new AnythingLLMApiError("topK must be a positive integer.");
    if (
      typeof scoreThreshold !== "number" ||
      scoreThreshold < 0 ||
      scoreThreshold > 1
    )
      throw new AnythingLLMApiError(
        "scoreThreshold must be a number from 0 through 1."
      );

    const data = await this.request(
      `workspace/${encodeURIComponent(workspace.slug)}/vector-search`,
      {
        method: "POST",
        body: {
          query: query.trim(),
          topN: topK,
          scoreThreshold,
        },
      }
    );
    return {
      notebook: { name: workspace.name, slug: workspace.slug },
      results: Array.isArray(data?.results) ? data.results : [],
    };
  }

  async readChunkContext({ notebook, vectorId, before = 2, after = 2 }) {
    const workspace = await this.resolveNotebook(notebook);
    if (typeof vectorId !== "string" || vectorId.trim().length === 0)
      throw new AnythingLLMApiError("vectorId must be a non-empty string.");
    for (const [name, value] of Object.entries({ before, after })) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 10)
        throw new AnythingLLMApiError(
          `${name} must be an integer from 0 through 10.`
        );
    }

    return await this.request(
      `workspace/${encodeURIComponent(workspace.slug)}/chunk/${encodeURIComponent(
        vectorId.trim()
      )}/context?before=${before}&after=${after}`
    );
  }
}

function createAnythingLLMAgentTools(options = {}) {
  const client = new AnythingLLMApiClient(options);
  return [
    {
      name: "anythingllm_list_notebooks",
      description:
        "List AnythingLLM workspaces with their slugs and document counts.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => await client.listNotebooks(),
    },
    {
      name: "anythingllm_search_notebook",
      description:
        "Resolve a notebook name or slug and run vector search in that workspace.",
      inputSchema: {
        type: "object",
        required: ["notebook", "query"],
        properties: {
          notebook: { type: "string" },
          query: { type: "string" },
          topK: { type: "integer", minimum: 1, default: 8 },
          scoreThreshold: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.25,
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => await client.searchNotebook(args),
    },
    {
      name: "anythingllm_read_chunk_context",
      description:
        "Read ordered chunks around a vector-search result in the same workspace document.",
      inputSchema: {
        type: "object",
        required: ["notebook", "vectorId"],
        properties: {
          notebook: { type: "string" },
          vectorId: { type: "string" },
          before: { type: "integer", minimum: 0, maximum: 10, default: 2 },
          after: { type: "integer", minimum: 0, maximum: 10, default: 2 },
        },
        additionalProperties: false,
      },
      handler: async (args) => await client.readChunkContext(args),
    },
  ];
}

module.exports = {
  AnythingLLMApiClient,
  AnythingLLMApiError,
  createAnythingLLMAgentTools,
};
