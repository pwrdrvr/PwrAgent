import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

type WorktreeEntry = {
  branch?: string;
  path: string;
};

type HandoffFixture = {
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
  threadId: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
      }
      current = undefined;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function getWorktrees(repoDir: string): WorktreeEntry[] {
  return parseWorktreeList(git(repoDir, ["worktree", "list", "--porcelain"]));
}

function getSecondaryWorktree(repoDir: string): WorktreeEntry {
  const repoRealPath = realpathSync.native(repoDir);
  const secondary = getWorktrees(repoDir).find(
    (entry) => realpathSync.native(entry.path) !== repoRealPath,
  );
  if (!secondary) {
    throw new Error("Expected a secondary worktree to exist.");
  }
  return secondary;
}

async function createHandoffFixture(testId: string): Promise<HandoffFixture> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `pwragent-handoff-flow-${testId}-`));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const threadId = `thread-handoff-${testId}`;
  await mkdir(repoDir, { recursive: true });

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "PwrAgent Tests"]);
  git(repoDir, ["config", "user.email", "pwragent-tests@example.invalid"]);
  await writeFile(path.join(repoDir, ".gitignore"), ".worktrees/\n", "utf8");
  await writeFile(path.join(repoDir, "README.md"), "clean main\n", "utf8");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial"]);
  git(repoDir, ["branch", "release"]);
  git(repoDir, ["switch", "-c", "feature/handoff"]);
  await writeFile(path.join(repoDir, "feature.txt"), "feature branch\n", "utf8");
  git(repoDir, ["add", "feature.txt"]);
  git(repoDir, ["commit", "-m", "feature"]);
  await writeFile(path.join(repoDir, "README.md"), `dirty ${testId}\n`, "utf8");
  await writeFile(path.join(repoDir, "dirty.txt"), `untracked ${testId}\n`, "utf8");

  const fixturePath = path.join(rootDir, "workspace-handoff-flow.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: `workspace-handoff-flow-${testId}`,
          threadId,
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
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: threadId,
                title: `Round trip ${testId}`,
                titleSource: "explicit",
                summary: "Exercise workspace handoff against a real git repo",
                source: "codex",
                executionMode: "default",
                gitBranch: "feature/handoff",
                observedGitBranch: "feature/handoff",
                linkedDirectories: [
                  {
                    id: "fixture-repo",
                    label: "FixtureRepo",
                    path: repoDir,
                    kind: "local",
                  },
                ],
                updatedAt: 1_760_000_000_000,
              },
            ],
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
                  text: "Move my in-flight repo changes.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: "Move my in-flight repo changes.",
                },
              ],
              lastUserMessage: "Move my in-flight repo changes.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
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
    repoDir,
    threadId,
  };
}

async function openLocalHandoffDialog(page: Page, title: string) {
  await page.getByRole("button", { name: title }).click();
  await page.getByLabel("Workspace mode").click();
  await page.getByRole("menuitem", { name: "Handoff to New Worktree" }).click();
  const dialog = page.getByRole("dialog", { name: "Handoff to New Worktree" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function handoffBackToLocal(page: Page) {
  await page.getByLabel("Workspace mode").click();
  await page.getByRole("menuitem", { name: "Handoff to Local" }).click();
  const dialog = page.getByRole("dialog", { name: "Handoff to Local" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Handoff" }).click();
  await expect(dialog).toBeHidden();
}

async function expectDirtyWipAt(workspacePath: string, testId: string): Promise<void> {
  await expect(readFile(path.join(workspacePath, "README.md"), "utf8")).resolves.toBe(
    `dirty ${testId}\n`,
  );
  await expect(readFile(path.join(workspacePath, "dirty.txt"), "utf8")).resolves.toBe(
    `untracked ${testId}\n`,
  );
}

test.describe("workspace handoff git flows", () => {
  const cases = [
    {
      testId: "detached",
      configure: async () => undefined,
      expectedLocalBranchAfterLocalHandoff: "feature/handoff",
      expectedLocalBranchAfterReturn: "",
      expectedWorktreeBranch: "",
    },
    {
      testId: "new-branch",
      configure: async (page: Page) => {
        const dialog = page.getByRole("dialog", { name: "Handoff to New Worktree" });
        await dialog.getByRole("radio", { name: /Handoff to New Branch/ }).click();
        await dialog.getByLabel("New branch name").fill("pwragent/e2e-handoff");
      },
      expectedLocalBranchAfterLocalHandoff: "feature/handoff",
      expectedLocalBranchAfterReturn: "pwragent/e2e-handoff",
      expectedWorktreeBranch: "pwragent/e2e-handoff",
    },
    {
      testId: "move-leave-main",
      configure: async (page: Page) => {
        const dialog = page.getByRole("dialog", { name: "Handoff to New Worktree" });
        await dialog.getByRole("radio", { name: /Handoff Current Branch/ }).click();
        await dialog.getByLabel("Leave current checkout on").selectOption("main");
      },
      expectedLocalBranchAfterLocalHandoff: "main",
      expectedLocalBranchAfterReturn: "feature/handoff",
      expectedWorktreeBranch: "feature/handoff",
    },
    {
      testId: "move-leave-detached",
      configure: async (page: Page) => {
        const dialog = page.getByRole("dialog", { name: "Handoff to New Worktree" });
        await dialog.getByRole("radio", { name: /Handoff Current Branch/ }).click();
        await dialog.getByLabel("Leave current checkout on").selectOption("HEAD");
      },
      expectedLocalBranchAfterLocalHandoff: "",
      expectedLocalBranchAfterReturn: "feature/handoff",
      expectedWorktreeBranch: "feature/handoff",
    },
  ];

  for (const handoffCase of cases) {
    test(`round trips dirty WIP through ${handoffCase.testId}`, async () => {
      const fixture = await createHandoffFixture(handoffCase.testId);
      const app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
      });

      try {
        const dialog = await openLocalHandoffDialog(
          app.window,
          `Round trip ${handoffCase.testId}`,
        );
        await handoffCase.configure(app.window);
        await dialog.getByRole("button", { name: "Handoff" }).click();
        await expect(dialog).toBeHidden();

        await expect
          .poll(() => getWorktrees(fixture.repoDir).length)
          .toBe(2);
        const worktree = getSecondaryWorktree(fixture.repoDir);
        expect(git(fixture.repoDir, ["branch", "--show-current"])).toBe(
          handoffCase.expectedLocalBranchAfterLocalHandoff,
        );
        expect(git(worktree.path, ["branch", "--show-current"])).toBe(
          handoffCase.expectedWorktreeBranch,
        );
        expect(git(fixture.repoDir, ["status", "--porcelain", "--untracked-files=normal"])).toBe(
          "",
        );
        await expectDirtyWipAt(worktree.path, handoffCase.testId);

        await handoffBackToLocal(app.window);

        await expect
          .poll(async () => await pathExists(worktree.path))
          .toBe(false);
        expect(git(fixture.repoDir, ["branch", "--show-current"])).toBe(
          handoffCase.expectedLocalBranchAfterReturn,
        );
        await expectDirtyWipAt(fixture.repoDir, handoffCase.testId);
      } finally {
        await app.close();
        await fixture.cleanup();
      }
    });
  }

  test("blocks handoff back to Local when Local has WIP", async () => {
    const fixture = await createHandoffFixture("dirty-local");
    const app = await launchElectronApp({
      fixturePath: fixture.fixturePath,
    });

    try {
      const dialog = await openLocalHandoffDialog(app.window, "Round trip dirty-local");
      await dialog.getByRole("button", { name: "Handoff" }).click();
      await expect(dialog).toBeHidden();

      await expect
        .poll(() => getWorktrees(fixture.repoDir).length)
        .toBe(2);
      const worktree = getSecondaryWorktree(fixture.repoDir);
      await writeFile(path.join(fixture.repoDir, "local-wip.txt"), "local only\n", "utf8");
      await writeFile(path.join(worktree.path, "worktree-wip.txt"), "worktree only\n", "utf8");

      await app.window.getByLabel("Workspace mode").click();
      await app.window.getByRole("menuitem", { name: "Handoff to Local" }).click();
      const returnDialog = app.window.getByRole("dialog", { name: "Handoff to Local" });
      await expect(returnDialog).toBeVisible();
      await returnDialog.getByRole("button", { name: "Handoff" }).click();

      await expect(returnDialog).toContainText(
        "Local has dirty tracked or untracked changes",
      );
      expect(await pathExists(worktree.path)).toBe(true);
      await expect(readFile(path.join(fixture.repoDir, "local-wip.txt"), "utf8")).resolves.toBe(
        "local only\n",
      );
      await expect(readFile(path.join(worktree.path, "worktree-wip.txt"), "utf8")).resolves.toBe(
        "worktree only\n",
      );
      expect(git(fixture.repoDir, ["stash", "list"])).toBe("");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
