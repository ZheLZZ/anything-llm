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
  version: "1.2.0",
};

const SERVER_INSTRUCTIONS =
  "Use vector search and bounded context for raw evidence. Use notebook query only when the caller wants AnythingLLM's configured workspace model to generate an answer. Notebook query creates a visible AnythingLLM Thread when threadSlug is omitted; reuse the returned thread.slug only within the intended notebook conversation. Its text result is the final generated answer, while structured sources are compact metadata without raw chunks. Never expose API keys or embedding vectors.";

function structuredContentFor(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value;
  return { result: value };
}

function successResult(value, textOverride = null) {
  const structuredContent = structuredContentFor(value);
  return {
    content: [
      {
        type: "text",
        text:
          typeof textOverride === "string"
            ? textOverride
            : JSON.stringify(structuredContent),
      },
    ],
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
      ...(tool.annotations || {}),
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
      const value = await tool.handler(request.params.arguments || {});
      const resultText =
        typeof tool.resultText === "function" ? tool.resultText(value) : null;
      return successResult(value, resultText);
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
