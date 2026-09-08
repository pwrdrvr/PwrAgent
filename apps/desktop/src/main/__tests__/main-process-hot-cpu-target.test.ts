import fs from "node:fs/promises";
import path from "node:path";
import type { ProcessMetric } from "electron";
import { expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "../testing/test-harness";
import { createMainProcessHotCpuTarget } from "../diagnostics/main-process-hot-cpu-target";
import { HotCpuProfiler } from "../diagnostics/hot-cpu-profiler";
import { createHotCpuProfileSession } from "../diagnostics/hot-cpu-profile-session";
import { resolveHotCpuProfileConfig } from "../diagnostics/hot-cpu-profile-config";
import { directoryEnrichmentDiagnostics } from "../diagnostics/directory-enrichment-diagnostics";
import type { HotCpuProfileCapturedEvent } from "../../shared/hot-cpu-profile";

function metric(pid: number, cpuPercent: number, cumulativeCpu: number): ProcessMetric {
  return {
    pid,
    type: pid === process.pid ? "Browser" : "Tab",
    creationTime: 1,
    cpu: {
      percentCPUUsage: cpuPercent,
      cumulativeCPUUsage: cumulativeCpu,
      idleWakeupsPerSecond: 0,
    },
    memory: { workingSetSize: 2, peakWorkingSetSize: 2 },
  };
}

it.each([false, true])("captures main CPU and heap usage (auxiliary failure: %s)", async (diagnosticsFail) => {
  const workspace = await createTemporaryTestDirectory();
  const target = createMainProcessHotCpuTarget();
  if (diagnosticsFail) target.readDiagnostics = () => { throw new Error("fixture diagnostics failure"); };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let profiler: HotCpuProfiler | undefined;
  try {
    const resolved = resolveHotCpuProfileConfig({ enabled: true, repoRoot: workspace.path, env: {} });
    if (!resolved.enabled) throw new Error("Expected enabled config");
    const config = {
      ...resolved, startDelayMs: 0, intervalMs: 1, profileDurationMs: 5,
      thresholdPercent: 50, consecutiveSamples: 2, maxProfiles: 1,
      captureHeapSnapshot: true,
    };
    const created = await createHotCpuProfileSession({
      config, target: "main",
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version },
    });
    if (!created.ok) throw new Error(created.message);
    let resolveCapture!: (event: HotCpuProfileCapturedEvent) => void;
    const capture = new Promise<HotCpuProfileCapturedEvent>((resolve) => { resolveCapture = resolve; });
    let cpuSeconds = 0;
    let nowMs = 0;
    profiler = new HotCpuProfiler({
      config, session: created.session, target,
      logger,
      now: () => new Date(nowMs += 1000),
      getAppMetrics: () => [
        metric(1234, 0, 0),
        metric(process.pid, 200, cpuSeconds += 4),
      ],
      onProfileWritten: resolveCapture,
    });
    directoryEnrichmentDiagnostics.record({
      directory: "/fixture/cpu-capture", enricherId: 0, caller: "thread-list", reason: "cold",
    }, { requests: 1, gitStarted: 3 });
    await profiler.start();
    const event = await capture;
    await profiler.stop("test-complete");
    expect(event).toMatchObject({ target: "main", profileFilename: "main-hot-0001.cpuprofile", heapSnapshotArtifacts: [] });
    const profile = JSON.parse(await fs.readFile(event.profilePath, "utf8"));
    expect(profile.nodes.length).toBeGreaterThan(0);
    const diagnosticsFilename = "main-hot-0001.diagnostics.json";
    const manifest = JSON.parse(await fs.readFile(path.join(created.session.directoryPath, "session.json"), "utf8"));
    if (diagnosticsFail) {
      expect(manifest.artifacts).not.toContain(diagnosticsFilename);
      expect(logger.warn).toHaveBeenCalledWith(
        "[pwragent:hot-cpu] auxiliary diagnostics failed", expect.any(Error),
      );
    } else {
      const diagnostics = JSON.parse(await fs.readFile(path.join(created.session.directoryPath, diagnosticsFilename), "utf8"));
      expect(diagnostics.directoryEnrichment.schemaVersion).toBe(1);
      expect(diagnostics.directoryEnrichment.buckets.flatMap((bucket: { rows: unknown[] }) => bucket.rows))
        .toContainEqual(expect.objectContaining({ directory: "/fixture/cpu-capture", requests: 1, gitStarted: 3 }));
      expect(manifest.artifacts).toContain(diagnosticsFilename);
    }
    const samples = (await fs.readFile(created.session.samplesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]).toMatchObject({ pid: process.pid, heapUsed: expect.any(Number), heapTotal: expect.any(Number) });
    expect(JSON.parse(await fs.readFile(path.join(created.session.directoryPath, "session.json"), "utf8"))).toMatchObject({ target: "main" });
    expect(target.debugger.isAttached()).toBe(false);
    expect(target.takeHeapSnapshot).toBeUndefined();
    await expect(target.debugger.sendCommand("Profiler.stop")).rejects.toThrow("not attached");
  } finally {
    await profiler?.stop("test-cleanup");
    target.debugger.detach();
    await workspace.cleanup();
  }
});
