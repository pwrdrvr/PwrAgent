import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import * as gitExecutable from "../app-server/git-executable";
import { GitWorkspaceHandoffService } from "../app-server/git-workspace-handoff-service";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { createOverlayStoreMock, git, MockBackendClient, pathExists } from "./helpers/backend-registry-fixture";

type OtherThreadWorkspace = "source" | "descendant" | "unrelated";

async function checkHandoffRemoval(
  otherWorkspaces: OtherThreadWorkspace[],
  {
    direction = "worktree-to-worktree", lateWorkspace, strategy, inventory = "paged", clean = false, refuseDetachment = false,
  }: {
    direction?: "worktree-to-worktree" | "worktree-to-local";
    lateWorkspace?: OtherThreadWorkspace;
    strategy?: "new-branch" | "move-branch";
    inventory?: "paged" | "aggregate";
    clean?: boolean;
    refuseDetachment?: boolean;
  } = {},
) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-shared-handoff-")));
  try {
    const repositoryPath = path.join(root, "repo");
    await mkdir(repositoryPath);
    await git(repositoryPath, ["init", "-b", "main"]);
    await writeFile(path.join(repositoryPath, ".gitignore"), "/nested/\n");
    await writeFile(path.join(repositoryPath, "tracked.txt"), "committed\n");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "Initial commit"]);
    const archiveService = new WorktreeArchiveService();
    const handoffService = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo", worktreeArchiveService: archiveService });
    const created = await handoffService.handoff({
      backend: "codex", threadId: "moving", direction: "to-project", targetPath: repositoryPath, sourceWorkMode: "worktree",
    });
    const sourcePath = created.targetPath;
    if (strategy) await git(sourcePath, ["switch", "-c", "source-branch"]);
    if (!clean) {
      await writeFile(path.join(sourcePath, "tracked.txt"), "staged\n");
      await git(sourcePath, ["add", "tracked.txt"]);
      await writeFile(path.join(sourcePath, "tracked.txt"), "working tree\n");
      await writeFile(path.join(sourcePath, "untracked.txt"), "untracked\n");
    }
    const sourceStatus = await git(sourcePath, ["status", "--porcelain"]);
    const expectOriginalEdits = async () => {
      expect(await git(sourcePath, ["status", "--porcelain"])).toBe(sourceStatus);
      expect(await git(sourcePath, ["show", ":tracked.txt"])).toBe("staged");
      expect(await readFile(path.join(sourcePath, "tracked.txt"), "utf8")).toBe("working tree\n");
      expect(await readFile(path.join(sourcePath, "untracked.txt"), "utf8")).toBe("untracked\n");
    };
    const descendant = path.join(sourcePath, "nested");
    await mkdir(descendant);
    // Ignored content is deliberately excluded from a handoff's transfer.
    // Its survival here demonstrates that Git never removed the source.
    await writeFile(path.join(descendant, "keep.txt"), "keep");
    const unrelated = path.join(root, "unrelated");
    await mkdir(unrelated);
    const workspacePaths = { source: sourcePath, descendant, unrelated };
    const moving: AppServerThreadSummary = {
      source: "codex", id: "moving", title: "Moving", titleSource: "explicit", updatedAt: 1,
      projectKey: sourcePath, linkedDirectories: [created.linkedDirectory],
    };
    const active = [moving, ...otherWorkspaces.map((workspace, index): AppServerThreadSummary => ({
      source: "codex", id: `other-${index}`, title: "Other thread", titleSource: "explicit", updatedAt: 2,
      projectKey: workspacePaths[workspace], linkedDirectories: [],
    }))];
    const codexClient = new MockBackendClient({
      // The provider can still list the previous CWD after an acknowledged move.
      // In an aggregate read the workspace overlay must remain authoritative.
      threads: inventory === "aggregate" ? [{
        ...moving,
        projectKey: repositoryPath,
        linkedDirectories: [{ id: "local", kind: "local", label: "repo", path: repositoryPath }],
      }, ...active.slice(1)] : active,
      archivedThreads: [],
    });
    if (inventory === "paged") Object.assign(codexClient, {
      listArchiveCleanupThreadsPage: async ({ archived }: { archived: boolean }) => ({ threads: archived ? [] : active }),
    });
    const overlayStore = createOverlayStoreMock();
    await overlayStore.replaceWorkspaceLinkedDirectory({
      backend: "codex", threadId: moving.id, directory: created.linkedDirectory,
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore, gitWorkspaceHandoffService: handoffService });
    try {
      if (refuseDetachment) {
        // The response uses forward slashes. The Git runner uses the native real path.
        const nativeSourcePath = await realpath(sourcePath);
        const runGit = gitExecutable.runGitCommand;
        const switchSpy = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation((cwd, args, options) => {
          if (cwd === nativeSourcePath && args[0] === "switch" && args[1] === "--detach") {
            return runGit(cwd, args, { ...options, beforeSpawn: () => { throw new Error("Ownership changed before detachment"); } });
          }
          return runGit(cwd, args, options);
        });
        try {
          await expect(registry.handoffThreadWorkspace({
            backend: "codex", threadId: moving.id, direction, strategy, repositoryPath, sourcePath,
          })).rejects.toThrow("Ownership changed before detachment");
        } finally {
          switchSpy.mockRestore();
        }
        expect(await git(sourcePath, ["branch", "--show-current"])).toBe("source-branch");
        await expectOriginalEdits();
        expect(await git(repositoryPath, ["stash", "list"])).toBe("");
        return;
      }
      if (lateWorkspace) {
        const archive = archiveService.archive.bind(archiveService);
        vi.spyOn(archiveService, "archive").mockImplementationOnce(async (params) => await archive({
          ...params,
          beforeRemove: async () => {
            const assertRemoval = await params.beforeRemove?.();
            const thread = { ...moving, id: "late", projectKey: workspacePaths[lateWorkspace], linkedDirectories: [] };
            active.push(thread);
            await registry.publishLocalEvent({ backend: "codex", notification: { method: "thread/started", params: { thread } } });
            return assertRemoval ?? (() => {});
          },
        }));
      }
      const handoff = registry.handoffThreadWorkspace({
        backend: "codex", threadId: moving.id, direction, repositoryPath, sourcePath,
        ...(strategy ? { strategy } : {}),
        ...(strategy === "new-branch" ? { newBranchName: "destination-branch" } : {}),
      });
      const sharedAtStart = otherWorkspaces.some((workspace) => workspace !== "unrelated");
      if (sharedAtStart && !clean) {
        await expect(handoff).rejects.toThrow(strategy === "move-branch" ? "still used by another active thread" : "The handoff could not transfer uncommitted changes.");
        if (strategy) expect(await git(sourcePath, ["branch", "--show-current"])).toBe("source-branch");
        await expectOriginalEdits();
        const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: moving.id });
        expect(overlay?.extraLinkedDirectories).toEqual([created.linkedDirectory]);
        return;
      }
      const result = await handoff;
      expect(result.targetPath).not.toBe(sourcePath);
      const shared = sharedAtStart || (lateWorkspace !== undefined && lateWorkspace !== "unrelated");
      expect(await pathExists(sourcePath)).toBe(shared);
      expect(await pathExists(path.join(descendant, "keep.txt"))).toBe(shared);
      if (clean) {
        expect(await readFile(path.join(result.targetPath, "tracked.txt"), "utf8")).toMatch(/^committed\r?\n$/);
        if (strategy === "new-branch") {
          expect(await git(sourcePath, ["branch", "--show-current"])).toBe("source-branch");
          expect(await git(result.targetPath, ["branch", "--show-current"])).toBe("destination-branch");
        }
      } else {
        if (shared) await expectOriginalEdits();
        expect(await readFile(path.join(result.targetPath, "tracked.txt"), "utf8")).toMatch(/^working tree\r?\n$/);
        expect(await readFile(path.join(result.targetPath, "untracked.txt"), "utf8")).toMatch(/^untracked\r?\n$/);
        expect(await git(result.targetPath, ["show", ":tracked.txt"])).toBe("staged");
        if (strategy === "move-branch") {
          expect(await git(result.targetPath, ["branch", "--show-current"])).toBe("source-branch");
        }
      }
      const worktrees = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
      expect(worktrees.split("\n").includes(`worktree ${sourcePath.replaceAll("\\", "/")}`)).toBe(shared);
      const snapshotRefs = await git(repositoryPath, ["for-each-ref", "--format=%(refname)", "refs/codex/snapshots/"]);
      expect(Boolean(snapshotRefs)).toBe(!shared);
      const snapshots = (await overlayStore.getThreadOverlayState({ backend: "codex", threadId: moving.id }))?.worktreeSnapshots ?? [];
      expect(snapshots).toHaveLength(shared ? 0 : 1);
    } finally {
      await registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace handoff source removal", () => {
  it("keeps the checkout when two other active threads still use it", async () => {
    await checkHandoffRemoval(["source", "source"], { clean: true });
  });

  it("refuses a dirty shared handoff that would otherwise move only the commit", async () => {
    await checkHandoffRemoval(["source"]);
  });

  it("returns a sole owner's named worktree to Local when its provider listing still shows the old checkout", async () => {
    await checkHandoffRemoval([], { direction: "worktree-to-local", strategy: "move-branch", inventory: "aggregate" });
  });

  it.each([
    { lateWorkspace: "source", direction: "worktree-to-worktree" },
    { lateWorkspace: "source", direction: "worktree-to-local" },
    { lateWorkspace: "unrelated", direction: "worktree-to-worktree" },
  ] as const)("checks a late thread in the $lateWorkspace workspace during $direction", async (options) => {
    await checkHandoffRemoval([], options);
  });

  it("creates a new branch from a shared checkout without changing its branch", async () => {
    await checkHandoffRemoval(["source"], { strategy: "new-branch", clean: true });
  });

  it.each(["worktree-to-worktree", "worktree-to-local"] as const)("refuses to move a shared branch during %s", async (direction) => {
    await checkHandoffRemoval(["source"], { direction, strategy: "move-branch" });
  });

  it.each(["worktree-to-worktree", "worktree-to-local"] as const)("keeps the exact Git state when detachment is refused during %s", async (direction) => {
    await checkHandoffRemoval([], { direction, strategy: "move-branch", refuseDetachment: true });
  });

  // One real Git fixture per test. These cases distinguish each kind of
  // workspace use, including a blocker after an unrelated thread.
  const workspaceCases: { scenario: string; workspaces: OtherThreadWorkspace[] }[] = [
    { scenario: "no other thread", workspaces: [] },
    { scenario: "an unrelated thread", workspaces: ["unrelated"] },
    { scenario: "a thread at the worktree root", workspaces: ["source"] },
    { scenario: "a descendant thread after an unrelated thread", workspaces: ["unrelated", "descendant"] },
  ];
  const removalCases = (["worktree-to-worktree", "worktree-to-local"] as const).flatMap((direction) =>
    (["paged", "aggregate"] as const).flatMap((inventory) =>
      workspaceCases.map((workspaceCase) => ({ ...workspaceCase, direction, inventory })),
    ),
  );
  it.each(removalCases)(
    "checks removal with $scenario during $direction using $inventory inventory",
    async ({ workspaces, direction, inventory }) => {
      await checkHandoffRemoval(workspaces, { direction, inventory });
    },
  );
});
