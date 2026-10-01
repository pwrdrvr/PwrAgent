import { describe, expect, it } from "vitest";
import {
  buildSubthreadLaunchpadKey,
  getParentThreadIdFromSubthreadLaunchpadKey,
  getSubthreadLaunchpadMode,
  isSameWorktreeSubthreadLaunchpad,
  pickSubthreadWorktreeBase,
} from "../subthread-launchpads";

describe("subthread launchpad keys", () => {
  const parent = { source: "codex" as const, id: "thread:with/colon" };

  it("keeps the parent's own machine on the four-part key", () => {
    const key = buildSubthreadLaunchpadKey(parent, "same-worktree");
    expect(key).toBe("subthread:codex:thread%3Awith%2Fcolon:same-worktree");
    expect(getSubthreadLaunchpadMode(key)).toBe("same-worktree");
    expect(getParentThreadIdFromSubthreadLaunchpadKey(key)).toBe("thread:with/colon");
    expect(isSameWorktreeSubthreadLaunchpad(key)).toBe(true);
  });

  it("gives each other machine its own key that still parses", () => {
    const studio = buildSubthreadLaunchpadKey(parent, "new-worktree", "studio");
    const attic = buildSubthreadLaunchpadKey(parent, "new-worktree", "attic");
    expect(studio).toBe("subthread:codex:thread%3Awith%2Fcolon:new-worktree:studio");
    expect(attic).not.toBe(studio);
    expect(getSubthreadLaunchpadMode(studio)).toBe("new-worktree");
    expect(getParentThreadIdFromSubthreadLaunchpadKey(studio)).toBe("thread:with/colon");
  });

  it("rejects keys that are not sub-thread launchpads", () => {
    expect(getSubthreadLaunchpadMode("directory:/repo")).toBeUndefined();
    expect(getSubthreadLaunchpadMode("subthread:codex:parent:sideways")).toBeUndefined();
    expect(getSubthreadLaunchpadMode("subthread:codex:parent:local:studio:extra")).toBeUndefined();
    expect(getParentThreadIdFromSubthreadLaunchpadKey("subthread:codex:parent")).toBeUndefined();
  });
});

describe("pickSubthreadWorktreeBase", () => {
  it("keeps the parent's branch only where the checkout is known to have it", () => {
    expect(pickSubthreadWorktreeBase("feature/a", { currentBranch: "main", branches: ["feature/a"] }))
      .toEqual({ available: true, baseBranch: "feature/a" });
    expect(pickSubthreadWorktreeBase("feature/a", { currentBranch: "main", defaultBranch: "main" }))
      .toEqual({ available: true, baseBranch: "main" });
    expect(pickSubthreadWorktreeBase(undefined, { currentBranch: "release" }))
      .toEqual({ available: true, baseBranch: "release" });
  });

  it("falls back from a detached checkout to its default branch", () => {
    expect(pickSubthreadWorktreeBase("feature/a", { currentBranch: "HEAD", defaultBranch: "main" }))
      .toEqual({ available: true, baseBranch: "main" });
  });

  it("offers no worktree where the checkout cannot start one", () => {
    expect(pickSubthreadWorktreeBase("main", {
      currentBranch: "main",
      worktreeCreationAvailable: false,
      worktreeCreationUnavailableReason: "The repository has no commits yet",
    })).toEqual({ available: false, reason: "The repository has no commits yet" });
    expect(pickSubthreadWorktreeBase("main", undefined))
      .toEqual({ available: false, reason: "No branch" });
  });
});
