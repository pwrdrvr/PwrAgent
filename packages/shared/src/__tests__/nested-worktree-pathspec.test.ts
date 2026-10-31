import { describe, expect, it, vi } from "vitest";
import {
  containingWorktreePath,
  nestedWorktreeExcludePathspecs,
  nestedWorktreePathspecArgs,
  parseWorktreeListPaths,
  readStatusWithoutNestedWorktrees,
  statusReportsUntrackedDirectory,
} from "../nested-worktree-pathspec";

describe("nestedWorktreeExcludePathspecs", () => {
  it("excludes only worktrees strictly inside the checkout", () => {
    expect(nestedWorktreeExcludePathspecs({
      toplevel: "/src/repo",
      worktreePaths: [
        "/src/repo",
        "/src/repo/.claude/worktrees/agent-a",
        "/src/repo-other",
        "/src/repo2/.claude/worktrees/agent-b",
        "/elsewhere/feature",
      ],
    })).toEqual([":(exclude,top,literal).claude/worktrees/agent-a"]);
  });

  it("compares Windows paths across separators and drive-letter case", () => {
    expect(nestedWorktreeExcludePathspecs({
      toplevel: "C:\\Users\\dev\\repo\\",
      worktreePaths: ["c:/Users/dev/repo/.claude/worktrees/agent-a", "C:/Users/dev/repo"],
    })).toEqual([":(exclude,top,literal).claude/worktrees/agent-a"]);
  });

  it("keeps glob characters literal", () => {
    expect(nestedWorktreeExcludePathspecs({
      toplevel: "/src/repo",
      worktreePaths: ["/src/repo/wt/[x]*"],
    })).toEqual([":(exclude,top,literal)wt/[x]*"]);
  });
});

describe("containingWorktreePath", () => {
  it("picks the deepest worktree holding the cwd", () => {
    const worktrees = ["/src/repo", "/src/repo/.claude/worktrees/agent-a"];
    expect(containingWorktreePath("/src/repo/apps", worktrees)).toBe("/src/repo");
    expect(containingWorktreePath("/src/repo/.claude/worktrees/agent-a/src", worktrees))
      .toBe("/src/repo/.claude/worktrees/agent-a");
    expect(containingWorktreePath("/src/repo-other", worktrees)).toBeUndefined();
  });
});

describe("parseWorktreeListPaths", () => {
  it("reads NUL-terminated and newline porcelain", () => {
    expect(parseWorktreeListPaths("worktree /a\0HEAD 1\0branch refs/heads/main\0\0worktree /a/b\0detached\0\0"))
      .toEqual(["/a", "/a/b"]);
    expect(parseWorktreeListPaths("worktree /a\nHEAD 1\n\nworktree /a/b\nbare\n")).toEqual(["/a", "/a/b"]);
  });
});

describe("statusReportsUntrackedDirectory", () => {
  it("finds a collapsed untracked directory in -z and plain porcelain", () => {
    expect(statusReportsUntrackedDirectory("?? .claude/\0")).toBe(true);
    expect(statusReportsUntrackedDirectory(" M a.ts\n?? \"odd dir/\"\n")).toBe(true);
    expect(statusReportsUntrackedDirectory(" M a.ts\0?? new.txt\0")).toBe(false);
    expect(statusReportsUntrackedDirectory("")).toBe(false);
  });
});

describe("readStatusWithoutNestedWorktrees", () => {
  const statusArgs = ["status", "--porcelain=v1", "-z"];

  it("runs one status when nothing untracked is a directory", async () => {
    const git = vi.fn(async () => " M a.ts\0");
    await expect(readStatusWithoutNestedWorktrees({ cwd: "/src/repo", git, statusArgs }))
      .resolves.toBe(" M a.ts\0");
    expect(git).toHaveBeenCalledOnce();
  });

  it("re-reads status with excludes when a nested worktree exists", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "worktree") {
        return "worktree /src/repo\0\0worktree /src/repo/.claude/worktrees/agent-a\0\0";
      }
      return args.includes(":(top)") ? "" : "?? .claude/\0";
    });

    await expect(readStatusWithoutNestedWorktrees({ cwd: "/src/repo", git, statusArgs }))
      .resolves.toBe("");
    expect(git).toHaveBeenLastCalledWith([
      ...statusArgs,
      ...nestedWorktreePathspecArgs([":(exclude,top,literal).claude/worktrees/agent-a"]),
    ]);
  });

  it("keeps the first status when the worktree probe fails or finds none nested", async () => {
    const failing = vi.fn(async (args: string[]) => {
      if (args[0] === "worktree") throw new Error("git failed");
      return "?? vendor/\0";
    });
    await expect(readStatusWithoutNestedWorktrees({ cwd: "/src/repo", git: failing, statusArgs }))
      .resolves.toBe("?? vendor/\0");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
