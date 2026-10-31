import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { captureRenderingDiagnostics, stopRenderingDiagnostics } from "../../../src/main/diagnostics/rendering-capture";

// A standalone Electron process: no PwrAgent startup, profiles, backends or IPC.
const root = process.env.PWRAGENT_RENDERING_FIXTURE_ROOT!;
app.setPath("userData", join(root, "user-data"));
const watchdog = setTimeout(() => { console.error("fixture deadline exceeded"); app.exit(1); }, 20_000);
await app.whenReady();
const external = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
await external.loadURL("data:text/html,<p>invented rendering fixture</p>");
const d = external.webContents.debugger;
d.attach("1.3");
let completions = 0;
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
  await settled;
  await stopRenderingDiagnostics("shutdown");
  let externalStillRecording = false;
  try { await d.sendCommand("Tracing.start", { transferMode: "ReportEvents" }); }
  catch { externalStillRecording = true; }
  const outputDirectories = await readdir(join(root, "diagnostics")).catch(() => []);
  const report = {
    electron: process.versions.electron, platform: process.platform,
    renderingRejected, externalStillRecording, externalCompletionsBeforeOwnerStop: completions,
    outputDirectories: outputDirectories.length, elapsedMs: Math.round(performance.now() - started),
  };
  console.log(JSON.stringify({ externalTraceOwnership: report }));
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
