import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { openStarMapWindow } from "./fixtures/star-map-window";

test("pauses map load demand for a visible background window and a hidden window", async () => {
  const app = await launchElectronApp({ fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/star-map/replay.fixture.json") });
  try {
    // Count only the map's explicit load requests, separately from navigation
    // and federation heartbeats. Values and threads are wholly contrived.
    await app.electronApp.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { mapLoadReads: number };
      state.mapLoadReads = 0;
      ipcMain.removeHandler("federation:read-instance-load");
      ipcMain.handle("federation:read-instance-load", () => {
        state.mapLoadReads++;
        return { load: { loadAvg1: 1, loadAvg5: 1, loadAvg15: 1, availableMemoryBytes: 100, sampledAt: Date.now() } };
      });
    });
    const map = await openStarMapWindow(app);
    const cdp = await map.context().newCDPSession(map);
    // Playwright emulates a focused page by default; this regression needs
    // the real native window focus signal.
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await map.clock.install();
    const load = map.getByRole("button", { name: /^Show load for/ }).first();
    await expect(load).toBeVisible();
    await load.click();
    const count = () => app.electronApp.evaluate(() => (globalThis as typeof globalThis & { mapLoadReads: number }).mapLoadReads);
    await expect.poll(count).toBe(1);
    const cards = await map.locator(".star-map-card").count();
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("#star-map"))!;
      main.show();
      main.focus();
    });
    await expect.poll(() => map.evaluate(() => document.hasFocus())).toBe(false);
    expect(await map.evaluate(() => document.visibilityState)).toBe("visible");
    await map.clock.fastForward(120_000);
    expect(await count()).toBe(1);
    expect(await map.locator(".star-map-card").count()).toBe(cards);
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("#star-map"))!.hide();
    });
    // Electron can keep document.visibilityState visible when background
    // throttling is disabled; assert the OS window state directly.
    await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("#star-map"))!.isVisible())).toBe(false);
    expect(await map.evaluate(() => document.hasFocus())).toBe(false);
    await map.clock.fastForward(60_000);
    expect(await count()).toBe(1);
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const mapWindow = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("#star-map"))!;
      mapWindow.show();
      mapWindow.focus();
    });
    await expect.poll(() => map.evaluate(() => document.hasFocus())).toBe(true);
    await expect.poll(count).toBe(2);
    expect(await map.locator(".star-map-card").count()).toBe(cards);
  } finally {
    await app.close();
  }
});
