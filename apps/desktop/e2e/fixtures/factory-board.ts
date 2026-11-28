import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SqliteThreadReviewStorage } from "@pwragent/sqlite-storage/thread-review-storage-sqlite";
import type { ElectronApplication } from "@playwright/test";
import { StateDb } from "../../src/main/state/state-db";
import { expect, type Page } from "./electron-test";
import { seedProfileOverlayState } from "./overlay-state-seeding";
import { stateDbPathForHomeRoot } from "./readme-state-seeding";

const git = promisify(execFile);
export const factoryIssue = "10000000-0000-4000-a000-000000000042";
export const factoryBranch = "fix/keyboard-focus";
export const factoryReviewId = "aster-keyboard-review";
export const factoryRepositoryName = "Aster-Factory-Fixture";
export const factoryRepositoryOwner = "northwind-labs";

export async function factoryWorktreePath(homeRoot: string) {
  return path.join(await realpath(homeRoot), "aster-keyboard-focus");
}

export async function seedFactoryBoard(homeRoot: string) {
  const root = await realpath(homeRoot);
  const repository = path.join(root, "aster");
  const worktree = await factoryWorktreePath(homeRoot);
  await mkdir(repository);
  const run = async (args: string[], cwd = repository) => (await git("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z" },
  })).stdout.trim();
  const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "--no-gpg-sign", "-m"];
  await run(["init", "--template=", "-b", "main"]);
  await run([...commit, "Aster base"]);
  const mergeBase = await run(["rev-parse", "HEAD"]);
  await run(["remote", "add", "origin", `https://github.com/${factoryRepositoryOwner}/${factoryRepositoryName}.git`]);
  await run(["worktree", "add", "-b", factoryBranch, worktree]);
  await run([...commit, "Keep focus on the selected row"], worktree);
  const head = await run(["rev-parse", "HEAD"], worktree);
  await run([...commit, "Advance the target after review"]);
  const base = await run(["rev-parse", "HEAD"]);
  await run(["update-ref", "refs/remotes/origin/main", base]);
  await seedProfileOverlayState(homeRoot, {
    directoryLaunchpads: [{
      directoryKey: `directory:${repository}`, directoryKind: "directory",
      directoryLabel: "Aster", directoryPath: repository, registeredAt: 1,
      backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
    }],
  });
  const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
  try {
    new SqliteThreadReviewStorage(db).insert({
      backend: "codex", threadId: "thread-smoke", id: factoryReviewId, origin: "automatic",
      sourceKey: "message-2", title: "Aster keyboard review", status: "handled",
      items: [], createdAt: 1, updatedAt: 1,
      context: { workspacePath: worktree, repositoryPath: repository, gitBranch: factoryBranch, headCommit: head, baseCommit: mergeBase },
    });
  } finally {
    db.close();
  }
  return { worktree, head, base, mergeBase };
}

export async function openFactoryBoard(app: { window: Page; electronApp: ElectronApplication }) {
  const profile = app.window.getByRole("button", { name: /^Open PwrAgent profile menu:/ });
  await profile.click();
  const menu = app.window.locator(".sidebar__menu--profile");
  await expect(menu).toBeVisible();
  const entry = menu.getByRole("menuitem", { name: /^Factory/ });
  const nextWindow = app.electronApp.waitForEvent("window");
  await entry.click();
  const factory = await nextWindow;
  await expect(factory).toHaveURL(/#factory$/);
  await expect(factory.getByRole("heading", { name: "Factory board" })).toBeVisible();
  await expect(factory.getByText("Aster", { exact: true })).toBeVisible();
  await factory.getByLabel("Repository name", { exact: true }).fill(factoryRepositoryName);
  return factory;
}

export async function fillFactoryBranch(factory: Page, worktree: string) {
  await factory.getByLabel("Branch", { exact: true }).fill(factoryBranch);
  await factory.getByLabel("Base ref", { exact: true }).fill("refs/remotes/origin/main");
  await factory.getByLabel("Worktree path (optional)", { exact: true }).fill(worktree);
  await factory.getByLabel("Review IDs (optional)", { exact: true }).fill(factoryReviewId);
  await factory.getByRole("button", { name: "Read branch evidence", exact: true }).click();
}
