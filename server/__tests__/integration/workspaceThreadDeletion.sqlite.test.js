const fs = require("fs");
const os = require("os");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

describe("atomic thread deletion against isolated SQLite", () => {
  let root, prisma, WorkspaceThread;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "thread-deletion-test-"));
    prisma = new PrismaClient({
      datasources: {
        db: { url: `file:${path.join(root, "test.db").replace(/\\/g, "/")}` },
      },
    });
    await prisma.$executeRawUnsafe(
      "CREATE TABLE workspace_threads (id INTEGER PRIMARY KEY, slug TEXT, workspace_id INTEGER, user_id INTEGER)"
    );
    await prisma.$executeRawUnsafe(
      "CREATE TABLE workspace_chats (id INTEGER PRIMARY KEY, thread_id INTEGER)"
    );
    jest.doMock("../../utils/prisma", () => prisma);
    ({ WorkspaceThread } = require("../../models/workspaceThread"));
  });
  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS reject_thread_delete"
    );
    await prisma.$executeRawUnsafe("DELETE FROM workspace_threads");
    await prisma.$executeRawUnsafe("DELETE FROM workspace_chats");
    await prisma.$executeRawUnsafe(
      "INSERT INTO workspace_threads VALUES (1, 'selected', 10, 7), (2, 'other-user', 10, 8), (3, 'other-workspace', 20, 7), (4, 'unselected', 10, 7)"
    );
    await prisma.$executeRawUnsafe(
      "INSERT INTO workspace_chats VALUES (1, 1), (2, 1), (3, 2), (4, 3), (5, 4), (6, NULL)"
    );
  });

  it("deletes only selected owned threads and their chats, retaining default chats", async () => {
    expect(
      await WorkspaceThread.delete({
        slug: { in: ["selected", "other-user", "other-workspace"] },
        workspace_id: 10,
        user_id: 7,
      })
    ).toBe(true);
    expect(
      await prisma.workspace_threads.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
    expect(
      await prisma.workspace_chats.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).toEqual([{ id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]);
  });

  it("rolls back chat deletion when thread deletion fails", async () => {
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER reject_thread_delete BEFORE DELETE ON workspace_threads BEGIN SELECT RAISE(ABORT, 'simulated failure'); END"
    );
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await WorkspaceThread.delete({ id: 1 })).toBe(false);
      expect(await prisma.workspace_threads.count()).toBe(4);
      expect(await prisma.workspace_chats.count()).toBe(6);
    } finally {
      log.mockRestore();
    }
  });

  it("safely accepts already-deleted or nonexistent threads", async () => {
    expect(await WorkspaceThread.delete({ id: 999 })).toBe(true);
    expect(await prisma.workspace_chats.count()).toBe(6);
  });
});
