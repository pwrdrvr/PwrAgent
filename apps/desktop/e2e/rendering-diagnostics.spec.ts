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

test("production thinking scanners submit fewer frames than a refresh-rate sweep", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    // Read the built app's rules, so this comparison exercises the shipped CSS.
    const css = await app.window.evaluate(() => {
      const tokens = getComputedStyle(document.documentElement);
      const colors = ["--accent", "--accent-bright", "--accent-bg-medium"]
        .map((name) => `${name}:${tokens.getPropertyValue(name)};`).join("");
      const rules = [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .filter((rule) => rule instanceof CSSStyleRule
          ? [".thinking-scanner", ".thinking-scanner--mini", ".thinking-scanner__beam",
            ".thinking-scanner--mini .thinking-scanner__beam"].includes(rule.selectorText)
          : rule instanceof CSSKeyframesRule && rule.name === "pwragent-thinking-scanner-sweep")
        .map((rule) => rule.cssText).join("\n");
      return `:root { ${colors} }\n${rules}`;
    });
    expect(css).toContain("pwragent-thinking-scanner-sweep");
    const probePid = await app.electronApp.evaluate(async ({ BrowserWindow }, css) => {
      const window = new BrowserWindow({ width: 640, height: 480, webPreferences: { contextIsolation: true, sandbox: true } });
      await window.loadURL("data:text/html," + encodeURIComponent(`<!doctype html>
        <style>${css}</style>
        <div class="thinking-scanner thinking-scanner--mini"><div class="thinking-scanner__beam"></div></div>
        <div class="thinking-scanner"><div class="thinking-scanner__beam"></div></div>`));
      await window.webContents.executeJavaScript(`document.querySelectorAll('.thinking-scanner__beam')
        .forEach(element => element.getAnimations().forEach(animation => { animation.startTime = 0; }))`);
      return window.webContents.getOSProcessId();
    }, css);
    const captureFrames = async () => {
      const result = await app.window.evaluate(() => (window as unknown as { pwragent: {
        captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
      } }).pwragent.captureRenderingDiagnostics(2));
      const summary = JSON.parse(await readFile(result.summaryPath, "utf8")) as {
        bufferUsage: { percentage: number };
        trace: { pid: number; events: { name: string; count: number }[] }[];
      };
      expect(summary.bufferUsage.percentage).toBeLessThan(0.9);
      return summary.trace.filter((process) => process.pid === probePid)
        .flatMap((process) => process.events)
        .filter((event) => event.name === "DrawFrame")
        .reduce((total, event) => total + event.count, 0);
    };
    const stepped = await captureFrames();
    await app.electronApp.evaluate(async ({ BrowserWindow }, pid) => {
      const probe = BrowserWindow.getAllWindows().find((window) => window.webContents.getOSProcessId() === pid)!;
      await probe.webContents.executeJavaScript(`document.querySelectorAll('.thinking-scanner__beam')
        .forEach(element => { element.style.animationTimingFunction = 'ease-in-out'; })`);
    }, probePid);
    const continuous = await captureFrames();
    expect(stepped).toBeGreaterThan(20);
    expect(continuous).toBeGreaterThan(stepped * 1.5);
    console.log(JSON.stringify({ scannerFrames: { stepped, continuous } }));
  } finally {
    await app.close();
  }
});

test("production usage warning settles without sustaining compositor frames", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    const css = await app.window.evaluate(() => {
      const tokens = getComputedStyle(document.documentElement);
      const colors = ["--accent", "--accent-bright", "--accent-bg-medium", "--status-warning", "--bg-panel"]
        .map((name) => `${name}:${tokens.getPropertyValue(name)};`).join("");
      const selectors = new Set([
        ".thinking-scanner", ".thinking-scanner--mini", ".thinking-scanner__beam",
        ".thinking-scanner--mini .thinking-scanner__beam", ".usage-pace-card__hit",
        ".usage-pace-card__hit::after",
      ]);
      const collect = (rules: CSSRuleList): string => [...rules].flatMap((rule): string[] => {
        if (rule instanceof CSSStyleRule) {
          return rule.selectorText.split(",").some((selector) => selectors.has(selector.trim())) ? [rule.cssText] : [];
        }
        if (rule instanceof CSSKeyframesRule) {
          return ["pwragent-thinking-scanner-sweep", "usage-pace-ping"].includes(rule.name) ? [rule.cssText] : [];
        }
        if (rule instanceof CSSMediaRule) {
          const nested = collect(rule.cssRules);
          return nested ? [`@media ${rule.conditionText} { ${nested} }`] : [];
        }
        return [];
      }).join("\n");
      return `:root { ${colors} }\n${[...document.styleSheets].map((sheet) => collect(sheet.cssRules)).join("\n")}`;
    });
    const windowCreated = app.electronApp.waitForEvent("window");
    const probePid = await app.electronApp.evaluate(async ({ BrowserWindow }, css) => {
      const window = new BrowserWindow({ width: 640, height: 480, webPreferences: { contextIsolation: true, sandbox: true } });
      await window.loadURL("data:text/html," + encodeURIComponent(`<!doctype html>
        <style>${css}
          body { padding:40px;background:var(--bg-panel); }
          .usage-pace-card__hit { left:120px;top:100px; }
        </style>
        <style id="former-loop">.usage-pace-card__hit::after { animation-iteration-count:infinite; }</style>
        <div class="thinking-scanner"><div class="thinking-scanner__beam"></div></div>
        <span class="usage-pace-card__hit"></span><span>100% fixture warning</span>`));
      return window.webContents.getOSProcessId();
    }, css);
    const page = await windowCreated;
    await page.waitForLoadState("domcontentloaded");
    const setScannersRunning = (running: boolean) => page.evaluate((running) => {
      document.querySelectorAll<HTMLElement>(".thinking-scanner__beam").forEach((element) => {
        element.style.animationPlayState = running ? "running" : "paused";
        element.getAnimations().forEach((animation) => { if (running) animation.startTime = 0; });
      });
    }, running);
    const captureFrames = async () => {
      const result = await app.window.evaluate(() => (window as unknown as { pwragent: {
        captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
      } }).pwragent.captureRenderingDiagnostics(2));
      const summary = JSON.parse(await readFile(result.summaryPath, "utf8")) as {
        bufferUsage: { percentage: number };
        trace: { pid: number; events: { name: string; count: number }[] }[];
      };
      expect(summary.bufferUsage.percentage).toBeLessThan(0.9);
      return {
        drawFrames: summary.trace.filter((process) => process.pid === probePid)
          .flatMap((process) => process.events)
          .filter((event) => event.name === "DrawFrame")
          .reduce((total, event) => total + event.count, 0),
        bufferPercentage: summary.bufferUsage.percentage,
      };
    };
    await setScannersRunning(true);
    const formerWithScanners = await captureFrames();
    await setScannersRunning(false);
    const formerPingOnly = await captureFrames();
    await page.evaluate(() => {
      document.getAnimations().forEach((animation) => animation.pause());
    });
    const allPaused = await captureFrames();

    // Removing the former infinite override starts the production finite ping.
    // Wait on that animation's completion rather than a guessed paint delay.
    const ping = await page.evaluate(async () => {
      const element = document.querySelector<HTMLElement>(".usage-pace-card__hit")!;
      const override = document.querySelector("#former-loop")!;
      override.textContent = ".usage-pace-card__hit::after { animation:none; }";
      // Flush cancellation so the production rule creates a fresh animation.
      if (getComputedStyle(element, "::after").animationName !== "none") {
        throw new Error("The former usage warning animation did not cancel.");
      }
      override.remove();
      const animation = element.getAnimations({ subtree: true })
        .find((animation) => (animation as CSSAnimation).animationName === "usage-pace-ping")!;
      animation.play();
      const iterations = animation.effect!.getTiming().iterations;
      await animation.finished;
      return { iterations, playState: animation.playState, markerOpacity: getComputedStyle(element).opacity };
    });
    expect(ping).toEqual({ iterations: 2, playState: "finished", markerOpacity: "1" });
    await expect(page.locator(".usage-pace-card__hit")).toBeVisible();
    await expect(page.getByText("100% fixture warning")).toBeVisible();
    const settledPingOnly = await captureFrames();
    await setScannersRunning(true);
    const settledWithScanners = await captureFrames();
    expect(allPaused.drawFrames).toBeLessThanOrEqual(2);
    expect(settledPingOnly.drawFrames).toBeLessThanOrEqual(2);
    expect(settledWithScanners.drawFrames).toBeGreaterThan(20);
    expect(formerWithScanners.drawFrames).toBeGreaterThan(settledWithScanners.drawFrames * 1.5);
    expect(formerPingOnly.drawFrames).toBeGreaterThan(50);

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => document.getAnimations()
      .some((animation) => (animation as CSSAnimation).animationName === "usage-pace-ping"))).toBe(false);
    console.log(JSON.stringify({ usageWarningFrames: {
      formerWithScanners, formerPingOnly, allPaused, settledPingOnly, settledWithScanners,
    } }));
  } finally {
    await app.close();
  }
});
