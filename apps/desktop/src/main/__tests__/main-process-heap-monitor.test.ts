import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deferred, createTemporaryTestDirectory } from "@pwragnt/agent-core";
import { resolveHeapMonitorConfig } from "../diagnostics/heap-monitor-config";
import { createHeapSession } from "../diagnostics/heap-session";
import { MainProcessHeapMonitor } from "../diagnostics/main-process-heap-monitor";

type MainProcessHeapReading = {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimit: number;
  totalPhysicalSize: number;
  totalAvailableSize: number;
  mallocedMemory: number;
  peakMallocedMemory: number;
};

type SessionStub = ReturnType<typeof createSessionStub>;

function createMonitorConfig(
  overrides?: Partial<Extract<ReturnType<typeof resolveHeapMonitorConfig>, { enabled: true }>>,
) {
  const config = resolveHeapMonitorConfig({
    env: {
      PWRAGNT_HEAP_DIAGNOSTICS: "1",
      PWRAGNT_HEAP_DIAGNOSTICS_SETTLE_MS: "1",
      PWRAGNT_HEAP_DIAGNOSTICS_INTERVAL_MS: "5",
      PWRAGNT_HEAP_DIAGNOSTICS_DELTA_BYTES: "100",
      PWRAGNT_HEAP_DIAGNOSTICS_COOLDOWN_MS: "10",
      PWRAGNT_HEAP_DIAGNOSTICS_MAX_SNAPSHOTS: "2",
    },
    repoRoot: "/repo",
  });

  expect(config.enabled).toBe(true);
  if (!config.enabled) {
    throw new Error("Expected enabled config.");
  }

  return {
    ...config,
    ...overrides,
  };
}

function createSessionStub() {
  const samples: unknown[] = [];
  const events: unknown[] = [];
  const snapshotFiles: string[] = [];

  return {
    samples,
    events,
    snapshotFiles,
    session: {
      id: "abc123",
      directoryName: "heap-2026-04-18-1702-abc123",
      directoryPath: "/repo/.local/heap-2026-04-18-1702-abc123",
      samplesPath: "/repo/.local/heap-2026-04-18-1702-abc123/samples.ndjson",
      eventsPath: "/repo/.local/heap-2026-04-18-1702-abc123/events.ndjson",
      appendSample: vi.fn(async (sample) => {
        samples.push(sample);
      }),
      appendEvent: vi.fn(async (event) => {
        events.push(event);
      }),
      registerSnapshotFile: vi.fn(async (filename) => {
        snapshotFiles.push(filename);
      }),
    },
  };
}

function createReading(overrides: Partial<MainProcessHeapReading>): MainProcessHeapReading {
  return {
    heapUsed: 100,
    heapTotal: 200,
    rss: 300,
    external: 10,
    arrayBuffers: 5,
    heapSizeLimit: 4096,
    totalPhysicalSize: 180,
    totalAvailableSize: 2048,
    mallocedMemory: 12,
    peakMallocedMemory: 18,
    ...overrides,
  };
}

function createHeapReader(responses: Array<MainProcessHeapReading | Error>) {
  return vi.fn(() => {
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }

    if (!next) {
      throw new Error("No more heap responses queued.");
    }

    return next;
  });
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function waitForEvent(
  eventsPath: string,
  predicate: (event: { type?: string; detail?: Record<string, unknown> }) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const events = (await fs.readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; detail?: Record<string, unknown> });
      if (events.some(predicate)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for heap monitor event in ${eventsPath}.`);
}

describe("MainProcessHeapMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T21:02:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a baseline after settle and recurring follow-up samples", async () => {
    const session = createSessionStub();
    const readHeap = createHeapReader([
      createReading({ heapUsed: 100, heapTotal: 200, rss: 300 }),
      createReading({ heapUsed: 120, heapTotal: 220, rss: 320 }),
      createReading({ heapUsed: 125, heapTotal: 225, rss: 330 }),
    ]);

    const monitor = new MainProcessHeapMonitor({
      session: session.session,
      config: createMonitorConfig(),
      readHeap,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);

    expect(session.samples).toEqual([
      expect.objectContaining({
        source: "main",
        usedSize: 100,
        totalSize: 200,
        rss: 300,
        isBaseline: true,
        deltaBytes: null,
      }),
    ]);

    await advance(5);
    await advance(5);

    expect(session.samples).toEqual([
      expect.objectContaining({ source: "main", usedSize: 100, isBaseline: true, deltaBytes: null }),
      expect.objectContaining({ source: "main", usedSize: 120, isBaseline: false, deltaBytes: 20 }),
      expect.objectContaining({ source: "main", usedSize: 125, isBaseline: false, deltaBytes: 5 }),
    ]);

    await monitor.stop();
  });

  it("captures the baseline immediately when settle delay is zero", async () => {
    const session = createSessionStub();
    const readHeap = createHeapReader([createReading({ heapUsed: 100, heapTotal: 200 })]);

    const monitor = new MainProcessHeapMonitor({
      session: session.session,
      config: createMonitorConfig({
        settleDelayMs: 0,
      }),
      readHeap,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();

    expect(session.samples).toEqual([
      expect.objectContaining({
        source: "main",
        usedSize: 100,
        isBaseline: true,
        deltaBytes: null,
      }),
    ]);

    await monitor.stop();
  });

  it("captures a heap snapshot when adjacent samples cross the threshold", async () => {
    const session = createSessionStub();
    const readHeap = createHeapReader([
      createReading({ heapUsed: 100, heapTotal: 200 }),
      createReading({ heapUsed: 250, heapTotal: 350 }),
    ]);
    const writeSnapshot = vi.fn((filePath: string) => filePath);

    const monitor = new MainProcessHeapMonitor({
      session: session.session,
      config: createMonitorConfig(),
      readHeap,
      writeSnapshot,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);
    await advance(5);

    expect(writeSnapshot).toHaveBeenCalledWith(
      "/repo/.local/heap-2026-04-18-1702-abc123/main-heap-0001.heapsnapshot",
    );
    expect(session.snapshotFiles).toEqual(["main-heap-0001.heapsnapshot"]);
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "main",
          type: "snapshot-triggered",
          detail: expect.objectContaining({
            filename: "main-heap-0001.heapsnapshot",
            deltaBytes: 150,
          }),
        }),
        expect.objectContaining({
          source: "main",
          type: "snapshot-completed",
          detail: expect.objectContaining({
            filename: "main-heap-0001.heapsnapshot",
          }),
        }),
      ]),
    );

    await monitor.stop();
  });

  it("logs sample failures without crashing the monitor", async () => {
    const session = createSessionStub();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const readHeap = createHeapReader([
      createReading({ heapUsed: 100, heapTotal: 200 }),
      new Error("heap exploded"),
      createReading({ heapUsed: 130, heapTotal: 230 }),
    ]);

    const monitor = new MainProcessHeapMonitor({
      session: session.session,
      config: createMonitorConfig(),
      readHeap,
      logger,
    });

    await monitor.start();
    await advance(1);
    await advance(5);
    await advance(5);

    expect(logger.error).toHaveBeenCalled();
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "main",
          type: "sample-failed",
          detail: expect.objectContaining({
            error: "heap exploded",
          }),
        }),
      ]),
    );
    expect(session.samples).toEqual([
      expect.objectContaining({ source: "main", usedSize: 100 }),
      expect.objectContaining({ source: "main", usedSize: 130 }),
    ]);

    await monitor.stop();
  });

  it("writes a heap snapshot file and matching events into a real session directory", async () => {
    vi.useRealTimers();
    const workspace = await createTemporaryTestDirectory();
    const config = resolveHeapMonitorConfig({
      env: {
        PWRAGNT_HEAP_DIAGNOSTICS: "1",
        PWRAGNT_HEAP_DIAGNOSTICS_SETTLE_MS: "1",
        PWRAGNT_HEAP_DIAGNOSTICS_INTERVAL_MS: "5",
        PWRAGNT_HEAP_DIAGNOSTICS_DELTA_BYTES: "100",
      },
      repoRoot: workspace.path,
    });

    expect(config.enabled).toBe(true);
    if (!config.enabled) {
      await workspace.cleanup();
      return;
    }

    const created = await createHeapSession({
      config,
      createdAt: new Date(2026, 3, 18, 17, 2, 3),
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      await workspace.cleanup();
      return;
    }

    const snapshotWritten = new Deferred<void>();
    const readHeap = createHeapReader([
      createReading({ heapUsed: 100, heapTotal: 200 }),
      createReading({ heapUsed: 250, heapTotal: 350 }),
    ]);

    const monitor = new MainProcessHeapMonitor({
      session: created.session,
      config,
      readHeap,
      writeSnapshot: (filePath) => {
        void fs.writeFile(filePath, '{"snapshot":true}', "utf8").then(() => {
          snapshotWritten.resolve();
        });
        return filePath;
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await snapshotWritten.promise;

    await expect(
      fs.readFile(
        path.join(created.session.directoryPath, "main-heap-0001.heapsnapshot"),
        "utf8",
      ),
    ).resolves.toContain('"snapshot":true');

    await waitForEvent(
      created.session.eventsPath,
      (event) =>
        event.type === "snapshot-completed" &&
        event.detail?.filename === "main-heap-0001.heapsnapshot",
    );

    const eventLines = (
      await fs.readFile(path.join(created.session.directoryPath, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(eventLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "main",
          type: "snapshot-triggered",
          detail: expect.objectContaining({
            filename: "main-heap-0001.heapsnapshot",
          }),
        }),
        expect.objectContaining({
          source: "main",
          type: "snapshot-completed",
          detail: expect.objectContaining({
            filename: "main-heap-0001.heapsnapshot",
          }),
        }),
      ]),
    );

    await monitor.stop();
    await workspace.cleanup();
  });
});
