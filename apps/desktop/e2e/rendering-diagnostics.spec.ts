import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import type { RenderingCaptureResult } from "../src/shared/rendering-diagnostics";

test("rendering capture distinguishes static pixels from a compositor animation", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    // A separate, wholly contrived surface in this fixture process. No React,
    // polling or rAF loop can explain its compositor frames.
    const windowCreated = app.electronApp.waitForEvent("window");
    const probePid = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({ width: 640, height: 480, webPreferences: { contextIsolation: true, sandbox: true } });
      await window.loadURL("data:text/html," + encodeURIComponent(`<!doctype html>
        <style>@keyframes pending-spinner-spin { to { transform: rotate(360deg); } }
        .pending-spinner { width:80px;height:80px;border:8px solid gray;border-top-color:orange;
          animation:pending-spinner-spin 0.8s linear infinite;animation-play-state:paused; }</style>
        <div class="pending-spinner">fixture</div>`));
      return window.webContents.getOSProcessId();
    });
    const page = await windowCreated;
    await page.waitForLoadState("domcontentloaded");
    const capture = () => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: {
        captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
      } }).pwragent;
      return api.captureRenderingDiagnostics(2);
    });
    const idle = JSON.parse(await readFile((await capture()).summaryPath, "utf8"));
    await page.evaluate(() => { document.querySelector<HTMLElement>(".pending-spinner")!.style.animationPlayState = "running"; });
    const animated = JSON.parse(await readFile((await capture()).summaryPath, "utf8"));
    const animatedWindow = animated.samples[0].state.windows.find((window: { pid: number }) => window.pid === probePid);
    expect(animatedWindow.renderer.animations[0].state).toEqual([
      "pending-spinner-spin", ".pending-spinner", "running", true, true,
    ]);
    const frames = (summary: typeof idle) => summary.trace
      .filter((process: { pid: number }) => process.pid === animatedWindow.pid)
      .flatMap((process: { events: { name: string; count: number }[] }) => process.events)
      .filter((event: { name: string }) => event.name === "DrawFrame")
      .reduce((total: number, event: { count: number }) => total + event.count, 0);
    expect(frames(animated)).toBeGreaterThan(frames(idle) + 10);
    expect(JSON.stringify(animated)).not.toContain("data:text/html");
    expect(JSON.stringify(animated)).not.toContain("fixture</div>");
    console.log(JSON.stringify({ renderingCapture: { idleDrawFrames: frames(idle), animatedDrawFrames: frames(animated) } }));
  } finally {
    await app.close();
  }
});
