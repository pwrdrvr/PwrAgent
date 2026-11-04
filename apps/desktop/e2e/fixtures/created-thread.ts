import { expect, type Locator, type Page } from "@playwright/test";

/** Wait for the submitted launchpad to hand selection to its real thread. */
export async function waitForCreatedThreadTranscript(page: Page, title: string): Promise<Locator> {
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  return page.getByRole("region", { name: "Transcript", exact: true });
}
