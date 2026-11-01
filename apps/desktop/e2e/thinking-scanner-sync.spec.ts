import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp, threadRowCard } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const SCAN_ID = "pwragent-thinking-scanner-scan";

test("scans every visible thinking beam together and holds them still between scans", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/approval-pending/replay.fixture.json"),
  });

  try {
    await app.window.emulateMedia({ reducedMotion: "no-preference" });
    await app.window.getByRole("button", { name: /Approval pending replay/i }).first().click();
    await app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("Scanner synchronization fixture");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });

    const row = threadRowCard(app.window, /Approval pending replay/i);
    await expect(row.locator(".thinking-scanner__beam")).toBeVisible();
    const beams = app.window.locator(".thinking-scanner__beam");
    await expect.poll(() => beams.count()).toBeGreaterThan(1);

    // One scan per period, started for every on-screen beam in one task, so
    // they share a start time and move in the same frames.
    const readScan = () => beams.evaluateAll((elements) => {
      const onScreen = elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight;
      });
      const animations = onScreen.flatMap((element) => element.getAnimations());
      return {
        onScreen: onScreen.length,
        scanning: animations.filter((animation) => animation.id === "pwragent-thinking-scanner-scan").length,
        others: animations.length - animations.filter((animation) => animation.id === "pwragent-thinking-scanner-scan").length,
        startTimes: [...new Set(animations.map((animation) => animation.startTime))],
      };
    });
    await expect.poll(async () => {
      const scan = await readScan();
      return scan.scanning > 0 && scan.startTimes.every((time) => time !== null) ? scan : null;
    }, { timeout: 10_000, intervals: [50] }).toMatchObject({ others: 0, startTimes: [expect.any(Number)] });
    const scan = await readScan();
    expect(scan.scanning).toBe(scan.onScreen);

    // Finite: once the scan ends nothing is left running, and the beam rests on
    // the held pose, centred.
    await expect.poll(async () => (await readScan()).scanning, { timeout: 5_000 }).toBe(0);
    const pose = await row.locator(".thinking-scanner__beam").evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      opacity: getComputedStyle(element).opacity,
      travel: getComputedStyle(element).getPropertyValue("--thinking-scanner-travel").trim(),
    }));
    expect(pose.opacity).toBe("1");
    expect(pose.transform).toBe(`matrix(1, 0, 0, 1, ${Number.parseFloat(pose.travel) / 2}, 0)`);

    // Under reduced motion no scan starts at all, across a full period.
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    const scansWhileReduced = await app.window.evaluate(async (id) => {
      // The media change event lands at the next rendering update, which is
      // also when a scan already moving is cancelled. Sample after it.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let seen = 0;
      const until = performance.now() + 5_000;
      while (performance.now() < until) {
        seen += document.getAnimations().filter((animation) => animation.id === id).length;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return seen;
    }, SCAN_ID);
    expect(scansWhileReduced).toBe(0);
  } finally {
    await app.close();
  }
});
