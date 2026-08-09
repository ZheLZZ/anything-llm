const { v4: uuidv4 } = require("uuid");
const { Document } = require("../../../models/documents");
const { Telemetry } = require("../../../models/telemetry");
const { DocumentVectors } = require("../../../models/vectors");
const { Workspace } = require("../../../models/workspace");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../../../utils/helpers");
const {
  multiUserMode,
  reqBody,
  safeJsonParse,
} = require("../../../utils/http");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const { VALID_CHAT_MODE } = require("../../../utils/chats/stream");
const { EventLogs } = require("../../../models/eventLogs");
const {
  convertToChatHistory,
  writeResponseChunk,
} = require("../../../utils/helpers/chat/responses");
const { ApiChatHandler } = require("../../../utils/chats/apiChatHandler");
const { getModelTag } = require("../../utils");
const {
  workspaceDeletionProtection,
} = require("../../../utils/middleware/workspaceDeletionProtection");

const MAX_CHUNK_CONTEXT_SIZE = 10;

function parseChunkContextSize(value, fallback = 2) {
  if (value === undefined) return fallback;
  if (!["string", "number"].includes(typeof value)) return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_CHUNK_CONTEXT_SIZE
  )
    return null;
  return parsed;
}

function buildChunkPosition(record) {
  const available =
    Number.isInteger(record?.chunkIndex) &&
    Number.isInteger(record?.chunkCount) &&
    record.chunkIndex >= 0 &&
    record.chunkCount > 0 &&
    record.chunkIndex < record.chunkCount &&
    typeof record.chunkText === "string";

  if (!available) return { available: false, reindexRequired: true };
  return {
    available: true,
    docId: record.docId,
    chunkIndex: record.chunkIndex,
    chunkNumber: record.chunkIndex + 1,
    chunkCount: record.chunkCount,
  };
}

function apiWorkspaceEndpoints(app) {
  if (!app) return;

  app.post("/v1/workspace/new", [validApiKey], async (request, response) => {
    /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Create a new workspace'
    #swagger.requestBody = {
      description: 'JSON object containing workspace configuration.',
      required: true,
      content: {
        "application/json": {
          example: {
            name: "My New Workspace",
            similarityThreshold: 0.7,
            openAiTemp: 0.7,
            openAiHistory: 20,
            openAiPrompt: "Custom prompt for responses",
            queryRefusalResponse: "Custom refusal message",
            chatMode: "chat",
            topN: 4
          }
        }
      }
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspace: {
                "id": 79,
                "name": "Sample workspace",
                "slug": "sample-workspace",
                "createdAt": "2023-08-17 00:45:03",
                "openAiTemp": null,
                "lastUpdatedAt": "2023-08-17 00:45:03",
                "openAiHistory": 20,
                "openAiPrompt": null
              },
              message: 'Workspace created'
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
    try {
      const { name = null, ...additionalFields } = reqBody(request);
      const { workspace, message } = await Workspace.new(
        name,
        null,
        additionalFields
      );

      if (!workspace) {
        response.status(400).json({ workspace: null, message });
        return;
      }

      await Telemetry.sendTelemetry("workspace_created", {
        multiUserMode: multiUserMode(response),
        LLMSelection: process.env.LLM_PROVIDER || "openai",
        Embedder: process.env.EMBEDDING_ENGINE || "inherit",
        VectorDbSelection: process.env.VECTOR_DB || "lancedb",
        TTSSelection: process.env.TTS_PROVIDER || "native",
        LLMModel: getModelTag(),
      });
      await EventLogs.logEvent("api_workspace_created", {
        workspaceName: workspace?.name || "Unknown Workspace",
      });
      response.status(200).json({ workspace, message });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/v1/workspaces", [validApiKey], async (request, response) => {
    /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'List all current workspaces'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspaces: [
                {
                  "id": 79,
                  "name": "Sample workspace",
                  "slug": "sample-workspace",
                  "createdAt": "2023-08-17 00:45:03",
                  "openAiTemp": null,
                  "lastUpdatedAt": "2023-08-17 00:45:03",
                  "openAiHistory": 20,
                  "openAiPrompt": null,
                  "threads": []
                }
              ],
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
    try {
      const workspaces = await Workspace._findMany({
        where: {},
        include: {
          threads: {
            select: {
              user_id: true,
              slug: true,
              name: true,
            },
          },
        },
      });
      response.status(200).json({ workspaces });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/v1/workspace/:slug", [validApiKey], async (request, response) => {
    /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Get a workspace by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspace: [
                {
                  "id": 79,
                  "name": "My workspace",
                  "slug": "my-workspace-123",
                  "createdAt": "2023-08-17 00:45:03",
                  "openAiTemp": null,
                  "lastUpdatedAt": "2023-08-17 00:45:03",
                  "openAiHistory": 20,
                  "openAiPrompt": null,
                  "documents": [],
                  "threads": []
                }
              ]
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
    try {
      const { slug } = request.params;
      const workspace = await Workspace._findMany({
        where: {
          slug: String(slug),
        },
        include: {
          documents: true,
          threads: {
            select: {
              user_id: true,
              slug: true,
            },
          },
        },
      });

      response.status(200).json({ workspace });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.delete(
    "/v1/workspace/:slug",
    [validApiKey, workspaceDeletionProtection],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Deletes a workspace by its slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to delete',
        required: true,
        type: 'string'
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      try {
        const { slug = "" } = request.params;
        const VectorDb = getVectorDbClass();
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const workspaceId = Number(workspace.id);
        await WorkspaceChats.delete({ workspaceId: workspaceId });
        await DocumentVectors.deleteForWorkspace(workspaceId);
        await Document.delete({ workspaceId: workspaceId });
        await Workspace.delete({ id: workspaceId });

        await EventLogs.logEvent("api_workspace_deleted", {
          workspaceName: workspace?.name || "Unknown Workspace",
        });
        try {
          await VectorDb["delete-namespace"]({ namespace: slug });
        } catch (e) {
          console.error(e.message);
        }
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/update",
    [validApiKey],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Update workspace settings by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.requestBody = {
      description: 'JSON object containing new settings to update a workspace. All keys are optional and will not update unless provided',
      required: true,
      content: {
        "application/json": {
          example: {
            "name": 'Updated Workspace Name',
            "openAiTemp": 0.2,
            "openAiHistory": 20,
            "openAiPrompt": "Respond to all inquires and questions in binary - do not respond in any other format."
          }
        }
      }
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspace: {
                "id": 79,
                "name": "My workspace",
                "slug": "my-workspace-123",
                "createdAt": "2023-08-17 00:45:03",
                "openAiTemp": null,
                "lastUpdatedAt": "2023-08-17 00:45:03",
                "openAiHistory": 20,
                "openAiPrompt": null,
                "documents": []
              },
              message: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      try {
        const { slug = null } = request.params;
        const data = reqBody(request);
        const currWorkspace = await Workspace.get({ slug: String(slug) });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        const { workspace, message } = await Workspace.update(
          currWorkspace.id,
          data
        );

        if (!workspace)
          return response.status(500).json({ workspace: null, message });
        return response.status(200).json({ workspace, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/v1/workspace/:slug/chats",
    [validApiKey],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Get a workspaces chats regardless of user by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.parameters['apiSessionId'] = {
        in: 'query',
        description: 'Optional apiSessionId to filter by',
        required: false,
        type: 'string'
    }
    #swagger.parameters['limit'] = {
        in: 'query',
        description: 'Optional number of chat messages to return (default: 100)',
        required: false,
        type: 'integer'
    }
    #swagger.parameters['orderBy'] = {
        in: 'query',
        description: 'Optional order of chat messages (asc or desc)',
        required: false,
        type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              history: [
                {
                  "role": "user",
                  "content": "What is AnythingLLM?",
                  "sentAt": 1692851630
                },
                {
                  "role": "assistant",
                  "content": "AnythingLLM is a platform that allows you to convert notes, PDFs, and other source materials into a chatbot. It ensures privacy, cites its answers, and allows multiple people to interact with the same documents simultaneously. It is particularly useful for businesses to enhance the visibility and readability of various written communications such as SOPs, contracts, and sales calls. You can try it out with a free trial to see if it meets your business needs.",
                  "sources": [{"source": "object about source document and snippets used"}]
                }
              ]
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      try {
        const { slug } = request.params;
        const {
          apiSessionId = null,
          limit = 100,
          orderBy = "asc",
        } = request.query;
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const validLimit = Math.max(1, parseInt(limit));
        const validOrderBy = ["asc", "desc"].includes(orderBy)
          ? orderBy
          : "asc";

        const history = apiSessionId
          ? await WorkspaceChats.forWorkspaceByApiSessionId(
              workspace.id,
              apiSessionId,
              validLimit,
              { createdAt: validOrderBy }
            )
          : await WorkspaceChats.forWorkspace(workspace.id, validLimit, {
              createdAt: validOrderBy,
            });
        response.status(200).json({ history: convertToChatHistory(history) });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/update-embeddings",
    [validApiKey],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Add or remove documents from a workspace by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.requestBody = {
      description: 'JSON object of additions and removals of documents to add to update a workspace. The value should be the folder + filename with the exclusions of the top-level documents path.',
      required: true,
      content: {
        "application/json": {
          example: {
            adds: ["custom-documents/my-pdf.pdf-hash.json"],
            deletes: ["custom-documents/anythingllm.txt-hash.json"]
          }
        }
      }
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspace: {
                "id": 79,
                "name": "My workspace",
                "slug": "my-workspace-123",
                "createdAt": "2023-08-17 00:45:03",
                "openAiTemp": null,
                "lastUpdatedAt": "2023-08-17 00:45:03",
                "openAiHistory": 20,
                "openAiPrompt": null,
                "documents": []
              },
              message: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      try {
        const { slug = null } = request.params;
        const { adds = [], deletes = [] } = reqBody(request);
        const currWorkspace = await Workspace.get({ slug: String(slug) });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        await Document.removeDocuments(currWorkspace, deletes);
        await Document.addDocuments(currWorkspace, adds);
        const updatedWorkspace = await Workspace.get({
          id: Number(currWorkspace.id),
        });
        response.status(200).json({ workspace: updatedWorkspace });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/update-pin",
    [validApiKey],
    async (request, response) => {
      /*
      #swagger.tags = ['Workspaces']
      #swagger.description = 'Add or remove pin from a document in a workspace by its unique slug.'
      #swagger.parameters['slug'] = {
          in: 'path',
          description: 'Unique slug of workspace to find',
          required: true,
          type: 'string'
      }
      #swagger.requestBody = {
        description: 'JSON object with the document path and pin status to update.',
        required: true,
        content: {
          "application/json": {
            example: {
              docPath: "custom-documents/my-pdf.pdf-hash.json",
              pinStatus: true
            }
          }
        }
      }
      #swagger.responses[200] = {
        description: 'OK',
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                message: 'Pin status updated successfully'
              }
            }
          }
        }
      }
      #swagger.responses[404] = {
        description: 'Document not found'
      }
      #swagger.responses[500] = {
        description: 'Internal Server Error'
      }
      */
      try {
        const { slug = null } = request.params;
        const { docPath, pinStatus = false } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        const document = await Document.get({
          workspaceId: workspace.id,
          docpath: docPath,
        });
        if (!document) return response.sendStatus(404).end();

        await Document.update(document.id, { pinned: pinStatus });
        return response
          .status(200)
          .json({ message: "Pin status updated successfully" })
          .end();
      } catch (error) {
        console.error("Error processing the pin status update:", error);
        return response.status(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/chat",
    [validApiKey],
    async (request, response) => {
      /*
   #swagger.tags = ['Workspaces']
   #swagger.description = 'Execute a chat with a workspace'
   #swagger.requestBody = {
       description: 'Send a prompt to the workspace and the type of conversation (automatic, query or chat).<br/><b>Query:</b> Will not use LLM unless there are relevant sources from vectorDB & does not recall chat history.<br/><b>Automatic:</b> Will use tool-calling if the provider supports native tool calling without needing to invoke @agent.<br/><b>Chat:</b> Uses LLM general knowledge w/custom embeddings to produce output, uses rolling chat history.<br/><b>Attachments:</b> Can include images and documents.<br/><b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Document attachments:</b> must have the mime type <code>application/anythingllm-document</code> - otherwise it will be passed to the LLM as an image and may fail to process. This uses the built-in document processor to first parse the document to text before injecting it into the context window.',
       required: true,
       content: {
         "application/json": {
           example: {
             message: "What is AnythingLLM?",
             mode:"automatic | query | chat",
             sessionId: "identifier-to-partition-chats-by-external-id",
             attachments: [
               {
                 name: "image.png",
                 mime: "image/png",
                 contentString: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               },
               {
                 name: "this is a document.pdf",
                 mime: "application/anythingllm-document",
                 contentString: "data:application/pdf;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               }
             ],
             reset: false
           }
         }
       }
     }
   #swagger.responses[200] = {
     content: {
       "application/json": {
         schema: {
           type: 'object',
           example: {
              id: 'chat-uuid',
              type: "abort | textResponse",
              textResponse: "Response to your query",
              sources: [{title: "anythingllm.txt", chunk: "This is a context chunk used in the answer of the prompt by the LLM,"}],
              close: true,
              error: "null | text string of the failure mode."
           }
         }
       }
     }
   }
   #swagger.responses[403] = {
     schema: {
       "$ref": "#/definitions/InvalidAPIKey"
     }
   }
   */
      try {
        const { slug } = request.params;
        const {
          message,
          mode = null,
          sessionId = null,
          attachments = [],
          reset = false,
        } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `Workspace ${slug} is not a valid workspace.`,
          });
          return;
        }

        const resolvedMode = mode ?? workspace.chatMode;
        if (
          (!message?.length || !VALID_CHAT_MODE.includes(resolvedMode)) &&
          !reset
        ) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: !message?.length
              ? "Message is empty"
              : `${resolvedMode} is not a valid mode.`,
          });
          return;
        }

        const result = await ApiChatHandler.chatSync({
          workspace,
          message,
          mode: resolvedMode,
          user: null,
          thread: null,
          sessionId: !!sessionId ? String(sessionId) : null,
          attachments,
          reset,
        });

        await Telemetry.sendTelemetry("sent_chat", {
          LLMSelection:
            workspace.chatProvider ?? process.env.LLM_PROVIDER ?? "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          TTSSelection: process.env.TTS_PROVIDER || "native",
        });
        await EventLogs.logEvent("api_sent_chat", {
          workspaceName: workspace?.name,
          chatModel: workspace?.chatModel || "System Default",
        });
        return response.status(200).json({ ...result });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/stream-chat",
    [validApiKey],
    async (request, response) => {
      /*
   #swagger.tags = ['Workspaces']
   #swagger.description = 'Execute a streamable chat with a workspace'
   #swagger.requestBody = {
       description: 'Send a prompt to the workspace and the type of conversation (automatic, query or chat).<br/><b>Query:</b> Will not use LLM unless there are relevant sources from vectorDB & does not recall chat history.<br/><b>Automatic:</b> Will use tool-calling if the provider supports native tool calling without needing to invoke @agent.<br/><b>Chat:</b> Uses LLM general knowledge w/custom embeddings to produce output, uses rolling chat history.<br/><b>Attachments:</b> Can include images and documents.<br/><b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Document attachments:</b> must have the mime type <code>application/anythingllm-document</code> - otherwise it will be passed to the LLM as an image and may fail to process. This uses the built-in document processor to first parse the document to text before injecting it into the context window.',
       required: true,
       content: {
         "application/json": {
           example: {
             message: "What is AnythingLLM?",
             mode: "automatic | query | chat",
             sessionId: "identifier-to-partition-chats-by-external-id",
             attachments: [
               {
                 name: "image.png",
                 mime: "image/png",
                 contentString: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               },
               {
                 name: "this is a document.pdf",
                 mime: "application/anythingllm-document",
                 contentString: "data:application/pdf;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               }
             ],
             reset: false
           }
         }
       }
     }
   #swagger.responses[200] = {
     content: {
       "text/event-stream": {
         schema: {
           type: 'array',
           items: {
              type: 'string',
          },
           example: [
            {
              id: 'uuid-123',
              type: "abort | textResponseChunk",
              textResponse: "First chunk",
              sources: [],
              close: false,
              error: "null | text string of the failure mode."
            },
            {
              id: 'uuid-123',
              type: "abort | textResponseChunk",
              textResponse: "chunk two",
              sources: [],
              close: false,
              error: "null | text string of the failure mode."
            },
             {
              id: 'uuid-123',
              type: "abort | textResponseChunk",
              textResponse: "final chunk of LLM output!",
              sources: [{title: "anythingllm.txt", chunk: "This is a context chunk used in the answer of the prompt by the LLM. This will only return in the final chunk."}],
              close: true,
              error: "null | text string of the failure mode."
            }
          ]
         }
       }
     }
   }
   #swagger.responses[403] = {
     schema: {
       "$ref": "#/definitions/InvalidAPIKey"
     }
   }
   */
      try {
        const { slug } = request.params;
        const {
          message,
          mode = null,
          sessionId = null,
          attachments = [],
          reset = false,
        } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `Workspace ${slug} is not a valid workspace.`,
          });
          return;
        }

        const resolvedMode = mode ?? workspace.chatMode;
        if (
          (!message?.length || !VALID_CHAT_MODE.includes(resolvedMode)) &&
          !reset
        ) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: !message?.length
              ? "Message is empty"
              : `${resolvedMode} is not a valid mode.`,
          });
          return;
        }

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        await ApiChatHandler.streamChat({
          response,
          workspace,
          message,
          mode: resolvedMode,
          user: null,
          thread: null,
          sessionId: !!sessionId ? String(sessionId) : null,
          attachments,
          reset,
        });
        await Telemetry.sendTelemetry("sent_chat", {
          LLMSelection:
            workspace.chatProvider ?? process.env.LLM_PROVIDER ?? "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          TTSSelection: process.env.TTS_PROVIDER || "native",
        });
        await EventLogs.logEvent("api_sent_chat", {
          workspaceName: workspace?.name,
          chatModel: workspace?.chatModel || "System Default",
        });
        response.end();
      } catch (e) {
        console.error(e.message, e);
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/vector-search",
    [validApiKey],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Perform a vector similarity search in a workspace'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to search in',
        required: true,
        type: 'string'
    }
    #swagger.requestBody = {
      description: 'Query to perform vector search with and optional parameters',
      required: true,
      content: {
        "application/json": {
          example: {
            query: "What is the meaning of life?",
            topN: 4,
            scoreThreshold: 0.75
          }
        }
      }
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              results: [
                {
                  id: "5a6bee0a-306c-47fc-942b-8ab9bf3899c4",
                  text: "Document chunk content...",
                  metadata: {
                    url: "file://document.txt",
                    title: "document.txt",
                    author: "no author specified",
                    description: "no description found",
                    docSource: "post:123456",
                    chunkSource: "document.txt",
                    published: "12/1/2024, 11:39:39 AM",
                    wordCount: 8,
                    tokenCount: 9
                  },
                  distance: 0.541887640953064,
                  score: 0.45811235904693604,
                  position: {
                    available: true,
                    docId: "e1c14c2e-3842-4b3f-9b77-09d65b85347a",
                    chunkIndex: 5,
                    chunkNumber: 6,
                    chunkCount: 20
                  }
                }
              ]
            }
          }
        }
      }
    }
    */
      try {
        const { slug } = request.params;
        const { query, topN, scoreThreshold } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace)
          return response.status(400).json({
            message: `Workspace ${slug} is not a valid workspace.`,
          });

        if (!query?.length)
          return response.status(400).json({
            message: "Query parameter cannot be empty.",
          });

        const VectorDb = getVectorDbClass();
        const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
        const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

        if (!hasVectorizedSpace || embeddingsCount === 0)
          return response.status(200).json({
            results: [],
            message: "No embeddings found for this workspace.",
          });

        const parseSimilarityThreshold = () => {
          let input = parseFloat(scoreThreshold);
          if (isNaN(input) || input < 0 || input > 1)
            return workspace?.similarityThreshold ?? 0.25;
          return input;
        };

        const parseTopN = () => {
          let input = Number(topN);
          if (isNaN(input) || input < 1) return workspace?.topN ?? 4;
          return input;
        };

        const { connector: LLMConnector } = await resolveProviderConnector({
          workspace,
          prompt: String(query),
        });

        const results = await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: String(query),
          LLMConnector,
          similarityThreshold: parseSimilarityThreshold(),
          topN: parseTopN(),
          rerank: workspace?.vectorSearchMode === "rerank",
        });

        const vectorRecords = await DocumentVectors.forVectorIds(
          results.sources.map(({ id }) => id)
        );
        const positionsByVectorId = new Map();
        for (const record of vectorRecords) {
          const existing = positionsByVectorId.get(record.vectorId);
          if (!existing || buildChunkPosition(record).available)
            positionsByVectorId.set(record.vectorId, record);
        }

        response.status(200).json({
          results: results.sources.map((source) => ({
            id: source.id,
            text: source.text,
            metadata: {
              url: source.url,
              title: source.title,
              author: source.docAuthor,
              description: source.description,
              docSource: source.docSource,
              chunkSource: source.chunkSource,
              published: source.published,
              wordCount: source.wordCount,
              tokenCount: source.token_count_estimate,
            },
            distance: source._distance,
            score: source.score,
            position: buildChunkPosition(
              positionsByVectorId.get(source.id) || null
            ),
          })),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/v1/workspace/:slug/chunk/:vectorId/context",
    [validApiKey],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Read ordered chunks surrounding a vector search result. The vector must belong to the requested workspace.'
    #swagger.parameters['slug'] = {
      in: 'path',
      description: 'Unique slug of the workspace',
      required: true,
      type: 'string'
    }
    #swagger.parameters['vectorId'] = {
      in: 'path',
      description: 'Vector ID returned by the workspace vector-search endpoint',
      required: true,
      type: 'string'
    }
    #swagger.parameters['before'] = {
      in: 'query',
      description: 'Number of preceding chunks to return (0-10, default 2)',
      required: false,
      type: 'integer',
      minimum: 0,
      maximum: 10,
      default: 2
    }
    #swagger.parameters['after'] = {
      in: 'query',
      description: 'Number of following chunks to return (0-10, default 2)',
      required: false,
      type: 'integer',
      minimum: 0,
      maximum: 10,
      default: 2
    }
    #swagger.responses[200] = {
      description: 'Ordered chunk context',
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspace: { name: "My Workspace", slug: "my-workspace" },
              document: {
                docId: "e1c14c2e-3842-4b3f-9b77-09d65b85347a",
                title: "document.txt"
              },
              hit: {
                vectorId: "5a6bee0a-306c-47fc-942b-8ab9bf3899c4",
                chunkIndex: 5,
                chunkNumber: 6,
                chunkCount: 20
              },
              range: { fromIndex: 3, toIndex: 7 },
              chunks: [
                {
                  vectorId: "ad0a330e-37d5-472d-bc81-aae217e24880",
                  chunkIndex: 3,
                  chunkNumber: 4,
                  text: "Preceding document chunk...",
                  matched: false
                },
                {
                  vectorId: "5a6bee0a-306c-47fc-942b-8ab9bf3899c4",
                  chunkIndex: 5,
                  chunkNumber: 6,
                  text: "Matched document chunk...",
                  matched: true
                }
              ]
            }
          }
        }
      }
    }
    #swagger.responses[400] = {
      description: 'Invalid before or after query parameter'
    }
    #swagger.responses[403] = {
      schema: { "$ref": "#/definitions/InvalidAPIKey" }
    }
    #swagger.responses[404] = {
      description: 'Workspace or vector chunk not found'
    }
    #swagger.responses[409] = {
      description: 'The document must be re-indexed before context can be read',
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              code: "CHUNK_POSITION_UNAVAILABLE",
              message: "This document must be re-indexed before chunk context can be read.",
              reindexRequired: true
            }
          }
        }
      }
    }
    */
      try {
        const { slug, vectorId } = request.params;
        const workspace = await Workspace.get({ slug: String(slug) });
        if (!workspace)
          return response.status(404).json({
            code: "WORKSPACE_NOT_FOUND",
            message: `Workspace ${slug} was not found.`,
          });

        const before = parseChunkContextSize(request.query?.before);
        const after = parseChunkContextSize(request.query?.after);
        if (before === null || after === null)
          return response.status(400).json({
            code: "INVALID_CHUNK_CONTEXT_RANGE",
            message: `before and after must be non-negative integers no greater than ${MAX_CHUNK_CONTEXT_SIZE}.`,
          });

        const context = await DocumentVectors.contextByVectorId({
          vectorId: String(vectorId),
          workspaceId: workspace.id,
          before,
          after,
        });
        if (!context.found)
          return response.status(404).json({
            code: "CHUNK_NOT_FOUND",
            message: "The vector chunk was not found in this workspace.",
          });

        if (context.reindexRequired)
          return response.status(409).json({
            code: "CHUNK_POSITION_UNAVAILABLE",
            message:
              "This document must be re-indexed before chunk context can be read.",
            reindexRequired: true,
          });

        const documentMetadata = safeJsonParse(context.document.metadata, {});
        return response.status(200).json({
          workspace: { name: workspace.name, slug: workspace.slug },
          document: {
            docId: context.document.docId,
            title: documentMetadata?.title || context.document.filename,
          },
          hit: {
            vectorId: context.hit.vectorId,
            chunkIndex: context.hit.chunkIndex,
            chunkNumber: context.hit.chunkIndex + 1,
            chunkCount: context.hit.chunkCount,
          },
          range: context.range,
          chunks: context.chunks.map((chunk) => ({
            vectorId: chunk.vectorId,
            chunkIndex: chunk.chunkIndex,
            chunkNumber: chunk.chunkIndex + 1,
            text: chunk.chunkText,
            matched: chunk.vectorId === context.hit.vectorId,
          })),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = {
  apiWorkspaceEndpoints,
  buildChunkPosition,
  parseChunkContextSize,
};
