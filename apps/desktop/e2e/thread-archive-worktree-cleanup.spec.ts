import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { launchElectronApp } from "./fixtures/electron-app";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  }).trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function createArchiveWorktreeFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoPath: string;
  worktreePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-e2e-"));
  const repoPath = path.join(rootDir, "PwrAgnt");
  const worktreeRoot = path.join(rootDir, ".codex", "worktrees", "mozycyl1");
  const worktreePath = path.join(worktreeRoot, "PwrAgnt");

  await mkdir(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.email", "pwragent-tests@example.invalid"]);
  git(repoPath, ["config", "user.name", "PwrAgent Tests"]);
  await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "Seed archive fixture"]);
  await mkdir(worktreeRoot, { recursive: true });
  git(repoPath, ["worktree", "add", "-b", "feat/archive-cleanup", worktreePath, "main"]);

  const resolvedWorktreePath = await realpath(worktreePath);
  const fixturePath = path.join(rootDir, "thread-archive-worktree-cleanup.fixture.json");
  const thread = {
    id: "thread-archive-worktree",
    title: "Archive worktree cleanup",
    titleSource: "explicit",
    summary: "Archive removes the backing worktree",
    source: "codex",
    executionMode: "default",
    gitBranch: "feat/archive-cleanup",
    linkedDirectories: [
      {
        id: `directory:${repoPath}`,
        label: "PwrAgnt",
        path: repoPath,
        kind: "worktree",
        worktreePath: resolvedWorktreePath,
      },
    ],
    inbox: {
      inInbox: false,
    },
    updatedAt: 1760000000000,
  };

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-archive-worktree-cleanup",
          threadId: "thread-archive-worktree",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: {
                name: "Replay Codex",
                version: "1.0.0",
              },
              methods: ["thread/list", "thread/read", "thread/archive", "skills/list"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [thread],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "message-1",
                  role: "user",
                  text: "Archive this thread and clean up the worktree.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: "Archive this thread and clean up the worktree.",
                },
              ],
              lastUserMessage: "Archive this thread and clean up the worktree.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-archive-1",
            kind: "response",
            method: "thread/archive",
            result: {
              threadId: "thread-archive-worktree",
            },
          },
          {
            id: "thread-list-post-archive",
            afterResponseId: "thread-archive-1",
            kind: "response",
            method: "thread/list",
            result: [],
          },
          // Codex moves an archived thread into the archived listing. The
          // cleanup finds its target there, however many active reads ran.
          {
            id: "thread-list-archived-post-archive",
            afterResponseId: "thread-archive-1",
            archived: true,
            kind: "response",
            method: "thread/list",
            result: [thread],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
    fixturePath,
    repoPath,
    worktreePath: resolvedWorktreePath,
  };
}

test("archiving a replay-backed thread removes its real Git worktree", async () => {
  const fixture = await createArchiveWorktreeFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    // The row proves the active listing reached the renderer, so every read
    // after the archive sees the thread only in the archived listing.
    await expect(
      app.window.getByRole("button", { name: /Archive worktree cleanup/i }),
    ).toBeVisible();
    // The archive response owns the Git cleanup. A first Windows Job-wrapper
    // launch can still be compiling after the UI optimistically hides the row.
    const response = await app.window.evaluate(async () => {
      const api = (window as Window & { pwragent?: DesktopApi }).pwragent;
      if (!api?.archiveThread) {
        throw new Error("Desktop archive bridge is unavailable.");
      }
      return await api.archiveThread({
        backend: "codex",
        threadId: "thread-archive-worktree",
      });
    });
    expect(response.cleanup).toEqual([
      expect.objectContaining({
        worktreePath: fixture.worktreePath,
        removedWorktree: true,
      }),
    ]);
    expect(await pathExists(fixture.worktreePath)).toBe(false);
    expect(git(fixture.repoPath, ["worktree", "list", "--porcelain"]))
      .not.toContain(fixture.worktreePath);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
