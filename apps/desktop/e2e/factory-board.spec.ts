import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { factoryWorkItemKey, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test } from "./fixtures/electron-test";
import {
  factoryBranch as branch, factoryIssue as issue, factoryRepositoryName, factoryRepositoryOwner as repositoryOwner,
  factoryReviewId as reviewId, fillFactoryBranch, openFactoryBoard, seedFactoryBoard,
} from "./fixtures/factory-board";

const fixturePath = fileURLToPath(new URL("./fixtures/smoke/replay.fixture.json", import.meta.url));
const captureDir = process.env.PWRAGENT_FACTORY_CAPTURE_DIR;
const before = process.env.PWRAGENT_FACTORY_CAPTURE_BASELINE === "1";

for (const theme of (captureDir ? ["dark", "light"] : ["dark"]) as ("dark" | "light")[]) {
  test(`opens Factory from the profile menu and follows owner evidence (${theme})`, async () => {
    let seed: Awaited<ReturnType<typeof seedFactoryBoard>>;
    const app = await launchElectronApp({
      fixturePath,
      appearance: { theme },
      contextRailPinned: false,
      env: { PWRAGENT_GH_ENABLED: "false", PWRAGENT_GLAB_ENABLED: "false" },
      preLaunchHook: async (homeRoot) => { seed = await seedFactoryBoard(homeRoot); },
    });

    try {
      const { worktree, head, base } = seed!;
      const factory = await openFactoryBoard(app);
      if (!before) {
        const refresh = factory.getByRole("button", { name: "Refresh projects", exact: true });
        await refresh.click();
        await expect(refresh).toBeEnabled();
      }
      await factory.getByText("Read a local branch", { exact: true }).click();
      await factory.getByRole("combobox", { name: "Tracking record", exact: true }).click();
      await factory.getByRole("option", { name: "Linear issue", exact: true }).click();
      await factory.getByLabel("Linear issue ID", { exact: true }).fill(issue);
      await fillFactoryBranch(factory, worktree);

      const queue = factory.getByRole("region", { name: "Outcomes", exact: true });
      const row = queue.getByRole("button", { name: /^fix\/keyboard-focus\b/ });
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-row-key", `linear:${issue}`);
      await expect(factory.getByText(`Aster · ${before ? "pwrdrvr" : repositoryOwner}/${factoryRepositoryName}`, { exact: true })).toBeVisible();
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
        await expect(drawer.getByText("Local branch observed", { exact: false }).locator("time")).toHaveAttribute("datetime", /T/);
      }
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
        if (!before && item.provider === "github" && item.kind === "pull_request") {
          await expect(drawer.getByRole("button", { name: "Compare tracked PR #42", exact: true })).toBeVisible();
        }
        if (captureDir) await factory.locator(".factory-window").screenshot({ path: path.join(captureDir, `drawer-${filename}-${theme}.png`) });
        await factory.keyboard.press("Escape");
      }
    } finally {
      await app.close();
    }
  });
}
