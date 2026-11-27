import { expect, type Page } from "@playwright/test";

/**
 * Opens the new-thread Where panel, which holds the project picker, the
 * workspace mode and base branch, and the machine. A no-op while it is open.
 */
export async function openLaunchpadWherePanel(page: Page): Promise<void> {
  const panel = page.getByRole("dialog", { name: "Where this thread runs" });
  if (await panel.isVisible()) return;
  await page.getByLabel("New thread settings").getByRole("button", { name: /^Where:/ }).click();
  await expect(panel).toBeVisible();
}
