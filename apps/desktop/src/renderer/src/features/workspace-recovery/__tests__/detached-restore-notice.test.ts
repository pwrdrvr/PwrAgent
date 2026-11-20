import { describe, expect, it } from "vitest";
import type {
  RestoreThreadResponse,
  WorktreeSnapshotSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import { detachedRestoreNotices } from "../detached-restore-notice";

const snapshot = (detachedFrom?: WorktreeSnapshotSummary["detachedFrom"]): WorktreeSnapshotSummary => ({
  id: "s1", backend: "codex", threadId: "t1", worktreePath: "/w/atlas", repositoryPath: "/src/atlas",
  snapshotRef: "refs/x", snapshotCommit: "c", createdAt: 1, state: "restored", ignoredFilesExcluded: true,
  ...(detachedFrom ? { detachedFrom } : {}),
});
const response = (worktrees: NonNullable<RestoreThreadResponse["worktrees"]>): RestoreThreadResponse =>
  ({ backend: "codex", threadId: "t1", restoredAt: 1, worktrees });
const head = "0123456789abcdef0123";

describe("detachedRestoreNotices", () => {
  it("raises one durable notice for each worktree restored on a detached HEAD, and none otherwise", () => {
    const notices = detachedRestoreNotices([response([
      { worktreePath: "/w/atlas", restored: true, snapshot: snapshot({ branch: "fix/retry", head, reason: "in-use", checkedOutAt: "/src/atlas" }) },
      { worktreePath: "/w/plain", restored: true, snapshot: snapshot() },
      { worktreePath: "/w/failed", restored: false, error: "boom" },
    ])], "Retry backoff");

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      id: "restore-detached:codex:t1:/w/atlas",
      autoDismiss: false,
      facts: [
        { label: "Worktree", value: "/w/atlas" },
        { label: "Commit", value: "0123456789ab" },
        { label: "fix/retry is in", value: "/src/atlas" },
      ],
    });
    expect(notices[0]!.message).toBe(
      "fix/retry is checked out in another worktree, so “Retry backoff” came back at the same commit on a detached HEAD, with its saved changes. Commits made there won't move fix/retry.",
    );
  });

  it.each([
    ["moved", "fix/retry has moved since its changes were saved"],
    ["missing", "fix/retry no longer exists"],
  ] as const)("explains a %s branch without a holder", (reason, lead) => {
    const [notice] = detachedRestoreNotices([response([
      { worktreePath: "/w/atlas", restored: true, snapshot: snapshot({ branch: "fix/retry", head, reason }) },
    ])]);
    expect(notice!.message.startsWith(`${lead}, so the thread came back`)).toBe(true);
    expect(notice!.facts).toHaveLength(2);
  });
});
