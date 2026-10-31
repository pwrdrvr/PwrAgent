// Contrived controls for the production capture. Run in Sandboxer or the macOS
// lab: pnpm --filter @pwragent/desktop probe:native-cpu. No operator state.
require("tsx/cjs");
const { app, BrowserWindow, contentTracing, ipcMain } = require("electron");
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const { captureNativeCpuDiagnostics, NATIVE_CPU_TRACE_CONFIG } = require("../src/main/diagnostics/native-cpu-capture.ts");
const root = mkdtempSync(join(tmpdir(), "pwragent-native-controls-"));
app.setPath("userData", join(root, "user-data"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => app.exit(2), 180_000);
const output = join(__dirname, "../.local/native-cpu-controls.json");
const cpu = (pid) => app.getAppMetrics().find((m) => m.pid === pid)?.cpu.cumulativeCPUUsage;

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  writeFileSync(join(root, "preload.cjs"), 'const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("controlIpc", () => ipcRenderer.invoke("native-control"));');
  ipcMain.handle("native-control", () => 1);
  const w = new BrowserWindow({ show: true, width: 640, height: 480,
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(root, "preload.cjs") } });
  await w.loadURL("data:text/html," + encodeURIComponent("<!doctype html><div id='root'></div>"));
  await w.webContents.executeJavaScript(`window.control = async (kind) => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    if (kind === "js") { const end = performance.now() + 700; while (performance.now() < end) {} }
    if (kind === "layout") {
      const root = document.getElementById("root");
      root.innerHTML = "<div style='display:inline-block;width:100px'>invented</div>".repeat(300);
      for (let i = 0; i < 30; i++) { root.style.width = (310 + (i % 2) * 100) + "px"; void root.offsetWidth; await delay(15); }
      root.innerHTML = "";
    }
    if (kind === "ipc") for (let i = 0; i < 1000; i++) await window.controlIpc();
    if (kind === "worker") {
      const url = URL.createObjectURL(new Blob(["onmessage = () => { const end = performance.now() + 700; while (performance.now() < end) {} postMessage(1); }"], { type: "text/javascript" }));
      const worker = new Worker(url);
      await new Promise(resolve => { worker.onmessage = resolve; worker.postMessage(1); });
      worker.terminate(); URL.revokeObjectURL(url);
    }
  }; void 0;`);
  const pid = w.webContents.getOSProcessId(), d = w.webContents.debugger;
  // CDP must reject an already-owned trace, without ending it.
  d.attach("1.3");
  await d.sendCommand("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: NATIVE_CPU_TRACE_CONFIG });
  await assert.rejects(captureNativeCpuDiagnostics(root, w.webContents), /Native CPU capture failed/);
  const foreignComplete = new Promise(resolve => {
    const listener = (_event, method, params) => {
      if (method === "Tracing.tracingComplete") { d.off("message", listener); resolve(params); }
    };
    d.on("message", listener);
  });
  await d.sendCommand("Tracing.end");
  await d.sendCommand("IO.close", { handle: (await foreignComplete).stream });
  d.detach();
  const rows = [];
  for (const mode of ["baseline", "v8", "trace", "trace-and-v8"]) {
    const profiling = mode === "v8" || mode === "trace-and-v8";
    if (profiling) { d.attach("1.3"); await d.sendCommand("Profiler.enable"); }
    for (const kind of ["idle", "js", "layout", "ipc", "worker"]) {
      const tracing = mode === "trace" || mode === "trace-and-v8";
      if (profiling) await d.sendCommand("Profiler.start");
      const startCpu = cpu(pid), startMain = process.cpuUsage(), started = performance.now();
      let pending;
      if (tracing) {
        const ready = new Promise(resolve => {
          const listener = (_event, method) => {
            if (method === "Tracing.bufferUsage") { d.off("message", listener); resolve(); }
          };
          d.on("message", listener);
        });
        pending = captureNativeCpuDiagnostics(root, w.webContents);
        await ready;
      }
      await w.webContents.executeJavaScript(`window.control(${JSON.stringify(kind)})`);
      if (!tracing) await delay(Math.max(0, 3000 - (performance.now() - started)));
      let native;
      if (pending) {
        const result = await pending;
        native = JSON.parse(readFileSync(result.summaryPath, "utf8"));
        assert.deepEqual(readdirSync(require("node:path").dirname(result.summaryPath)), ["summary.json"]);
        assert.ok(native.buffer.peakFraction < 0.99, "Control filled native buffer");
        assert.equal(native.trace.coverage.omittedSpans, 0);
        assert.ok(native.durationMs < 3300, "Main deadline missed");
        assert.ok(native.transfer.bytes <= 64 * 1024 * 1024);
        if (kind === "layout") assert.ok(native.trace.spans.some(s => s.name === "Layout"), "Missing layout");
        if (kind === "js" || kind === "worker") {
          const thread = native.trace.threads.find(t => t.role === (kind === "worker" ? "DedicatedWorker thread" : "CrRendererMain"));
          assert.ok(thread && thread.wallUnionUs > 600_000, "Busy thread missing");
        }
      }
      const mainCpu = process.cpuUsage(startMain);
      const row = { mode, kind, rendererCpuMs: (cpu(pid) - startCpu) * 1000,
        mainCpuMs: (mainCpu.user + mainCpu.system) / 1000, elapsedMs: performance.now() - started };
      if (profiling) {
        const { profile } = await d.sendCommand("Profiler.stop");
        assert.ok(profile.samples.length > 0, "V8 profiler did not survive trace");
        assert.ok(d.isAttached(), "Native capture detached V8 profiler");
        row.v8Samples = profile.samples.length;
      }
      if (native) row.native = { durationMs: native.durationMs, bytes: native.transfer.bytes,
        buffer: native.buffer, coverage: native.trace.coverage, threads: native.trace.threads,
        layoutSpans: native.trace.spans.filter(s => s.name === "Layout").length,
        ipcSpans: native.trace.spans.filter(s => /mojo|ipc/.test(s.name)).length };
      rows.push(row);
      console.log(JSON.stringify({ mode, kind, rendererCpuMs: row.rendererCpuMs, mainCpuMs: row.mainCpuMs, bytes: row.native?.bytes }));
    }
    if (profiling) d.detach();
  }
  require("node:fs").mkdirSync(require("node:path").dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ platform: process.platform, electron: process.versions.electron,
    chromium: process.versions.chrome, conflictRejected: true, rows }, null, 2));
  rmSync(root, { recursive: true, force: true });
  clearTimeout(watchdog);
  console.log("native-cpu-controls passed");
  app.exit(0);
}).catch(error => { console.error(error); rmSync(root, { recursive: true, force: true }); app.exit(1); });
