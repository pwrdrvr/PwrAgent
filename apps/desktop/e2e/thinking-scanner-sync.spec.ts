import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp, threadRowCard } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("keeps restarted thinking scanners on the shared epoch", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/approval-pending/replay.fixture.json"),
  });

  try {
    await app.window.emulateMedia({ reducedMotion: "no-preference" });
    await app.window.getByRole("button", { name: /Approval pending replay/i }).first().click();
    await app.window.getByLabel("Reply").fill("Scanner synchronization fixture");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });

    const row = threadRowCard(app.window, /Approval pending replay/i);
    const beam = row.locator(".thinking-scanner__beam");
    const beams = app.window.locator(".thinking-scanner__beam");
    await expect(beam).toBeVisible();
    const mountedBeam = await beam.elementHandle();
    expect(mountedBeam).not.toBeNull();
    await expect.poll(() => beams.count()).toBeGreaterThan(1);
    const sharedEpochs = Array<number>(await beams.count()).fill(0);
    const readEpochs = () => beams.evaluateAll((elements) => elements.flatMap(
      (element) => element.getAnimations().map((animation) => animation.startTime),
    ));
    await expect.poll(readEpochs).toEqual(sharedEpochs);

    // Use the DOM move React uses for keyed row reorders. The beam, component,
    // and mount-time ref survive, but Chromium replaces the CSS animation.
    const restarted = await beam.evaluate(async (element) => {
      const original = element.getAnimations()[0];
      const rowShell = element.closest(".thread-row-shell")!;
      const parent = rowShell.parentElement!;
      parent.appendChild(rowShell);
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
      return {
        sameBeam: rowShell.querySelector(".thinking-scanner__beam") === element,
        newAnimation: element.getAnimations()[0] !== original,
      };
    });
    expect(restarted).toEqual({ sameBeam: true, newAnimation: true });
    await expect.poll(readEpochs).toEqual(sharedEpochs);

    // The sidebar stays mounted when hidden. Showing it recreates animations
    // too, and must not require a lens flip to repair their phase.
    const sidebar = app.window.locator(".sidebar");
    await sidebar.evaluate((element) => { element.style.display = "none"; });
    // The row locator contains a visible-button role filter, so it no longer
    // resolves while the sidebar is hidden. Retain the mounted node instead.
    await expect.poll(() => mountedBeam!.evaluate((element) => ({
      connected: element.isConnected,
      animationCount: element.getAnimations().length,
    }))).toEqual({ connected: true, animationCount: 0 });
    await sidebar.evaluate((element) => { element.style.removeProperty("display"); });
    await expect(beam).toBeVisible();
    await expect.poll(readEpochs).toEqual(sharedEpochs);

    await app.window.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(readEpochs).toEqual([]);
    await app.window.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(readEpochs).toEqual(sharedEpochs);
  } finally {
    await app.close();
  }
});
