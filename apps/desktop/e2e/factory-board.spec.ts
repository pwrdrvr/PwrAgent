import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { SqliteThreadReviewStorage } from "@pwragent/sqlite-storage/thread-review-storage-sqlite";
import { factoryWorkItemKey, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { StateDb } from "../src/main/state/state-db";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test } from "./fixtures/electron-test";
import { seedProfileOverlayState } from "./fixtures/overlay-state-seeding";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const git = promisify(execFile);
const fixturePath = fileURLToPath(new URL("./fixtures/smoke/replay.fixture.json", import.meta.url));
const issue = "10000000-0000-4000-a000-000000000042";
const branch = "fix/keyboard-focus";
const reviewId = "aster-keyboard-review";
const repositoryName = "Aster-Factory-Fixture";
const repositoryOwner = "northwind-labs";
const captureDir = process.env.PWRAGENT_FACTORY_CAPTURE_DIR;
const before = process.env.PWRAGENT_FACTORY_CAPTURE_BASELINE === "1";

for (const theme of (captureDir ? ["dark", "light"] : ["dark"]) as ("dark" | "light")[]) {
  test(`opens Factory from the profile menu and follows owner evidence (${theme})`, async () => {
    let worktree = "";
    let head = "";
    let base = "";
    let mergeBase = "";
    const app = await launchElectronApp({
      fixturePath,
      appearance: { theme },
      contextRailPinned: false,
      preLaunchHook: async (homeRoot) => {
        const root = await realpath(homeRoot);
        const repository = path.join(root, "aster");
        worktree = path.join(root, "aster-keyboard-focus");
        await mkdir(repository);
        const run = async (args: string[], cwd = repository) => (await git("git", args, {
          cwd,
          env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z" },
        })).stdout.trim();
        const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "--no-gpg-sign", "-m"];
        await run(["init", "--template=", "-b", "main"]);
        await run([...commit, "Aster base"]);
        mergeBase = await run(["rev-parse", "HEAD"]);
        await run(["remote", "add", "origin", `https://github.com/${repositoryOwner}/${repositoryName}.git`]);
        await run(["worktree", "add", "-b", branch, worktree]);
        await run([...commit, "Keep focus on the selected row"], worktree);
        head = await run(["rev-parse", "HEAD"], worktree);
        await run([...commit, "Advance the target after review"]);
        base = await run(["rev-parse", "HEAD"]);
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
            backend: "codex", threadId: "thread-smoke", id: reviewId, origin: "automatic",
            sourceKey: "message-2", title: "Aster keyboard review", status: "handled",
            items: [], createdAt: 1, updatedAt: 1,
            context: { workspacePath: worktree, repositoryPath: repository, gitBranch: branch, headCommit: head, baseCommit: mergeBase },
          });
        } finally {
          db.close();
        }
      },
    });

    try {
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
      await factory.getByLabel("Repository name", { exact: true }).fill(repositoryName);
      await factory.getByText("Read a local branch", { exact: true }).click();
      await factory.getByRole("combobox", { name: "Tracking record", exact: true }).click();
      await factory.getByRole("option", { name: "Linear issue", exact: true }).click();
      await factory.getByLabel("Linear issue ID", { exact: true }).fill(issue);
      await factory.getByLabel("Branch", { exact: true }).fill(branch);
      await factory.getByLabel("Base ref", { exact: true }).fill("refs/remotes/origin/main");
      await factory.getByLabel("Worktree path (optional)", { exact: true }).fill(worktree);
      await factory.getByLabel("Review IDs (optional)", { exact: true }).fill(reviewId);
      await factory.getByRole("button", { name: "Read branch evidence", exact: true }).click();

      const queue = factory.getByRole("region", { name: "Outcomes", exact: true });
      const row = queue.getByRole("button", { name: /^fix\/keyboard-focus\b/ });
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-row-key", `linear:${issue}`);
      await expect(factory.getByText(`Aster · ${before ? "pwrdrvr" : repositoryOwner}/${repositoryName}`, { exact: true })).toBeVisible();
      const suffix = `${theme}-${before ? "before" : "after"}.png`;
      if (captureDir) {
        await mkdir(captureDir, { recursive: true });
        await factory.locator(".factory-window").screenshot({ path: path.join(captureDir, `board-${suffix}`) });
      }

      await row.focus();
      await row.press("Enter");
      const drawer = factory.getByRole("complementary");
      await expect(drawer.getByRole("heading", { name: branch, exact: true })).toBeFocused();
      await expect(drawer.getByText(head, { exact: true })).toBeVisible();
      await expect(drawer.getByText(base, { exact: true })).toBeVisible();
      await expect(drawer.getByText(reviewId, { exact: true })).toBeVisible();
      await expect(drawer.getByText(issue, { exact: true })).toBeVisible();
      if (!before) {
        await expect(drawer.getByText("Reviewed merge base", { exact: true })).toHaveCount(0);
        await expect(drawer.getByRole("listitem").filter({ hasText: reviewId })).toContainText("Inconclusive");
      }
      const axe = await new AxeBuilder({ page: factory }).setLegacyMode(true)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations).toEqual([]);
      if (captureDir) await factory.locator(".factory-window").screenshot({ path: path.join(captureDir, `drawer-${suffix}`) });

      await app.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("#factory"))?.setSize(440, 660);
      });
      await expect(queue).toBeHidden();
      expect(await factory.locator(".factory-window").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(440);
      await factory.keyboard.press("Escape");
      await expect(row).toBeFocused();
      await row.press("Enter");
      await drawer.getByRole("button", { name: "Open review thread", exact: true }).click();
      await expect(app.window.getByRole("heading", { name: "Replay smoke thread", exact: true })).toBeVisible();
      await expect(app.window.getByText("The replay harness is live.", { exact: true }).last()).toBeVisible();

      await app.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("#factory"))?.setSize(1100, 800);
      });
      await factory.keyboard.press("Escape");
      const scope = factory.getByText("Project and evidence source", { exact: true });
      const branchForm = factory.getByText("Read a local branch", { exact: true });
      const alternateRecords: Array<{ label: string; item: FactoryWorkItem; filename: string }> = [
        { label: "GitHub issue", item: { provider: "github", kind: "issue", repositoryId: "R_aster_fixture", number: 42 }, filename: "github-issue" },
        { label: "GitHub pull request", item: { provider: "github", kind: "pull_request", repositoryId: "R_aster_fixture", number: 42 }, filename: "github-pr" },
        { label: "Jira issue", item: { provider: "jira", siteId: "aster-cloud", id: "10042" }, filename: "jira-issue" },
      ];
      for (const { label, item, filename } of alternateRecords) {
        if (!await scope.evaluate((summary) => summary.closest("details")?.open)) await scope.click();
        if (!await branchForm.evaluate((summary) => summary.closest("details")?.open)) await branchForm.click();
        await factory.getByRole("combobox", { name: "Tracking record", exact: true }).click();
        await factory.getByRole("option", { name: label, exact: true }).click();
        if (item.provider === "github") {
          await factory.getByLabel("GitHub repository ID", { exact: true }).fill(item.repositoryId);
          await factory.getByLabel(item.kind === "issue" ? "Issue number" : "Pull request number", { exact: true }).fill(String(item.number));
        } else if (item.provider === "jira") {
          await factory.getByLabel("Jira site ID", { exact: true }).fill(item.siteId);
          await factory.getByLabel("Jira issue ID", { exact: true }).fill(item.id);
        }
        if (captureDir) await factory.locator(".factory-window").screenshot({ path: path.join(captureDir, `form-${filename}-${theme}.png`) });
        await factory.getByRole("button", { name: "Read branch evidence", exact: true }).click();
        await expect(row).toHaveAttribute("data-row-key", factoryWorkItemKey(item));
        await row.click();
        await expect(drawer.getByText(/Operator selected/)).toContainText(label);
        await expect(drawer.getByText("Owner review", { exact: false })).toBeVisible();
        if (captureDir) await factory.locator(".factory-window").screenshot({ path: path.join(captureDir, `drawer-${filename}-${theme}.png`) });
        await factory.keyboard.press("Escape");
      }
    } finally {
      await app.close();
    }
  });
}
