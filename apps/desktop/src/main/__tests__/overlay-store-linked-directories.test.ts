import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("SqliteOverlayStore — linked directories", () => {
  it.each([
    ["codex", undefined], ["codex", "remote-instance"],
    ["acp:grok", undefined], ["acp:grok", "remote-instance"],
  ] as const)("detaches a moved project thread from its parent in the workspace commit: %s / %s", async (backend, parentThreadInstanceId) => {
    await store.setThreadParent({
      backend, threadId: "child", parentThreadId: "parent",
      parentThreadBackend: backend === "codex" ? "acp:grok" : "codex", parentThreadInstanceId,
    });
    const overlay = await store.replaceWorkspaceLinkedDirectory({
      backend, threadId: "child", resetProjectState: true, gitBranch: "HEAD",
      directory: { id: `pwragent-handoff:${backend}:child`, label: "target", path: "/repo/target", kind: "worktree", worktreePath: "/worktrees/target" },
    });
    expect(overlay.parentThreadId).toBeUndefined();
    expect(overlay.parentThreadBackend).toBeUndefined();
    expect(overlay.parentThreadInstanceId).toBeUndefined();
    expect((await store.getThreadOverlayState({ backend, threadId: "child" }))?.parentThreadId).toBeUndefined();
  });

  it("keeps project movement and parent detachment in one SQLite commit", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-project-move-");
    const db = StateDb.open(temp.dbPath);
    const persisted = new SqliteOverlayStore(db);
    try {
      await persisted.setThreadParent({ backend: "codex", threadId: "child", parentThreadId: "parent" });
      const { writes } = await measureSqliteWrites(async () => {
        await persisted.replaceWorkspaceLinkedDirectory({
          backend: "codex", threadId: "child", resetProjectState: true,
          directory: { id: "pwragent-handoff:codex:child", label: "target", path: "/repo/target", kind: "local" },
        });
      });
      expect(writes.commits).toBe(1);
      expectSqliteWriteBudget({
        scenario: "project-move-parent-detachment",
        note: "One workspace boundary commit also clears the parent; no timer or per-turn writes.",
        writes,
      });
    } finally {
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.unstubAllEnvs();
    }
  });

  it("preserves the parent when changing workspaces within the repository", async () => {
    await store.setThreadParent({ backend: "codex", threadId: "child", parentThreadId: "parent" });
    const overlay = await store.replaceWorkspaceLinkedDirectory({
      backend: "codex", threadId: "child",
      directory: { id: "pwragent-handoff:codex:child", label: "source", path: "/repo/source", kind: "worktree", worktreePath: "/worktrees/source" },
    });
    expect(overlay.parentThreadId).toBe("parent");
  });

  it("replaces same-path local directories even when their IDs use different shapes", async () => {
    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    const overlay = await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "directory:/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    expect(overlay.extraLinkedDirectories).toEqual([
      {
        id: "directory:/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    ]);
  });

  it("removes same-path local directories even when their IDs use different shapes", async () => {
    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    const overlay = await store.removeLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "directory:/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    expect(overlay.extraLinkedDirectories).toEqual([]);
  });
});
