// Temporary measurement probe, loaded with NODE_OPTIONS=--require. It prints
// one `[heap-probe]` line when the electron-vite build or a Playwright process
// exits: the V8 heap limit, the peak heap, the largest heap that survived a
// full GC, and the time spent in GC. Electron ignores NODE_OPTIONS --require,
// and every other Node process stays silent.
"use strict";

const v8 = require("node:v8");
const { PerformanceObserver, constants, performance } = require("node:perf_hooks");

const entry = process.argv[1] ?? "";
let role = null;
if (/electron-vite/.test(entry)) {
  role = "electron-vite";
} else if (/playwright/.test(entry)) {
  role = process.send ? "playwright-worker" : "playwright-runner";
}

if (role && !process.versions.electron) {
  const mb = (bytes) => (bytes / 1048576).toFixed(0);
  const stats = { gcMs: 0, gcCount: 0, majorMs: 0, majorCount: 0, peakUsed: 0, peakTotal: 0, peakLive: 0 };
  const sample = () => {
    const heap = v8.getHeapStatistics();
    stats.peakUsed = Math.max(stats.peakUsed, heap.used_heap_size);
    stats.peakTotal = Math.max(stats.peakTotal, heap.total_heap_size);
    return heap;
  };
  const record = (list) => {
    for (const gc of list.getEntries()) {
      stats.gcMs += gc.duration;
      stats.gcCount += 1;
      if (gc.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
        stats.majorMs += gc.duration;
        stats.majorCount += 1;
        stats.peakLive = Math.max(stats.peakLive, sample().used_heap_size);
      }
    }
  };
  const observer = new PerformanceObserver(record);
  observer.observe({ entryTypes: ["gc"] });
  setInterval(sample, 50).unref();

  process.on("exit", (code) => {
    record({ getEntries: () => observer.takeRecords() });
    observer.disconnect();
    const heap = sample();
    const wallMs = performance.now();
    process.stderr.write(
      `[heap-probe] role=${role} code=${code}`
      + ` limit_mb=${mb(heap.heap_size_limit)}`
      + ` peak_used_mb=${mb(stats.peakUsed)}`
      + ` peak_total_mb=${mb(stats.peakTotal)}`
      + ` peak_live_after_major_gc_mb=${mb(stats.peakLive)}`
      + ` max_rss_mb=${mb(process.resourceUsage().maxRSS * 1024)}`
      + ` gc_ms=${stats.gcMs.toFixed(0)} gc_count=${stats.gcCount}`
      + ` major_gc_ms=${stats.majorMs.toFixed(0)} major_gc_count=${stats.majorCount}`
      + ` wall_ms=${wallMs.toFixed(0)}`
      + ` gc_share=${((stats.gcMs / wallMs) * 100).toFixed(1)}%\n`,
    );
  });
}
