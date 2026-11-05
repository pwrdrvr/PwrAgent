import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Captures the model pickers this change touched (the `/review` card, the
 * automation editor, Settings → Helper model) with a catalog that mixes
 * current and superseded Codex models, plus one Codex model provider's
 * model, for before/after screenshots. Nothing is asserted about the list itself: the
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

type Box = { x: number; y: number; width: number; height: number };

/**
 * Screenshot only the surface being shown: the union of the given elements'
 * boxes, padded, so a menu is seen beside the control that opened it.
 */
async function captureRegion(page: Page, file: string, anchors: Locator[]): Promise<void> {
  const boxes: Box[] = [];
  for (const anchor of anchors) {
    const box = await anchor.boundingBox();
    if (box) boxes.push(box);
  }
  if (boxes.length === 0) throw new Error(`Nothing to capture for ${file}.`);
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const pad = 16;
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - pad);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - pad);
  const right = Math.min(viewport.width, Math.max(...boxes.map((box) => box.x + box.width)) + pad);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((box) => box.y + box.height)) + pad);
  await page.mouse.move(-10, -10);
  await page.screenshot({
    path: test.info().outputPath(file),
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}

/** Run one surface's capture; a surface that cannot be reached is noted, not fatal. */
async function surface(
  page: Page,
  failures: string[],
  name: string,
  run: () => Promise<void>,
  cleanup?: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    await page.screenshot({
      path: test.info().outputPath(`failed-${name.replace(/\W+/g, "-")}.png`),
    }).catch(() => undefined);
  } finally {
    await cleanup?.().catch(() => undefined);
  }
}

test("captures the model pickers this change touched", async () => {
  test.setTimeout(180_000);
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

  const failures: string[] = [];
  const app = await launchElectronApp({ fixturePath });
  const page = app.window;
  try {
    // The replay has no answer for every startup call; its notice is noise here.
    const dismissNotices = async () => {
      const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
      for (const button of await dismiss.all()) await button.click().catch(() => undefined);
    };

    await surface(page, failures, "review card", async () => {
      await page.getByRole("button", { name: /Review command flow/i }).first().click();
      const reply = page.getByRole("textbox", { name: "Reply", exact: true });
      await reply.fill("/review");
      await page.getByRole("button", { name: "Send" }).click();
      const reviewCard = page.getByRole("group", { name: "Review target" });
      await expect(reviewCard).toBeVisible();
      await dismissNotices();
      await reviewCard.getByRole("button", { name: /^Review model(?::|$)/ }).click();
      const list = page.getByRole("listbox", { name: /^Review model/ }).first();
      await expect(list).toBeVisible();
      await captureRegion(page, "review-card.png", [reviewCard, list]);

      const other = list.getByRole("option", { name: /^Other/ });
      if (await other.count()) {
        await other.click();
        const otherList = page.getByRole("listbox", { name: /: Other/ });
        await expect(otherList).toBeVisible();
        await captureRegion(page, "review-card-other.png", [reviewCard, list, otherList]);
      }
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });

    await surface(page, failures, "automation editor", async () => {
      await page.getByRole("button", { name: "Open automations" }).first().click();
      await page.getByRole("button", { name: /New Automation/ }).click();
      await expect(page.getByText("New automation", { exact: true })).toBeVisible();
      await dismissNotices();
      // Model, access and tools sit under the collapsed Advanced settings row.
      await page.getByText(/^Advanced settings/).click();
      const provider = page.getByRole("button", { name: /^Automation model provider/ });
      await provider.scrollIntoViewIfNeeded();
      await provider.click();
      await page.getByRole("option", { name: /OpenAI|Codex/ }).first().click();
      const chip = page.getByRole("button", { name: /^Automation model(?::|$)/ });
      await chip.click();
      const list = page.getByRole("listbox", { name: /^Automation model(?! provider)/ }).first();
      await expect(list).toBeVisible();
      await captureRegion(page, "automation-model.png", [provider, chip, list]);
    }, async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /Exit Automations/ }).click({ timeout: 5_000 });
    });

    await surface(page, failures, "settings helper model", async () => {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "AI Providers", exact: true })
        .click();
      await expect(page.getByRole("region", { name: "Model settings" })).toBeVisible();
      await dismissNotices();
      const field = page.getByRole("combobox", { name: "Helper model" });
      await field.scrollIntoViewIfNeeded();
      await field.click();
      const list = page.getByRole("listbox").last();
      await expect(list).toBeVisible();
      const section = field.locator("xpath=ancestor::section[1]");
      await captureRegion(
        page,
        "settings-helper-model.png",
        [(await section.count()) ? section : field, list],
      );
      await page.keyboard.press("Escape");
    });
  } finally {
    await writeFile(test.info().outputPath("failures.txt"), failures.join("\n") || "none", "utf8");
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
