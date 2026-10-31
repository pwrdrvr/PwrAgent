import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { tolerateTransientRpcFailure } from "./fixtures/transient-rpc-poll";
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

test("rendering acquisition preserves an external Electron contentTracing owner", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    await app.electronApp.evaluate(async ({ contentTracing }) => {
      await contentTracing.startRecording({
        recording_mode: "record-until-full", trace_buffer_size_in_kb: 8192,
        included_categories: ["toplevel"], excluded_categories: ["*"], enable_argument_filter: true,
      });
    });
    await expect(app.window.evaluate(() => (window as unknown as { pwragent: {
      captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
    } }).pwragent.captureRenderingDiagnostics(1))).rejects.toThrow("Rendering capture failed");
    // Only the original owner stops this trace. The previous implementation
    // resolved the overlapping start, then stopped this recording itself.
    const rawPath = path.join(app.homeRoot, "contrived-external-trace.json");
    const stopped = await app.electronApp.evaluate(({ contentTracing }, file) => contentTracing.stopRecording(file), rawPath);
    expect(stopped).toBe(rawPath);
    expect((await readFile(rawPath)).byteLength).toBeGreaterThan(0);
    // A failed acquisition must release its lease so a later request can run.
    const result = await app.window.evaluate(() => (window as unknown as { pwragent: {
      captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
    } }).pwragent.captureRenderingDiagnostics(1));
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).reason).toBe("duration");
  } finally {
    await app.close();
  }
});

test("HotCpuProfiler co-records through rendering capture on one debugger attachment", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
    env: {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "0",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "250",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "0.01",
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "2000",
      PWRAGENT_HOT_CPU_PROFILING_COOLDOWN_MS: "1",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "10",
    },
  });
  try {
    await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: {
        onHotCpuProfileCaptured: (callback: (event: { target?: string; profilePath: string }) => void) => () => void;
        writeSettingsConfig: (request: { patch: { general: { hotCpuProfilingEnabled: boolean } } }) => Promise<unknown>;
      } }).pwragent;
      (window as unknown as { rendererProfile: Promise<string> }).rendererProfile = new Promise((resolve) => {
        const unsubscribe = api.onHotCpuProfileCaptured((event) => {
          if (event.target !== "renderer") return;
          unsubscribe();
          resolve(event.profilePath);
        });
      });
      // Entirely contrived activity. The normal profiler owns start/stop and
      // artifact publication; the regression never sends Profiler commands.
      setInterval(() => {
        const until = performance.now() + 8;
        while (performance.now() < until) Math.sqrt(performance.now());
      }, 25);
      await api.writeSettingsConfig({ patch: { general: { hotCpuProfilingEnabled: true } } });
    });
    const debuggerAttached = tolerateTransientRpcFailure(() =>
      app.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.debugger.isAttached()));
    await expect.poll(debuggerAttached.read).toBe(true)
      .catch(debuggerAttached.rethrowWithLastFailure);
    const result = await app.window.evaluate(() => (window as unknown as { pwragent: {
      captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
    } }).pwragent.captureRenderingDiagnostics(1));
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).trace.length).toBeGreaterThan(0);
    expect(await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.debugger.isAttached())).toBe(true);
    const profilePath = await app.window.evaluate(() => (window as unknown as { rendererProfile: Promise<string> }).rendererProfile);
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    expect(profile.samples.length).toBeGreaterThan(0);
    console.log(JSON.stringify({ coRecording: { profileSamples: profile.samples.length } }));
  } finally {
    await app.close();
  }
});

test("rendering capture refuses existing DevTools and unknown debugger attachments", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  const capture = () => app.window.evaluate(() => (window as unknown as { pwragent: {
    captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
  } }).pwragent.captureRenderingDiagnostics(1));
  try {
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.debugger.attach("1.3");
    });
    await expect(capture()).rejects.toThrow("Rendering capture failed");
    const intact = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const debuggerApi = BrowserWindow.getAllWindows()[0].webContents.debugger;
      const result = await debuggerApi.sendCommand("Runtime.evaluate", { expression: "40 + 2" });
      debuggerApi.detach();
      return result.result.value;
    });
    expect(intact).toBe(42);
    await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const opened = new Promise<void>((resolve) => contents.once("devtools-opened", () => resolve()));
      contents.openDevTools({ mode: "detach", activate: false });
      await opened;
    });
    await expect(capture()).rejects.toThrow("Rendering capture failed");
    expect(await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())).toBe(true);
  } finally {
    await app.close();
  }
});
