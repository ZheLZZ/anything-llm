const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { createAnythingLLMAgentTools } = require("./index");

const SERVER_INFO = {
  name: "anythingllm-local-retrieval",
  version: "1.0.0",
};

const SERVER_INSTRUCTIONS =
  "Search an AnythingLLM notebook before reading context. Expand only the hits needed to answer the request, normally with before=2 and after=2. Keep notebook boundaries intact, preserve source and chunk-position metadata, and deduplicate overlapping chunks by vectorId. Never expose API keys or embedding vectors.";

function structuredContentFor(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value;
  return { result: value };
}

function successResult(value) {
  const structuredContent = structuredContentFor(value);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function errorResult(error, fallbackCode = "ANYTHINGLLM_TOOL_ERROR") {
  const structuredContent = {
    error: {
      code:
        typeof error?.code === "string" && error.code.length > 0
          ? error.code
          : fallbackCode,
      status: Number.isInteger(error?.status) ? error.status : null,
      message:
        typeof error?.message === "string" && error.message.length > 0
          ? error.message
          : "AnythingLLM tool call failed.",
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function publicToolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

function createAnythingLLMMcpServer({ tools = null, ...clientOptions } = {}) {
  const registeredTools = tools || createAnythingLLMAgentTools(clientOptions);
  const toolsByName = new Map(registeredTools.map((tool) => [tool.name, tool]));
  if (toolsByName.size !== registeredTools.length)
    throw new Error("AnythingLLM MCP tool names must be unique.");

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registeredTools.map(publicToolDefinition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool)
      return errorResult(
        new Error('Unknown AnythingLLM tool "' + request.params.name + '".'),
        "TOOL_NOT_FOUND"
      );

    try {
      return successResult(await tool.handler(request.params.arguments || {}));
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

async function runAnythingLLMMcpServer() {
  const server = createAnythingLLMMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (require.main === module) {
  runAnythingLLMMcpServer().catch((error) => {
    process.stderr.write(
      "[anythingllm-local-retrieval] " +
        (error?.message || String(error)) +
        "\n"
    );
    process.exit(1);
  });
}

module.exports = {
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  createAnythingLLMMcpServer,
  errorResult,
  runAnythingLLMMcpServer,
  successResult,
};
