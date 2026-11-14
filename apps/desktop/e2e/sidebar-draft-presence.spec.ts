import path from "node:path";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

test("draft presence keeps lens membership, metadata and tooltip behavior", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(import.meta.dirname, "fixtures/readme-recents-hero/replay.fixture.json"),
  });
  try {
    const page = app.window;
    const title = "Migrate auth from JWT to session cookies";
    const rows = page.locator(".sidebar .thread-row-shell[data-thread-key]");
    await expect(rows).toHaveCount(6);
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    const otherMetadata = () => rows.filter({ hasNot: page.getByRole("button", { name: title, exact: true }) })
      .locator(".thread-row__chips").allTextContents();
    const before = await otherMetadata();

    await reply.fill("Contrived unsent reply");
    const draft = page.locator('.sidebar [data-thread-draft="unsent"]');
    await expect(draft).toHaveCount(1);
    await expect(draft).toHaveAttribute("aria-label", "Unsent draft");
    await draft.hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "This thread has composer text you have not sent." })).toBeVisible();
    await page.mouse.move(1100, 850);
    await expect.poll(otherMetadata).toEqual(before);

    await page.getByRole("tab", { name: "Created", exact: true }).click();
    await expect(rows).toHaveCount(6);
    await expect(draft).toHaveCount(1);
    await page.getByRole("tab", { name: /^Drafts,/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.getByRole("button", { name: title, exact: true })).toBeVisible();
    await reply.fill("Contrived unsent reply edited");
    await expect(draft).toHaveCount(1);
    await reply.fill("");
    await expect(draft).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Drafts, No threads with unsent drafts", exact: true })).toBeVisible();
    await expect(page.getByText("No unsent replies.", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Updated", exact: true }).click();
    await expect(rows).toHaveCount(6);
    await expect(reply).toBeEmpty();
    await expect.poll(otherMetadata).toEqual(before);
  } finally {
    await app.close();
  }
});
