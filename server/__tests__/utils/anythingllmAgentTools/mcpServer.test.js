const {
  Client,
} = require("@modelcontextprotocol/sdk/client/index.js");
const {
  InMemoryTransport,
} = require("@modelcontextprotocol/sdk/inMemory.js");
const {
  createAnythingLLMMcpServer,
} = require("../../../utils/anythingllmAgentTools/mcpServer");

async function connectedClient(tools) {
  const server = createAnythingLLMMcpServer({ tools });
  const client = new Client(
    { name: "anythingllm-mcp-test", version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("AnythingLLM MCP server", () => {
  const openClients = [];
  const openServers = [];

  afterEach(async () => {
    await Promise.allSettled(
      openClients.splice(0).map((client) => client.close())
    );
    await Promise.allSettled(
      openServers.splice(0).map((server) => server.close())
    );
  });

  it("lists read-only tool definitions and calls a handler", async () => {
    const handler = jest.fn().mockResolvedValue([
      { name: "Notebook", slug: "notebook", documentCount: 2 },
    ]);
    const tool = {
      name: "anythingllm_list_notebooks",
      description: "List notebooks.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler,
    };
    const { client, server } = await connectedClient([tool]);
    openClients.push(client);
    openServers.push(server);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: "anythingllm_list_notebooks",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });

    const called = await client.callTool({
      name: "anythingllm_list_notebooks",
      arguments: {},
    });
    expect(handler).toHaveBeenCalledWith({});
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({
      result: [{ name: "Notebook", slug: "notebook", documentCount: 2 }],
    });
    expect(JSON.parse(called.content[0].text)).toEqual(
      called.structuredContent
    );
  });

  it("returns safe structured errors without response bodies or stacks", async () => {
    const apiError = new Error("This document must be re-indexed.");
    apiError.code = "CHUNK_POSITION_UNAVAILABLE";
    apiError.status = 409;
    apiError.response = { text: "must not be exposed" };
    const { client, server } = await connectedClient([
      {
        name: "anythingllm_read_chunk_context",
        description: "Read context.",
        inputSchema: { type: "object", properties: {} },
        handler: jest.fn().mockRejectedValue(apiError),
      },
    ]);
    openClients.push(client);
    openServers.push(server);

    const called = await client.callTool({
      name: "anythingllm_read_chunk_context",
      arguments: {},
    });
    expect(called).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "CHUNK_POSITION_UNAVAILABLE",
          status: 409,
          message: "This document must be re-indexed.",
        },
      },
    });
    expect(called.content[0].text).not.toContain("must not be exposed");
    expect(called.content[0].text).not.toContain("stack");
  });

  it("returns a structured error for unknown tools", async () => {
    const { client, server } = await connectedClient([]);
    openClients.push(client);
    openServers.push(server);

    const called = await client.callTool({
      name: "anythingllm_unknown",
      arguments: {},
    });
    expect(called).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "TOOL_NOT_FOUND",
          status: null,
        },
      },
    });
  });
});
