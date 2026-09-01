import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("hydrates provider-scoped pricing totals in the context rail", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/thread-pricing-panel/replay.fixture.json",
    ),
    windowSize: {
      width: 1280,
      height: 820,
    },
    preLaunchHook: (homeRoot) => {
      applyDesktopSettingsPatch(
        path.join(homeRoot, ".pwragent/profiles/default/config.toml"),
        {
          experimental: {
            threadPricingSummary: true,
          },
        },
      );
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Pricing ledger thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Pricing ledger thread",
      }),
    ).toBeVisible();

    const contextRail = app.window.getByRole("complementary", {
      name: "Thread context",
    });
    await contextRail.getByRole("tab", { name: "Pricing" }).click();

    await expect(
      contextRail.getByRole("heading", { level: 3, name: "Pricing" }),
    ).toBeVisible();
    await expect(contextRail.getByText("$0.018", { exact: true })).toBeVisible();
    await expect(contextRail.getByText("Pricing summary")).toBeVisible();
    await expect(contextRail.getByText("3 rows")).toBeVisible();
    await expect(
      contextRail.getByText(/2 priced · 1 unpriced ·/),
    ).toBeVisible();
    await expect(
      contextRail.getByText("1 usage row could not be priced."),
    ).toBeVisible();

    // Spend by model replaced the per-provider cards that used to reprint the
    // summary's own by-provider breakdown directly underneath it.
    await expect(contextRail.getByText("Spend by model")).toBeVisible();
    await expect(contextRail.getByText("openai · USD")).toHaveCount(0);

    // Only OpenAI ran more than one model here, so it is the one provider
    // whose subtotal is not already a row of its own.
    const spendGroupHead = contextRail.locator(".pricing-spend-group__head");
    await expect(spendGroupHead).toHaveCount(1);
    await expect(spendGroupHead).toContainText("OpenAI");
    await expect(spendGroupHead).toContainText("$0.017 · 2 rows");
    await expect(contextRail.locator(".pricing-spend-row__label")).toHaveText([
      "gpt-5.5",
      "Unknown model",
      "grok-4.5",
    ]);
    // A bucket nothing could price says so; "$0.000" is what a model that
    // genuinely cost nothing would read as.
    const unpricedSpendRow = contextRail.locator(".pricing-spend-row", {
      hasText: "Unknown model",
    });
    await expect(
      unpricedSpendRow.locator(".pricing-spend-row__cost"),
    ).toHaveText("Unpriced");

    // Rows arrive collapsed whenever the thread spent on more than one model,
    // and expanding one shows that model's own token volume — the reviewer's
    // here, which the old parent-only fold never displayed at all.
    const grokSpendRow = contextRail.locator(".pricing-spend-row", {
      hasText: "grok-4.5",
    });
    await expect(grokSpendRow.locator(".pricing-spend-row__meta")).toHaveText(
      "xAI · 1 row",
    );
    await expect(grokSpendRow.locator(".pricing-spend-row__cost")).toHaveText(
      "$0.002",
    );
    await expect(grokSpendRow.getByText("Uncached input")).toHaveCount(0);
    await grokSpendRow.getByRole("button").click();
    await expect(grokSpendRow.getByText("Uncached input")).toBeVisible();
    await expect(grokSpendRow.getByText("400", { exact: true })).toBeVisible();

    // The usage cards still name every model, so each of these now resolves
    // against a spend row too and has to be scoped to the card list.
    const usageRows = contextRail.locator(".pricing-usage-row");
    await expect(usageRows.getByText("gpt-5.5 · high")).toBeVisible();
    await expect(
      contextRail.getByText("$0.017 list price this turn"),
    ).toBeVisible();
    await expect(usageRows.getByText("Unknown model")).toBeVisible();
    await expect(usageRows.getByText("grok-4.5")).toBeVisible();
  } finally {
    await app.close();
  }
});
