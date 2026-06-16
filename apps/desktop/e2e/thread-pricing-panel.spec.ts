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
    await expect(contextRail.getByText("$0.020")).toBeVisible();
    await expect(contextRail.getByText("3 (2 priced, 1 unpriced)")).toBeVisible();
    await expect(
      contextRail.getByText("1 usage row could not be priced."),
    ).toBeVisible();
    await expect(contextRail.getByText("openai · USD")).toBeVisible();
    await expect(contextRail.getByText("$0.017 list price · 2 rows")).toBeVisible();
    await expect(contextRail.getByText("xai · USD")).toBeVisible();
    await expect(contextRail.getByText("$0.003 list price · 1 row")).toBeVisible();
    await expect(
      contextRail.getByText("gpt-5.5 · high · standard"),
    ).toBeVisible();
    await expect(contextRail.getByText("$0.017 list price this turn")).toBeVisible();
    await expect(contextRail.getByText("Unknown model")).toBeVisible();
    await expect(contextRail.getByText("grok-4.20-reasoning · standard")).toBeVisible();
  } finally {
    await app.close();
  }
});
