jest.mock("../../utils/http", () => ({
  reqBody: (request) => request.body,
  userFromSession: async (_, response) => response.locals.user,
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn(),
}));
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  ROLES: { all: "all" },
  flexUserRoleValid: () => jest.fn(),
}));
jest.mock("../../utils/middleware/validWorkspace", () => ({
  validWorkspaceSlug: jest.fn(),
  validWorkspaceAndThreadSlug: jest.fn(),
}));
jest.mock("../../models/telemetry", () => ({ Telemetry: {} }));
jest.mock("../../models/eventLogs", () => ({ EventLogs: {} }));
jest.mock("../../models/workspaceChats", () => ({ WorkspaceChats: {} }));
jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: { delete: jest.fn() },
}));
jest.mock("../../utils/helpers/chat/responses", () => ({}));
jest.mock("../../endpoints/utils", () => ({}));

const { WorkspaceThread } = require("../../models/workspaceThread");
const {
  workspaceThreadEndpoints,
} = require("../../endpoints/workspaceThreads");

describe("thread deletion endpoints", () => {
  const routes = {};
  workspaceThreadEndpoints({
    get() {},
    post() {},
    delete(path, _, handler) {
      routes[path] = handler;
    },
  });
  const bulk = routes["/workspace/:slug/thread-bulk-delete"];
  let response;
  beforeEach(() => {
    jest.clearAllMocks();
    WorkspaceThread.delete.mockResolvedValue(true);
    response = {
      locals: { workspace: { id: 10 }, user: { id: 7 }, thread: { id: 8 } },
      sendStatus: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };
  });

  it("scopes bulk deletion to the current user and workspace and deduplicates slugs", async () => {
    await bulk({ body: { slugs: ["one", "two", "one"] } }, response);
    expect(WorkspaceThread.delete).toHaveBeenCalledWith({
      slug: { in: ["one", "two"] },
      user_id: 7,
      workspace_id: 10,
    });
    expect(response.sendStatus).toHaveBeenCalledWith(200);
  });

  it("uses null ownership in single-user mode", async () => {
    response.locals.user = null;
    await bulk({ body: { slugs: ["one"] } }, response);
    expect(WorkspaceThread.delete).toHaveBeenCalledWith({
      slug: { in: ["one"] },
      user_id: null,
      workspace_id: 10,
    });
  });

  it.each([null, "one", {}, [null], [1], [""], [" "]])(
    "rejects invalid slug input %j",
    async (slugs) => {
      await bulk({ body: { slugs } }, response);
      expect(response.sendStatus).toHaveBeenCalledWith(400);
      expect(WorkspaceThread.delete).not.toHaveBeenCalled();
    }
  );

  it("does not delete anything for an empty selection", async () => {
    await bulk({ body: { slugs: [] } }, response);
    expect(response.sendStatus).toHaveBeenCalledWith(200);
    expect(WorkspaceThread.delete).not.toHaveBeenCalled();
  });

  it.each([
    "/workspace/:slug/thread-bulk-delete",
    "/workspace/:slug/thread/:threadSlug",
  ])("reports model failure for %s", async (path) => {
    WorkspaceThread.delete.mockResolvedValue(false);
    await routes[path]({ body: { slugs: ["one"] } }, response);
    expect(response.sendStatus).toHaveBeenCalledWith(500);
    expect(response.sendStatus).not.toHaveBeenCalledWith(200);
  });
});
