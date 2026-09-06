import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { ReadFederationActivityResponse } from "@pwragent/shared";
import { FederationActivityLedger } from "../src/main/federation/federation-activity-ledger";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
function activityFixture(): ReadFederationActivityResponse {
  const now = Date.UTC(2026, 8, 5, 12);
  const ledger = new FederationActivityLedger(now - 3_600_000);
  for (let index = 0; index < 360; index += 1) {
    for (const direction of ["sent", "received"] as const) {
      ledger.record({
        at: now - 3_590_000 + index * 10_000,
        peerId: "pwr_fixture_gateway", localInstanceId: "pwr_fixture_local", direction,
        dataByteCount: (direction === "sent" ? 8_000 : 4_000) + Math.round(Math.abs(Math.sin(index / 3)) * 12_000),
        byteCount: (direction === "sent" ? 3_000 : 1_000) + Math.round(Math.abs(Math.sin(index / 3)) * 6_000),
        envelope: { kind: direction === "sent" ? "request" : "response",
          sourceInstanceId: direction === "sent" ? "pwr_fixture_local" : "pwr_fixture_remote",
          targetInstanceId: direction === "sent" ? "pwr_fixture_remote" : "pwr_fixture_local" },
      });
    }
  }
  return {
    activity: ledger.snapshot(now), configuredMode: "dual", running: true,
    health: { enabled: true, role: "dual", status: "connected", peers: [] },
  };
}

for (const theme of ["dark", "light"] as const) {
  test(`Federation hover activity and detachable window (${theme})`, async ({}, testInfo) => {
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
      appearance: { theme },
    });
    try {
      // Contrived numeric fixture only; the real native window, preload and UI are exercised.
      await app.electronApp.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler("federation:read-activity");
        ipcMain.handle("federation:read-activity", () => snapshot);
      }, activityFixture());
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      const trigger = app.window.getByRole("button", { name: "Open Star Map", exact: true });
      await expect(trigger).toBeVisible();
      expect(await trigger.evaluate((button) => {
        const control = button.getBoundingClientRect();
        const wrapper = button.parentElement!.getBoundingClientRect();
        return {
          width: wrapper.width - control.width,
          height: wrapper.height - control.height,
          left: wrapper.left - control.left,
          top: wrapper.top - control.top,
        };
      })).toEqual({ width: 0, height: 0, left: 0, top: 0 });
      await trigger.hover();
      const panel = app.window.getByRole("dialog", { name: "Federation activity", exact: true });
      await expect(panel.getByText("Running · connected")).toBeVisible();
      const popoverAudit = await new AxeBuilder({ page: app.window })
        .setLegacyMode(true)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(popoverAudit.violations).toEqual([]);
      await panel.screenshot({ path: testInfo.outputPath(`federation-popover-${theme}.png`) });
      const opened = app.electronApp.waitForEvent("window", {
        predicate: (page) => page !== app.window,
      });
      await panel.getByRole("button", { name: "Open Federation Activity", exact: true }).click();
      const activity = await opened;
      await activity.emulateMedia({ reducedMotion: "reduce" });
      await expect(activity.getByText("Running · connected")).toBeVisible();
      await expect(activity.getByRole("switch", { name: "Federation enabled" })).toHaveClass(/settings-switch/);
      await expect(activity.getByRole("img", { name: /Data and wire rates/ })).toBeVisible();
      const topmost = activity.getByRole("checkbox", { name: "Always on top", exact: true });
      await topmost.click();
      await expect(topmost).toBeChecked();
      await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Federation Activity")?.isAlwaysOnTop(),
      )).toBe(true);
      await topmost.click();
      await expect(topmost).not.toBeChecked();
      await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Federation Activity")?.isAlwaysOnTop(),
      )).toBe(false);
      const audit = await new AxeBuilder({ page: activity })
        .setLegacyMode(true)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(audit.violations).toEqual([]);
      await activity.screenshot({ path: testInfo.outputPath(`federation-activity-${theme}.png`) });
      const titlebar = activity.locator(".activity-titlebar");
      const titlebarBeforeScroll = await titlebar.boundingBox();
      const totals = activity.locator(".federation-activity__tables").first();
      await expect(totals.getByRole("columnheader", { name: "Last 10m", exact: true })).toHaveCount(2);
      await totals.scrollIntoViewIfNeeded();
      await activity.screenshot({ path: testInfo.outputPath(`federation-totals-${theme}.png`) });
      const sizes = activity.getByRole("table", { name: "Lifetime request/response sizes · uncompressed", exact: true });
      await sizes.scrollIntoViewIfNeeded();
      await expect(titlebar).toBeVisible();
      expect(await titlebar.boundingBox()).toEqual(titlebarBeforeScroll);
      expect(await activity.locator(".activity-content").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await activity.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0);
      await expect(sizes.getByRole("columnheader", { name: "p50 ≈", exact: true })).toBeVisible();
      await activity.screenshot({ path: testInfo.outputPath(`federation-sizes-${theme}.png`) });
      await activity.getByRole("button", { name: "Copy Federation activity" }).click();
      await expect(activity.getByRole("status")).toHaveText("Federation activity copied");
      const copied = await app.electronApp.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).toContain("Last 1m\tLast 10m\tLast 1h\tTotal");
      expect(copied).toContain("Samples\tAvg\tp50 (approx.)\tMin\tMax");
      // Reset still crosses the real preload/IPC bridge, with contrived returned totals.
      await app.electronApp.evaluate(({ ipcMain }, activity) => {
        ipcMain.removeHandler("federation:reset-activity");
        const cleared = {
          activity, configuredMode: "dual", running: true,
          health: { enabled: true, role: "dual", status: "connected", peers: [] },
        };
        ipcMain.handle("federation:reset-activity", () => {
          ipcMain.removeHandler("federation:read-activity");
          ipcMain.handle("federation:read-activity", () => cleared);
          return cleared;
        });
      }, new FederationActivityLedger().snapshot());
      await activity.getByRole("button", { name: "Reset", exact: true }).click();
      await sizes.scrollIntoViewIfNeeded();
      await expect(sizes.getByRole("row", { name: "Sent requests 0 — — — —", exact: true })).toBeVisible();
      await activity.close();
      await expect(trigger).toBeVisible();
    } finally { await app.close(); }
  });
}
