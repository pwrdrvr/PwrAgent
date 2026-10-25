import type { AppServerThreadSummary, WorktreeSnapshotSummary } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { detectMissingThreadWorkspace } from "../app-server/missing-thread-workspace";

const WORKTREE = "/home/dev/.pwragent/worktrees/mf3k2q/atlas";
const MAIN = "/home/dev/src/atlas";

function thread(overrides: Partial<AppServerThreadSummary> = {}): AppServerThreadSummary {
  return {
    id: "t1",
    title: "Retry backoff for webhook deliveries",
    titleSource: "user",
    source: "codex",
    gitBranch: "fix/retry-backoff",
    linkedDirectories: [{
      id: "d1", label: "atlas", kind: "worktree", path: MAIN, worktreePath: WORKTREE,
    }],
    ...overrides,
  } as AppServerThreadSummary;
}

function snapshot(overrides: Partial<WorktreeSnapshotSummary> = {}): WorktreeSnapshotSummary {
  return {
    id: "s1", backend: "codex", threadId: "t1", worktreePath: WORKTREE, repositoryPath: MAIN,
    snapshotRef: "refs/codex/snapshots/abc", snapshotCommit: "a41c9e2", sourceBranch: "fix/from-snapshot",
    createdAt: 10, archivedAt: 20, state: "archived", ignoredFilesExcluded: true,
    ...overrides,
  };
}

describe("detectMissingThreadWorkspace", () => {
  it("says nothing while the worktree folder exists, without reading the main checkout", async () => {
    const readBranch = vi.fn(async () => "main");
    expect(await detectMissingThreadWorkspace(thread(), {
      pathExists: async () => true, readBranch,
    })).toBeUndefined();
    expect(readBranch).not.toHaveBeenCalled();
  });

  it("leaves archived threads to Restore, which brings their worktrees back", async () => {
    const pathExists = vi.fn(async () => false);
    expect(await detectMissingThreadWorkspace(thread({ archivedAt: 30 }), { pathExists })).toBeUndefined();
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("ignores threads with no worktree", async () => {
    expect(await detectMissingThreadWorkspace(thread({
      linkedDirectories: [{ id: "d1", label: "atlas", kind: "local", path: MAIN }],
    }), { pathExists: async () => false })).toBeUndefined();
  });

  it("describes a deleted worktree with the branch the main checkout is on now", async () => {
    expect(await detectMissingThreadWorkspace(thread(), {
      pathExists: async (target) => target === MAIN,
      readBranch: async () => "main",
    })).toEqual({
      worktreePath: WORKTREE,
      repositoryPath: MAIN,
      repositoryAvailable: true,
      branch: "fix/retry-backoff",
      mainCheckoutBranch: "main",
    });
  });

  it("offers the newest archived checkpoint for the same path, and its branch", async () => {
    const result = await detectMissingThreadWorkspace(thread({
      worktreeSnapshots: [
        snapshot({ snapshotCommit: "old", archivedAt: 5 }),
        snapshot(),
        snapshot({ worktreePath: "/elsewhere", archivedAt: 99 }),
        snapshot({ state: "restored", archivedAt: 50 }),
      ],
    }), { pathExists: async (target) => target === MAIN, readBranch: async () => "main" });

    expect(result?.checkpoint).toEqual({
      snapshotRef: "refs/codex/snapshots/abc", snapshotCommit: "a41c9e2", archivedAt: 20,
    });
    expect(result?.branch).toBe("fix/from-snapshot");
  });

  it("reports a missing main checkout without reading its branch", async () => {
    const readBranch = vi.fn(async () => "main");
    const result = await detectMissingThreadWorkspace(thread({ gitBranch: "HEAD" }), {
      pathExists: async () => false, readBranch,
    });
    expect(result).toEqual({ worktreePath: WORKTREE, repositoryPath: MAIN, repositoryAvailable: false });
    expect(readBranch).not.toHaveBeenCalled();
  });
});
