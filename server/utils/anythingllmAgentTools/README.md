# AnythingLLM local Agent tools

This adapter exposes three tool definitions without storing an API key in source code:

- `anythingllm_list_notebooks`
- `anythingllm_search_notebook`
- `anythingllm_read_chunk_context`

Provide credentials in the local Agent process environment:

```text
ANYTHINGLLM_API_BASE_URL=http://127.0.0.1:3001/api/v1
ANYTHINGLLM_API_KEY=<read from a local secret store>
```

Register the returned tool definitions with the local Agent runtime:

```js
const {
  createAnythingLLMAgentTools,
} = require("./server/utils/anythingllmAgentTools");

const tools = createAnythingLLMAgentTools();

const list = tools.find(
  ({ name }) => name === "anythingllm_list_notebooks"
);
const search = tools.find(
  ({ name }) => name === "anythingllm_search_notebook"
);
const context = tools.find(
  ({ name }) => name === "anythingllm_read_chunk_context"
);

await list.handler({});
const hits = await search.handler({
  notebook: "My Workspace",
  query: "How are core technologies and business described?",
  topK: 8,
  scoreThreshold: 0.25,
});
await context.handler({
  notebook: hits.notebook.slug,
  vectorId: hits.results[0].id,
  before: 2,
  after: 2,
});
```

Workspace slugs take precedence over names. Duplicate names are rejected with
`AMBIGUOUS_NOTEBOOK`, so the caller must select a slug rather than guess. When
several hits from the same document have overlapping context ranges, the Agent
should merge the ranges and deduplicate chunks by `vectorId` before prompting a
model.

## MCP STDIO entry point

mcpServer.js exposes the same three definitions through MCP without duplicating
their HTTP or validation logic. Start it from server with yarn mcp:anythingllm.

The process uses STDIO for MCP messages. Do not write normal logs to stdout.
Configure the Agent host to provide ANYTHINGLLM_API_KEY through its environment;
never add the key to this repository. ANYTHINGLLM_API_BASE_URL is optional and
defaults to http://127.0.0.1:3001/api/v1.
