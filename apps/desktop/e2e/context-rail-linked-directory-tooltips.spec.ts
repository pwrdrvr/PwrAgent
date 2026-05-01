import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("shows linked directory path tooltips in the context rail", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/context-rail-linked-directory-tooltips/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /Linked directory tooltip thread/i })
      .first()
      .click();
    await app.window.getByRole("button", { name: "Open context rail" }).click();
    const contextRail = app.window.getByRole("complementary", {
      name: "Thread context",
    });

    await contextRail.getByLabel("Path for PwrAgnt", { exact: true }).focus();
    await expectVisibleTooltip(app.window, "/repo/PwrAgnt");

    await contextRail
      .getByRole("button", { name: "Copy path for PwrAgnt", exact: true })
      .focus();
    await expectVisibleTooltip(
      app.window,
      "/repo/PwrAgnt\nClick to copy to clipboard"
    );

    await contextRail.getByLabel("Path for worktree PwrAgnt", { exact: true }).focus();
    await expectVisibleTooltip(
      app.window,
      "/repo/PwrAgnt/.worktrees/feature-context-tooltips"
    );

    await contextRail
      .getByRole("button", { name: "Copy path for worktree PwrAgnt", exact: true })
      .focus();
    await expectVisibleTooltip(
      app.window,
      "/repo/PwrAgnt/.worktrees/feature-context-tooltips\nClick to copy to clipboard"
    );

    await contextRail.getByLabel("Path for local LocalCheckout", { exact: true }).focus();
    await expectVisibleTooltip(app.window, "/repo/PwrAgnt");

    await contextRail
      .getByRole("button", { name: "Copy path for local LocalCheckout", exact: true })
      .focus();
    await expectVisibleTooltip(
      app.window,
      "/repo/PwrAgnt\nClick to copy to clipboard"
    );
  } finally {
    await app.close();
  }
});

async function expectVisibleTooltip(page: Page, text: string) {
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(text);
  await expect
    .poll(async () =>
      await tooltip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          inBody: element.parentElement === document.body,
          hasSize: rect.height > 0 && rect.width > 0,
          visibility: getComputedStyle(element).visibility,
        };
      })
    )
    .toMatchObject({
      hasSize: true,
      inBody: true,
      visibility: "visible",
    });
}
