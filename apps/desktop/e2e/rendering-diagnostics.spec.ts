import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedThreadSubAgents } from "./fixtures/sub-agent-state-seeding";
import { tolerateTransientRpcFailure } from "./fixtures/transient-rpc-poll";
import type { RenderingCaptureResult } from "../src/shared/rendering-diagnostics";

test("pending spinners keep moving onscreen and pause outside visible panes", async () => {
  test.setTimeout(90_000);
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    // Bundle the production ref and its shared observer into this otherwise
    // inert probe. The stylesheet comes from the built app; no copied loop or
    // visibility implementation can make the regression pass by itself.
    const bundle = await build({
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        lib: {
          entry: path.resolve(import.meta.dirname, "../src/renderer/src/lib/pending-spinner.ts"),
          name: "pendingSpinnerProbe",
          formats: ["iife"],
        },
      },
    });
    const output = (Array.isArray(bundle) ? bundle[0]! : bundle) as { output: { type: string; code?: string }[] };
    const script = output.output.find((chunk) => chunk.type === "chunk")!.code!;
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().waitFor();
    // CSSOM serialization drops the variable border shorthand after the
    // border-top-color override. Read the built stylesheet bytes so the probe
    // retains the actual visible ring, rather than an invisible transform.
    const stylesheets = await app.window.evaluate(() => [...document.styleSheets]
      .map((sheet) => sheet.href).filter((href): href is string => href !== null));
    const sources = await Promise.all(stylesheets.map((href) => readFile(new URL(href), "utf8")));
    const selectors = /^\.pending-spinner(?:--(?:sm|lg)|\[data-spinner-visible=(?:"false"|false)\])?$/;
    const css = sources.flatMap((source) => [
      ...[...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((match) => selectors.test(match[1]!.trim())).map((match) => match[0]),
      ...source.match(/@keyframes\s+pending-spinner-spin\s*\{(?:[^{}]*\{[^{}]*\})+\s*\}/g) ?? [],
    ]).join("\n");
    expect(css).toContain("pending-spinner-spin");
    expect(css).toContain("border:");
    const created = app.electronApp.waitForEvent("window");
    const pid = await app.electronApp.evaluate(async ({ BrowserWindow }, css) => {
      const probe = new BrowserWindow({ width: 640, height: 480, webPreferences: { contextIsolation: true, sandbox: true } });
      await probe.loadURL("data:text/html," + encodeURIComponent(`<!doctype html><style>
        :root { --border-subtle: gray; --accent: orange; } ${css}
        .pending-spinner { display:inline-block; }
        #pane { width:200px;height:100px;overflow:auto; }
        #rings { padding-top:20px; }
        </style><div id="pane"><div id="rings">${'<span class="pending-spinner"></span>'.repeat(6)}</div></div>`));
      return probe.webContents.getOSProcessId();
    }, css);
    const page = await created;
    await page.waitForLoadState("domcontentloaded");
    await app.electronApp.evaluate(({ BrowserWindow }, pid) => {
      const probe = BrowserWindow.getAllWindows().find((window) => window.webContents.getOSProcessId() === pid)!;
      probe.show();
      probe.focus();
      probe.moveTop();
    }, pid);
    await page.bringToFront();
    const rings = page.locator(".pending-spinner");
    await expect(rings.first()).toBeVisible();
    const capture = async () => {
      const result = await app.window.evaluate(() => (window as unknown as { pwragent: {
        captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
      } }).pwragent.captureRenderingDiagnostics(3));
      const summary = JSON.parse(await readFile(result.summaryPath, "utf8")) as {
        bufferUsage: { percentage: number };
        trace: { pid: number; events: { name: string; count: number }[] }[];
      };
      expect(summary.bufferUsage.percentage).toBeLessThan(0.9);
      const events = summary.trace.filter((process) => process.pid === pid).flatMap((process) => process.events);
      const rate = (name: string) => events.filter((event) => event.name === name)
        .reduce((sum, event) => sum + event.count, 0) / 3;
      return { drawFrames: rate("DrawFrame"), beginFrames: rate("BeginFrame") };
    };
    const measurements: Record<string, Awaited<ReturnType<typeof capture>>> = {};
    const setScene = async (scene: "onscreen" | "offscreen" | "clipped" | "scrolled" | "hidden") => {
      await page.evaluate((scene) => {
        const pane = document.getElementById("pane")!;
        pane.style.cssText = scene === "offscreen" ? "translate:0 -10000px" : scene === "hidden" ? "display:none" : "";
        document.getElementById("rings")!.style.paddingTop = scene === "clipped" || scene === "scrolled" ? "1000px" : "20px";
        pane.scrollTop = scene === "scrolled" ? 1000 : 0;
      }, scene);
    };
    // Same six rings and three-second captures, first with explicit overrides
    // for a paused baseline and the former always-running behavior.
    for (const scene of ["onscreen", "offscreen", "clipped", "hidden"] as const) {
      await setScene(scene);
      for (const state of ["paused", "running"] as const) {
        await page.evaluate((state) => document.querySelectorAll<HTMLElement>(".pending-spinner")
          .forEach((element) => { element.style.animationPlayState = state; }), state);
        measurements[`${scene}-${state}`] = await capture();
      }
    }
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const probe = (window as unknown as { pendingSpinnerProbe: {
        pendingSpinnerRef: (element: HTMLSpanElement) => () => void;
      } }).pendingSpinnerProbe;
      document.querySelectorAll<HTMLSpanElement>(".pending-spinner").forEach((element) => {
        element.style.animationPlayState = "";
        probe.pendingSpinnerRef(element);
      });
    });
    for (const scene of ["onscreen", "offscreen", "clipped", "scrolled", "hidden", "onscreen"] as const) {
      await setScene(scene);
      const visible = scene === "onscreen" || scene === "scrolled";
      await expect.poll(() => rings.evaluateAll((elements, visible) => elements.every((element) =>
        (element as HTMLElement).dataset.spinnerVisible === String(visible)), visible)).toBe(true);
      measurements[`${scene}-observed`] = await capture();
    }
    console.log(JSON.stringify({ pendingSpinnerFramesPerSecond: measurements }));
    const baseline = measurements["offscreen-paused"]!;
    expect(measurements["onscreen-running"]!.drawFrames).toBeGreaterThan(30);
    expect(measurements["onscreen-observed"]!.drawFrames).toBeGreaterThan(30);
    expect(measurements["scrolled-observed"]!.drawFrames).toBeGreaterThan(30);
    for (const scene of ["offscreen", "clipped"]) {
      expect(measurements[`${scene}-running`]!.beginFrames).toBeGreaterThan(30);
      expect(measurements[`${scene}-running`]!.beginFrames)
        .toBeGreaterThan(measurements[`${scene}-observed`]!.beginFrames * 4);
    }
    for (const scene of ["offscreen", "clipped", "hidden"]) {
      expect(measurements[`${scene}-observed`]!.beginFrames).toBeLessThanOrEqual(baseline.beginFrames + 3);
      expect(measurements[`${scene}-observed`]!.drawFrames).toBeLessThanOrEqual(1);
    }
  } finally {
    await app.close();
  }
});

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

test("rendering trace host stays out of the Window menu during capture", async () => {
  test.skip(process.platform === "darwin", "macOS owns its native shown-window menu");
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    const mainId = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
    const capture = app.window.evaluate(() => (window as unknown as { pwragent: {
      captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
    } }).pwragent.captureRenderingDiagnostics(30));
    void capture.catch(() => {});
    const hosts = tolerateTransientRpcFailure(() => app.electronApp.evaluate(({ BrowserWindow }, mainId) =>
      BrowserWindow.getAllWindows().filter((window) => window.id !== mainId).length, mainId));
    await expect.poll(hosts.read).toBe(1).catch(hosts.rethrowWithLastFailure);
    const menu = await app.electronApp.evaluate(({ BrowserWindow, Menu }, mainId) => {
      const main = BrowserWindow.fromId(mainId)!;
      const host = BrowserWindow.getAllWindows().find((window) => window.id !== mainId)!;
      host.setTitle("Diagnostic fixture host");
      // Exercise the production focus handler that rebuilds the menu.
      main.emit("focus");
      const rows = Menu.getApplicationMenu()!.items.find((item) => item.label === "Window")!
        .submenu!.items.filter((item) => !item.role && item.type !== "separator");
      rows.forEach((item) => item.click(item, main, {} as Electron.KeyboardEvent));
      return { labels: rows.map((item) => item.label), mainTitle: main.getTitle(), hostVisible: host.isVisible() };
    }, mainId);
    expect(menu.labels).toEqual([menu.mainTitle]);
    expect(menu.hostVisible).toBe(false);
    await app.window.evaluate(() => (window as unknown as { pwragent: {
      stopRenderingDiagnostics: () => Promise<RenderingCaptureResult>;
    } }).pwragent.stopRenderingDiagnostics());
    await capture;
  } finally {
    await app.close();
  }
});

test("HotCpuProfiler co-records through rendering capture on independent debugger attachments", async () => {
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

test("rendering capture preserves existing DevTools and unknown debugger attachments", async () => {
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
    await expect(capture()).resolves.toHaveProperty("summaryPath");
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
    await expect(capture()).resolves.toHaveProperty("summaryPath");
    expect(await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())).toBe(true);
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

test("status dots dip from one shared timer and leave offscreen dots still", async () => {
  // Five captures, 25 seconds of tracing in all.
  test.setTimeout(90_000);
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/smoke/replay.fixture.json"),
  });
  try {
    // Running sub-agents mount real `.status-dot--blink` rows in the main
    // window, the surface a live capture found with six offscreen loops.
    const now = Date.now();
    seedThreadSubAgents({
      stateDbPath: stateDbPathForHomeRoot(app.homeRoot),
      subAgents: Array.from({ length: 6 }, (_, index) => ({
        monitorId: `pulse-${index}`,
        task: `Contrived running task ${index}`,
        status: "running" as const,
        createdAt: now - 60_000 - index,
        updatedAt: now - 60_000 - index,
        backend: "codex",
        monitorThreadId: `pulse-thread-${index}`,
        monitorTurnId: `pulse-turn-${index}`,
      })),
      threadId: "thread-smoke",
    });
    await app.window.reload();
    await app.window.emulateMedia({ reducedMotion: "no-preference" });
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    const strip = app.window.getByRole("button", { name: /^Active sub-agents, 6$/ });
    await strip.click();
    await expect(strip).toHaveAttribute("aria-expanded", "true");
    const dots = app.window.locator(".live-strip__list .status-dot--blink");
    await expect(dots).toHaveCount(6);
    await app.window.evaluate(() => {
      // Keep only the dots moving. The strip header's thinking scanner has its
      // own loop, and the composer caret blinks on its own timer.
      const style = document.createElement("style");
      style.textContent = ".thinking-scanner { display: none !important; }";
      document.head.append(style);
      (document.activeElement as HTMLElement | null)?.blur();
    });
    const pid = await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId());

    type Summary = {
      bufferUsage: { percentage: number };
      samples: { state: { windows: { pid: number; renderer: {
        animations: { state: [string, string, string, boolean, boolean] }[];
      } | null }[] } }[];
      trace: { pid: number; events: { name: string; count: number }[] }[];
    };
    const capture = async (seconds: number) => {
      const result = await app.window.evaluate((seconds) => (window as unknown as { pwragent: {
        captureRenderingDiagnostics: (seconds: number) => Promise<RenderingCaptureResult>;
      } }).pwragent.captureRenderingDiagnostics(seconds), seconds);
      const summary = JSON.parse(await readFile(result.summaryPath, "utf8")) as Summary;
      expect(summary.bufferUsage.percentage).toBeLessThan(0.9);
      const events = summary.trace.filter((process) => process.pid === pid).flatMap((process) => process.events);
      const perSecond = (name: string) => Math.round(events.filter((event) => event.name === name)
        .reduce((total, event) => total + event.count, 0) / seconds * 10) / 10;
      const animations = summary.samples.flatMap((sample) => sample.state.windows)
        .filter((window) => window.pid === pid)
        .flatMap((window) => window.renderer?.animations ?? [])
        .map((group) => group.state);
      return {
        drawFrames: perSecond("DrawFrame"),
        beginFrames: perSecond("BeginFrame"),
        paints: perSecond("Paint"),
        animations,
      };
    };

    // Baseline: the preference holds every dot at rest.
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    const still = await capture(5);
    expect(still.animations.filter(([, , playState, infinite]) => infinite && playState === "running")).toEqual([]);

    // Two full 4.5s periods, so the capture holds two dips whatever its phase.
    await app.window.emulateMedia({ reducedMotion: "no-preference" });
    const pulses = await capture(9);
    expect(pulses.animations).toContainEqual(["status-blink", ".status-dot", "running", false, true]);
    expect(pulses.animations.some(([, , , infinite]) => infinite)).toBe(false);

    // The former rule, restored in the same window.
    await app.window.evaluate(() => {
      const style = document.createElement("style");
      style.id = "former-blink";
      style.textContent = `@keyframes former-status-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        .status-dot--blink { animation: former-status-blink 1.6s ease-in-out infinite; }`;
      document.head.append(style);
    });
    const formerLoop = await capture(3);

    // Every dot offscreen, as in a scrolled-away row or rail card.
    await app.window.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = ".live-strip__list .status-dot--blink { translate: 0 -10000px; }";
      document.head.append(style);
    });
    await expect.poll(() => dots.evaluateAll((elements) =>
      elements.every((element) => element.getBoundingClientRect().bottom < 0))).toBe(true);
    const formerOffscreen = await capture(3);
    await app.window.evaluate(() => document.getElementById("former-blink")!.remove());
    const pulsesOffscreen = await capture(5);

    console.log(JSON.stringify({ statusPulseFramesPerSecond: {
      still, pulses, formerLoop, formerOffscreen, pulsesOffscreen,
    } }, (key, value) => key === "animations" ? undefined : value));

    // The dips draw, and the compositor sleeps between them.
    expect(pulses.drawFrames).toBeGreaterThan(still.drawFrames + 5);
    expect(formerLoop.beginFrames).toBeGreaterThan(pulses.beginFrames * 1.6);
    // Offscreen, the former loop drew nothing and still woke every refresh;
    // the shared timer starts no animation there at all.
    expect(formerOffscreen.beginFrames).toBeGreaterThan(30);
    expect(formerOffscreen.beginFrames).toBeGreaterThan(pulsesOffscreen.beginFrames * 4);
    expect(pulsesOffscreen.beginFrames).toBeLessThanOrEqual(still.beginFrames + 3);
    expect(pulsesOffscreen.animations.some(([name]) => name === "status-blink")).toBe(false);
  } finally {
    await app.close();
  }
});
