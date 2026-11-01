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
  it("repairs one worktree relationship without detaching sibling or retained worktrees", async () => {
    const identity = { backend: "codex" as const, threadId: "thread-1" };
    const primary = {
      id: "/worktrees/primary", kind: "worktree" as const, label: "app",
      path: "/repo/app", worktreePath: "/worktrees/primary",
    };
    const attached = {
      id: "/repo/app", kind: "worktree" as const, label: "attached", path: "/repo/app",
      worktreePath: "/worktrees/attached", gitBranch: "attached-branch",
      worktreeOwnership: "external" as const,
    };
    const retained = { ...primary, id: "retained", worktreePath: "/worktrees/retained" };
    await store.replaceWorkspaceLinkedDirectory({ ...identity, directory: primary, retainWorktree: retained });
    await store.addLinkedDirectory({ ...identity, directory: attached });
    // Enrichment may correct an ID and the spelling of a repository alias.
    const repaired = { ...primary, id: "/worktrees/primary/subdir", path: "/physical/repo/app" };
    const overlay = await store.replaceWorkspaceLinkedDirectory({
      ...identity, directory: repaired, preserveOtherWorktrees: true,
    });
    expect(overlay.extraLinkedDirectories).toEqual([repaired, attached]);
    expect(overlay.retainedWorktrees).toEqual([retained]);
    expect((await store.getArchiveCleanupOverlayStates({
      backend: "codex", threadIds: [identity.threadId],
    }))[identity.threadId]).toMatchObject({
      extraLinkedDirectories: [repaired, attached], retainedWorktrees: [retained],
    });
  });

  it.each(["local", "worktree"] as const)(
    "still replaces the primary workspace for an explicit move to %s", async (kind) => {
      const identity = { backend: "codex" as const, threadId: "thread-1" };
      const primary = {
        id: "/worktrees/primary", kind: "worktree" as const, label: "app",
        path: "/repo/app", worktreePath: "/worktrees/primary",
      };
      const unrelated = { id: "/repo/other", kind: "local" as const, label: "other", path: "/repo/other" };
      await store.addLinkedDirectory({ ...identity, directory: primary });
      await store.addLinkedDirectory({ ...identity, directory: unrelated });
      const target = {
        id: "pwragent-handoff:codex:thread-1", kind, label: "app", path: "/repo/app",
        ...(kind === "worktree" ? { worktreePath: "/worktrees/target" } : {}),
      };
      const overlay = await store.replaceWorkspaceLinkedDirectory({ ...identity, directory: target });
      expect(overlay.extraLinkedDirectories).toEqual([unrelated, target]);
    },
  );

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

  it("keeps a retained worktree out of the workspace until the thread moves back into it", async () => {
    const worktree = (name: string) => ({
      id: "pwragent-handoff:codex:thread-1", label: "app", path: "/repo/app", kind: "worktree" as const,
      worktreePath: `/worktrees/${name}`,
    });
    const retained = {
      id: "pwragent-retained-worktree:codex:thread-1:/worktrees/old", label: "app", path: "/repo/app",
      kind: "worktree" as const, worktreePath: "/worktrees/old",
    };
    await store.replaceWorkspaceLinkedDirectory({ backend: "codex", threadId: "thread-1", directory: worktree("old") });
    const moved = await store.replaceWorkspaceLinkedDirectory({
      backend: "codex", threadId: "thread-1", directory: worktree("new"), retainWorktree: retained,
    });
    expect(moved.extraLinkedDirectories).toEqual([worktree("new")]);
    expect(moved.retainedWorktrees).toEqual([retained]);
    // Thread archive reads it through its narrow projection.
    const archiveView = await store.getArchiveCleanupOverlayStates({ backend: "codex", threadIds: ["thread-1"] });
    expect(archiveView["thread-1"]?.retainedWorktrees).toEqual([retained]);
    // A later move keeps it tracked.
    const later = await store.replaceWorkspaceLinkedDirectory({ backend: "codex", threadId: "thread-1", directory: worktree("later") });
    expect(later.retainedWorktrees).toEqual([retained]);
    // Moving back into it makes it the workspace again.
    const back = await store.replaceWorkspaceLinkedDirectory({ backend: "codex", threadId: "thread-1", directory: worktree("old") });
    expect(back.retainedWorktrees).toBeUndefined();
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.retainedWorktrees).toBeUndefined();
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
