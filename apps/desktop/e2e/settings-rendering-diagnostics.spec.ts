import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

test("Settings offers a staged rendering capture without Developer Mode", async () => {
  const testInfo = test.info();
  const app = await launchElectronApp({
    // Hand-authored showcase data, never an operator's profile or transcript.
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/readme-recents-hero/replay.fixture.json"),
  });
  try {
    const page = app.window;
    const openTroubleshooting = async () => {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "Settings sections" });
      await nav.getByRole("button", { name: "Troubleshooting", exact: true }).click();
      return nav;
    };
    let nav = await openTroubleshooting();
    const pane = page.getByRole("region", { name: "Troubleshooting settings", exact: true });
    const developerMode = pane.getByRole("switch", { name: "Developer Mode", exact: true });
    // Development builds default this on; exercise access with it explicitly off.
    if (await developerMode.getAttribute("aria-checked") === "true") {
      await developerMode.click();
    }
    await expect(developerMode).not.toBeChecked();
    const start = pane.getByRole("button", { name: "Capture Rendering (10s)", exact: true });
    await expect(start).toBeEnabled();
    await start.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("rendering-diagnostics-ready.png") });

    await start.click();
    await expect(pane.getByRole("button", { name: "Cancel Rendering Capture", exact: true })).toBeVisible();
    await expect(start).toBeDisabled();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await expect(nav).toBeHidden();
    // This notice arrives only after the real 5s staging + 10s native capture
    // finishes, without reopening Settings or DevTools during the sample.
    await expect(page.getByText("Rendering summary saved", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Dismiss notice", exact: true }).click();
    nav = await openTroubleshooting();
    const copy = pane.getByRole("button", { name: "Copy rendering summary path", exact: true });
    await expect(copy).toBeVisible();
    const summaryPath = await copy.locator("..").locator("code").innerText();
    expect(summaryPath).toMatch(/[/\\]state[/\\]diagnostics[/\\]rendering-[^/\\]+[/\\]summary\.json$/);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(summary.samples.length).toBeGreaterThan(0);
    expect(summary.samples.length).toBeLessThanOrEqual(11);
    await expect(start).toBeEnabled();
    await copy.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("rendering-diagnostics-complete.png") });
  } finally {
    await app.close();
  }
});

test("Troubleshooting persists the Chromium trace opt-in independently of Start Capture", async () => {
  const info = test.info();
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/readme-recents-hero/replay.fixture.json"),
    env: {
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "250",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "100",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "1",
      PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "1",
    },
  });
  try {
    const page = app.window;
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await nav.getByRole("button", { name: "Troubleshooting", exact: true }).click();
    const pane = page.getByRole("region", { name: "Troubleshooting settings", exact: true });
    const toggle = pane.getByRole("switch", { name: "Chromium trace", exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("hot-cpu-chromium-trace-off.png") });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(pane.getByText("Not armed", { exact: true })).toBeVisible();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await nav.getByRole("button", { name: "Troubleshooting", exact: true }).click();
    await expect(toggle).toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("hot-cpu-chromium-trace.png") });

    const rules = pane.getByRole("group", { name: "Capture rules", exact: true });
    await rules.getByRole("radio", { name: "Spike", exact: true }).click();
    await expect(rules.getByRole("radio", { name: "Spike", exact: true })).toBeChecked();
    const slowburn = rules.getByRole("checkbox", { name: "Slow burn", exact: true });
    await slowburn.click();
    await expect(slowburn).toBeChecked();
    // Exercise the shared interval fallback alongside the live main-process
    // sampler, debugger, trace publication and capture notice.
    await app.electronApp.evaluate(({ app: electronApp, BrowserWindow }) => {
      const rendererPid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
      const readMetrics = electronApp.getAppMetrics.bind(electronApp);
      electronApp.getAppMetrics = () => readMetrics().map((metric) => metric.pid === rendererPid
        ? {
          ...metric,
          cpu: {
            percentCPUUsage: 95,
            idleWakeupsPerSecond: 0,
          },
        }
        : metric);
    });
    await pane.getByRole("button", { name: "Start Capture (Immediate)", exact: true }).click();
    const rendererNotice = page.getByText("Renderer CPU profile captured", { exact: true });
    const nextNotice = page.getByRole("navigation", { name: "Durable notices", exact: true })
      .getByRole("button", { name: "Next notice", exact: true })
      .and(page.locator(":enabled"));
    // The main process can also match a rule and occupy the first notice.
    // Wait for the renderer notice or the carousel that makes it reachable.
    await expect(rendererNotice.or(nextNotice).first()).toBeVisible();
    if (!await rendererNotice.isVisible()) await nextNotice.click();
    await expect(rendererNotice).toBeVisible();
    const diagnostics = path.join(path.dirname(stateDbPathForHomeRoot(app.homeRoot)), "diagnostics");
    const sessions = await Promise.all((await readdir(diagnostics)).filter((name) => name.startsWith("hot-cpu-"))
      .map(async (name) => ({
        name,
        manifest: JSON.parse(await readFile(path.join(diagnostics, name, "session.json"), "utf8")),
      })));
    const renderer = sessions.find(({ manifest }) => manifest.target === "renderer")!;
    const traceName = "renderer-hot-0001.trace.json";
    const events = (await readFile(path.join(diagnostics, renderer.name, "events.ndjson"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const written = events.filter((event) => event.type === "profile-written");
    expect(written).toHaveLength(1);
    expect(written[0].detail.matchedRules).toEqual([
      expect.objectContaining({ id: "spike", thresholdPercent: 50, durationMs: 100, sampleCount: 1, usedElectronInterval: true }),
      expect.objectContaining({ id: "slowburn", thresholdPercent: 15, durationMs: 100, sampleCount: 1, usedElectronInterval: true }),
    ]);
    expect(written[0].detail.triggerMode).toBe("spike");
    expect(renderer.manifest.artifacts, JSON.stringify(events))
      .toEqual(expect.arrayContaining(["renderer-hot-0001.cpuprofile", traceName]));
    const trace = JSON.parse(await readFile(path.join(diagnostics, renderer.name, traceName), "utf8"));
    expect(trace.traceEvents).toEqual(expect.any(Array));

    await pane.getByRole("button", { name: "Stop Capture", exact: true }).click();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  } finally {
    await app.close();
  }
});
