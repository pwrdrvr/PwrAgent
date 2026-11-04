import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Captures the `/review` card's model menu with a catalog that mixes current
 * and superseded Codex models, plus one Codex model provider's model, for
 * before/after screenshots. Nothing is asserted about the list itself: the
 * same spec runs against the code before and after a change.
 *
 *   PWRAGENT_MODEL_PICKER_CAPTURE=1 playwright test \
 *     -c playwright.inspect.config.ts e2e/model-picker-screenshots.inspect.spec.ts
 *
 * PNGs land in this test's output directory under test-results/.
 */
const specDir = path.dirname(fileURLToPath(import.meta.url));

const CATALOG = [
  "GPT-6-Astra",
  "GPT-6.1-Sol",
  "GPT-6-Sol",
  "GPT-6.1-Terra",
  "GPT-6-Luna",
  "GPT-5.6-Sol",
  "GPT-5.6-Terra",
  "GPT-5.6-Luna",
].map((label) => ({
  id: label.toLowerCase(),
  label,
  supportsReasoning: true,
  reasoningEfforts: ["low", "medium", "high"],
  ...(label === "GPT-6.1-Sol" ? { current: true } : {}),
}));

const PROVIDER_MODEL = {
  id: "@bonsai/ternary-bonsai-27b",
  label: "Ternary-Bonsai-27B",
  providerId: "bonsai",
  providerLabel: "PrismML Bonsai (local)",
  supportsReasoning: false,
};

test.skip(
  process.env.PWRAGENT_MODEL_PICKER_CAPTURE !== "1",
  "Set PWRAGENT_MODEL_PICKER_CAPTURE=1 to capture model picker screenshots.",
);

test("captures the review card's model menu", async () => {
  const testInfo = test.info();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-model-picker-"));
  const fixturePath = path.join(rootDir, "replay.fixture.json");
  const fixture = JSON.parse(await readFile(
    path.resolve(specDir, "fixtures/review-command-flow/replay.fixture.json"),
    "utf8",
  ));
  fixture.metadata.models = [...CATALOG, PROVIDER_MODEL];
  // Reviewer overrides need a backend that can start a review thread.
  const initialize = fixture.steps.find((step: { id: string }) => step.id === "initialize-1");
  initialize.result.methods = [...new Set([...initialize.result.methods, "thread/start"])];
  await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Review command flow/i }).first().click();
    const reply = app.window.getByRole("textbox", { name: "Reply", exact: true });
    await reply.fill("/review");
    await app.window.getByRole("button", { name: "Send" }).click();

    const reviewTarget = app.window.getByRole("group", { name: "Review target" });
    await expect(reviewTarget).toBeVisible();
    // The replay has no answer for every startup call; its notice is noise here.
    const dismiss = app.window.getByRole("button", { name: "Dismiss", exact: true });
    for (const button of await dismiss.all()) await button.click();
    await reviewTarget.getByRole("button", { name: /^Review model(?::|$)/ }).click();
    const list = app.window.getByRole("listbox", { name: /^Review model/ }).first();
    await expect(list).toBeVisible();
    await app.window.mouse.move(-10, -10);
    await app.window.screenshot({ path: testInfo.outputPath("review-model-menu.png") });

    const other = list.getByRole("option", { name: /^Other/ });
    if (await other.count()) {
      await other.click();
      await expect(app.window.getByRole("listbox", { name: /: Other/ })).toBeVisible();
      await app.window.mouse.move(-10, -10);
      await app.window.screenshot({ path: testInfo.outputPath("review-model-menu-other.png") });
    }
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
