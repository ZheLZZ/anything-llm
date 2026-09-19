class AnythingLLMApiError extends Error {
  constructor(message, { status = null, code = null, response = null } = {}) {
    super(message);
    this.name = "AnythingLLMApiError";
    this.status = status;
    this.code = code;
    this.response = response;
  }
}

function compactString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function cleanGeneratedAnswer(value) {
  const original = typeof value === "string" ? value.trim() : "";
  const withoutLeadingThinking = original
    .replace(/^(?:\s*<think>[\s\S]*?<\/think>\s*)+/i, "")
    .trim();
  return withoutLeadingThinking || original;
}

function queryThreadName(question) {
  const prefix = "Codex · ";
  const maxLength = 64;
  const normalized = String(question).replace(/\s+/g, " ").trim();
  const availableLength = maxLength - prefix.length;
  const label =
    normalized.length <= availableLength
      ? normalized
      : `${normalized.slice(0, availableLength - 1)}…`;
  return `${prefix}${label}`;
}

function compactQuerySource(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source))
    return null;

  const metadata =
    source.metadata !== null &&
    typeof source.metadata === "object" &&
    !Array.isArray(source.metadata)
      ? source.metadata
      : {};
  const field = (name) => source[name] ?? metadata[name];
  const compact = {};
  const id = compactString(field("id"), 200);
  const title = compactString(field("title"), 300);
  const url = compactString(field("url"), 1_000);
  const score = field("score");

  if (id) compact.id = id;
  if (title) compact.title = title;
  if (url) compact.url = url;
  if (typeof score === "number" && Number.isFinite(score))
    compact.score = score;

  const rawPosition = source.position ?? metadata.position;
  if (
    rawPosition !== null &&
    typeof rawPosition === "object" &&
    !Array.isArray(rawPosition)
  ) {
    const position = {};
    if (typeof rawPosition.available === "boolean")
      position.available = rawPosition.available;
    const docId = compactString(rawPosition.docId, 200);
    if (docId) position.docId = docId;
    for (const name of ["chunkIndex", "chunkNumber", "chunkCount"]) {
      if (Number.isSafeInteger(rawPosition[name]))
        position[name] = rawPosition[name];
    }
    if (Object.keys(position).length > 0) compact.position = position;
  }

  return Object.keys(compact).length > 0 ? compact : null;
}

function compactQueryMetrics(metrics) {
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics))
    return {};

  const compact = {};
  for (const name of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "duration",
    "outputTps",
  ]) {
    if (typeof metrics[name] === "number" && Number.isFinite(metrics[name]))
      compact[name] = metrics[name];
  }
  for (const name of ["model", "provider", "timestamp"]) {
    const value = compactString(metrics[name], 200);
    if (value) compact[name] = value;
  }
  return compact;
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

  async queryNotebook({ notebook, question, threadSlug = null }) {
    if (typeof question !== "string" || question.trim().length === 0)
      throw new AnythingLLMApiError("question must be a non-empty string.");

    const message = question.trim();
    if (/^(?:@agent|\/)/i.test(message))
      throw new AnythingLLMApiError(
        "question cannot begin with @agent or a slash command in query mode.",
        { code: "QUERY_MODE_PREFIX_NOT_ALLOWED" }
      );

    let resolvedThreadSlug = null;
    if (threadSlug !== null && threadSlug !== undefined) {
      if (typeof threadSlug !== "string" || threadSlug.trim().length === 0)
        throw new AnythingLLMApiError(
          "threadSlug must be a non-empty string when provided."
        );
      resolvedThreadSlug = threadSlug.trim();
    }

    const workspace = await this.resolveNotebook(notebook);

    let thread = { name: null, slug: resolvedThreadSlug };
    if (!resolvedThreadSlug) {
      const threadData = await this.request(
        `workspace/${encodeURIComponent(workspace.slug)}/thread/new`,
        {
          method: "POST",
          body: { name: queryThreadName(message) },
        }
      );
      if (
        typeof threadData?.thread?.slug !== "string" ||
        threadData.thread.slug.trim().length === 0
      )
        throw new AnythingLLMApiError(
          threadData?.message || "AnythingLLM could not create a query thread.",
          {
            code: "ANYTHINGLLM_THREAD_CREATION_FAILED",
            response: threadData,
          }
        );
      resolvedThreadSlug = threadData.thread.slug.trim();
      thread = {
        name: compactString(threadData.thread.name, 100),
        slug: resolvedThreadSlug,
      };
    }

    const data = await this.request(
      `workspace/${encodeURIComponent(
        workspace.slug
      )}/thread/${encodeURIComponent(resolvedThreadSlug)}/chat`,
      {
        method: "POST",
        body: {
          message,
          mode: "query",
        },
      }
    );

    if (
      data?.type === "abort" ||
      (typeof data?.error === "string" && data.error.length > 0)
    )
      throw new AnythingLLMApiError(
        data?.error || "AnythingLLM aborted the notebook query.",
        { code: "ANYTHINGLLM_QUERY_ABORTED", response: data }
      );

    if (typeof data?.textResponse !== "string")
      throw new AnythingLLMApiError(
        "AnythingLLM returned an invalid notebook query response.",
        { code: "INVALID_ANYTHINGLLM_QUERY_RESPONSE", response: data }
      );

    const rawSources = Array.isArray(data?.sources) ? data.sources : [];
    const sources = rawSources.map(compactQuerySource).filter(Boolean);
    return {
      notebook: { name: workspace.name, slug: workspace.slug },
      thread,
      answer: cleanGeneratedAnswer(data.textResponse),
      sources,
      sourceCount: rawSources.length,
      hasSources: rawSources.length > 0,
      chatId: data?.chatId ?? null,
      metrics: compactQueryMetrics(data?.metrics),
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
    {
      name: "anythingllm_query_notebook",
      description:
        "Ask an AnythingLLM workspace in query mode, creating or reusing a visible Thread, and return its configured LLM's final answer with compact source metadata (never raw source text).",
      inputSchema: {
        type: "object",
        required: ["notebook", "question"],
        properties: {
          notebook: { type: "string", minLength: 1 },
          question: { type: "string", minLength: 1 },
          threadSlug: {
            type: "string",
            minLength: 1,
            description:
              "Reuse the Thread slug returned by an earlier call only for follow-up questions in the same notebook conversation. Omit it to create a new visible Thread.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Query an AnythingLLM notebook",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => await client.queryNotebook(args),
      resultText: ({ answer }) => answer,
    },
  ];
}

module.exports = {
  AnythingLLMApiClient,
  AnythingLLMApiError,
  createAnythingLLMAgentTools,
};
