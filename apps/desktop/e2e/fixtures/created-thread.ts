import { expect, type Locator, type Page } from "@playwright/test";

/** Wait for the submitted launchpad to hand selection to its real thread. */
export async function waitForCreatedThreadTranscript(page: Page, title: string): Promise<Locator> {
  const transcript = page.getByRole("region", { name: "Transcript", exact: true });
  // Submission still owns a Preparing transcript pane while startup runs.
  // Let the real thread take ownership before spending the heading assertion
  // budget on its asynchronously hydrated navigation title.
  await transcript.waitFor();
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  return transcript;
}
