import path from "node:path";
import type { Page } from "@playwright/test";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import { StateDb } from "../src/main/state/state-db";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test } from "./fixtures/electron-test";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const fixturePath = path.join(import.meta.dirname, "fixtures/thread-pricing-panel/replay.fixture.json");

async function openSpendSettings(window: Page) {
  await window.getByRole("button", { name: "Open settings", exact: true }).click();
  await window.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Usage & Pricing", exact: true }).click();
  return window.getByRole("switch", { name: "Total thread spend", exact: true });
}

test("only delivers a legacy pending thread spend warning after opt-in survives reopening", async () => {
  const first = await launchElectronApp({
    fixturePath,
    preLaunchHook: async (homeRoot) => {
      applyDesktopSettingsPatch(configTomlPathForHomeRoot(homeRoot), {
        general: { spendAlerts: { threadSpendThresholdUsd: 30 } },
      });
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const threadId = "thread-legacy-spend-warning";
        await new SqliteOverlayStore(db).setThreadSpendAlertPending({
          backend: "codex",
          threadId,
          alert: {
            alertId: `spend-alert:thread:codex:${threadId}`,
            createdAt: 1,
            currency: "USD",
            kind: "thread-spend",
            spendMicros: 31_000_000,
            threadId,
            thresholdMicros: 30_000_000,
          },
        });
      } finally {
        db.close();
      }
    },
  });
  let reopened: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const toggle = await openSpendSettings(first.window);
    const threshold = first.window.getByRole("spinbutton", { name: "Total thread spend threshold" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(threshold).toBeDisabled();
    expect(await first.window.evaluate(() => {
      const { pwragent } = window as typeof window & { pwragent: DesktopApi };
      return pwragent.listPendingThreadSpendAlerts!({});
    })).toEqual({ alerts: [], hasMore: false });
    await expect(first.window.getByText("Thread spend threshold reached", { exact: true })).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(threshold).toBeEnabled();
    await first.closeApplication();

    reopened = await launchElectronApp({ fixturePath, homeRoot: first.homeRoot });
    await expect(reopened.window.getByText("Thread spend threshold reached", { exact: true })).toBeVisible();
    await expect(reopened.window.getByText(/\$31\.00 in estimated list-price spend/)).toBeVisible();
    await expect(await openSpendSettings(reopened.window)).toHaveAttribute("aria-checked", "true");
    await expect(reopened.window.getByRole("spinbutton", { name: "Total thread spend threshold" })).toHaveValue("30");
  } finally {
    await reopened?.close();
    await first.close();
  }
});
