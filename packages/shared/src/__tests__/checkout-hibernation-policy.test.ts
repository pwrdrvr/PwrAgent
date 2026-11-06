import { describe, expect, it } from "vitest";
import { isThreadCheckoutHibernated } from "../checkout-hibernation-policy";
import type { WorktreeSnapshotSummary } from "../contracts/normalized-app-server";

const snapshot = (worktreePath: string, state: WorktreeSnapshotSummary["state"]): WorktreeSnapshotSummary => ({
  id: "s", backend: "codex", threadId: "t", worktreePath, repositoryPath: "/repo", snapshotRef: "refs/codex/snapshots/s",
  snapshotCommit: "c", createdAt: 1, state, ignoredFilesExcluded: true,
});
const linkedDirectories = [{ id: "d", kind: "worktree" as const, label: "repo", path: "/repo", worktreePath: "/home/dev/.pwragent/worktrees/a/repo" }];

describe("isThreadCheckoutHibernated", () => {
  it("marks only the thread's own worktree, and never an archived thread", () => {
    expect(isThreadCheckoutHibernated({ linkedDirectories, worktreeSnapshots: [snapshot("/home/dev/.pwragent/worktrees/a/repo/", "hibernated")] })).toBe(true);
    expect(isThreadCheckoutHibernated({ linkedDirectories, worktreeSnapshots: [snapshot("/home/dev/.pwragent/worktrees/a/repo", "restored")] })).toBe(false);
    expect(isThreadCheckoutHibernated({ linkedDirectories, worktreeSnapshots: [snapshot("/elsewhere", "hibernated")] })).toBe(false);
    expect(isThreadCheckoutHibernated({ linkedDirectories, archivedAt: 1,
      worktreeSnapshots: [snapshot("/home/dev/.pwragent/worktrees/a/repo", "hibernated")] })).toBe(false);
    expect(isThreadCheckoutHibernated({ linkedDirectories: [{ ...linkedDirectories[0]!, kind: "local", worktreePath: undefined }],
      worktreeSnapshots: [snapshot("/repo", "hibernated")] })).toBe(false);
  });
});
