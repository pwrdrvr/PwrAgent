// Property test of the heap-snapshot cooldown in both heap monitors
// (`PWRAGENT_HEAP_DIAGNOSTICS=1`). A heap snapshot stalls the process it
// serializes, so the cooldown and the snapshot cap exist to bound how often
// that stall can happen while the heap keeps growing. fast-check generates
// sessions of heap readings, failing snapshot writes and backwards clock
// jumps, and runs each through the real monitor loop under fake timers.
//
// The rules:
//
//   C1  Two snapshot attempts are at least `snapshotCooldownMs` apart in
//       elapsed time, whether or not the earlier one succeeded.
//   C2  At most `maxSnapshots` snapshots are written.
//   C3  A clock that jumps backwards never lets an attempt in early.
//
// Before the fix, only a successful write started the cooldown. A write
// that failed (ENOSPC, a detached debugger) was retried on the next sample,
// every `intervalMs`, for as long as the heap kept growing, so C1 failed on
// two consecutive threshold crossings with the first write failing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { resolveHeapMonitorConfig } from "../diagnostics/heap-monitor-config";
import type { HeapSession } from "../diagnostics/heap-session";
import { MainProcessHeapMonitor } from "../diagnostics/main-process-heap-monitor";
import { RendererHeapMonitor } from "../diagnostics/renderer-heap-monitor";

const INTERVAL_MS = 1_000;
const COOLDOWN_MS = 4_500;
const THRESHOLD_BYTES = 100;
const MAX_SNAPSHOTS = 3;
const START_MS = Date.parse("2026-04-18T21:02:00.000Z");

type Step = { growth: number; fails: boolean; clockBackMs: number };

const stepArbitrary: fc.Arbitrary<Step> = fc.record({
  // Mostly a leak: most samples cross the threshold.
  growth: fc.oneof(
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 99 }) },
    { weight: 4, arbitrary: fc.integer({ min: 100, max: 1_000 }) },
  ),
  fails: fc.integer({ min: 0, max: 3 }).map((roll) => roll === 0),
  clockBackMs: fc.oneof({ weight: 12, arbitrary: fc.constant(0) }, fc.integer({ min: 1, max: 10_000 })),
});

function config() {
  const resolved = resolveHeapMonitorConfig({
    env: {
      PWRAGENT_HEAP_DIAGNOSTICS: "1",
      PWRAGENT_HEAP_DIAGNOSTICS_SETTLE_MS: "0",
      PWRAGENT_HEAP_DIAGNOSTICS_INTERVAL_MS: String(INTERVAL_MS),
      PWRAGENT_HEAP_DIAGNOSTICS_DELTA_BYTES: String(THRESHOLD_BYTES),
      PWRAGENT_HEAP_DIAGNOSTICS_COOLDOWN_MS: String(COOLDOWN_MS),
      PWRAGENT_HEAP_DIAGNOSTICS_MAX_SNAPSHOTS: String(MAX_SNAPSHOTS),
    },
    repoRoot: "/repo",
  });
  if (!resolved.enabled) throw new Error("Expected enabled heap config.");
  return resolved;
}

function sessionStub(): HeapSession {
  return {
    id: "property",
    directoryName: "heap-property",
    directoryPath: "/repo/.local/heap-property",
    samplesPath: "/repo/.local/heap-property/samples.ndjson",
    eventsPath: "/repo/.local/heap-property/events.ndjson",
    appendSample: async () => {},
    appendEvent: async () => {},
    registerSnapshotFile: async () => {},
  } as unknown as HeapSession;
}

type World = {
  heapUsed: number;
  failNext: boolean;
  // Wall clock the monitor sees: elapsed fake time minus every backwards jump.
  clockOffsetMs: number;
  // Elapsed (monotonic) fake time of each write attempt, and whether it wrote.
  attempts: Array<{ elapsedMs: number; wrote: boolean }>;
};

type Monitor = { start: () => Promise<void>; stop: (reason?: string) => Promise<void> };

const monitors: Record<string, (world: World) => Monitor> = {
  main: (world) => new MainProcessHeapMonitor({
    session: sessionStub(),
    config: config(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => new Date(Date.now() + world.clockOffsetMs),
    readHeap: () => ({
      heapUsed: world.heapUsed,
      heapTotal: world.heapUsed * 2,
      rss: 0,
      external: 0,
      arrayBuffers: 0,
      heapSizeLimit: 0,
      totalPhysicalSize: 0,
      totalAvailableSize: 0,
      mallocedMemory: 0,
      peakMallocedMemory: 0,
    }),
    writeSnapshot: (filePath) => {
      const fails = world.failNext;
      world.attempts.push({ elapsedMs: Date.now() - START_MS, wrote: !fails });
      if (fails) throw new Error("ENOSPC: no space left on device");
      return filePath;
    },
  }),
  renderer: (world) => new RendererHeapMonitor({
    session: sessionStub(),
    config: config(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => new Date(Date.now() + world.clockOffsetMs),
    target: {
      debugger: {
        attach: () => {},
        detach: () => {},
        isAttached: () => true,
        sendCommand: async () => ({ usedSize: world.heapUsed, totalSize: world.heapUsed * 2 }),
        on: () => {},
        off: () => {},
      },
      takeHeapSnapshot: async () => {
        const fails = world.failNext;
        world.attempts.push({ elapsedMs: Date.now() - START_MS, wrote: !fails });
        if (fails) throw new Error("Target closed");
      },
      isDestroyed: () => false,
    },
  }),
};

describe.each(Object.keys(monitors))("%s heap monitor snapshot cooldown", (kind) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces snapshot attempts by the cooldown and caps written snapshots", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArbitrary, { minLength: 1, maxLength: 60, size: "max" }), async (steps) => {
        vi.setSystemTime(START_MS);
        const world: World = { heapUsed: 1_000, failNext: false, clockOffsetMs: 0, attempts: [] };
        const monitor = monitors[kind]!(world);
        await monitor.start();
        for (const step of steps) {
          world.heapUsed += step.growth;
          world.failNext = step.fails;
          world.clockOffsetMs -= step.clockBackMs;
          await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        }
        await monitor.stop("property");

        world.attempts.forEach((attempt, index) => {
          const previous = world.attempts[index - 1];
          if (!previous) return;
          expect(
            attempt.elapsedMs - previous.elapsedMs,
            `C1/C3: attempt ${index} came ${attempt.elapsedMs - previous.elapsedMs}ms after the last`,
          ).toBeGreaterThanOrEqual(COOLDOWN_MS);
        });
        expect(world.attempts.filter((attempt) => attempt.wrote).length, "C2: snapshot cap")
          .toBeLessThanOrEqual(MAX_SNAPSHOTS);
      }),
      { numRuns: 150 },
    );
  });

  it("stops at the snapshot cap under a steady leak", async () => {
    const world: World = { heapUsed: 1_000, failNext: false, clockOffsetMs: 0, attempts: [] };
    const monitor = monitors[kind]!(world);
    await monitor.start();
    for (let sample = 0; sample < 30; sample += 1) {
      world.heapUsed += 500;
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
    await monitor.stop("example");
    expect(world.attempts.map((attempt) => attempt.elapsedMs)).toEqual([1_000, 6_000, 11_000]);
  });

  it("does not retry a failed snapshot on the next threshold crossing", async () => {
    const world: World = { heapUsed: 1_000, failNext: true, clockOffsetMs: 0, attempts: [] };
    const monitor = monitors[kind]!(world);
    await monitor.start();
    for (let sample = 0; sample < 3; sample += 1) {
      world.heapUsed += 500;
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
    await monitor.stop("example");
    expect(world.attempts).toHaveLength(1);
  });
});
