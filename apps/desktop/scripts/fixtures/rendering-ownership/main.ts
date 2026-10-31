import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, contentTracing } from "electron";
import { captureRenderingDiagnostics, stopRenderingDiagnostics } from "../../../src/main/diagnostics/rendering-capture";

// A standalone Electron process: no PwrAgent startup, profiles, backends or IPC.
const root = process.env.PWRAGENT_RENDERING_FIXTURE_ROOT!;
app.setPath("userData", join(root, "user-data"));
const watchdog = setTimeout(() => { console.error("fixture deadline exceeded"); app.exit(1); }, 20_000);
async function main() {
  await app.whenReady();
  const external = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await external.loadURL("data:text/html,<p>invented rendering fixture</p>");
  if (process.env.PWRAGENT_RENDERING_EXTERNAL_KIND === "content") {
    try {
      await contentTracing.startRecording({ included_categories: ["blink.user_timing"], excluded_categories: ["*"] });
      let renderingRejected = false;
      const started = performance.now();
      await captureRenderingDiagnostics(join(root, "diagnostics"), 1).catch(() => { renderingRejected = true; });
      let externalOwnerStopSucceeded = false;
      try {
        await contentTracing.stopRecording(join(root, "external-owner-only.json"));
        externalOwnerStopSucceeded = true;
      } catch { /* The old rendering capture has already stopped this recording. */ }
      console.log(JSON.stringify({ externalContentTraceOwnership: {
        electron: process.versions.electron, renderingRejected, externalOwnerStopSucceeded,
        elapsedMs: Math.round(performance.now() - started),
      } }));
      if (!process.env.PWRAGENT_RENDERING_EXPECT_BASELINE) {
        assert.equal(externalOwnerStopSucceeded, true);
        // Electron's contentTracing uses a separate controller; a CDP session
        // may coexist. Either rejection or an independently owned trace is safe.
      }
    } finally {
      clearTimeout(watchdog);
      external.destroy();
      app.quit();
    }
    return;
  }
  const d = external.webContents.debugger;
  d.attach("1.3");
  let completions = 0;
  let startRecordingResolved = false;
  let stopRecordingCalls = 0;
  const originalStart = contentTracing.startRecording;
  const originalStop = contentTracing.stopRecording;
  contentTracing.startRecording = async (...args) => {
    await originalStart(...args);
    startRecordingResolved = true;
  };
  contentTracing.stopRecording = (...args) => {
    stopRecordingCalls++;
    return originalStop(...args);
  };
  d.on("message", (_event, method) => { if (method === "Tracing.tracingComplete") completions++; });
  try {
    await d.sendCommand("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: { includedCategories: ["blink.user_timing"], excludedCategories: ["*"] },
    });
    const started = performance.now();
    let renderingRejected = false;
    const capture = captureRenderingDiagnostics(join(root, "diagnostics"), 1);
    // Observe rejection immediately; Chromium errors themselves are never printed.
    const settled = capture.then(() => {}, () => { renderingRejected = true; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renderingSettled = await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); }),
    ]);
    clearTimeout(timer);
    if (renderingSettled) await stopRenderingDiagnostics("shutdown");
    let externalStillRecording = false;
    try { await d.sendCommand("Tracing.start", { transferMode: "ReportEvents" }); }
    catch { externalStillRecording = true; }
    const outputDirectories = await readdir(join(root, "diagnostics")).catch(() => []);
    const report = {
      electron: process.versions.electron, platform: process.platform,
      renderingSettled, renderingRejected, startRecordingResolved, stopRecordingCalls,
      externalStillRecording, externalCompletionsBeforeOwnerStop: completions,
      outputDirectories: outputDirectories.length, elapsedMs: Math.round(performance.now() - started),
    };
    console.log(JSON.stringify({ externalTraceOwnership: report }));
    if (!renderingSettled && process.env.PWRAGENT_RENDERING_EXPECT_BASELINE) {
      app.exit(0);
    }
    if (!process.env.PWRAGENT_RENDERING_EXPECT_BASELINE) {
      assert.equal(renderingRejected, true);
      assert.equal(externalStillRecording, true);
      assert.equal(completions, 0);
      assert.equal(outputDirectories.length, 0);
    }
    await d.sendCommand("Tracing.end");
    // Verify an independent capture still works after the owner ends its trace.
    await new Promise<void>((resolve) => {
      if (completions > report.externalCompletionsBeforeOwnerStop) return resolve();
      d.on("message", (_event, method) => { if (method === "Tracing.tracingComplete") resolve(); });
    });
    const result = await captureRenderingDiagnostics(join(root, "diagnostics"), 1);
    const summary = await readFile(result.summaryPath, "utf8");
    assert.ok(!summary.includes("invented rendering fixture"));
    assert.ok(!summary.includes("data:text/html"));
    console.log(JSON.stringify({ isolatedRenderingCapture: { durationMs: result.durationMs, summaryBytes: Buffer.byteLength(summary) } }));
  } finally {
    clearTimeout(watchdog);
    external.destroy();
    app.quit();
  }

}
void main().catch(() => { console.error("rendering ownership fixture failed"); app.exit(1); });
