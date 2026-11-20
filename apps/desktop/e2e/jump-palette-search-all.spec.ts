import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const jumpChord = process.platform === "darwin" ? "Meta+K" : "Control+K";
const searchAllChord = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";

async function openJumpPalette(page: Page) {
  // The thread row is the proxy for "renderer has hydrated".
  await expect(
    page.getByRole("button", { name: /Replay smoke thread/i }).first(),
  ).toBeVisible();
  await page.keyboard.press(jumpChord);
  const dialog = page.getByRole("dialog", { name: "Jump to thread" });
  await expect(dialog.getByRole("textbox")).toBeFocused();
  return dialog;
}

/**
 * The palette tests stop at `onSearchAllThreads` and the search screen's tests
 * start at its store. This covers the App handler between them: the query has
 * to arrive in the search screen and the search has to run without a second
 * Enter.
 */
test("jump palette hands a query to the search screen and runs it", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });

  try {
    const searchField = app.window.getByRole("combobox", { name: "Search threads" });
    const searchView = app.window.locator(".thread-search");
    const resultCount = searchView.locator(".thread-search-results-meta__count");

    await test.step("no quick match: Enter runs the full search", async () => {
      const query = "zzqx no such thread";
      const dialog = await openJumpPalette(app.window);
      await dialog.getByRole("textbox").fill(query);
      await expect(
        dialog.getByRole("button", { name: `Search message content for “${query}”` }),
      ).toBeVisible();
      await app.window.keyboard.press("Enter");

      await expect(dialog).toBeHidden();
      await expect(searchField).toBeVisible();
      await expect(searchField).toHaveValue(query);
      await expect(searchField).toBeFocused();
      // The count line only renders once a response for this request arrived.
      await expect(resultCount).toBeVisible();
      await expect(searchView.getByText("Search your threads")).toHaveCount(0);

      await searchField.press("Escape");
      await expect(searchField).toBeHidden();
    });

    await test.step("quick match present: the chord still runs the full search", async () => {
      const query = "Replay smoke";
      const dialog = await openJumpPalette(app.window);
      await dialog.getByRole("textbox").fill(query);
      await expect(
        dialog.locator(".jump-palette__row-title").filter({
          hasText: "Replay smoke thread",
        }).first(),
      ).toBeVisible();
      await app.window.keyboard.press(searchAllChord);

      await expect(dialog).toBeHidden();
      await expect(searchField).toHaveValue(query);
      await expect(resultCount).toBeVisible();
      await expect(
        searchView.locator(".thread-search-result__title").filter({
          hasText: "Replay smoke thread",
        }),
      ).toBeVisible();
    });
  } finally {
    await app.close();
  }
});
